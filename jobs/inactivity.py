"""Job de inactividad: ejecuta UN recordatorio de una conversación, o un contacto programado.

Quién decide qué conversación y cuándo es el cron del dashboard (Vercel), que llama a esta función
una vez por conversación con `{convId, botId, code, reminderIndex, closeAfter, useTemplate,
templateId}`. Aquí solo se ejecuta y se vuelve idempotente. La función es una sola para todos los
módulos; lo que cada uno hace al cerrar por inactividad se despacha como el evento
`inactivity_closed` (p. ej. Ventas cierra el Lead en Salesforce).

Respuestas: (cuerpo, status). Un salto de seguridad (conversación ya atendida, recordatorio ya
enviado) responde 200 con `skipped: true` para que el cron no reintente.
"""
import logging

from google.cloud import firestore

from ai import engine
from ai.parsing import extract_bot_response
from channels import send_whatsapp_message
from core import outcomes
from core.conversations import add_message, resolve_vertical
from core.db import get_db
from core.numbers import get_bot_for_conversation
from core.tools import dispatch
from crm import templates

log = logging.getLogger(__name__)

SCHEDULED_CONTACT_CODE = "__ADMIN_SCHEDULED_CONTACT__"
APPOINTMENT_STATUSES = ("cita_bot", "cita_agente")


def _skip(reason: str) -> tuple[dict, int]:
    return {"success": False, "skipped": True, "reason": reason}, 200


def _send_template(bot: dict, conv_id: str, conv_data: dict, code: str | None, template_id: str, db) -> bool:
    """Envía la plantilla de ValueText y deja al bot al tanto (la sesión de Abacus vive por deployment)."""
    sf_config = bot.get("salesforceConfig", {})
    bucket = templates.send_valuetext_template(
        sf_config, bot.get("valuetextSenderId", ""), conv_data.get("customerPhone", ""), conv_data.get("leadId", ""), template_id=template_id)
    if not bucket:
        return False
    structure = templates.get_template_structure(sf_config, template_id)
    template_msg = f"<<PLANTILLA>> {structure}" if structure else "<<PLANTILLA>>"
    add_message(conv_id, "bot", template_msg, db=db)
    text = f"{code}\n{template_msg}" if (code and structure) else (code or template_msg)
    engine.send_to_bot(bot, [{"is_user": True, "text": text}], conv_id=conv_id)
    return True


def run_followup(body: dict, db=None, send=send_whatsapp_message) -> tuple[dict, int]:
    """Un recordatorio de inactividad (o, con `type: scheduled_contact`, un contacto programado)."""
    if body.get("type") == "scheduled_contact":
        return run_scheduled_contact(body, db, send)

    conv_id, bot_id, code = body.get("convId"), body.get("botId"), body.get("code")
    index = body.get("reminderIndex")
    if not conv_id or not bot_id or not code or index is None:
        return {"error": "Missing required fields"}, 400
    use_template, template_id = body.get("useTemplate", False), body.get("templateId")

    db = db or get_db()
    conv_ref = db.collection("conversations").document(conv_id)
    snap = conv_ref.get()
    if not snap.exists:
        return _skip("conv_not_found")
    conv = snap.to_dict()

    # waiting_agent se acepta solo si la escaló este mismo mecanismo (inactivityEscalatedAt): sigue
    # la escalera de recordatorios y cierre aunque ya no esté en "bot".
    status = conv.get("status")
    if not (status == "bot" or (status == "waiting_agent" and conv.get("inactivityEscalatedAt"))):
        return _skip("status_changed")
    if conv.get("inactivityRemindersSent", 0) >= index:
        return _skip("already_sent")

    bot, from_number = get_bot_for_conversation(bot_id, conv.get("whatsappNumberId"), db)
    if not bot:
        return {"success": False, "error": "bot_not_found"}, 200
    provider = bot.get("provider", "twilio")

    reply = None
    if use_template and template_id and provider == "valuetext":  # ventana de 24 h vencida
        if not _send_template(bot, conv_id, conv, code, template_id, db):
            return {"success": False, "error": "template_send_failed"}, 200
        updates = {"inactivityRemindersSent": index, "lastTemplateMessageAt": firestore.SERVER_TIMESTAMP}
    elif not use_template:  # ventana libre: el bot redacta el recordatorio a partir del código
        reply = extract_bot_response(engine.send_to_bot(bot, [{"is_user": True, "text": code}], conv_id=conv_id))
        if not reply:
            return {"success": False, "error": "empty_bot_response"}, 200
        add_message(conv_id, "bot", reply, db=db)
        send(bot, conv.get("customerPhone"), from_number, reply)
        updates = {"inactivityRemindersSent": index}
    else:  # useTemplate sin plantilla válida (sin templateId o proveedor distinto): no se envía nada
        log.info("inactivity_followup: sin plantilla válida, no se envía (conv=%s)", conv_id)
        updates = {"inactivityRemindersSent": index}

    close_after = body.get("closeAfter", False)
    if close_after:
        updates.update(status="closed", closedReason="inactivity_bot", closedAt=firestore.SERVER_TIMESTAMP,
                       assignedAgentId=None, assignedAt=None)
    conv_ref.update(updates)

    if close_after:
        outcomes.set_conversation_outcome(conv_id, "inactividad", db=db)  # no pisa un outcome terminal
        if not conv.get("vertical"):  # conversación anterior al hub: se deduce del equipo para despachar al módulo
            conv["vertical"] = resolve_vertical(db, conv.get("teamId"), bot)
        dispatch("inactivity_closed", conv, {
            "bot": bot, "conv_id": conv_id, "db": db,
            "has_appointment": conv.get("appointmentStatus") in APPOINTMENT_STATUSES,
        })
    return {"success": True, "messageSent": reply}, 200


def run_scheduled_contact(body: dict, db=None, send=send_whatsapp_message) -> tuple[dict, int]:
    """Ejecuta el contacto que el cliente pidió programar ("a las 5 contáctenme")."""
    conv_id, bot_id = body.get("convId"), body.get("botId")
    if not conv_id or not bot_id:
        return {"error": "Missing required fields"}, 400
    use_template, template_id = body.get("useTemplate", False), body.get("templateId")

    db = db or get_db()
    conv_ref = db.collection("conversations").document(conv_id)
    snap = conv_ref.get()
    if not snap.exists:
        return _skip("conv_not_found")
    conv = snap.to_dict()
    if conv.get("status") != "bot":
        return _skip("status_changed")
    if not conv.get("scheduledContactAt"):
        return _skip("already_cleared")

    bot, from_number = get_bot_for_conversation(bot_id, conv.get("whatsappNumberId"), db)
    if not bot:
        return {"success": False, "error": "bot_not_found"}, 200

    reply = None
    if use_template and template_id and bot.get("provider") == "valuetext":
        if not _send_template(bot, conv_id, conv, None, template_id, db):
            return {"success": False, "error": "template_send_failed"}, 200
        conv_ref.update({"scheduledContactAt": firestore.DELETE_FIELD, "lastTemplateMessageAt": firestore.SERVER_TIMESTAMP})
    else:
        reply = extract_bot_response(engine.send_to_bot(bot, [{"is_user": True, "text": SCHEDULED_CONTACT_CODE}], conv_id=conv_id))
        if not reply:
            return {"success": False, "error": "empty_bot_response"}, 200
        add_message(conv_id, "bot", reply, db=db)
        send(bot, conv.get("customerPhone"), from_number, reply)
        conv_ref.update({"scheduledContactAt": firestore.DELETE_FIELD})
    return {"success": True, "messageSent": reply}, 200
