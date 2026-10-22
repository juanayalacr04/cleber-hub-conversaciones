"""Acciones del propio usuario (tarea 1.39): inicio y cierre de sesión del dashboard.

Antes `AuthContext.tsx` escribía su documento de `users` directo desde el navegador, incluido el alta con el
rol que el cliente quisiera. Ahora la función 2 decide, con la identidad del token:

    me.claim_invite   El primer inicio de sesión de alguien invitado: convierte el documento pre-registrado
                      por email (lo creó `api/invite`) en `users/{uid}` y borra el original. Exige el email
                      verificado del token y que exista la invitación; nada de esto sale del cliente.
    me.sign_in        Última conexión y estado `online`
    me.sign_out       Estado `offline`

Son del scope `identity`: bastan el token y, salvo el reclamo, un usuario ya registrado.
"""
from datetime import datetime, timezone

from google.cloud import firestore

from contracts.actions import NO_AUTORIZADO
from core.user_actions import UserActionError, UserContext, declare


def _registered(ctx: UserContext) -> str:
    if ctx.requester is None:
        raise UserActionError(NO_AUTORIZADO, "Usuario no registrado")
    return ctx.requester.uid


@declare("me.claim_invite", scope="identity", level=None)
def claim_invite(ctx: UserContext, data: dict) -> dict:
    claims = ctx.claims or {}
    uid, email = claims["uid"], claims.get("email")
    if ctx.requester is not None:  # ya reclamada (otra pestaña, un reintento)
        return {"claimed": False}
    if not email or claims.get("email_verified") is not True:
        raise UserActionError(NO_AUTORIZADO, "El correo de la cuenta no está verificado")

    users = ctx.db.collection("users")
    invited = None
    for candidate in dict.fromkeys([email, email.lower()]):
        invited = next(iter(users.where("email", "==", candidate).limit(1).stream()), None)
        if invited is not None:
            break
    if invited is None:
        raise UserActionError(NO_AUTORIZADO, "No tienes una invitación a la plataforma")

    old = invited.to_dict() or {}
    now = datetime.now(timezone.utc)
    claimed = {
        **old, "id": uid, "name": claims.get("name") or old.get("name") or "",
        "photoURL": claims.get("picture") or old.get("photoURL"), "status": "online", "lastLoginAt": now,
    }
    if not claimed.get("organizationIds"):  # documentos en formato viejo: nacen con los campos multi-organización
        org_id, team_id = claimed.get("organizationId"), claimed.get("teamId")
        claimed["organizationIds"] = [org_id] if org_id else []
        claimed["orgTeams"] = {org_id: team_id} if org_id and team_id else {}

    batch = ctx.db.batch()
    batch.set(users.document(uid), claimed)
    if invited.id != uid:
        batch.delete(invited.reference)
    batch.commit()
    return {"claimed": True}


@declare("me.sign_in", scope="identity", level=None)
def sign_in(ctx: UserContext, data: dict) -> dict:
    uid = _registered(ctx)
    ctx.db.collection("users").document(uid).update({"lastLoginAt": firestore.SERVER_TIMESTAMP, "status": "online"})
    return {"status": "online"}


@declare("me.sign_out", scope="identity", level=None)
def sign_out(ctx: UserContext, data: dict) -> dict:
    uid = _registered(ctx)
    ctx.db.collection("users").document(uid).update({"status": "offline"})
    return {"status": "offline"}
