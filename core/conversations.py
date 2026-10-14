"""Conversaciones y mensajes: crear, reabrir, cerrar, agregar mensaje.

Unión de las dos plataformas (tarea 1.5). De Comercial: el cierre sella `closedAt`, la reapertura
respeta `statusBeforeClose` y la marca sale de la organización. De Servicio: filtro por
organización en las consultas, `direction` y limpiar el outcome "inactividad" al reabrir.
Nuevo en el hub: `vertical`, `customerId`, `source` y `externalId`, escritos desde la primera
conversación para no necesitar backfill.
"""
import logging
import os
import re
from datetime import datetime, timezone

from google.cloud import firestore

from core.db import get_db
from core.schema import VERTICALS, customer_id
from core.utils import hours_since, normalize_mx_phone, phone_variants

log = logging.getLogger(__name__)

SESSION_TIMEOUT_HOURS = int(os.environ.get("SESSION_TIMEOUT_HOURS", "24"))
DEFAULT_REOPEN_HOURS = 96
OPEN_STATUSES = ["bot", "waiting_agent", "with_agent"]


def is_stop_message(message: str) -> bool:
    """Detecta opt-out: el mensaje contiene la palabra 'stop' como palabra completa.

    Universal: cierra la conversación en todos los módulos (decisión 6). Lo que cada módulo
    hace además se despacha como el evento `opt_out` al registro de handlers.
    """
    return bool(re.search(r"\bstop\b", (message or "").lower()))


def resolve_vertical(db, team_id: str | None, bot_config: dict | None) -> str | None:
    """Vertical (módulo) de una conversación: la del bot, si no la de su equipo, si no su categoría."""
    bot_config = bot_config or {}
    declared = bot_config.get("vertical")
    if declared in VERTICALS:
        return declared
    if team_id:
        team_doc = db.collection("teams").document(team_id).get()
        from_team = team_doc.to_dict().get("vertical") if team_doc.exists else None
        if from_team in VERTICALS:
            return from_team
    category = (bot_config.get("category") or "").lower()
    return category if category in VERTICALS else None


def upsert_customer(db, org_id: str, phone: str, name: str | None) -> str:
    """Ficha única de cliente: customers/{orgId}_{phone}. Devuelve su id (conversations.customerId)."""
    cid = customer_id(org_id, normalize_mx_phone(phone))
    ref = db.collection("customers").document(cid)
    now = datetime.now(timezone.utc)
    if ref.get().exists:
        updates = {"lastConversationAt": now}
        if name:
            updates["name"] = name
        ref.update(updates)
    else:
        ref.set({
            "id": cid, "organizationId": org_id, "phone": normalize_mx_phone(phone),
            "name": name or None, "createdAt": now, "lastConversationAt": now,
        })
    return cid


def _messages_of(conv_ref) -> list[dict]:
    out = []
    for m in conv_ref.collection("messages").order_by("createdAt").stream():
        d = m.to_dict()
        out.append({"is_user": d["sender"] == "customer", "text": d["text"]})
    return out


def _backfill(data: dict, customer_phone, whatsapp_number_id, team_id, customer_name, direction) -> dict:
    updates = {}
    if data.get("customerPhone") != customer_phone:
        updates["customerPhone"] = customer_phone
    if whatsapp_number_id and not data.get("whatsappNumberId"):
        updates["whatsappNumberId"] = whatsapp_number_id
    if team_id and not data.get("teamId"):
        updates["teamId"] = team_id
    if customer_name and not data.get("customerName"):
        updates["customerName"] = customer_name
    if not data.get("direction"):
        updates["direction"] = direction
    return updates


