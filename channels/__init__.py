"""Canales de WhatsApp: un módulo por proveedor y un despacho único por `bot["provider"]`."""
from channels.meta_wa import send_meta_handoff_template, send_meta_message
from channels.twilio_wa import send_twilio_handoff_template, send_twilio_message
from channels.valuetext_wa import send_valuetext_handoff_template, send_valuetext_message


def send_whatsapp_message(bot_config: dict, to_number: str, from_number: str, message: str, media_url: str | None = None):
    """Envía por el proveedor del número (twilio por defecto). Valuetext y meta no soportan imagen."""
    provider = bot_config.get("provider", "twilio")
    if provider == "valuetext":
        return send_valuetext_message(bot_config, to_number, message)
    if provider == "meta":
        return send_meta_message(bot_config, to_number, message)
    return send_twilio_message(bot_config, to_number, from_number, message, media_url=media_url)


def send_handoff_template(number: dict, to_number: str, variables: dict, lead_id: str | None = None, sf_config: dict | None = None):
    """Plantilla de handoff a Servicio por el proveedor del número (twilio por defecto). Lanza `core.outbound.TemplateError`."""
    provider = number.get("provider", "twilio")
    if provider == "valuetext":
        return send_valuetext_handoff_template(number, to_number, lead_id, sf_config)
    if provider == "meta":
        return send_meta_handoff_template(number, to_number, variables)
    return send_twilio_handoff_template(number, to_number, variables)
