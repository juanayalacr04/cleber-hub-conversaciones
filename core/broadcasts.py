"""Campañas (broadcasts): estado de entrega por destinatario y respuesta del cliente.

Unifica `_process_twilio_status` y `_process_meta_status`, que hacían lo mismo. El vocabulario de
respuestas y sus contadores es configuración (`bots/{id}`); los valores por defecto son los de Servicio.
"""
import logging
import time

from google.cloud import firestore

from core.db import get_db

log = logging.getLogger(__name__)

STATUS_ORDER = {"pending": 0, "sent": 1, "delivered": 2, "read": 3, "failed": 4}
DEFAULT_RESPONSE_COUNTERS = {
    "confirmar_cita": "confirmedCount",
    "cancelar_cita": "cancelledCount",
    "reagendar_cita": "rescheduledCount",
}
_INSTRUCTIONS_TTL = 300
_instructions_cache: dict[str, dict] = {}


def update_recipient_delivery(message_id: str, status: str, error_message: str = "", db=None) -> bool:
    """Avanza el estado de entrega del destinatario cuyo `whatsappMessageId` es `message_id`.

    Solo avanza en el ciclo (pending < sent < delivered < read < failed) y actualiza los contadores
    de la campaña. Devuelve True si hubo cambio. Nunca lanza: es un callback de proveedor.
    """
    try:
        if not message_id or status not in ("sent", "delivered", "read", "failed"):
            return False
        db = db or get_db()
        docs = list(db.collection_group("recipients").where("whatsappMessageId", "==", message_id).limit(1).stream())
        if not docs:
            return False
        recipient = docs[0]
        data = recipient.to_dict()
        old = data.get("status", "pending")

        # Ya finalizado por el botón manual "Verificar entregas": evita contar dos veces
        if data.get("deliveryStatus"):
            return False
        if STATUS_ORDER.get(status, 0) <= STATUS_ORDER.get(old, 0):
            return False

        updates = {"status": status}
        if status == "failed" and error_message:
            updates["errorMessage"] = error_message
        recipient.reference.update(updates)

        broadcast_ref = recipient.reference.parent.parent
        if broadcast_ref:
            counters = {}
            if status == "delivered":
                counters["deliveredCount"] = firestore.Increment(1)
            elif status == "failed":
                counters["failedCount"] = firestore.Increment(1)
            if counters:
                broadcast_ref.update(counters)
        return True
    except Exception as e:
        log.error("Error procesando el estado de entrega %s: %s", message_id, e)
        return False


def record_broadcast_response(conv_data: dict, action: str, counters: dict | None = None, db=None) -> bool:
    """Registra la respuesta del cliente a la campaña. Solo guarda la primera. Devuelve True si la guardó."""
    recipient_id = conv_data.get("lastBroadcastRecipientId")
    broadcast_id = conv_data.get("broadcastId")
    if not recipient_id or not broadcast_id:
        return False
    counter_field = (counters or DEFAULT_RESPONSE_COUNTERS).get(action)
    if not counter_field:
        return False
    try:
        db = db or get_db()
        broadcast_ref = db.collection("broadcasts").document(broadcast_id)
        recipient_ref = broadcast_ref.collection("recipients").document(recipient_id)
        snap = recipient_ref.get()
        if not snap.exists or snap.to_dict().get("response") is not None:
            return False
        recipient_ref.update({"response": action})
        broadcast_ref.update({counter_field: firestore.Increment(1)})
        return True
    except Exception as e:
        log.error("Error registrando la respuesta a la campaña: %s", e)
        return False


def get_broadcast_instructions(broadcast_id: str, db=None) -> str:
    """`botInstructions` de una campaña (caché de 5 minutos)."""
    cached = _instructions_cache.get(broadcast_id)
    if cached and time.time() < cached["expires"]:
        return cached["instructions"]
    doc = (db or get_db()).collection("broadcasts").document(broadcast_id).get()
    instructions = (doc.to_dict().get("botInstructions") or "") if doc.exists else ""
    _instructions_cache[broadcast_id] = {"instructions": instructions, "expires": time.time() + _INSTRUCTIONS_TTL}
    return instructions