def get_or_create_conversation(bot_id: str, org_id: str, customer_phone: str,
                               team_id: str | None = None, whatsapp_number_id: str | None = None,
                               bot_config: dict | None = None, channel: str = "whatsapp",
                               customer_name: str | None = None, direction: str = "inbound",
                               source: str | None = None, external_id: str | None = None,
                               db=None) -> tuple:
    """Obtiene la conversación abierta de un cliente, reabre una cerrada reciente, o crea una nueva.

    Returns: (conversation_id, conversation_data, messages_list)
    """
    db = db or get_db()
    variants = phone_variants(customer_phone)
    convs_ref = db.collection("conversations")

    def new_conversation():
        return create_new_conversation(db, bot_id, org_id, customer_phone, team_id, whatsapp_number_id,
                                       bot_config, channel, customer_name, direction, source, external_id)

    # 1. Conversación abierta (cualquier variante del teléfono)
    docs = []
    for variant in variants:
        q = convs_ref.where("botId", "==", bot_id).where("customerPhone", "==", variant).where("status", "in", OPEN_STATUSES)
        if org_id:
            q = q.where("organizationId", "==", org_id)
        docs = list(q.order_by("lastMessageAt", direction=firestore.Query.DESCENDING).limit(1).stream())
        if docs:
            break

    if docs:
        conv = docs[0]
        conv_data = conv.to_dict()
        hours = hours_since(conv_data.get("lastMessageAt"))
        if hours is not None and hours >= SESSION_TIMEOUT_HOURS:
            # La sesión expiró: se cierra (con closedAt, que usa la reapertura) y se abre otra.
            conv.reference.update({"status": "closed", "closedAt": firestore.SERVER_TIMESTAMP})
            return new_conversation()
        updates = _backfill(conv_data, customer_phone, whatsapp_number_id, team_id, customer_name, direction)
        if not conv_data.get("vertical"):  # conversaciones anteriores al hub: se les pone la vertical al volver a escribir
            updates["vertical"] = resolve_vertical(db, team_id or conv_data.get("teamId"), bot_config)
        if updates:
            conv.reference.update(updates)
            conv_data.update(updates)
        return conv.id, conv_data, _messages_of(conv.reference)

    # 2. Reabrir una cerrada recientemente
    reopen_hours = DEFAULT_REOPEN_HOURS
    if bot_config and bot_config.get("reopenWindowHours") is not None:
        reopen_hours = bot_config["reopenWindowHours"]

    if reopen_hours and reopen_hours > 0:
        closed_docs = []
        try:
            for variant in variants:
                cq = convs_ref.where("botId", "==", bot_id).where("customerPhone", "==", variant).where("status", "==", "closed")
                if org_id:
                    cq = cq.where("organizationId", "==", org_id)
                closed_docs = list(cq.order_by("closedAt", direction=firestore.Query.DESCENDING).limit(1).stream())
                if closed_docs:
                    break
        except Exception as e:  # típicamente: falta el índice compuesto
            log.warning("reopen query failed (missing index?): %s", e)
            closed_docs = []

        if closed_docs:
            closed_conv = closed_docs[0]
            closed_data = closed_conv.to_dict()
            if closed_data.get("manualClose"):
                return new_conversation()
            hours_closed = hours_since(closed_data.get("closedAt"))
            if hours_closed is not None and hours_closed < reopen_hours:
                # Si al cerrarse ya la traía un asesor (statusBeforeClose lo estampa el cron
                # close-inactive), se reabre con él y NO se devuelve al bot: el bot no debe
                # meterse encima de una negociación que un humano ya venía trabajando.
                prev_status = closed_data.get("statusBeforeClose")
                if prev_status in ("with_agent", "waiting_agent"):
                    prev_agent = closed_data.get("agentBeforeClose")
                    reopen = {
                        "status": prev_status, "assignedAgentId": prev_agent,
                        "assignedAgentType": "human" if prev_agent else None, "closedAt": None,
                    }
                else:
                    reopen = {"status": "bot", "assignedAgentId": None, "assignedAgentType": "bot", "closedAt": None}
                # El outcome "inactividad" solo describe el momento del cierre: si el cliente
                # volvió, ya no aplica (el historial conserva la entrada para auditoría).
                if closed_data.get("conversationOutcome") == "inactividad":
                    reopen["conversationOutcome"] = None
                    reopen["conversationOutcomeAt"] = None
                reopen.update(_backfill(closed_data, customer_phone, whatsapp_number_id, team_id, customer_name, direction))
                if not closed_data.get("vertical"):
                    reopen["vertical"] = resolve_vertical(db, team_id or closed_data.get("teamId"), bot_config)
                closed_conv.reference.update(reopen)
                closed_data.update(reopen)
                log.info("Reopened conversation %s (closed %.1fh ago, window=%sh, status=%s)",
                         closed_conv.id, hours_closed, reopen_hours, reopen["status"])
                return closed_conv.id, closed_data, _messages_of(closed_conv.reference)

    return new_conversation()


def create_new_conversation(db, bot_id: str, org_id: str, customer_phone: str,
                            team_id: str | None = None, whatsapp_number_id: str | None = None,
                            bot_config: dict | None = None, channel: str = "whatsapp",
                            customer_name: str | None = None, direction: str = "inbound",
                            source: str | None = None, external_id: str | None = None) -> tuple:
    """Crea una nueva conversación con los campos del hub (vertical, customerId, source, externalId)."""
    now = datetime.now(timezone.utc)

    bot_brand = None
    if org_id:
        org_doc = db.collection("organizations").document(org_id).get()
        if org_doc.exists:
            bot_brand = org_doc.to_dict().get("salesforceConfig", {}).get("marcaRR") or None
    if not bot_brand and bot_config:
        bot_brand = bot_config.get("brand") or None

    conv_ref = db.collection("conversations").document()
    conv_data = {
        "id": conv_ref.id,
        "botId": bot_id,
        "organizationId": org_id,
        "customerPhone": customer_phone,
        "customerName": customer_name or None,
        "status": "bot",
        "assignedAgentId": None,
        "priority": "normal",
        "tags": [],
        "lastMessageAt": now,
        "createdAt": now,
        "abacusConversationId": None,  # Se llena con el ID de Abacus en la primera respuesta
        "teamId": team_id,
        "whatsappNumberId": whatsapp_number_id,
        "assignedAgentType": "bot",  # "bot" | "human" | None
        "assignedBotId": bot_id,
        "assignedUserId": None,
        "botName": bot_config.get("name") if bot_config else None,
        "botBrand": bot_brand,
        "botCategory": bot_config.get("category") if bot_config else None,
        "channel": channel,
        "direction": direction,
        # Ganchos del hub
        "vertical": resolve_vertical(db, team_id, bot_config),
        "customerId": upsert_customer(db, org_id, customer_phone, customer_name) if org_id else None,
        "source": source,
        "externalId": external_id,
    }
    conv_ref.set(conv_data)
    return conv_ref.id, conv_data, []


