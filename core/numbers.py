"""Resolución del número de WhatsApp: número -> organización, equipo, bot, proveedor.

Portado de Comercial (idéntico a Servicio salvo `get_whatsapp_number_by_brand`, que se corrige).
"""
import logging
import time

from core.db import get_db
from core.schema import VERTICALS
from crm import salesforce

log = logging.getLogger(__name__)

_BOT_CACHE_TTL = 60
_bot_cache: dict[str, dict] = {}


def get_whatsapp_number_by_phone(phone_number: str, channel: str | None = None, db=None) -> dict | None:
    """Busca un whatsappNumber activo por teléfono ("whatsapp:+52..." o "+52...")."""
    db = db or get_db()
    q = db.collection("whatsappNumbers").where("phoneNumber", "==", phone_number).where("status", "==", "active")
    if channel:
        q = q.where("channel", "==", channel)
    docs = list(q.limit(1).stream())
    if docs:
        data = docs[0].to_dict()
        data["id"] = docs[0].id
        return data
    log.info("No WhatsApp number found: %s (channel=%s)", phone_number, channel)
    return None


def get_bot_by_id(bot_id: str, db=None) -> dict | None:
    db = db or get_db()
    doc = db.collection("bots").document(bot_id).get()
    if doc.exists:
        data = doc.to_dict()
        data["id"] = doc.id
        return data
    return None


def get_bot_by_phone(phone_number: str, db=None) -> dict | None:
    """Bot que atiende un número, con la config de canal mezclada. Cache de 60 s."""
    cached = _bot_cache.get(phone_number)
    if cached and time.time() < cached["expires"]:
        return cached["bot"]
    bot = _get_bot_by_phone_uncached(phone_number, db)
    if bot:
        _bot_cache[phone_number] = {"bot": bot, "expires": time.time() + _BOT_CACHE_TTL}
    return bot


def get_bot_by_meta_phone_number_id(meta_phone_number_id: str, db=None) -> dict | None:
    """Bot que atiende un número de Meta, por su `metaPhoneNumberId`."""
    db = db or get_db()
    docs = list(db.collection("whatsappNumbers").where("metaPhoneNumberId", "==", meta_phone_number_id).where("status", "==", "active").limit(1).stream())
    if not docs:
        log.info("No hay número de WhatsApp para el Meta Phone Number ID %s", meta_phone_number_id)
        return None
    wa_number = docs[0].to_dict()
    wa_number["id"] = docs[0].id
    if not wa_number.get("defaultBotId"):
        log.warning("El número de Meta %s no tiene defaultBotId", meta_phone_number_id)
        return None
    bot = get_bot_by_id(wa_number["defaultBotId"], db)
    if not bot:
        return None
    bot.update(
        provider="meta", whatsappNumberId=wa_number["id"], teamId=wa_number.get("teamId"),
        metaPhoneNumberId=wa_number.get("metaPhoneNumberId", ""), metaAccessToken=wa_number.get("metaAccessToken", ""),
    )
    return bot


def clear_bot_cache() -> None:
    _bot_cache.clear()


def apply_channel_config(bot: dict, wa_number: dict, db=None) -> dict:
    """Mezcla en el bot la configuración de su canal (número, proveedor, equipo, credenciales)."""
    db = db or get_db()
    provider = wa_number.get("provider", "twilio")
    bot["provider"] = provider
    bot["whatsappNumberId"] = wa_number.get("id")
    bot["teamId"] = wa_number.get("teamId")
    bot["reopenWindowHours"] = wa_number.get("reopenWindowHours")
    bot["closeWebhookUrl"] = wa_number.get("closeWebhookUrl")

    if provider == "valuetext":
        bot["valuetextSenderId"] = wa_number.get("valuetextSenderId", "")
        org_id = bot.get("organizationId")
        org_config = {}
        if org_id:
            org_doc = db.collection("organizations").document(org_id).get()
            if org_doc.exists:
                org_config = org_doc.to_dict().get("salesforceConfig", {})
        from core.conversations import resolve_vertical  # import local: conversations usa numbers en funciones
        bot["salesforceConfig"] = salesforce.resolve_config(org_config, resolve_vertical(db, bot["teamId"], bot))
    elif provider == "meta":
        bot["metaPhoneNumberId"] = wa_number.get("metaPhoneNumberId", "")
        bot["metaAccessToken"] = wa_number.get("metaAccessToken", "")
    else:
        # Config de Twilio del número mezclada en el bot (compatibilidad)
        bot["twilioConfig"] = {
            "phoneNumber": wa_number.get("phoneNumber"),
            "accountSid": wa_number.get("twilioAccountSid"),
            "authToken": wa_number.get("twilioAuthToken"),
        }
    return bot


def get_bot_for_conversation(bot_id: str, whatsapp_number_id: str | None, db=None) -> tuple[dict | None, str]:
    """Bot con la config de canal del número de una conversación. Devuelve (bot, número_del_bot).

    Lo usan los jobs, que parten de una conversación y no de un mensaje entrante.
    """
    db = db or get_db()
    bot = get_bot_by_id(bot_id, db)
    if not bot:
        return None, ""
    if whatsapp_number_id:
        doc = db.collection("whatsappNumbers").document(whatsapp_number_id).get()
        if doc.exists:
            wa_number = doc.to_dict()
            wa_number["id"] = doc.id
            apply_channel_config(bot, wa_number, db)
            return bot, wa_number.get("phoneNumber", "")
    return bot, (bot.get("twilioConfig") or {}).get("phoneNumber", "")


