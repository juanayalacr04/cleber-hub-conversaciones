"""Escalera de inactividad (tarea 1.32): qué conversaciones reciben recordatorio, escalan o cierran, y cuándo.

Antes lo decidía el cron `inactivity-followup` del dashboard, que llamaba a la función una vez por conversación. Ahora
el cron solo avisa la hora: este job decide y ejecuta en el mismo proceso (`jobs.inactivity.run_followup` para los
recordatorios y cierres, `core.escalation` para escalar).

`decide` es pura (conversación, configuración del bot y hora → qué hacer), para probarla sin Firestore ni red.

Por cada conversación, en orden:
  1. Se omite si es una campaña de Servicio, si está esperando agente sin haber sido escalada por este mismo job, si ya se
     escaló en el último recordatorio, si pidió asesor fuera de horario, si tiene un contacto programado o ya tiene cita.
  2. Escalación independiente (`escalateEnabled`): una sola vez, si el Lead está completo y el cliente ya respondió hace
     `escalateHours` o más. No respeta el horario de envío porque no manda mensaje.
  3. Fuera del horario de envío del bot, se omite. Sin configuración de inactividad del bot, se cierra sin mensaje.
  4. Escalera de recordatorios, con tres variantes según el origen: `noResponseOverride` (Lead saliente que nunca
     respondió), `inboundOverride` (el cliente escribió primero) o los `reminders` base. Agotada la escalera cierra o,
     con `escalateOnLastReminder`, escala. Un recordatorio con plantilla respeta la ventana de 24 h de WhatsApp; si toca
     pero no se puede mandar plantilla, el paso avanza sin mensaje para no atorar el cierre.
"""
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from core import escalation
from core.conversations import resolve_vertical
from core.db import get_db, get_executor
from core.utils import as_utc
from jobs import inactivity

log = logging.getLogger(__name__)

WINDOW = timedelta(hours=24)
DEFAULT_TIMEZONE = "America/Mexico_City"
CLOSING_CODE = "__ADMIN_FOLLOWUP_CIERRE__"
APPOINTMENT_STATUSES = ("cita_bot", "cita_agente")


@dataclass
class Decision:
    action: str                       # "skip", "escalate" o "followup"
    payload: dict = field(default_factory=dict)   # skip: {}; escalate: campos extra; followup: cuerpo de run_followup


SKIP = Decision("skip")


def stage_code(index: int) -> str:
    """Código que recibe el bot: dice en qué paso de la escalera está (1-indexado) para modular el tono."""
    return f"__ADMIN_FOLLOWUP_{index + 1}_RECORDATORIO__"


def within_sending_hours(sending_hours: dict | None, now: datetime) -> bool:
    if not sending_hours or not sending_hours.get("enabled"):
        return True
    local = now.astimezone(ZoneInfo(sending_hours.get("timezone") or DEFAULT_TIMEZONE))
    minutes = local.hour * 60 + local.minute
    start_h, start_m = map(int, sending_hours["from"].split(":"))
    end_h, end_m = map(int, sending_hours["to"].split(":"))
    return start_h * 60 + start_m <= minutes <= end_h * 60 + end_m


def pick_ladder(conv: dict, cfg: dict) -> list:
    """Escalera aplicable, en orden: Lead saliente sin respuesta, conversación entrante, o la base."""
    outbound_lead, responded = bool(conv.get("smsBucketId")), bool(conv.get("lastCustomerMessageAt"))
    no_response = (cfg.get("noResponseOverride") or {}).get("reminders")
    inbound = (cfg.get("inboundOverride") or {}).get("reminders")
    if outbound_lead and not responded and no_response:
        chosen = no_response
    elif not outbound_lead and inbound:
        chosen = inbound
    else:
        chosen = cfg["reminders"]
    return sorted(chosen, key=lambda r: r["order"])


def _escalate_hours(cfg: dict) -> float:
    hours = cfg.get("escalateHours")
    return 1 if hours is None else hours


