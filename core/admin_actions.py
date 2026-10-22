"""Acciones de usuario de administración (tarea 1.39): lo que las pantallas de equipos, números, bots,
plantillas, etiquetas, organizaciones y agentes escribían directo a Firestore.

Cada entidad se declara con una lista blanca de campos y sus tipos; de ella salen las acciones
`<entidad>.create`, `.update` y `.delete`. Todas piden administrador de la organización del recurso
(`core.user_actions` lo comprueba antes de llamar aquí), y la organización sale del documento, nunca de `data`.

    <entidad>.create   {organizationId, fields: {...}}          → {id}
    <entidad>.update   {id, set: {...}, unset: [campo, ...]}
    <entidad>.delete   {id}

    team · number (whatsappNumbers) · bot · template · label · organization (alta solo superadmin)
    member.set_role · member.set_availability · member.set_team · member.remove · member.set_primary_org · member.invite

Reglas comunes:
  - Un campo fuera de la lista blanca, o con tipo equivocado, se rechaza. Cambiar `organizationId` de un
    recurso (moverlo de marca) y los campos de plataforma de una organización son solo del superadmin.
  - Un teléfono puede repetirse en varios números, pero solo uno puede estar `active` a la vez.
  - Lo que el recurso referencia (equipo, bot, plantilla) debe ser de su misma organización.
  - Los cascos de borrado y reasignación que la pantalla hacía a mano (agentes y números de un equipo,
    conversaciones abiertas de un número) viven aquí.
"""
import html
import json
import logging
import os
from dataclasses import dataclass, field
from typing import Callable

from google.cloud import firestore

from contracts.actions import DATOS_INVALIDOS, NO_AUTORIZADO, PRECONDICION_FALLIDA
from core import authz, credentials, http
from core.conversations import resolve_vertical
from core.schema import BOT_TYPES, VERTICALS, assert_unique_brand_code
from core.user_actions import UserActionError, UserContext, declare

log = logging.getLogger(__name__)
MAX_BYTES = 200_000
OPEN_STATUSES = ["bot", "waiting_agent", "with_agent"]
BATCH_SIZE = 499
ROLES = ("admin", "agent", "viewer")
ROLE_LABELS = {"admin": "Administrador", "agent": "Agente", "viewer": "Observador"}
FALLBACK_APP_URL = "https://web-delta-three-35.vercel.app"
DEFAULT_INVITE_FROM = "usr.prd.sistemas@cleber.com"
LABEL_COLORS = ("red", "orange", "yellow", "green", "blue", "purple", "pink", "gray")
NUMBER_TEMPLATE_FIELDS = ("leadTemplateId", "followupOpeningTemplateId", "followupReminderTemplateId",
                          "followupClosingTemplateId", "scheduledContactTemplateId", "situationTemplateId")


@dataclass
class Entity:
    name: str
    collection: str
    fields: dict                          # campo → tipo (str, int, bool, dict, list) o tupla de valores permitidos
    required: tuple = ()                  # obligatorios al crear
    super_only: frozenset = frozenset()   # campos que solo cambia un superadmin
    create_only: frozenset = frozenset()  # campos que no se editan después de crear
    defaults: dict = field(default_factory=dict)
    ops: tuple = ("create", "update", "delete")
    secrets_kind: str | None = None       # "numbers" o "bots": sus credenciales van a `secrets`, no al documento (core/credentials.py)
    check: Callable | None = None         # check(ctx, fields, org_id, old) → valida y puede normalizar `fields`
    after_update: Callable | None = None  # after_update(ctx, fields, old)
    before_delete: Callable | None = None


# --------------------------------------------------------------------------- validación

def _fits(kind, value) -> bool:
    if isinstance(kind, tuple):
        return value in kind
    if kind is int:
        return isinstance(value, int) and not isinstance(value, bool)
    return isinstance(value, kind)


