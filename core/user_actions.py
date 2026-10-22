"""Endpoint de acciones de los usuarios del dashboard (tarea 1.37, §7.7).

    POST /user-actions/execute
    Headers: Authorization: Bearer <ID token de Firebase>
    Cuerpo:  {"action": "...", "data": {...}}   Respuesta: contracts.ActionResponse

La web lee Firestore en vivo y *pide* toda escritura aquí. Este módulo no escribe nada por sí mismo: valida
el token, ubica el recurso y aplica los permisos (`core.authz`) antes de llamar al handler de la acción.
Las acciones concretas (tomar y cerrar conversación, etiquetas, bots, campañas...) se declaran con
`declare` en la tarea 1.39.

Reglas:
  - La identidad sale del token, nunca del cuerpo. La organización y el equipo de una conversación salen
    del documento de la conversación, nunca de `data`.
  - Cada acción declara su `scope` y su `level`; el permiso se comprueba antes de llamar al handler:
      scope `org`           `data.organizationId`; `conversation` `data.conversationId`;
            `doc`           `data.id` de un documento de `collection` (su organización sale del documento);
            `global`        sin recurso (alta de organizaciones, etc.);
            `identity`      solo el token, sin exigir usuario registrado ni nivel (`level=None`): el reclamo
                            de la invitación en el primer inicio de sesión y la presencia del propio usuario.
      level `write` (admin o agente), `admin` (admin de esa organización), `super` (solo superadmin). Falla cerrado: sin token válido o sin usuario registrado, no hay acción.
  - Es la puerta de usuarios; la de los bots es `core/actions.py` (autenticación de servicio aparte).

Estados HTTP: 401 sin token válido, 400 cuerpo inválido, 403 sin permiso, 404 acción o conversación
inexistente, 500 error interno y 200 para el resto (un rechazo de negocio va en `error.code`).
"""
import logging
import os
from dataclasses import dataclass
from typing import Callable

from contracts.actions import (ACCION_DESCONOCIDA, CONVERSACION_NO_ENCONTRADA, DATOS_INVALIDOS, ERROR_INTERNO,
                               NO_AUTORIZADO, RECURSO_NO_ENCONTRADO, ActionResponse)
from core import authz
from core.db import get_db

log = logging.getLogger(__name__)

SCOPES = ("org", "conversation", "doc", "global", "identity")
LEVELS = ("write", "admin", "super")

_STATUS = {NO_AUTORIZADO: 403, CONVERSACION_NO_ENCONTRADA: 404, RECURSO_NO_ENCONTRADO: 404, ACCION_DESCONOCIDA: 404,
           DATOS_INVALIDOS: 400, ERROR_INTERNO: 500}


class UserActionError(Exception):
    """Rechazo de negocio de una acción: llega al cliente como `error` tipado."""

    def __init__(self, code: str, message: str = "", retryable: bool = False):
        super().__init__(message or code)
        self.code, self.message, self.retryable = code, message, retryable


@dataclass
class UserContext:
    """Lo que recibe un handler: el usuario ya autenticado y autorizado, y el recurso ya ubicado."""
    db: object
    requester: authz.Requester | None   # None solo en scope `identity` con un usuario aún sin registrar
    org_id: str
    conv_id: str | None = None
    conv: dict | None = None   # con `id`, para scope `conversation`
    doc_id: str | None = None
    doc: dict | None = None    # para scope `doc`
    claims: dict | None = None  # token verificado: uid, email, email_verified, name, picture
    origin: str | None = None   # Origin de la petición, solo si está en ALLOWED_ORIGINS (p. ej. el enlace de una invitación)


@dataclass
class UserAction:
    name: str
    handler: Callable[[UserContext, dict], dict | None]
    scope: str
    level: str
    collection: str | None = None


_REGISTRY: dict[str, UserAction] = {}


def declare(name: str, *, scope: str, level: str = "write", collection: str | None = None):
    """Decorador que registra el handler `handler(ctx, data) -> dict | None` de una acción de usuario."""
    if scope not in SCOPES or (scope == "identity") != (level is None) or (level is not None and level not in LEVELS)             or (scope == "doc") != bool(collection):
        raise ValueError(f"{name}: scope {scope!r}, level {level!r} o collection {collection!r} inválido")

    def wrap(fn):
        if name in _REGISTRY:
            raise ValueError(f"la acción de usuario {name!r} ya está registrada")
        _REGISTRY[name] = UserAction(name, fn, scope, level, collection)
        return fn
    return wrap


def clear() -> None:
    _REGISTRY.clear()


# --------------------------------------------------------------------------- autenticación

_transport = None


def _firebase_verifier(token: str) -> dict | None:
    """Verifica el ID token contra los certificados de Google, con el proyecto como audiencia."""
    global _transport
    project = os.environ.get("FIREBASE_PROJECT_ID") or os.environ.get("GOOGLE_CLOUD_PROJECT")
    if not project:
        log.error("falta FIREBASE_PROJECT_ID: no se puede verificar el token")
        return None
    from google.auth.transport import requests as ga_requests
    from google.oauth2 import id_token
    _transport = _transport or ga_requests.Request()
    try:
        return id_token.verify_firebase_token(token, _transport, audience=project)
    except ValueError:
        return None


def verify_claims(headers, verifier=None) -> dict | None:
    """Claims del token de la petición (con `uid`), o None. Falla cerrado.

    `verifier(token) -> claims | None` es inyectable para las pruebas.
    """
    value = headers.get("Authorization") or ""
    token = value.removeprefix("Bearer ").strip() if value.startswith("Bearer ") else ""
    if not token:
        return None
    claims = (verifier or _firebase_verifier)(token)
    uid = (claims or {}).get("uid") or (claims or {}).get("sub")
    return {**claims, "uid": uid} if uid else None


