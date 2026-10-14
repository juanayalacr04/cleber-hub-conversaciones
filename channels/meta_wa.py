"""Canal Meta (WhatsApp Cloud API): envío y estado de entrega."""
import json
import logging

from core import http
from core.broadcasts import update_recipient_delivery

log = logging.getLogger(__name__)
GRAPH_VERSION = "v21.0"


def send_meta_message(bot_config: dict, to_number: str, message: str) -> str | None:
    """Envía un mensaje por la API de Meta. Devuelve el id del mensaje o None."""
    phone_number_id = bot_config.get("metaPhoneNumberId", "")
    access_token = bot_config.get("metaAccessToken", "")
    if not phone_number_id or not access_token:
        log.error("Credenciales de Meta WhatsApp sin configurar")
        return None

    payload = json.dumps({
        "messaging_product": "whatsapp",
        "to": to_number.replace("whatsapp:", "").replace("+", ""),
        "type": "text",
        "text": {"body": message},
    }).encode("utf-8")
    try:
        _, body = http.request(
            f"https://graph.facebook.com/{GRAPH_VERSION}/{phone_number_id}/messages", payload,
            {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        )
        msg_id = json.loads(body).get("messages", [{}])[0].get("id", "unknown")
        log.info("Meta message sent: %s", msg_id)
        return msg_id
    except http.HTTPError as e:
        log.error("Error enviando por Meta: HTTP %s: %s", e.code, e.read().decode("utf-8", "replace"))
    except Exception as e:
        log.error("Error enviando por Meta: %s", e)
    return None


def process_meta_status(status_update: dict, db=None) -> None:
    """Estado de entrega de Meta (sent, delivered, read, failed) para campañas."""
    update_recipient_delivery(status_update.get("id", ""), status_update.get("status", ""), db=db)