def _clean(entity: Entity, raw, requester: authz.Requester, creating: bool) -> dict:
    if not isinstance(raw, dict):
        raise UserActionError(DATOS_INVALIDOS, "Se esperaba un objeto con los campos")
    out = {}
    for key, value in raw.items():
        kind = entity.fields.get(key)
        if kind is None or (key in entity.create_only and not creating):
            raise UserActionError(DATOS_INVALIDOS, f"El campo {key!r} no se puede escribir en {entity.name}")
        if key in entity.super_only and not requester.is_super_admin:
            raise UserActionError(NO_AUTORIZADO, f"Solo un superadmin puede cambiar {key!r}")
        if value is not None and not _fits(kind, value):
            raise UserActionError(DATOS_INVALIDOS, f"Valor inválido para {key!r}")
        out[key] = value
    if len(json.dumps(out, default=str)) > MAX_BYTES:
        raise UserActionError(DATOS_INVALIDOS, "Los datos son demasiado grandes")
    return out


def _clean_unset(entity: Entity, raw, requester: authz.Requester) -> list:
    if raw is None:
        return []
    if not isinstance(raw, list) or not all(isinstance(k, str) for k in raw):
        raise UserActionError(DATOS_INVALIDOS, "unset debe ser una lista de campos")
    _clean(entity, {k: None for k in raw}, requester, creating=False)  # misma lista blanca y mismos permisos
    return raw


def _ref_in_org(ctx: UserContext, collection: str, doc_id, what: str, org_id: str) -> None:
    """`doc_id` (si lo hay) debe existir en `collection` y ser de la organización `org_id`."""
    if doc_id is None:
        return
    snap = ctx.db.collection(collection).document(doc_id).get()
    if not snap.exists or (snap.to_dict() or {}).get("organizationId") != org_id:
        raise UserActionError(DATOS_INVALIDOS, f"{what} no existe en esta organización")


def _org_members(db, org_id: str) -> dict:
    """Usuarios de la organización, en formato nuevo (`organizationIds`) y legado (`organizationId`)."""
    found = {}
    for query in (db.collection("users").where("organizationIds", "array_contains", org_id),
                  db.collection("users").where("organizationId", "==", org_id)):
        for snap in query.stream():
            found[snap.id] = snap
    return found


# --------------------------------------------------------------------------- entidades

def _check_team(ctx, fields, org_id, old):
    if "maxConversationsPerAgent" in fields and fields["maxConversationsPerAgent"] is not None \
            and fields["maxConversationsPerAgent"] <= 0:
        raise UserActionError(DATOS_INVALIDOS, "maxConversationsPerAgent debe ser mayor a 0")
    sem = fields.get("semaphoreThresholds")
    if sem is not None:
        yellow, red = sem.get("yellowMinutes"), sem.get("redMinutes")
        if not all(_fits(int, v) for v in (yellow, red)) or not 0 < yellow < red:
            raise UserActionError(DATOS_INVALIDOS, "El tiempo amarillo debe ser menor al rojo y ambos mayores a 0")


def _unlink_team(ctx: UserContext, team_id: str) -> None:
    """Un equipo borrado deja a sus agentes y números sin equipo."""
    org = ctx.org_id
    for snap in _org_members(ctx.db, org).values():
        user = snap.to_dict() or {}
        updates = {}
        if (user.get("orgTeams") or {}).get(org) == team_id:
            updates[f"orgTeams.{org}"] = firestore.DELETE_FIELD
        if user.get("teamId") == team_id:
            updates["teamId"] = None
        if updates:
            snap.reference.update(updates)
    for snap in ctx.db.collection("whatsappNumbers").where("organizationId", "==", org).where("teamId", "==", team_id).stream():
        snap.reference.update({"teamId": None})


def _check_single_active(ctx: UserContext, fields: dict, old: dict | None) -> None:
    """Un teléfono puede estar dado de alta varias veces, pero activo en un solo lugar.

    El webhook resuelve el número por teléfono entre los `active`: dos activos chocan en silencio.
    Solo se revisa cuando la escritura cambia el teléfono o el estado, para no bloquear la edición de
    otros campos de un número que ya estaba en conflicto.
    """
    if old is not None and "phoneNumber" not in fields and "status" not in fields:
        return
    phone = fields.get("phoneNumber") or (old or {}).get("phoneNumber")
    status = fields.get("status", (old or {}).get("status") if old is not None else "active")
    if not phone or status != "active":
        return
    query = ctx.db.collection("whatsappNumbers").where("phoneNumber", "==", phone).where("status", "==", "active")
    if any(snap.id != ctx.doc_id for snap in query.limit(2).stream()):
        raise UserActionError(DATOS_INVALIDOS, f"El número {phone} ya está activo en otro registro; desactívalo antes")