def update_abacus_conversation_id(conv_id: str, abacus_conv_id: str, db=None) -> None:
    (db or get_db()).collection("conversations").document(conv_id).update({"abacusConversationId": abacus_conv_id})


def add_message(conv_id: str, sender: str, text: str, agent_id: str | None = None,
                media_url: str | None = None, db=None) -> None:
    """Agrega un mensaje y actualiza el resumen de la conversación en un solo batch."""
    db = db or get_db()
    now = datetime.now(timezone.utc)
    conv_ref = db.collection("conversations").document(conv_id)
    msg_ref = conv_ref.collection("messages").document()

    batch = db.batch()
    batch.set(msg_ref, {
        "id": msg_ref.id, "conversationId": conv_id,
        "sender": sender,  # "customer" | "bot" | "agent"
        "agentId": agent_id, "text": text, "mediaUrl": media_url, "createdAt": now,
    })
    batch.update(conv_ref, {
        "lastMessageAt": now,
        "lastMessagePreview": text[:100] if text else "📎 Archivo adjunto",
        "lastMessageSender": sender,
    })
    batch.commit()


def update_conversation_status(conv_id: str, status: str, db=None) -> None:
    """Actualiza el status. Al cerrar siempre se re-estampa closedAt.

    La reapertura ordena por ese campo y lo usa para medir la ventana. Una conversación reabierta
    lo trae en None, así que sin este re-estampado el siguiente cierre la dejaba sin fecha y ya
    nunca se podía reabrir: se creaba una conversación nueva y se partía el historial.
    """
    updates = {"status": status}
    if status == "closed":
        updates["closedAt"] = firestore.SERVER_TIMESTAMP
    (db or get_db()).collection("conversations").document(conv_id).update(updates)


def reset_inactivity(conv_id: str, current_reminders_sent: int, db=None) -> None:
    """El cliente escribió: reinicia el reloj de inactividad y los recordatorios enviados."""
    updates = {"lastCustomerMessageAt": firestore.SERVER_TIMESTAMP, "lastTemplateMessageAt": None}
    if current_reminders_sent > 0:
        updates["inactivityRemindersSent"] = 0
    (db or get_db()).collection("conversations").document(conv_id).update(updates)


def _conversation_for_outbound(customer_phone: str, bot_phone: str, db):
    from core.numbers import get_bot_by_phone  # import local: numbers no depende de conversations
    bot = get_bot_by_phone(bot_phone, db)
    if not bot:
        log.warning("outbound sin bot para el número %s", bot_phone)
        return None
    conv_id, conv_data, _ = get_or_create_conversation(
        bot.get("id"), bot.get("organizationId"), customer_phone, bot.get("teamId"),
        bot.get("whatsappNumberId"), bot_config=bot, db=db,
    )
    return conv_id, conv_data


def save_agent_outbound(customer_phone: str, bot_phone: str, message_body: str,
                        media_url: str | None = None, db=None) -> None:
    """Guarda en la conversación el mensaje que un agente humano mandó desde Salesforce.

    Si la conversación estaba con el bot o esperando agente, pasa a "with_agent": un humano ya
    está hablando con el cliente.
    """
    try:
        found = _conversation_for_outbound(customer_phone, bot_phone, db)
        if not found:
            return
        conv_id, conv_data = found
        add_message(conv_id, "agent", message_body, media_url=media_url, db=db)
        if conv_data.get("status", "bot") in ("bot", "waiting_agent"):
            update_conversation_status(conv_id, "with_agent", db=db)
    except Exception as e:
        log.error("Error guardando el outbound de agente: %s", e)


def save_template_outbound(customer_phone: str, bot_phone: str, message_body: str, db=None) -> None:
    """Guarda un template outbound masivo de Salesforce (recordatorios, campañas). Siempre queda con_agent."""
    try:
        found = _conversation_for_outbound(customer_phone, bot_phone, db)
        if not found:
            return
        conv_id, _ = found
        add_message(conv_id, "agent", message_body, db=db)
        update_conversation_status(conv_id, "with_agent", db=db)
    except Exception as e:
        log.error("Error guardando el template outbound: %s", e)