def _get_bot_by_phone_uncached(phone_number: str, db=None) -> dict | None:
    db = db or get_db()
    wa_number = get_whatsapp_number_by_phone(phone_number, db=db)
    if wa_number and wa_number.get("defaultBotId"):
        bot = get_bot_by_id(wa_number["defaultBotId"], db)
        if bot:
            return apply_channel_config(bot, wa_number, db)

    # Modelo antiguo: buscar por el twilioConfig del propio bot
    docs = list(
        db.collection("bots").where("twilioConfig.phoneNumber", "==", phone_number).where("status", "==", "active").limit(1).stream()
    )
    if docs:
        return docs[0].to_dict()
    log.info("No bot found for phone: %s", phone_number)
    return None


# Campos que dependen del canal (el número de WhatsApp), no de la "inteligencia" del bot.
# Al cambiar el bot activo de una conversación se conservan para seguir respondiendo por el
# mismo número, con el mismo proveedor, organización y equipo.
CHANNEL_BOT_FIELDS = (
    "provider", "whatsappNumberId", "teamId", "organizationId",
    "reopenWindowHours", "closeWebhookUrl", "twilioConfig",
    "valuetextSenderId", "metaPhoneNumberId", "metaAccessToken",
    "salesforceConfig",
)


def apply_active_bot_override(channel_bot: dict, conv_data: dict, db=None) -> dict:
    """Devuelve el bot que debe responder esta conversación.

    Si la conversación tiene `activeBotId` (lo setea el ruteo cuando una situación tiene destino
    "cambiar_bot"), se usa ese bot con la configuración de canal del número. Si no, el bot
    default del número, sin cambios.
    """
    active_bot_id = conv_data.get("activeBotId")
    if not active_bot_id or active_bot_id == channel_bot.get("id"):
        return channel_bot
    override = get_bot_by_id(active_bot_id, db)
    if not override:
        log.warning("active_bot_no_encontrado bot_id=%s", active_bot_id)
        return channel_bot
    bot = dict(override)
    for field in CHANNEL_BOT_FIELDS:
        if field in channel_bot:
            bot[field] = channel_bot[field]
    bot["channelBotId"] = channel_bot.get("id")
    log.info("active_bot_override bot_id=%s channel_bot_id=%s", active_bot_id, channel_bot.get("id"))
    return bot


class AmbiguousBrandCode(Exception):
    """Dos o más organizaciones comparten el mismo sfBrandCode."""


def get_whatsapp_number_by_brand(brand_code: str, vertical: str | None = None, db=None) -> dict | None:
    """Busca el whatsappNumber activo para una marca de Salesforce (tarea 1.7).

    Flujo: organizations.sfBrandCode == brand_code -> whatsappNumbers de esa organización.

    Correcciones respecto al original:
      * El original resolvía con `.limit(1)` sin `orderBy`: si dos organizaciones compartían
        código de marca, los leads se iban siempre a un documento arbitrario y fallaba en
        silencio. Ahora el código duplicado lanza AmbiguousBrandCode (falla ruidosa).
      * Una organización tiene ahora números de varias verticales. Con `vertical` se elige el
        número cuyo equipo es de esa vertical; sin él, la elección es determinista (id menor)
        en vez de depender del orden de Firestore.
    """
    if not brand_code:
        return None
    if vertical is not None and vertical not in VERTICALS:
        raise ValueError(f"vertical desconocida: {vertical!r}")
    db = db or get_db()

    orgs = list(db.collection("organizations").where("sfBrandCode", "==", brand_code).limit(2).stream())
    if not orgs:
        log.warning("lead_brand_not_found brand_code=%s", brand_code)
        return None
    if len(orgs) > 1:
        raise AmbiguousBrandCode(f"sfBrandCode {brand_code!r} lo comparten {sorted(o.id for o in orgs)}")
    org_id = orgs[0].id

    numbers = []
    for doc in db.collection("whatsappNumbers").where("organizationId", "==", org_id).where("status", "==", "active").stream():
        data = doc.to_dict()
        data["id"] = doc.id
        numbers.append(data)
    if not numbers:
        log.warning("lead_no_active_number brand_code=%s org_id=%s", brand_code, org_id)
        return None

    if vertical is not None:
        team_vertical: dict[str, str | None] = {}
        for n in numbers:
            team_id = n.get("teamId")
            if team_id and team_id not in team_vertical:
                team_doc = db.collection("teams").document(team_id).get()
                team_vertical[team_id] = team_doc.to_dict().get("vertical") if team_doc.exists else None
        numbers = [n for n in numbers if team_vertical.get(n.get("teamId")) == vertical]
        if not numbers:
            log.warning("lead_no_number_for_vertical brand_code=%s vertical=%s", brand_code, vertical)
            return None

    return sorted(numbers, key=lambda n: n["id"])[0]