def _check_number(ctx, fields, org_id, old):
    if fields.get("phoneNumber"):
        phone = fields["phoneNumber"].strip()
        phone = phone if phone.startswith("whatsapp:") else f"whatsapp:{phone}"
        fields["phoneNumber"] = phone
    _check_single_active(ctx, fields, old)
    _ref_in_org(ctx, "teams", fields.get("teamId"), "El equipo", org_id)
    _ref_in_org(ctx, "bots", fields.get("defaultBotId"), "El bot", org_id)
    for key in NUMBER_TEMPLATE_FIELDS:
        _ref_in_org(ctx, "templates", fields.get(key), "La plantilla", org_id)
    for key in ("reopenWindowHours", "inactivityCloseHours"):
        if fields.get(key) is not None and fields[key] <= 0:
            raise UserActionError(DATOS_INVALIDOS, f"{key} debe ser mayor a 0")


def _after_number_update(ctx: UserContext, fields: dict, old: dict) -> None:
    """Al cambiar de equipo, sus conversaciones abiertas se van con él (y su vertical)."""
    team_id = fields.get("teamId")
    if not team_id or team_id == old.get("teamId"):
        return
    updates = {"teamId": team_id}
    vertical = resolve_vertical(ctx.db, team_id, None)
    if vertical:
        updates["vertical"] = vertical
    query = ctx.db.collection("conversations").where("whatsappNumberId", "==", ctx.doc_id).where("status", "in", OPEN_STATUSES)
    batch, pending = ctx.db.batch(), 0
    for snap in query.stream():
        batch.update(snap.reference, updates)
        pending += 1
        if pending % BATCH_SIZE == 0:
            batch.commit()
            batch = ctx.db.batch()
    if pending % BATCH_SIZE:
        batch.commit()


def _check_label(ctx, fields, org_id, old):
    _ref_in_org(ctx, "teams", fields.get("teamId"), "El equipo", org_id)


ENTITIES = [
    Entity("team", "teams",
           fields={"name": str, "description": str, "assignmentMode": ("round_robin", "least_busy", "manual", "salesforce"),
                   "maxConversationsPerAgent": int, "optOutAction": ("close", "handoff"), "vertical": VERTICALS,
                   "status": ("active", "inactive"), "semaphoreThresholds": dict, "organizationId": str},
           required=("name", "vertical"), super_only=frozenset({"organizationId"}),
           defaults={"description": "", "activeConversations": 0, "status": "active"},
           check=_check_team, before_delete=lambda ctx: _unlink_team(ctx, ctx.doc_id)),
    Entity("number", "whatsappNumbers",
           fields={"phoneNumber": str, "displayName": str, "provider": ("twilio", "valuetext", "meta"), "teamId": str,
                   "defaultBotId": str, "status": ("active", "inactive"), "reopenWindowHours": int,
                   "closeWebhookUrl": str, "inactivityCloseHours": int, "organizationId": str,
                   "twilioAccountSid": str, "twilioAuthToken": str, "serviceHandoffContentSid": str,
                   "valuetextSenderId": str, **{k: str for k in NUMBER_TEMPLATE_FIELDS},
                   "metaPhoneNumberId": str, "metaAccessToken": str, "metaWebhookVerifyToken": str,
                   "serviceHandoffTemplateName": str, "serviceHandoffTemplateLanguage": str},
           required=("phoneNumber", "provider"), super_only=frozenset({"organizationId"}),
           defaults={"status": "active"}, check=_check_number, after_update=_after_number_update, secrets_kind="numbers"),
    Entity("bot", "bots",
           fields={"name": str, "description": str, "type": BOT_TYPES, "vertical": VERTICALS, "category": str,
                   "status": ("active", "paused"), "organizationId": str, "twilioConfig": dict, "abacusConfig": dict,
                   "vertexAiConfig": dict, "externalConfig": dict, "handoffConfig": dict, "inactivityConfig": dict,
                   "scheduleConfig": dict, "situationRouting": dict, "optOutAction": ("close", "handoff"),
                   "tools": list, "outcomeActions": list, "broadcastResponseCounters": dict, "injectPhoneContext": bool},
           required=("name", "type", "vertical"), super_only=frozenset({"organizationId"}),
           defaults={"description": "", "status": "active"}, ops=("create", "update"), secrets_kind="bots"),
    Entity("template", "templates",
           fields={"name": str, "content": str, "category": str, "vertical": VERTICALS},
           required=("name", "content")),
    Entity("label", "labels",
           fields={"name": str, "color": LABEL_COLORS, "teamId": str},
           required=("name", "color", "teamId"), create_only=frozenset({"teamId"}), check=_check_label),
]


