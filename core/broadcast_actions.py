"""Alta de campañas desde el dashboard (tarea 1.39): lo que `campanas/new` escribía directo a Firestore.

    broadcast.create   write   {organizationId, fields: {...}, recipients: [{phone, name?, variables?, salesforceRecordId?}]}
                               → {id}

El servidor pone lo que el cliente no decide: `id`, organización, estado `draft`, contadores en cero, autor
(del token), fecha y total de destinatarios. El módulo (`vertical`) se deriva del equipo del número de WhatsApp,
o del bot como respaldo, y solo si no sale de ahí se acepta el que manda la pantalla. El envío, los reintentos
y la verificación de entregas (`api/broadcasts/*`) siguen en el dashboard y migran en otra tarea.
"""
import re

from google.cloud import firestore

from contracts.actions import DATOS_INVALIDOS, ERROR_INTERNO
from core.admin_actions import Entity, _clean, _ref_in_org
from core.schema import VERTICALS
from core.user_actions import UserActionError, UserContext, declare

MAX_RECIPIENTS = 10_000
BATCH_SIZE = 500
PHONE_RE = re.compile(r"^\+\d{8,15}$")
TYPES = ("manual", "appointment_reminder", "no_show")

BROADCAST = Entity(
    "broadcast", "broadcasts",
    fields={"name": str, "whatsappNumberId": str, "botId": str, "templateName": str, "templateBody": str,
            "templateLanguage": str, "templateComponents": list, "contentSid": str, "valuetextObjectApi": str,
            "variableMapping": list, "botInstructions": str, "type": TYPES, "reminderConfig": dict, "vertical": VERTICALS},
    required=("name", "whatsappNumberId", "botId", "templateName"),
)


def _recipients(raw, needed: bool) -> list:
    """Destinatarios validados y con el teléfono normalizado a `+dígitos`."""
    if raw is None:
        raw = []
    if not isinstance(raw, list) or len(raw) > MAX_RECIPIENTS:
        raise UserActionError(DATOS_INVALIDOS, f"recipients debe ser una lista de hasta {MAX_RECIPIENTS} destinatarios")
    if needed and not raw:
        raise UserActionError(DATOS_INVALIDOS, "Una campaña manual necesita al menos un destinatario")
    out = []
    for i, r in enumerate(raw, start=1):
        phone = r.get("phone") if isinstance(r, dict) else None
        phone = ("+" + phone.strip().lstrip("+")) if isinstance(phone, str) else ""
        if not PHONE_RE.match(phone):
            raise UserActionError(DATOS_INVALIDOS, f"Teléfono inválido en el destinatario {i}")
        name, variables, record = r.get("name"), r.get("variables"), r.get("salesforceRecordId")
        if (name is not None and not isinstance(name, str)) or (variables is not None and not isinstance(variables, dict)) \
                or (record is not None and not isinstance(record, str)):
            raise UserActionError(DATOS_INVALIDOS, f"Datos inválidos en el destinatario {i}")
        out.append({"phone": phone, "name": name or None, "variables": variables or None, "salesforceRecordId": record or None})
    return out


def _derive_vertical(ctx: UserContext, number: dict, bot: dict) -> str | None:
    team_id = number.get("teamId")
    if team_id:
        team = ctx.db.collection("teams").document(team_id).get().to_dict() or {}
        if team.get("vertical") in VERTICALS:
            return team["vertical"]
    category = bot.get("category").lower() if isinstance(bot.get("category"), str) else ""
    if bot.get("vertical") in VERTICALS:
        return bot["vertical"]
    return category if category in VERTICALS else None


@declare("broadcast.create", scope="org")
def create(ctx: UserContext, data: dict) -> dict:
    fields = _clean(BROADCAST, data.get("fields"), ctx.requester, creating=True)
    missing = [k for k in BROADCAST.required if not isinstance(fields.get(k), str) or not fields[k].strip()]
    if missing:
        raise UserActionError(DATOS_INVALIDOS, f"Faltan campos: {', '.join(missing)}")
    kind = fields.get("type", "manual")
    recipients = _recipients(data.get("recipients"), needed=kind == "manual")
    if kind != "manual" and recipients:
        raise UserActionError(DATOS_INVALIDOS, "Las campañas de recordatorio no llevan destinatarios: salen de Salesforce")

    _ref_in_org(ctx, "whatsappNumbers", fields["whatsappNumberId"], "El número de WhatsApp", ctx.org_id)
    _ref_in_org(ctx, "bots", fields["botId"], "El bot", ctx.org_id)
    number = ctx.db.collection("whatsappNumbers").document(fields["whatsappNumberId"]).get().to_dict() or {}
    bot = ctx.db.collection("bots").document(fields["botId"]).get().to_dict() or {}
    vertical = _derive_vertical(ctx, number, bot) or fields.get("vertical")

    ref = ctx.db.collection("broadcasts").document()
    try:
        # Primero los destinatarios y al final la campaña: si algo falla a medias, no queda una campaña
        # a medio llenar (los destinatarios huérfanos no se ven sin su campaña)
        for start in range(0, len(recipients), BATCH_SIZE):
            batch = ctx.db.batch()
            for r in recipients[start:start + BATCH_SIZE]:
                rec = ref.collection("recipients").document()
                batch.set(rec, {"id": rec.id, **r, "conversationId": None, "status": "pending", "errorMessage": None,
                                "whatsappMessageId": None, "sentAt": None})
            batch.commit()
    except Exception as e:
        raise UserActionError(ERROR_INTERNO, f"No se pudieron guardar los destinatarios: {e}", retryable=True)

    is_reminder = kind in ("appointment_reminder", "no_show")
    mapping = [m for m in (fields.get("variableMapping") or []) if m] if is_reminder else []
    ref.set({
        "templateBody": None, "templateLanguage": "es", "contentSid": None, "valuetextObjectApi": None,
        "botInstructions": None, "reminderConfig": None, **fields,
        "id": ref.id, "organizationId": ctx.org_id, "vertical": vertical, "type": kind,
        "templateComponents": fields.get("templateComponents") or [],
        "variableMapping": mapping if is_reminder else None,
        "status": "draft", "totalRecipients": len(recipients), "sentCount": 0, "deliveredCount": 0, "failedCount": 0,
        "createdBy": ctx.requester.uid, "createdAt": firestore.SERVER_TIMESTAMP, "completedAt": None,
    })
    return {"id": ref.id}