def authenticate(headers, verifier=None) -> str | None:
    """`uid` del usuario que hace la petición, o None."""
    return (verify_claims(headers, verifier) or {}).get("uid")


def cors_headers(origin: str | None, env=None) -> dict:
    """Cabeceras CORS para el navegador, solo para los orígenes de `ALLOWED_ORIGINS` (separados por comas)."""
    env = os.environ if env is None else env
    allowed = {o.strip() for o in (env.get("ALLOWED_ORIGINS") or "").split(",") if o.strip()}
    if not origin or origin not in allowed:
        return {}
    return {"Access-Control-Allow-Origin": origin, "Vary": "Origin",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Max-Age": "3600"}


# --------------------------------------------------------------------------- ejecución

def _denied(message: str = "No tienes permiso para esta operación") -> ActionResponse:
    return ActionResponse.failure(NO_AUTORIZADO, message)


def _allowed(requester: authz.Requester, org_id: str | None, level: str) -> bool:
    if level == "super":
        return requester.is_super_admin
    return authz.is_admin_in(requester, org_id) if level == "admin" else authz.can_write(requester)


def _locate(spec: UserAction, requester: authz.Requester, data: dict, db) -> UserContext | ActionResponse:
    """Ubica el recurso de la acción y comprueba el permiso. Devuelve el contexto o la respuesta de rechazo."""
    if spec.scope == "global":
        return UserContext(db, requester, "") if _allowed(requester, None, spec.level) else _denied()

    if spec.scope == "doc":
        doc_id = data.get("id")
        if not isinstance(doc_id, str) or not doc_id:
            return ActionResponse.failure(DATOS_INVALIDOS, "Falta id")
        snap = db.collection(spec.collection).document(doc_id).get()
        doc = (snap.to_dict() or {}) if snap.exists else None
        org_id = doc_id if spec.collection == "organizations" else (doc or {}).get("organizationId")
        # Quien no pertenece a la organización del recurso no debe saber si existe
        if doc is None or not authz.in_org(requester, org_id):
            return ActionResponse.failure(RECURSO_NO_ENCONTRADO, "El recurso no existe")
        if not _allowed(requester, org_id, spec.level):
            return _denied()
        return UserContext(db, requester, org_id, doc_id=doc_id, doc=doc)

    if spec.scope == "org":
        org_id = data.get("organizationId")
        if not isinstance(org_id, str) or not org_id:
            return ActionResponse.failure(DATOS_INVALIDOS, "Falta organizationId")
        if not authz.in_org(requester, org_id):
            return _denied()
        return UserContext(db, requester, org_id) if _allowed(requester, org_id, spec.level) else _denied()

    conv_id = data.get("conversationId")
    if not isinstance(conv_id, str) or not conv_id:
        return ActionResponse.failure(DATOS_INVALIDOS, "Falta conversationId")
    snap = db.collection("conversations").document(conv_id).get()
    conv = (snap.to_dict() or {}) if snap.exists else None
    # Quien no ve la conversación no debe saber si existe: mismo rechazo que un id inexistente.
    if conv is None or not authz.can_access_conversation(requester, conv):
        return ActionResponse.failure(CONVERSACION_NO_ENCONTRADA, "La conversación no existe")
    org_id = conv.get("organizationId")
    allowed = _allowed(requester, org_id, spec.level) if spec.level != "write" else authz.can_act_on_conversation(requester, conv)
    if not allowed:
        return _denied()
    conv["id"] = conv_id
    return UserContext(db, requester, org_id, conv_id, conv)


def execute_user_action(uid: str, action: str, data: dict, db=None, claims: dict | None = None,
                        origin: str | None = None) -> ActionResponse:
    """Ejecuta `action` en nombre del usuario `uid` (ya autenticado). Nunca lanza."""
    db = db or get_db()
    spec = _REGISTRY.get(action)
    if spec is None:
        return ActionResponse.failure(ACCION_DESCONOCIDA, f"La acción {action!r} no existe")
    requester = authz.load_requester(db, uid)
    if spec.scope == "identity":
        located = UserContext(db, requester, "", claims=claims or {"uid": uid})
    elif requester is None:
        return _denied("Usuario no registrado")
    else:
        located = _locate(spec, requester, data, db)
    if isinstance(located, ActionResponse):
        return located
    located.origin = origin
    try:
        return ActionResponse.success(spec.handler(located, data) or {})
    except UserActionError as e:
        return ActionResponse.failure(e.code, e.message, e.retryable)
    except Exception:
        log.exception("error en la acción de usuario %s", action)
        return ActionResponse.failure(ERROR_INTERNO, "No se pudo completar la operación", retryable=True)


def handle(headers, body, db=None, verifier=None) -> tuple[dict, int]:
    """Entrada HTTP: autentica, valida el cuerpo y ejecuta. Devuelve (cuerpo, estado)."""
    claims = verify_claims(headers, verifier)
    if claims is None:
        return {"error": "Unauthorized"}, 401
    action = body.get("action") if isinstance(body, dict) else None
    data = body.get("data", {}) if isinstance(body, dict) else None
    if not isinstance(action, str) or not action or not isinstance(data, dict):
        return {"error": "Se esperaba {action: str, data: objeto}"}, 400
    origin = headers.get("Origin") if cors_headers(headers.get("Origin")) else None
    response = execute_user_action(claims["uid"], action, data, db, claims, origin)
    return response.to_dict(), 200 if response.ok else _STATUS.get(response.error.code, 200)