# --------------------------------------------------------------------------- acciones genéricas

def _create(entity: Entity):
    def handler(ctx: UserContext, data: dict) -> dict:
        fields = _clean(entity, data.get("fields"), ctx.requester, creating=True)
        fields.pop("organizationId", None)  # el alta es siempre en la organización de la acción
        missing = [k for k in entity.required if fields.get(k) in (None, "") or (isinstance(fields[k], str) and not fields[k].strip())]
        if missing:
            raise UserActionError(DATOS_INVALIDOS, f"Faltan campos: {', '.join(missing)}")
        new_secrets = {}
        if entity.secrets_kind:
            fields, new_secrets = credentials.split(entity.secrets_kind, fields)
        if entity.check:
            entity.check(ctx, fields, ctx.org_id, None)
        doc = {**entity.defaults, **fields, "organizationId": ctx.org_id, "createdAt": firestore.SERVER_TIMESTAMP}
        if entity.name == "number":
            doc.setdefault("displayName", doc["phoneNumber"])
        if entity.secrets_kind:
            doc["secretsSet"] = sorted(new_secrets)
        ref = ctx.db.collection(entity.collection).document()
        ref.set(doc)
        if new_secrets:   # después del documento: sin él, la credencial quedaría huérfana si el alta falla
            credentials.store(ctx.db, entity.secrets_kind, ref.id, new_secrets)
        return {"id": ref.id}
    return handler


def _update(entity: Entity):
    def handler(ctx: UserContext, data: dict) -> dict:
        sets = _clean(entity, data.get("set") or {}, ctx.requester, creating=False)
        unset = _clean_unset(entity, data.get("unset"), ctx.requester)
        if not sets and not unset:
            raise UserActionError(DATOS_INVALIDOS, "No hay nada que cambiar")
        if set(sets) & set(unset):
            raise UserActionError(DATOS_INVALIDOS, "Un campo no puede estar en set y en unset")
        for key in entity.required:
            if key in sets and (sets[key] is None or (isinstance(sets[key], str) and not sets[key].strip())):
                raise UserActionError(DATOS_INVALIDOS, f"{key} no puede quedar vacío")
        new_secrets, cleared = {}, []
        if entity.secrets_kind:
            sets, new_secrets = credentials.split(entity.secrets_kind, sets)
            cleared = [k for k in unset if k in credentials.paths(entity.secrets_kind)]
            unset = [k for k in unset if k not in cleared]
        org_id = ctx.org_id
        if sets.get("organizationId"):
            org_id = sets["organizationId"]
            if not ctx.db.collection("organizations").document(org_id).get().exists:
                raise UserActionError(DATOS_INVALIDOS, "La organización destino no existe")
        if entity.check:
            entity.check(ctx, sets, org_id, ctx.doc)
        updates = {**sets, **{k: firestore.DELETE_FIELD for k in unset}}
        if new_secrets or cleared:
            credentials.clear(ctx.db, entity.secrets_kind, ctx.doc_id, cleared)
            credentials.store(ctx.db, entity.secrets_kind, ctx.doc_id, new_secrets)
            updates["secretsSet"] = sorted(credentials.load(ctx.db, entity.secrets_kind, ctx.doc_id, use_cache=False))
        if updates:   # puede quedar vacío si solo llegaron credenciales vacías: nada que cambiar
            ctx.db.collection(entity.collection).document(ctx.doc_id).update(updates)
        if entity.after_update:
            entity.after_update(ctx, sets, ctx.doc)
        return {"id": ctx.doc_id}
    return handler


