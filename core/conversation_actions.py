"""Acciones de usuario sobre una conversación (tarea 1.39): lo que antes la pantalla escribía directo a Firestore.

Se registran al importar el módulo, contra `core.user_actions`. El permiso (organización, equipo, agente
asignado, admin) ya lo comprobó `user_actions` antes de llamar aquí; estas funciones validan lo que depende
del estado: que la conversación esté donde debe y que lo que se referencia (agente, equipo, etiqueta)
pertenezca a la misma organización. Todos los datos de contexto salen de la conversación, no de `data`.

    conversation.take             admin   Tomar una conversación que espera agente
    conversation.assign           admin   Asignar a un agente (`agentId`)
    conversation.transfer_team    admin   Pasarla a otro equipo (`teamId`)
    conversation.return_to_bot    write   Devolverla al bot
    conversation.close            write   Cerrar (`reason`)
    conversation.reopen           write   Reabrir una cerrada
    conversation.toggle_label     write   Poner o quitar una etiqueta (`labelId`)
    conversation.mark_appointment write   Marcar o desmarcar la cita con agente (`marked`)
    conversation.rename_customer  write   Nombre del cliente (`name`, vacío para borrarlo)
    conversation.add_note         write   Nota interna (`text`)
    conversation.send_message     write   Mensaje del agente al cliente (`text` y/o `mediaUrl`)
"""
from datetime import datetime, timezone

from google.cloud import firestore

from contracts.actions import DATOS_INVALIDOS, PRECONDICION_FALLIDA
from contracts.actions import ERROR_EXTERNO, ERROR_INTERNO
from core import authz, outbound
from core.conversations import add_message, resolve_vertical
from core.numbers import get_bot_for_conversation
from core.user_actions import UserActionError, UserContext, declare

MAX_NAME, MAX_NOTE, MAX_REASON, MAX_MESSAGE = 120, 4000, 200, 4096
APPOINTMENT_OUTCOME = "cita_agente_bdc"

# Campos que se limpian cuando la conversación deja de estar con un agente
_RELEASED = {"assignedAgentId": None, "assignedAt": None, "waitingStartedAt": None,
             "firstAgentResponseAt": None, "responseTimeSecs": None}  # responseTimes se conserva: es histórico


def _text(data: dict, key: str, max_len: int, required: bool = True) -> str:
    value = data.get(key)
    if value is None and not required:
        return ""
    if not isinstance(value, str) or (required and not value.strip()):
        raise UserActionError(DATOS_INVALIDOS, f"Falta {key}")
    return value.strip()[:max_len]


def _ref(ctx: UserContext):
    return ctx.db.collection("conversations").document(ctx.conv_id)


def _require_status(ctx: UserContext, *statuses: str) -> None:
    if ctx.conv.get("status") not in statuses:
        raise UserActionError(PRECONDICION_FALLIDA, f"La conversación está {ctx.conv.get('status')!r}; se esperaba {' o '.join(statuses)}")


def _same_org(ctx: UserContext, collection: str, doc_id: str, what: str) -> dict:
    """Documento `collection/doc_id` si existe y es de la organización de la conversación."""
    snap = ctx.db.collection(collection).document(doc_id).get()
    doc = (snap.to_dict() or {}) if snap.exists else None
    if doc is None or doc.get("organizationId") != ctx.org_id:
        raise UserActionError(DATOS_INVALIDOS, f"{what} no existe en esta organización")
    return doc


@declare("conversation.take", scope="conversation", level="admin")
def take(ctx: UserContext, data: dict) -> dict:
    _require_status(ctx, "waiting_agent")
    _ref(ctx).update({
        "status": "with_agent", "assignedAgentId": ctx.requester.uid,
        "assignedAt": firestore.SERVER_TIMESTAMP, "waitingStartedAt": ctx.conv.get("lastMessageAt"),
    })
    return {"status": "with_agent", "assignedAgentId": ctx.requester.uid}


@declare("conversation.assign", scope="conversation", level="admin")
def assign(ctx: UserContext, data: dict) -> dict:
    agent_id = _text(data, "agentId", 128)
    _require_status(ctx, "bot", "waiting_agent", "with_agent")
    snap = ctx.db.collection("users").document(agent_id).get()
    agent = authz.load_requester(ctx.db, agent_id) if snap.exists else None
    if agent is None or not authz.in_org(agent, ctx.org_id) or not authz.can_write(agent):
        raise UserActionError(DATOS_INVALIDOS, "El agente no existe en esta organización")
    _ref(ctx).update({"status": "with_agent", "assignedAgentId": agent_id, "assignedAt": firestore.SERVER_TIMESTAMP})
    return {"status": "with_agent", "assignedAgentId": agent_id}


@declare("conversation.transfer_team", scope="conversation", level="admin")
def transfer_team(ctx: UserContext, data: dict) -> dict:
    team_id = _text(data, "teamId", 128)
    _require_status(ctx, "bot", "waiting_agent", "with_agent")
    _same_org(ctx, "teams", team_id, "El equipo")
    updates = {"teamId": team_id, "status": "waiting_agent", "assignedAgentId": None, "assignedAt": None}
    vertical = resolve_vertical(ctx.db, team_id, None)  # `vertical` está denormalizada y sigue al equipo
    if vertical:
        updates["vertical"] = vertical
    _ref(ctx).update(updates)
    return {"status": "waiting_agent", "teamId": team_id}


@declare("conversation.return_to_bot", scope="conversation")
def return_to_bot(ctx: UserContext, data: dict) -> dict:
    _require_status(ctx, "with_agent")
    _ref(ctx).update({"status": "bot", **_RELEASED})
    return {"status": "bot"}


