"""Canal Twilio (WhatsApp): envío y estado de entrega."""
import base64
import json
import logging
import time
import urllib.parse

from core import http
from core.broadcasts import update_recipient_delivery
from core.outbound import FAILED, NOT_CONFIGURED, TemplateError

log = logging.getLogger(__name__)

ATTEMPTS = 3
_sleep = time.sleep


def send_twilio_message(bot_config: dict, to_number: str, from_number: str, message: str, media_url: str | None = None) -> str | None:
    """Envía un mensaje por Twilio, opcionalmente con imagen. Devuelve el SID o None.

    POST directo con urllib y no el SDK: el SDK reutilizaba un requests.Session cuyas conexiones
    keep-alive quedan inactivas con min-instances=1; Twilio las cierra del lado servidor y el
    siguiente envío reutilizaba un socket muerto (cuelgue ~60 s / SSLError EOF).
    """
    cfg = bot_config.get("twilioConfig", {})
    account_sid, auth_token = cfg.get("accountSid"), cfg.get("authToken")
    form = {"To": to_number, "From": from_number, "Body": message}
    if media_url:
        form["MediaUrl"] = media_url
    headers = {
        "Authorization": "Basic " + base64.b64encode(f"{account_sid}:{auth_token}".encode()).decode(),
        "Content-Type": "application/x-www-form-urlencoded",
    }
    url = f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json"

    last_error = None
    for attempt in range(ATTEMPTS):
        try:
            _, body = http.request(url, urllib.parse.urlencode(form).encode("utf-8"), headers, timeout=15)
            sid = json.loads(body).get("sid")
            log.info("Twilio message sent: %s (media: %s)", sid, bool(media_url))
            return sid
        except Exception as e:
            last_error = e
            log.warning("Error enviando por Twilio (intento %d/%d): %s", attempt + 1, ATTEMPTS, e)
            if attempt < ATTEMPTS - 1:
                _sleep(1)
    log.error("No se pudo enviar por Twilio tras %d intentos: %s", ATTEMPTS, last_error)
    return None


def send_twilio_handoff_template(number: dict, to_number: str, variables: dict) -> str:
    """Plantilla de handoff a Servicio por Twilio (Content Template). Devuelve el SID; lanza `TemplateError`."""
    account_sid, auth_token = number.get("twilioAccountSid"), number.get("twilioAuthToken")
    content_sid = number.get("serviceHandoffContentSid")
    if not (account_sid and auth_token and content_sid):
        raise TemplateError(NOT_CONFIGURED, "Twilio service handoff template not configured")
    form = {"To": f"whatsapp:{to_number}", "From": number.get("phoneNumber", ""), "ContentSid": content_sid,
            "ContentVariables": json.dumps(variables)}
    headers = {
        "Authorization": "Basic " + base64.b64encode(f"{account_sid}:{auth_token}".encode()).decode(),
        "Content-Type": "application/x-www-form-urlencoded",
    }
    try:
        _, body = http.request(f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json",
                               urllib.parse.urlencode(form).encode("utf-8"), headers, timeout=15)
        return json.loads(body).get("sid")
    except Exception as e:
        log.error("Error enviando la plantilla por Twilio: %s", e)
        raise TemplateError(FAILED, "Failed to send WhatsApp template")


def process_twilio_status(msg_sid: str, message_status: str, error_message: str = "", db=None) -> None:
    """Callback de estado de Twilio (sent, delivered, read, failed, undelivered) para campañas."""
    status = "failed" if message_status in ("failed", "undelivered") else message_status
    update_recipient_delivery(msg_sid, status, error_message, db=db)