def _delete(entity: Entity):
    def handler(ctx: UserContext, data: dict) -> dict:
        if entity.before_delete:
            entity.before_delete(ctx)
        ctx.db.collection(entity.collection).document(ctx.doc_id).delete()
        if entity.secrets_kind:
            credentials.delete(ctx.db, entity.secrets_kind, ctx.doc_id)
        return {"id": ctx.doc_id}
    return handler


def register_entities() -> None:
    for entity in ENTITIES:
        if "create" in entity.ops:
            declare(f"{entity.name}.create", scope="org", level="admin")(_create(entity))
        if "update" in entity.ops:
            declare(f"{entity.name}.update", scope="doc", level="admin", collection=entity.collection)(_update(entity))
        if "delete" in entity.ops:
            declare(f"{entity.name}.delete", scope="doc", level="admin", collection=entity.collection)(_delete(entity))


# --------------------------------------------------------------------------- organizaciones

ORG_FIELDS = {"name": str, "settings.timezone": str, "salesforceConfig": dict, "salesforceConfig.vehicleType": str,
              "sfBrandCode": str, "sfCalendario": str, "plan": str, "settings": dict}
ORG_SUPER_ONLY = frozenset({"salesforceConfig.vehicleType", "sfBrandCode", "sfCalendario", "plan", "settings"})
ORGANIZATION = Entity("organization", "organizations", fields=ORG_FIELDS, required=("name",), super_only=ORG_SUPER_ONLY)


def _check_org(ctx: UserContext, fields: dict, org_id: str | None) -> None:
    if "salesforceConfig" in fields and "salesforceConfig.vehicleType" in fields:
        raise UserActionError(DATOS_INVALIDOS, "salesforceConfig y salesforceConfig.vehicleType chocan en la misma escritura")
    code = fields.get("sfBrandCode")
    if code:
        try:
            assert_unique_brand_code(ctx.db, code, org_id or "")
        except ValueError as e:
            raise UserActionError(DATOS_INVALIDOS, str(e))


@declare("organization.create", scope="global", level="super")
def organization_create(ctx: UserContext, data: dict) -> dict:
    fields = _clean(ORGANIZATION, data.get("fields"), ctx.requester, creating=True)
    if not (fields.get("name") or "").strip():
        raise UserActionError(DATOS_INVALIDOS, "Falta name")
    _check_org(ctx, fields, None)
    ref = ctx.db.collection("organizations").document()
    ref.set({"plan": "enterprise", "settings": {"timezone": "America/Mexico_City"}, **fields,
             "createdAt": firestore.SERVER_TIMESTAMP})
    return {"id": ref.id}


@declare("organization.update", scope="doc", level="admin", collection="organizations")
def organization_update(ctx: UserContext, data: dict) -> dict:
    sets = _clean(ORGANIZATION, data.get("set") or {}, ctx.requester, creating=False)
    if not sets:
        raise UserActionError(DATOS_INVALIDOS, "No hay nada que cambiar")
    if "name" in sets and not (sets["name"] or "").strip():
        raise UserActionError(DATOS_INVALIDOS, "name no puede quedar vacío")
    _check_org(ctx, sets, ctx.doc_id)
    ctx.db.collection("organizations").document(ctx.doc_id).update(sets)
    return {"id": ctx.doc_id}


# --------------------------------------------------------------------------- agentes (usuarios de la organización)

def _target(ctx: UserContext, data: dict) -> tuple:
    """Usuario objetivo `userId`: debe pertenecer a la organización, y solo un superadmin toca a otro."""
    user_id = data.get("userId")
    if not isinstance(user_id, str) or not user_id:
        raise UserActionError(DATOS_INVALIDOS, "Falta userId")
    snap = ctx.db.collection("users").document(user_id).get()
    target = authz.load_requester(ctx.db, user_id) if snap.exists else None
    if target is None or not authz.in_org(target, ctx.org_id):
        raise UserActionError(DATOS_INVALIDOS, "El usuario no pertenece a esta organización")
    if target.is_super_admin and not ctx.requester.is_super_admin:
        raise UserActionError(NO_AUTORIZADO, "Solo un superadmin puede modificar a un superadmin")
    return snap.reference, snap.to_dict() or {}