@declare("conversation.close", scope="conversation")
def close(ctx: UserContext, data: dict) -> dict:
    reason = _text(data, "reason", MAX_REASON)
    _require_status(ctx, "bot", "waiting_agent", "with_agent")
    _ref(ctx).update({"status": "closed", **_RELEASED, "closedAt": firestore.SERVER_TIMESTAMP,
                      "closedReason": reason, "manualClose": True})
    return {"status": "closed"}


@declare("conversation.reopen", scope="conversation")
def reopen(ctx: UserContext, data: dict) -> dict:
    _require_status(ctx, "closed")
    _ref(ctx).update({"status": "bot", "assignedAgentId": None, "assignedAt": None, "closedAt": None})
    return {"status": "bot"}


@declare("conversation.toggle_label", scope="conversation")
def toggle_label(ctx: UserContext, data: dict) -> dict:
    label_id = _text(data, "labelId", 128)
    has = label_id in (ctx.conv.get("labelIds") or [])
    if not has:  # quitar una etiqueta ya borrada o ajena siempre se permite; ponerla exige que sea de la organización
        _same_org(ctx, "labels", label_id, "La etiqueta")
    _ref(ctx).update({"labelIds": firestore.ArrayRemove([label_id]) if has else firestore.ArrayUnion([label_id])})
    return {"labelId": label_id, "applied": not has}


@declare("conversation.mark_appointment", scope="conversation")
def mark_appointment(ctx: UserContext, data: dict) -> dict:
    marked = data.get("marked")
    if not isinstance(marked, bool):
        raise UserActionError(DATOS_INVALIDOS, "marked debe ser true o false")
    _require_status(ctx, "with_agent")
    now = datetime.now(timezone.utc)
    if marked:
        updates = {"appointmentStatus": "cita_agente", "appointmentDate": firestore.SERVER_TIMESTAMP,
                   "conversationOutcome": APPOINTMENT_OUTCOME, "conversationOutcomeAt": firestore.SERVER_TIMESTAMP,
                   "conversationOutcomeHistory": firestore.ArrayUnion([{"outcome": APPOINTMENT_OUTCOME, "at": now}])}
    else:
        # Desmarcar rompe el candado de estado terminal a propósito: vuelve a la última clasificación del bot
        # (o a nada si nunca hubo una).
        reverted = ctx.conv.get("aiOutcome")
        updates = {"appointmentStatus": "sin_cita", "appointmentDate": firestore.DELETE_FIELD,
                   "conversationOutcome": reverted, "conversationOutcomeAt": firestore.SERVER_TIMESTAMP}
        if reverted:
            updates["conversationOutcomeHistory"] = firestore.ArrayUnion([{"outcome": reverted, "at": now}])
    _ref(ctx).update(updates)
    return {"appointmentStatus": updates["appointmentStatus"]}


@declare("conversation.rename_customer", scope="conversation")
def rename_customer(ctx: UserContext, data: dict) -> dict:
    name = _text(data, "name", MAX_NAME, required=False)
    _ref(ctx).update({"customerName": name or None})
    return {"customerName": name or None}


@declare("conversation.add_note", scope="conversation")
def add_note(ctx: UserContext, data: dict) -> dict:
    text = _text(data, "text", MAX_NOTE)
    user = ctx.db.collection("users").document(ctx.requester.uid).get().to_dict() or {}
    note = _ref(ctx).collection("notes").document()
    note.set({"authorId": ctx.requester.uid, "authorName": user.get("name") or user.get("email") or "Agente",
              "text": text, "createdAt": firestore.SERVER_TIMESTAMP})
    return {"noteId": note.id}


# --------------------------------------------------------------------------- mensajes del agente

@declare("conversation.send_message", scope="conversation")
def send_message(ctx: UserContext, data: dict) -> dict:
    text = _text(data, "text", MAX_MESSAGE, required=False)
    media_url = data.get("mediaUrl")
    if media_url is not None and (not isinstance(media_url, str) or not media_url.startswith("https://")):
        raise UserActionError(DATOS_INVALIDOS, "mediaUrl debe ser una URL https")
    if not text and not media_url:
        raise UserActionError(DATOS_INVALIDOS, "Falta text o mediaUrl")
    conv = ctx.conv
    customer = conv.get("customerPhone")
    if not customer or not conv.get("botId"):
        raise UserActionError(PRECONDICION_FALLIDA, "La conversación no tiene teléfono del cliente o bot")

    # El canal web solo guarda el mensaje: el widget lo recibe por onSnapshot
    if conv.get("channel") != "web":
        if not outbound.is_configured("text"):
            raise UserActionError(ERROR_INTERNO, "El envío por WhatsApp no está configurado")
        bot, from_number = get_bot_for_conversation(conv["botId"], conv.get("whatsappNumberId"), ctx.db)
        if not bot:
            raise UserActionError(PRECONDICION_FALLIDA, "El bot de la conversación no existe")
        if not outbound.send_text(bot, customer, from_number, text, media_url=media_url):
            # Nada se guarda si el proveedor no aceptó el mensaje: el agente ve el error y puede reintentar
            raise UserActionError(ERROR_EXTERNO, "El proveedor no aceptó el mensaje", retryable=True)

    message_id = add_message(ctx.conv_id, "agent", text, agent_id=ctx.requester.uid, media_url=media_url, db=ctx.db)

    # Tiempo de primera respuesta del ciclo (una sola vez por ciclo)
    waiting = conv.get("waitingStartedAt")
    if not conv.get("firstAgentResponseAt") and waiting:
        secs = max(0, round((datetime.now(timezone.utc) - waiting).total_seconds()))
        _ref(ctx).update({"firstAgentResponseAt": firestore.SERVER_TIMESTAMP, "responseTimeSecs": secs,
                          "responseTimes": firestore.ArrayUnion([secs])})
    return {"messageId": message_id}
