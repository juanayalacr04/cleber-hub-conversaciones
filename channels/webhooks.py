"""Webhooks de los proveedores: parsean la petición, deduplican, publican en la cola y responden.

Son funciones puras sobre datos ya extraídos de la petición (formulario, cuerpo, argumentos), para poder probarlas sin Flask.
`publish(event)` publica un `ChannelEvent` en la cola (`channels/event_queue.py`) y **no regresa hasta que la cola lo aceptó**; si
falla, el webhook suelta la marca de deduplicación y responde 500 para que el proveedor reintente. El router no escribe en Firestore
(salvo `processed_events`, que es su deduplicación): lo que hay que guardar viaja en el evento y lo guarda la función 2
(`channels/ingest.py`). `channels/router.py` los enruta.
"""
import json
import logging
import uuid
from datetime import datetime, timezone

from channels.valuetext_wa import parse_salesforce_outbound_message
from contracts.messages import ChannelEvent, DeliveryStatus, IncomingMessage, OutboundRecord
from core import credentials, idempotency
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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _publish(publish, event: ChannelEvent, dedupe: tuple[str, str] | None = None, db=None) -> bool:
    """Deduplica (si hay ID), publica y devuelve True; False si no se pudo publicar (se suelta la marca para que el reintento pase)."""
    if dedupe and idempotency.is_duplicate(*dedupe, db=db):
        log.info("%s: duplicado ignorado, id=%s", dedupe[0], dedupe[1])
        return True
    try:
        publish(event)
        return True
    except Exception:
        log.exception("no se pudo publicar el evento %s en la cola", event.kind)
        if dedupe:
            idempotency.release(*dedupe, db=db)
        return False


# --------------------------------------------------------------------------- Twilio

def handle_twilio(form, publish, db=None) -> tuple:
    """Mensaje entrante o callback de estado de Twilio. Responde 200 cuando la cola lo aceptó."""
    message_status = form.get("MessageStatus", "")
    if message_status:  # callback de un mensaje ya enviado: no trae Body (y el mismo SID llega varias veces, una por estado)
        sid = form.get("MessageSid", "")
        if not sid:
            return "", 200
        status = DeliveryStatus("twilio", sid, message_status, form.get("ErrorMessage", ""))
        return ("", 200) if _publish(publish, ChannelEvent.of(status), db=db) else ("", 500)

    from_number, to_number = form.get("From", ""), form.get("To", "")
    body, profile_name = form.get("Body", "").strip(), form.get("ProfileName", "").strip()
    if not from_number or not body:
        return "", 200
    sid = form.get("MessageSid", "")
    message = IncomingMessage(message_id=sid or uuid.uuid4().hex, provider="twilio", from_number=normalize_mx_phone(from_number),
                              to_number=to_number, body=body, contact_name=profile_name, received_at=_now())
    # Twilio reintenta si tardamos en contestar: se deduplica por MessageSid
    return ("", 200) if _publish(publish, ChannelEvent.of(message), ("twilio", sid), db=db) else ("", 500)


# --------------------------------------------------------------------------- ValueText

def _first_media_url(media_json_raw: str) -> str | None:
    try:
        items = json.loads(media_json_raw) if media_json_raw else None
        return (items[0].get("url") or None) if isinstance(items, list) and items else None
    except Exception:
        return None


def handle_valuetext(raw_body: str, publish, db=None) -> tuple:
    """Outbound Message de Salesforce (SOAP). Un registro = un evento. ACK cuando la cola los aceptó todos; si alguno falla, sin ACK
    (Salesforce reintenta y lo ya publicado se ignora por duplicado)."""
    failed = False
    for fields in parse_salesforce_outbound_message(raw_body):
        sobject_id = fields.get("_sobject_id", "")
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
        outbound = msg_type.lower() == "outbound"
        if outbound and origin.lower() == BOT_ORIGIN:
            continue  # lo mandó el bot: ya lo guardó nuestro flujo

        if outbound:
            is_template = bool(fields.get("rsplus__Template_ID__c"))   # recordatorio o campaña, o un asesor humano
            payload = OutboundRecord(to_number=to_whatsapp(number), from_number=to_whatsapp(sender), body=body,
                                     media_url=None if is_template else media_url, is_template=is_template, source_id=sobject_id)
        else:
            payload = IncomingMessage(
                message_id=sobject_id or uuid.uuid4().hex, provider="valuetext", from_number=normalize_mx_phone(to_whatsapp(number)),
                to_number=to_whatsapp(sender), body=body, contact_name=name, received_at=_now(),
                # Last_Msg_Source__c nunca se limpia: el pipeline solo lo respeta si hay agente activo
                from_agent_system=fields.get("Last_Msg_Source__c", "").lower() == "salesforce")
        if not _publish(publish, ChannelEvent.of(payload), ("valuetext", sobject_id), db=db):
            failed = True
    if failed:
        return "Service Unavailable", 500, {"Content-Type": "text/plain"}
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


def handle_meta(body: dict | None, publish, db=None) -> tuple:
    """POST de Meta: estados de entrega y mensajes de texto. Responde 200 cuando la cola los aceptó; Meta reintenta ante un 500."""
    failed = False
    try:
        for entry in (body or {}).get("entry", []):
            for change in entry.get("changes", []):
                value = change.get("value", {})
                for status_update in value.get("statuses", []):
                    if not status_update.get("id"):
                        continue
                    status = DeliveryStatus("meta", status_update["id"], status_update.get("status", ""))
                    failed |= not _publish(publish, ChannelEvent.of(status), db=db)

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
                    message = IncomingMessage(
                        message_id=msg.get("id") or uuid.uuid4().hex, provider="meta",
                        from_number=normalize_mx_phone(f"whatsapp:{sender}"), phone_number_id=phone_number_id, body=text,
                        contact_name=contact_name, received_at=_now())
                    failed |= not _publish(publish, ChannelEvent.of(message), ("meta", msg.get("id", "")), db=db)   # Meta reintenta hasta el 200
    except Exception:
        log.exception("error parseando el webhook de Meta")
    return ("Service Unavailable", 500) if failed else ("OK", 200)
