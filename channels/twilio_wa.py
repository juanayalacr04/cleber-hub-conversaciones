"""Canal Twilio (WhatsApp): envío y estado de entrega."""
import base64
import json
import logging
import time
import urllib.parse

from core import http
from core.broadcasts import update_recipient_delivery

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


def process_twilio_status(msg_sid: str, message_status: str, error_message: str = "", db=None) -> None:
    """Callback de estado de Twilio (sent, delivered, read, failed, undelivered) para campañas."""
    status = "failed" if message_status in ("failed", "undelivered") else message_status
    update_recipient_delivery(msg_sid, status, error_message, db=db)
