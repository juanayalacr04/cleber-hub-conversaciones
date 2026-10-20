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


EVENT_KINDS = ("message", "status", "outbound")


@dataclass
class DeliveryStatus:
    """Estado de entrega de un mensaje que mandamos (campañas): sent, delivered, read, failed."""
    provider: str
    provider_message_id: str
    status: str
    error: str = ""

    def to_dict(self) -> dict:
        return {"provider": self.provider, "providerMessageId": self.provider_message_id, "status": self.status, "error": self.error}

    @classmethod
    def from_dict(cls, data: dict) -> "DeliveryStatus":
        name = "DeliveryStatus"
        data = as_dict(data, name)
        return cls(provider=one_of(required(data, "provider", name=name), PROVIDERS, "provider", name),
                   provider_message_id=required(data, "providerMessageId", name=name), status=required(data, "status", name=name),
                   error=optional(data, "error", str, "", name))


@dataclass
class OutboundRecord:
    """Eco de un mensaje que salió por fuera de la plataforma (un asesor desde Salesforce, o una plantilla masiva): solo se registra."""
    to_number: str                  # el cliente
    from_number: str                # el número del bot
    body: str = ""
    media_url: str | None = None
    is_template: bool = False       # recordatorio o campaña, no un asesor
    source_id: str = ""             # ID del registro en el sistema de origen: base de la deduplicación

    def to_dict(self) -> dict:
        return {"to": self.to_number, "from": self.from_number, "body": self.body, "mediaUrl": self.media_url, "isTemplate": self.is_template,
                "sourceId": self.source_id}

    @classmethod
    def from_dict(cls, data: dict) -> "OutboundRecord":
        name = "OutboundRecord"
        data = as_dict(data, name)
        return cls(to_number=required(data, "to", name=name), from_number=required(data, "from", name=name),
                   body=optional(data, "body", str, "", name), media_url=optional(data, "mediaUrl", str, None, name),
                   is_template=optional(data, "isTemplate", bool, False, name), source_id=optional(data, "sourceId", str, "", name))


@dataclass
class ChannelEvent:
    """Lo que viaja por la cola del router a las reglas: un mensaje del cliente, un estado de entrega o un eco de salida.

    Solo uno de `message`, `status` y `outbound` va lleno, según `kind`. El router no escribe en Firestore: todo lo que
    hay que guardar viaja aquí y lo guarda la función 2.
    """
    kind: str
    message: IncomingMessage | None = None
    status: DeliveryStatus | None = None
    outbound: OutboundRecord | None = None

    @property
    def event_id(self) -> str:
        """Identificador del evento para deduplicar al consumir (la cola entrega al menos una vez)."""
        if self.kind == "message":
            return f"{self.message.provider}__{self.message.message_id}"
        if self.kind == "status":
            return f"{self.status.provider}__{self.status.provider_message_id}__{self.status.status}"
        return f"outbound__{self.outbound.source_id}" if self.outbound.source_id else ""

    @property
    def ordering_key(self) -> str:
        """Clave de orden de la cola. Mensajes y ecos de una misma conversación comparten clave (número del bot + cliente);
        los estados se ordenan por el mensaje al que se refieren (sent → delivered → read)."""
        if self.kind == "message":
            return self.message.ordering_key
        if self.kind == "outbound":
            return f"{digits(self.outbound.from_number)}_{digits(self.outbound.to_number)}"
        return f"status_{self.status.provider_message_id}"

    def to_dict(self) -> dict:
        payload = {"message": self.message, "status": self.status, "outbound": self.outbound}[self.kind]
        return {"schemaVersion": SCHEMA_VERSION, "kind": self.kind, self.kind: payload.to_dict()}

    @classmethod
    def from_dict(cls, data: dict) -> "ChannelEvent":
        name = "ChannelEvent"
        data = as_dict(data, name)
        check_version(data)
        kind = one_of(required(data, "kind", name=name), EVENT_KINDS, "kind", name)
        body = required(data, kind, dict, name)
        parsed = {"message": IncomingMessage, "status": DeliveryStatus, "outbound": OutboundRecord}[kind].from_dict(body)
        return cls(kind=kind, **{kind: parsed})

    @classmethod
    def of(cls, payload) -> "ChannelEvent":
        kind = {IncomingMessage: "message", DeliveryStatus: "status", OutboundRecord: "outbound"}[type(payload)]
        return cls(kind=kind, **{kind: payload})
