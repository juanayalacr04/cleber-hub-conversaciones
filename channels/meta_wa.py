"""Canal Meta (WhatsApp Cloud API): envío y estado de entrega."""
import json
import logging

from core import http
from core.broadcasts import update_recipient_delivery
from core.outbound import FAILED, NOT_CONFIGURED, TemplateError

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


def send_meta_handoff_template(number: dict, to_number: str, variables: dict) -> str:
    """Plantilla de handoff a Servicio por Meta. Devuelve el id del mensaje; lanza `TemplateError`.

    Las variables del cuerpo van por orden numérico: {{1}} = nombre del cliente, {{2}} = motivo.
    """
    phone_number_id, access_token = number.get("metaPhoneNumberId"), number.get("metaAccessToken")
    template = number.get("serviceHandoffTemplateName")
    if not (phone_number_id and access_token and template):
        raise TemplateError(NOT_CONFIGURED, "Meta service handoff template not configured")
    payload = json.dumps({
        "messaging_product": "whatsapp", "to": to_number.replace("whatsapp:", "").replace("+", ""), "type": "template",
        "template": {"name": template, "language": {"code": number.get("serviceHandoffTemplateLanguage") or "es"},
                     "components": [{"type": "body", "parameters": [
                         {"type": "text", "text": variables[k]} for k in sorted(variables, key=int)]}]},
    }).encode("utf-8")
    try:
        _, body = http.request(f"https://graph.facebook.com/{GRAPH_VERSION}/{phone_number_id}/messages", payload,
                               {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"})
        return json.loads(body).get("messages", [{}])[0].get("id", "unknown")
    except Exception as e:
        log.error("Error enviando la plantilla por Meta: %s", e)
        raise TemplateError(FAILED, "Failed to send WhatsApp template")


def process_meta_status(status_update: dict, db=None) -> None:
    """Estado de entrega de Meta (sent, delivered, read, failed) para campañas."""
    update_recipient_delivery(status_update.get("id", ""), status_update.get("status", ""), db=db)
