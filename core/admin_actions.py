"""Acciones de usuario de administración (tarea 1.39): lo que las pantallas de equipos, números, bots,
plantillas, etiquetas, organizaciones y agentes escribían directo a Firestore.

Cada entidad se declara con una lista blanca de campos y sus tipos; de ella salen las acciones
`<entidad>.create`, `.update` y `.delete`. Todas piden administrador de la organización del recurso
(`core.user_actions` lo comprueba antes de llamar aquí), y la organización sale del documento, nunca de `data`.

    <entidad>.create   {organizationId, fields: {...}}          → {id}
    <entidad>.update   {id, set: {...}, unset: [campo, ...]}
    <entidad>.delete   {id}

    team · number (whatsappNumbers) · bot · template · label · organization (alta solo superadmin)
    member.set_role · member.set_availability · member.set_team · member.remove · member.set_primary_org

Reglas comunes:
  - Un campo fuera de la lista blanca, o con tipo equivocado, se rechaza. Cambiar `organizationId` de un
    recurso (moverlo de marca) y los campos de plataforma de una organización son solo del superadmin.
  - Lo que el recurso referencia (equipo, bot, plantilla) debe ser de su misma organización.
  - Los cascos de borrado y reasignación que la pantalla hacía a mano (agentes y números de un equipo,
    conversaciones abiertas de un número) viven aquí.
"""
import json
from dataclasses import dataclass, field
from typing import Callable

from google.cloud import firestore

from contracts.actions import DATOS_INVALIDOS, NO_AUTORIZADO, PRECONDICION_FALLIDA
from core import authz
from core.conversations import resolve_vertical
from core.schema import BOT_TYPES, VERTICALS, assert_unique_brand_code
from core.user_actions import UserActionError, UserContext, declare

MAX_BYTES = 200_000
OPEN_STATUSES = ["bot", "waiting_agent", "with_agent"]
BATCH_SIZE = 499
ROLES = ("admin", "agent", "viewer")
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


def _check_number(ctx, fields, org_id, old):
    if fields.get("phoneNumber"):
        phone = fields["phoneNumber"].strip()
        phone = phone if phone.startswith("whatsapp:") else f"whatsapp:{phone}"
        fields["phoneNumber"] = phone
        # El webhook resuelve el número por teléfono: dos documentos con el mismo número chocan en silencio
        for snap in ctx.db.collection("whatsappNumbers").where("phoneNumber", "==", phone).limit(2).stream():
            if snap.id != ctx.doc_id:
                raise UserActionError(DATOS_INVALIDOS, f"El número {phone} ya está dado de alta")
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
           defaults={"status": "active"}, check=_check_number, after_update=_after_number_update),
    Entity("bot", "bots",
           fields={"name": str, "description": str, "type": BOT_TYPES, "vertical": VERTICALS, "category": str,
                   "status": ("active", "paused"), "organizationId": str, "twilioConfig": dict, "abacusConfig": dict,
                   "vertexAiConfig": dict, "externalConfig": dict, "handoffConfig": dict, "inactivityConfig": dict,
                   "scheduleConfig": dict, "situationRouting": dict, "optOutAction": ("close", "handoff"),
                   "tools": list, "outcomeActions": list, "broadcastResponseCounters": dict, "injectPhoneContext": bool},
           required=("name", "type", "vertical"), super_only=frozenset({"organizationId"}),
           defaults={"description": "", "status": "active"}, ops=("create", "update")),
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
        if entity.check:
            entity.check(ctx, fields, ctx.org_id, None)
        doc = {**entity.defaults, **fields, "organizationId": ctx.org_id, "createdAt": firestore.SERVER_TIMESTAMP}
        if entity.name == "number":
            doc.setdefault("displayName", doc["phoneNumber"])
        ref = ctx.db.collection(entity.collection).document()
        ref.set(doc)
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
        org_id = ctx.org_id
        if sets.get("organizationId"):
            org_id = sets["organizationId"]
            if not ctx.db.collection("organizations").document(org_id).get().exists:
                raise UserActionError(DATOS_INVALIDOS, "La organización destino no existe")
        if entity.check:
            entity.check(ctx, sets, org_id, ctx.doc)
        ctx.db.collection(entity.collection).document(ctx.doc_id).update({**sets, **{k: firestore.DELETE_FIELD for k in unset}})
        if entity.after_update:
            entity.after_update(ctx, sets, ctx.doc)
        return {"id": ctx.doc_id}
    return handler


def _delete(entity: Entity):
    def handler(ctx: UserContext, data: dict) -> dict:
        if entity.before_delete:
            entity.before_delete(ctx)
        ctx.db.collection(entity.collection).document(ctx.doc_id).delete()
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