@declare("member.set_role", scope="org", level="admin")
def member_set_role(ctx: UserContext, data: dict) -> dict:
    role = data.get("role")
    if role not in ROLES:
        raise UserActionError(DATOS_INVALIDOS, f"role debe ser uno de {', '.join(ROLES)}")
    ref, _ = _target(ctx, data)
    ref.update({"role": role})
    return {"role": role}


@declare("member.set_availability", scope="org", level="admin")
def member_set_availability(ctx: UserContext, data: dict) -> dict:
    available = data.get("available")
    if not isinstance(available, bool):
        raise UserActionError(DATOS_INVALIDOS, "available debe ser true o false")
    ref, _ = _target(ctx, data)
    ref.update({"isAvailable": available})
    return {"isAvailable": available}


@declare("member.set_team", scope="org", level="admin")
def member_set_team(ctx: UserContext, data: dict) -> dict:
    """Equipo del agente en esta organización (`orgTeams`), y el `teamId` legado si esta es su organización principal."""
    team_id = data.get("teamId")
    if team_id is not None and (not isinstance(team_id, str) or not team_id):
        raise UserActionError(DATOS_INVALIDOS, "teamId inválido")
    _ref_in_org(ctx, "teams", team_id, "El equipo", ctx.org_id)
    ref, user = _target(ctx, data)
    updates = {f"orgTeams.{ctx.org_id}": team_id if team_id else firestore.DELETE_FIELD}
    if user.get("organizationId") == ctx.org_id:
        updates["teamId"] = team_id
    ref.update(updates)
    return {"teamId": team_id}


@declare("member.remove", scope="org", level="admin")
def member_remove(ctx: UserContext, data: dict) -> dict:
    ref, user = _target(ctx, data)
    org = ctx.org_id
    updates = {"organizationIds": firestore.ArrayRemove([org]), f"orgTeams.{org}": firestore.DELETE_FIELD}
    # Si era su organización principal (campo legado) hay que reasignarla o limpiarla: si no, las consultas
    # por `organizationId` lo seguirían mostrando como miembro.
    if user.get("organizationId") == org:
        remaining = next((o for o in (user.get("organizationIds") or []) if o != org), None)
        updates["organizationId"] = remaining
        updates["teamId"] = (user.get("orgTeams") or {}).get(remaining) if remaining else None
    ref.update(updates)
    return {"removed": True}


@declare("member.set_primary_org", scope="org", level="super")
def member_set_primary_org(ctx: UserContext, data: dict) -> dict:
    """Organización principal del usuario (solo superadmin): la agrega a sus organizaciones si no estaba."""
    user_id = data.get("userId")
    if not isinstance(user_id, str) or not user_id:
        raise UserActionError(DATOS_INVALIDOS, "Falta userId")
    snap = ctx.db.collection("users").document(user_id).get()
    if not snap.exists:
        raise UserActionError(DATOS_INVALIDOS, "El usuario no existe")
    if not ctx.db.collection("organizations").document(ctx.org_id).get().exists:
        raise UserActionError(PRECONDICION_FALLIDA, "La organización no existe")
    snap.reference.update({"organizationId": ctx.org_id, "organizationIds": firestore.ArrayUnion([ctx.org_id])})
    return {"organizationId": ctx.org_id}


register_entities()


# --------------------------------------------------------------------------- invitaciones

def _org_ids(user: dict) -> list:
    return list(user.get("organizationIds") or ([user["organizationId"]] if user.get("organizationId") else []))


