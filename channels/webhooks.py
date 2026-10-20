"""Webhooks de los proveedores: parsean la petición, responden rápido y mandan el trabajo a segundo plano.

Son funciones puras sobre datos ya extraídos de la petición (formulario, cuerpo, argumentos), para
poder probarlas sin Flask. `run(fn, *args)` agenda el trabajo (en producción, el executor de
`core.db`) y `main.py` los envuelve en los entry points de las Cloud Functions.
"""
import json
import logging

from channels import inbound
from channels.meta_wa import process_meta_status
from channels.twilio_wa import process_twilio_status
from channels.valuetext_wa import parse_salesforce_outbound_message
from core import idempotency
from core.conversations import save_agent_outbound, save_template_outbound
from core import credentials
from core.db import get_db
from core.utils import normalize_mx_phone

log = logging.getLogger(__name__)

SOAP_ACK = """<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <notificationsResponse xmlns="http://soap.sforce.com/2005/09/outbound">
      <Ack>true</Ack>
    </notificationsResponse>
  </soapenv:Body>
</soapenv:Envelope>"""
SOAP_HEADERS = {"Content-Type": "text/xml"}
BOT_ORIGIN = "plataforma ia"


def to_whatsapp(number: str) -> str:
    """'528186019229' o '+52...' -> 'whatsapp:+52...'. Vacío se queda vacío."""
    if not number or number.startswith("whatsapp:"):
        return number
    return f"whatsapp:{number if number.startswith('+') else '+' + number}"


# --------------------------------------------------------------------------- Twilio

def handle_twilio(form, run) -> tuple:
    """Mensaje entrante o callback de estado de Twilio. Responde 200 de inmediato."""
    message_status = form.get("MessageStatus", "")
    if message_status:  # callback de un mensaje ya enviado: no trae Body
        run(process_twilio_status, form.get("MessageSid", ""), message_status, form.get("ErrorMessage", ""))
        return "", 200

    from_number, to_number = form.get("From", ""), form.get("To", "")
    body, profile_name = form.get("Body", "").strip(), form.get("ProfileName", "").strip()
    if not from_number or not body:
        return "", 200
    run(inbound.process_twilio_message, from_number, to_number, body, profile_name)
    return "", 200


# --------------------------------------------------------------------------- ValueText

def _first_media_url(media_json_raw: str) -> str | None:
    try:
        items = json.loads(media_json_raw) if media_json_raw else None
        return (items[0].get("url") or None) if isinstance(items, list) and items else None
    except Exception:
        return None


def handle_valuetext(raw_body: str, run, db=None) -> tuple:
    """Outbound Message de Salesforce (SOAP). Responde el ACK de inmediato; un registro = un mensaje."""
    for fields in parse_salesforce_outbound_message(raw_body):
        sobject_id = fields.get("_sobject_id", "")
        if idempotency.is_duplicate("valuetext", sobject_id, db=db):
            log.info("ValueText: duplicado ignorado, sobject_id=%s", sobject_id)
            continue

        number = fields.get("rsplus__Number__c", "")
        sender = fields.get("rsplus__Sender_ID__c", "")
        body = fields.get("rsplus__Message__c", "").strip()
        msg_type = fields.get("rsplus__Type__c", "")
        origin = fields.get("Origen__c", "")
        name = (fields.get("rsplus__WA_Profile_Name__c") or fields.get("rsplus__Reated_To_Name_Formula__c")
                or fields.get("rsplus__Name__c") or fields.get("Name", ""))
        media_url = _first_media_url(fields.get("rsplus__Media_Json__c", ""))

        if not number or (not body and not media_url):
            continue

        if msg_type.lower() == "outbound":
            if origin.lower() == BOT_ORIGIN:
                continue  # lo mandó el bot: ya lo guardó nuestro flujo
            if fields.get("rsplus__Template_ID__c"):
                run(save_template_outbound, to_whatsapp(number), to_whatsapp(sender), body)  # recordatorio o campaña
            else:
                run(save_agent_outbound, to_whatsapp(number), to_whatsapp(sender), body, media_url)  # agente humano
            continue

        run(inbound.process_valuetext_message, to_whatsapp(number), to_whatsapp(sender), body, name,
            fields.get("Last_Msg_Source__c", ""))
    return SOAP_ACK, 200, SOAP_HEADERS


# --------------------------------------------------------------------------- Meta

def handle_meta_verification(args, db=None) -> tuple:
    """GET de verificación del webhook: el token debe pertenecer a un número de Meta activo."""
    mode, token, challenge = args.get("hub.mode", ""), args.get("hub.verify_token", ""), args.get("hub.challenge", "")
    if mode != "subscribe" or not token:
        return "Bad Request", 400
    db = db or get_db()
    number_id = credentials.find_number_by_verify_token(db, token)
    if number_id:
        number = db.collection("whatsappNumbers").document(number_id).get().to_dict() or {}
        if number.get("provider") == "meta" and number.get("status") == "active":
            return challenge, 200
    # datos anteriores a la migración de credenciales: el token todavía puede estar en el documento del número
    found = list(
        db.collection("whatsappNumbers").where("provider", "==", "meta")
        .where("metaWebhookVerifyToken", "==", token).where("status", "==", "active").limit(1).stream()
    )
    return (challenge, 200) if found else ("Forbidden", 403)


def handle_meta(body: dict | None, run) -> tuple:
    """POST de Meta: estados de entrega y mensajes de texto. Responde 200 de inmediato."""
    try:
        for entry in (body or {}).get("entry", []):
            for change in entry.get("changes", []):
                value = change.get("value", {})
                for status_update in value.get("statuses", []):
                    run(process_meta_status, status_update)

                messages = value.get("messages", [])
                if not messages:
                    continue
                phone_number_id = value.get("metadata", {}).get("phone_number_id", "")
                contacts = value.get("contacts", [])
                contact_name = contacts[0].get("profile", {}).get("name", "") if contacts else ""

                for msg in messages:
                    if msg.get("type") != "text":
                        continue
                    text = msg.get("text", {}).get("body", "").strip()
                    sender = msg.get("from", "")
                    if not sender or not text:
                        continue
                    sender = sender if sender.startswith("+") else f"+{sender}"
                    run(inbound.process_meta_message, normalize_mx_phone(f"whatsapp:{sender}"), phone_number_id, text, contact_name)
    except Exception:
        log.exception("error parseando el webhook de Meta")
    return "OK", 200