def decide(conv: dict, cfg: dict | None, number: dict, now: datetime) -> Decision:
    """Qué hacer con la conversación `conv` (con `cfg` = `inactivityConfig` de su bot, o None si no tiene)."""
    if conv.get("broadcastId") and conv.get("vertical") == "servicio":
        return SKIP
    if conv.get("status") == "waiting_agent" and not conv.get("inactivityEscalatedAt"):
        return SKIP   # escalada a mano (palabra clave): no se toca
    if conv.get("escalatedOnLastReminder") or conv.get("handoffBlockedAt") or conv.get("scheduledContactAt"):
        return SKIP
    if conv.get("appointmentStatus") in APPOINTMENT_STATUSES:
        return SKIP

    clm, fhp = as_utc(conv.get("lastCustomerMessageAt")), as_utc(conv.get("lastTemplateMessageAt"))
    sent = conv.get("inactivityRemindersSent") or 0

    # Escalación independiente de los recordatorios: una sola vez, con Lead completo y cliente que ya respondió
    lead_complete = bool(conv.get("smsBucketId")) or conv.get("completedLead") is True
    if cfg and cfg.get("escalateEnabled") and not conv.get("inactivityEscalatedAt") and conv.get("leadId") and lead_complete and clm:
        if now - clm >= timedelta(hours=_escalate_hours(cfg)):
            return Decision("escalate")

    if not within_sending_hours((cfg or {}).get("sendingHours"), now):
        return SKIP

    if not cfg:  # bot sin inactividad configurada: se cierra sin mensaje para no dejar la conversación atascada
        if fhp and now - fhp < WINDOW:
            return SKIP
        return Decision("followup", {"code": CLOSING_CODE, "closeAfter": True, "reminderIndex": sent, "useTemplate": False, "templateId": None})

    ladder = pick_ladder(conv, cfg)
    nxt = ladder[sent] if sent < len(ladder) else None
    if nxt is None:
        # Se mandaron más recordatorios de los configurados (configuración reducida): se trata como el último
        if fhp and now - fhp < WINDOW:
            return SKIP
        if cfg.get("escalateOnLastReminder"):
            return Decision("escalate", {"escalatedOnLastReminder": True})
        return Decision("followup", {"code": stage_code(sent), "closeAfter": True, "reminderIndex": sent, "useTemplate": True,
                                     "templateId": number.get("followupClosingTemplateId")})

    # Los pasos 3 y 4 miden las horas configuradas desde el último mensaje del cliente (o desde que se creó, si nunca respondió)
    reference = clm or as_utc(conv.get("createdAt"))
    if fhp and reference and now - reference < timedelta(hours=nxt["hours"]):
        return SKIP

    if not fhp and clm and now - clm < WINDOW:
        if now - clm < timedelta(hours=nxt["hours"]):
            return SKIP
        use_template = False   # ventana libre abierta por el cliente: el bot redacta el recordatorio
    else:
        use_template = True    # ventana vencida: plantilla de apertura, de recordatorio o de cierre

    is_last = sent == len(ladder) - 1
    if is_last and cfg.get("escalateOnLastReminder"):
        # Escalar en lugar de cerrar. No se exige `inactivityEscalatedAt`: una escalación previa fuera de horario en modo
        # "salesforce" solo reasignó el Lead y el status sigue en "bot"; sin esto el último paso cerraría la conversación
        # justo cuando debía quedar con el asesor. Repetir la escalación es idempotente.
        return Decision("escalate", {"escalatedOnLastReminder": True})

    # Ya tocaba este paso pero la última plantilla fue hace menos de 24 h: se avanza el conteo sin mandar mensaje
    cooldown = use_template and fhp is not None and now - fhp < WINDOW
    template_id = None
    if use_template and not cooldown:
        if is_last or nxt.get("closeAfter"):
            template_id = number.get("followupClosingTemplateId")   # el cierre nunca se omite aunque FHP quedara nulo
        elif not fhp:
            template_id = number.get("followupOpeningTemplateId")
        else:
            template_id = number.get("followupReminderTemplateId")
    return Decision("followup", {"code": stage_code(sent), "closeAfter": bool(is_last or nxt.get("closeAfter")),
                                 "reminderIndex": sent + 1, "useTemplate": use_template, "templateId": template_id})


def _min_hours(bots: list) -> float:
    """Horas del paso más corto entre todos los bots: cota inferior de las consultas."""
    hours = []
    for cfg in bots:
        hours += [r["hours"] for r in cfg["reminders"]]
        for override in ("inboundOverride", "noResponseOverride"):
            hours += [r["hours"] for r in (cfg.get(override) or {}).get("reminders", [])]
        if cfg.get("escalateEnabled"):
            hours.append(_escalate_hours(cfg))
    return min(hours)


def run(db=None, now: datetime | None = None) -> dict:
    """Un tick de la escalera sobre todas las conversaciones que podrían tocar. Devuelve {processed, skipped, errors}."""
    db = db or get_db()
    now = now or datetime.now(timezone.utc)
    configs = {}
    for snap in db.collection("bots").where("status", "==", "active").stream():
        cfg = (snap.to_dict() or {}).get("inactivityConfig") or {}
        if cfg.get("enabled") and cfg.get("reminders"):
            configs[snap.id] = cfg
    if not configs:
        return {"processed": 0, "skipped": 0, "errors": 0, "message": "No bots with inactivity config"}

    cutoff = now - timedelta(hours=_min_hours(list(configs.values())))
    # "waiting_agent" entra para seguir la escalera de conversaciones ya escaladas por este mismo job.
    # A: inactivos por mensaje del cliente. B: plantilla enviada hace tiempo y sin respuesta.
    candidates = {}
    for field_name in ("lastCustomerMessageAt", "lastTemplateMessageAt"):
        query = db.collection("conversations").where("status", "in", ["bot", "waiting_agent"]) \
            .where("lastMessageSender", "==", "bot").where(field_name, "<", cutoff)
        for snap in query.stream():
            candidates[snap.id] = snap

    numbers: dict = {}

    def number_of(conv):
        wa_id = conv.get("whatsappNumberId")
        if wa_id and wa_id not in numbers:
            numbers[wa_id] = db.collection("whatsappNumbers").document(wa_id).get().to_dict() or {}
        return numbers.get(wa_id, {})

    results = {"processed": 0, "skipped": 0, "errors": 0}
    todo = []
    for conv_id, snap in candidates.items():
        conv = snap.to_dict() or {}
        decision = decide(conv, configs.get(conv.get("botId")), number_of(conv), now)
        if decision.action == "skip":
            results["skipped"] += 1
        else:
            todo.append((conv_id, conv, decision))

    def execute(item) -> bool:
        conv_id, conv, decision = item
        try:
            if decision.action == "escalate":
                bot = (db.collection("bots").document(conv["botId"]).get().to_dict() or None) if conv.get("botId") else None
                if not conv.get("vertical"):   # conversación anterior al hub: el módulo se deduce del equipo
                    conv["vertical"] = resolve_vertical(db, conv.get("teamId"), bot)
                escalation.escalate_to_advisor(conv_id, conv, bot, db, extra_fields=decision.payload)
                return True
            body, status = inactivity.run_followup({"convId": conv_id, "botId": conv.get("botId"), **decision.payload}, db)
            return status == 200
        except Exception:
            log.exception("inactivity-followup: error con la conversación %s", conv_id)
            return False

    for ok in get_executor().map(execute, todo):
        results["processed" if ok else "errors"] += 1
    return results
