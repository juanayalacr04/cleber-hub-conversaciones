"""Entrada de un mensaje del cliente a las reglas: resuelve el bot del número y lo entrega al pipeline único.

El router ya normalizó el mensaje (`IncomingMessage`, tarea 1.34): aquí no queda nada específico de un proveedor salvo cómo se
identifica el número del bot (Meta, por `phone_number_id`; Twilio y ValueText, por el número) y si soporta imágenes.
"""
from channels import send_whatsapp_message
from contracts.messages import IncomingMessage
from core.numbers import get_bot_by_meta_phone_number_id, get_bot_by_phone
from core.pipeline import Incoming, process_message


def process_incoming(message: IncomingMessage, db=None) -> None:
    bot = get_bot_by_meta_phone_number_id(message.phone_number_id, db) if message.provider == "meta" else get_bot_by_phone(message.to_number, db)
    process_message(
        Incoming(provider=message.provider, from_number=message.from_number, to_number=message.to_number, body=message.body,
                 contact_name=message.contact_name, supports_media=message.supports_media, from_agent_system=message.from_agent_system),
        bot, send_whatsapp_message, db=db,
    )
