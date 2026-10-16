"""Contratos del canal: router → reglas (A) y reglas → router (B).

A. `IncomingMessage` viaja por la cola; lo arma el router, que es la única función que conoce los
   formatos de Twilio, Meta y ValueText.
B. `OutgoingMessage` reemplaza al callback `send(...)` que hoy se inyecta al pipeline. El router
   contesta con `SendResult`; mientras tanto la función 2 guarda el mensaje como `pending` y lo
   actualiza con `providerMessageId` (o con el error) al recibir la confirmación.
"""
from dataclasses import dataclass, field

from contracts.base import ContractError, SCHEMA_VERSION, as_dict, check_version, digits, one_of, optional, required

PROVIDERS = ("twilio", "meta", "valuetext")


@dataclass
class Media:
    url: str
    type: str = "image"

    def to_dict(self) -> dict:
        return {"url": self.url, "type": self.type}

    @classmethod
    def from_dict(cls, data: dict) -> "Media":
        data = as_dict(data, "media")
        return cls(url=required(data, "url", name="media"), type=optional(data, "type", str, "image", "media"))


@dataclass
class IncomingMessage:
    """A. Un mensaje del cliente, ya normalizado y deduplicado por el router."""
    message_id: str                 # ID del proveedor: base de la deduplicación
    provider: str
    from_number: str                # teléfono del cliente, normalizado
    to_number: str = ""             # número del bot ("" en Meta, que identifica por phone_number_id)
    phone_number_id: str = ""       # solo Meta
    body: str = ""
    contact_name: str = ""
    media: list[Media] = field(default_factory=list)
    from_agent_system: bool = False  # un humano ya atiende desde otro sistema (p. ej. Salesforce)
    received_at: str = ""           # ISO 8601 UTC

    @property
    def ordering_key(self) -> str:
        """Clave de orden de la cola: un número de bot con un cliente es una conversación.

        El router no conoce la organización (la resuelve la función 2), pero el par número del bot
        + cliente la determina: es equivalente a `{orgId}_{phone}` para efectos de orden.
        """
        return f"{digits(self.to_number) or self.phone_number_id}_{digits(self.from_number)}"

    @property
    def supports_media(self) -> bool:
        return self.provider == "twilio"

    def to_dict(self) -> dict:
        return {
            "schemaVersion": SCHEMA_VERSION, "messageId": self.message_id, "provider": self.provider,
            "from": self.from_number, "to": self.to_number, "phoneNumberId": self.phone_number_id,
            "body": self.body, "contactName": self.contact_name,
            "media": [m.to_dict() for m in self.media], "fromAgentSystem": self.from_agent_system,
            "receivedAt": self.received_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "IncomingMessage":
        name = "IncomingMessage"
        data = as_dict(data, name)
        check_version(data)
        provider = one_of(required(data, "provider", name=name), PROVIDERS, "provider", name)
        to_number = optional(data, "to", str, "", name)
        phone_number_id = optional(data, "phoneNumberId", str, "", name)
        if not to_number and not phone_number_id:
            raise ContractError(f"{name}: hace falta 'to' o 'phoneNumberId' para resolver el bot")
        return cls(
            message_id=required(data, "messageId", name=name), provider=provider,
            from_number=required(data, "from", name=name), to_number=to_number,
            phone_number_id=phone_number_id, body=optional(data, "body", str, "", name),
            contact_name=optional(data, "contactName", str, "", name),
            media=[Media.from_dict(m) for m in optional(data, "media", list, [], name)],
            from_agent_system=optional(data, "fromAgentSystem", bool, False, name),
            received_at=optional(data, "receivedAt", str, "", name),
        )


@dataclass
class OutgoingMessage:
    """B. Pedido de envío de la función 2 al router.

    El router busca las credenciales por `bot_id` (Secret Manager, 1.41): no viajan en el mensaje.
    """
    message_id: str                 # ID del mensaje en Firestore (estado `pending`): correlaciona la confirmación
    conversation_id: str
    bot_id: str
    provider: str
    to_number: str
    from_number: str = ""           # número del bot ("" en Meta)
    text: str = ""
    media_url: str | None = None

    def to_dict(self) -> dict:
        return {
            "schemaVersion": SCHEMA_VERSION, "messageId": self.message_id,
            "conversationId": self.conversation_id, "botId": self.bot_id, "provider": self.provider,
            "to": self.to_number, "from": self.from_number, "text": self.text, "mediaUrl": self.media_url,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "OutgoingMessage":
        name = "OutgoingMessage"
        data = as_dict(data, name)
        check_version(data)
        provider = one_of(required(data, "provider", name=name), PROVIDERS, "provider", name)
        text, media_url = optional(data, "text", str, "", name), optional(data, "mediaUrl", str, None, name)
        if not text and not media_url:
            raise ContractError(f"{name}: hace falta 'text' o 'mediaUrl'")
        return cls(
            message_id=required(data, "messageId", name=name),
            conversation_id=required(data, "conversationId", name=name),
            bot_id=required(data, "botId", name=name), provider=provider,
            to_number=required(data, "to", name=name), from_number=optional(data, "from", str, "", name),
            text=text, media_url=media_url,
        )


@dataclass
class SendResult:
    """Respuesta del router a un `OutgoingMessage`."""
    ok: bool
    message_id: str                 # el mismo del pedido
    provider_message_id: str | None = None
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "schemaVersion": SCHEMA_VERSION, "ok": self.ok, "messageId": self.message_id,
            "providerMessageId": self.provider_message_id, "error": self.error,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "SendResult":
        name = "SendResult"
        data = as_dict(data, name)
        check_version(data)
        return cls(
            ok=required(data, "ok", bool, name), message_id=required(data, "messageId", name=name),
            provider_message_id=optional(data, "providerMessageId", str, None, name),
            error=optional(data, "error", str, None, name),
        )
