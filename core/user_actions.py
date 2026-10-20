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
  - Cada acción declara su `scope` (`org` o `conversation`) y su `level` (`write` o `admin`); el permiso
    se comprueba antes de llamar al handler. Falla cerrado: sin token válido o sin usuario registrado, no hay acción.
  - Es la puerta de usuarios; la de los bots es `core/actions.py` (autenticación de servicio aparte).

Estados HTTP: 401 sin token válido, 400 cuerpo inválido, 403 sin permiso, 404 acción o conversación
inexistente, 500 error interno y 200 para el resto (un rechazo de negocio va en `error.code`).
"""
import logging
import os
from dataclasses import dataclass
from typing import Callable

from contracts.actions import (ACCION_DESCONOCIDA, CONVERSACION_NO_ENCONTRADA, DATOS_INVALIDOS, ERROR_INTERNO,
                               NO_AUTORIZADO, ActionResponse)
from core import authz
from core.db import get_db

log = logging.getLogger(__name__)

SCOPES = ("org", "conversation")
LEVELS = ("write", "admin")

_STATUS = {NO_AUTORIZADO: 403, CONVERSACION_NO_ENCONTRADA: 404, ACCION_DESCONOCIDA: 404,
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
    requester: authz.Requester
    org_id: str
    conv_id: str | None = None
    conv: dict | None = None   # con `id`, para scope `conversation`


@dataclass
class UserAction:
    name: str
    handler: Callable[[UserContext, dict], dict | None]
    scope: str
    level: str


_REGISTRY: dict[str, UserAction] = {}


def declare(name: str, *, scope: str, level: str = "write"):
    """Decorador que registra el handler `handler(ctx, data) -> dict | None` de una acción de usuario."""
    if scope not in SCOPES or level not in LEVELS:
        raise ValueError(f"{name}: scope {scope!r} o level {level!r} inválido")

    def wrap(fn):
        if name in _REGISTRY:
            raise ValueError(f"la acción de usuario {name!r} ya está registrada")
        _REGISTRY[name] = UserAction(name, fn, scope, level)
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


def authenticate(headers, verifier=None) -> str | None:
    """`uid` del usuario que hace la petición, o None. Falla cerrado.

    `verifier(token) -> claims | None` es inyectable para las pruebas.
    """
    value = headers.get("Authorization") or ""
    token = value.removeprefix("Bearer ").strip() if value.startswith("Bearer ") else ""
    if not token:
        return None
    claims = (verifier or _firebase_verifier)(token)
    return (claims or {}).get("uid") or (claims or {}).get("sub") or None


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


def _locate(spec: UserAction, requester: authz.Requester, data: dict, db) -> UserContext | ActionResponse:
    """Ubica el recurso de la acción y comprueba el permiso. Devuelve el contexto o la respuesta de rechazo."""
    if spec.scope == "org":
        org_id = data.get("organizationId")
        if not isinstance(org_id, str) or not org_id:
            return ActionResponse.failure(DATOS_INVALIDOS, "Falta organizationId")
        if not authz.in_org(requester, org_id):
            return _denied()
        allowed = authz.is_admin_in(requester, org_id) if spec.level == "admin" else authz.can_write(requester)
        return UserContext(db, requester, org_id) if allowed else _denied()

    conv_id = data.get("conversationId")
    if not isinstance(conv_id, str) or not conv_id:
        return ActionResponse.failure(DATOS_INVALIDOS, "Falta conversationId")
    snap = db.collection("conversations").document(conv_id).get()
    conv = (snap.to_dict() or {}) if snap.exists else None
    # Quien no ve la conversación no debe saber si existe: mismo rechazo que un id inexistente.
    if conv is None or not authz.can_access_conversation(requester, conv):
        return ActionResponse.failure(CONVERSACION_NO_ENCONTRADA, "La conversación no existe")
    org_id = conv.get("organizationId")
    allowed = authz.is_admin_in(requester, org_id) if spec.level == "admin" else authz.can_act_on_conversation(requester, conv)
    if not allowed:
        return _denied()
    conv["id"] = conv_id
    return UserContext(db, requester, org_id, conv_id, conv)


def execute_user_action(uid: str, action: str, data: dict, db=None) -> ActionResponse:
    """Ejecuta `action` en nombre del usuario `uid` (ya autenticado). Nunca lanza."""
    db = db or get_db()
    spec = _REGISTRY.get(action)
    if spec is None:
        return ActionResponse.failure(ACCION_DESCONOCIDA, f"La acción {action!r} no existe")
    requester = authz.load_requester(db, uid)
    if requester is None:
        return _denied("Usuario no registrado")
    located = _locate(spec, requester, data, db)
    if isinstance(located, ActionResponse):
        return located
    try:
        return ActionResponse.success(spec.handler(located, data) or {})
    except UserActionError as e:
        return ActionResponse.failure(e.code, e.message, e.retryable)
    except Exception:
        log.exception("error en la acción de usuario %s", action)
        return ActionResponse.failure(ERROR_INTERNO, "No se pudo completar la operación", retryable=True)


def handle(headers, body, db=None, verifier=None) -> tuple[dict, int]:
    """Entrada HTTP: autentica, valida el cuerpo y ejecuta. Devuelve (cuerpo, estado)."""
    uid = authenticate(headers, verifier)
    if uid is None:
        return {"error": "Unauthorized"}, 401
    action = body.get("action") if isinstance(body, dict) else None
    data = body.get("data", {}) if isinstance(body, dict) else None
    if not isinstance(action, str) or not action or not isinstance(data, dict):
        return {"error": "Se esperaba {action: str, data: objeto}"}, 400
    response = execute_user_action(uid, action, data, db)
    return response.to_dict(), 200 if response.ok else _STATUS.get(response.error.code, 200)