def _send_invite_email(ctx: UserContext, email: str, role: str) -> bool:
    """Correo de invitación por el webhook de correo (`INVITE_EMAIL_WEBHOOK_URL`). Un fallo no deshace la invitación."""
    url = os.environ.get("INVITE_EMAIL_WEBHOOK_URL")
    if not url:
        log.warning("INVITE_EMAIL_WEBHOOK_URL sin configurar: la invitación a %s no se envió por correo", email)
        return False
    org = ctx.db.collection("organizations").document(ctx.org_id).get().to_dict() or {}
    org_name = html.escape(org.get("name") or ctx.org_id)
    app_url = ctx.origin or os.environ.get("APP_URL", "").strip().rstrip("/") or FALLBACK_APP_URL  # el origen ya viene validado
    content = (
        '<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">'
        "<h2>Has sido invitado a la plataforma</h2>"
        f"<p>Un administrador te ha invitado a unirte al equipo de <strong>{org_name}</strong> como "
        f"<strong>{ROLE_LABELS[role]}</strong>.</p><p>Haz clic en el siguiente enlace para acceder:</p>"
        f'<a href="{html.escape(app_url)}" style="display: inline-block; padding: 12px 24px; background-color: #000; '
        'color: #fff; text-decoration: none; border-radius: 6px; margin: 16px 0;">Acceder a la plataforma</a>'
        f'<p style="color: #666; font-size: 14px;">Inicia sesión con tu cuenta de Google asociada a <strong>{html.escape(email)}</strong>.</p></div>'
    )
    body = json.dumps({"to": email, "from": os.environ.get("INVITE_EMAIL_FROM", DEFAULT_INVITE_FROM),
                       "subject": f"Invitación a la plataforma de Conversaciones — {org_name}", "content": content}).encode("utf-8")
    try:
        http.request(url, body, {"Content-Type": "application/json"}, timeout=15)
        return True
    except Exception as e:
        log.error("No se pudo enviar el correo de invitación a %s: %s", email, e)
        return False


@declare("member.invite", scope="org", level="admin")
def member_invite(ctx: UserContext, data: dict) -> dict:
    """Invita por email a la organización. El alta real ocurre en el primer inicio de sesión (`me.claim_invite`)."""
    raw = data.get("email")
    email = raw.strip().lower() if isinstance(raw, str) else ""
    role = data.get("role")
    if "@" not in email or role not in ROLES:
        raise UserActionError(DATOS_INVALIDOS, f"Se requiere un email válido y un role ({', '.join(ROLES)})")
    team_id = data.get("teamId") or None
    if team_id is not None and not isinstance(team_id, str):
        raise UserActionError(DATOS_INVALIDOS, "teamId inválido")
    _ref_in_org(ctx, "teams", team_id, "El equipo", ctx.org_id)

    org, uid = ctx.org_id, ctx.requester.uid
    found = {}
    for candidate in dict.fromkeys([raw.strip(), email]):  # los documentos viejos pueden traer el email con mayúsculas
        for snap in ctx.db.collection("users").where("email", "==", candidate).stream():
            found[snap.id] = snap
    member = next((s for s in found.values() if org in _org_ids(s.to_dict() or {})), None)
    team_update = {"teamId": team_id, f"orgTeams.{org}": team_id} if team_id else {}

    if member is not None:
        existing = member.to_dict() or {}
        if existing.get("lastLoginAt") is not None:
            raise UserActionError(PRECONDICION_FALLIDA, "Ya existe un usuario activo con este email en la organización")
        if existing.get("isSuperAdmin") and not ctx.requester.is_super_admin:
            raise UserActionError(NO_AUTORIZADO, "Solo un superadmin puede modificar a un superadmin")
        member.reference.update({"role": role, "invitedBy": uid, **team_update})  # pre-registrado: se actualiza el rol
    elif found:
        # Ya existe en otra organización: se agrega esta. El rol es global en el usuario, así que solo un
        # superadmin lo cambia; si no, un admin de una marca podría ascender a alguien en las demás.
        snap = next(iter(found.values()))
        existing = snap.to_dict() or {}
        if existing.get("isSuperAdmin") and not ctx.requester.is_super_admin:
            raise UserActionError(NO_AUTORIZADO, "Solo un superadmin puede modificar a un superadmin")
        updates = {"organizationIds": firestore.ArrayUnion(list(dict.fromkeys([*_org_ids(existing), org]))),
                   "invitedBy": uid, **team_update}
        if ctx.requester.is_super_admin:
            updates["role"] = role
        snap.reference.update(updates)
        role = updates.get("role", existing.get("role") or role)
    else:
        ref = ctx.db.collection("users").document()
        ref.set({"id": ref.id, "email": email, "name": "", "role": role, "organizationId": org, "organizationIds": [org],
                 "teamId": team_id, "orgTeams": {org: team_id} if team_id else {}, "status": "offline", "photoURL": None,
                 "createdAt": firestore.SERVER_TIMESTAMP, "lastLoginAt": None, "invitedBy": uid})
    return {"emailSent": _send_invite_email(ctx, email, role)}
