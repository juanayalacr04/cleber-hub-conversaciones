"""Adaptadores de entrada: cada proveedor resuelve su bot y entrega el mensaje al pipeline único."""
from channels import send_whatsapp_message
from core.numbers import get_bot_by_meta_phone_number_id, get_bot_by_phone
from core.pipeline import Incoming, process_message


def process_twilio_message(from_number: str, to_number: str, body: str, profile_name: str = "", db=None) -> None:
    bot = get_bot_by_phone(to_number, db)
    process_message(
        Incoming(provider="twilio", from_number=from_number, to_number=to_number, body=body,
                 contact_name=profile_name, supports_media=True),
        bot, send_whatsapp_message, db=db,
    )


def process_valuetext_message(from_number: str, to_number: str, body: str, contact_name: str = "",
                              msg_source: str = "", db=None) -> None:
    bot = get_bot_by_phone(to_number, db)
    process_message(
        Incoming(provider="valuetext", from_number=from_number, to_number=to_number, body=body,
                 contact_name=contact_name,
                 # Last_Msg_Source__c nunca se limpia: el pipeline solo lo respeta si hay agente activo
                 from_agent_system=msg_source.lower() == "salesforce"),
        bot, send_whatsapp_message, db=db,
    )


def process_meta_message(from_number: str, phone_number_id: str, body: str, contact_name: str = "", db=None) -> None:
    bot = get_bot_by_meta_phone_number_id(phone_number_id, db)
    process_message(
        Incoming(provider="meta", from_number=from_number, to_number="", body=body, contact_name=contact_name),
        bot, send_whatsapp_message, db=db,
    )
