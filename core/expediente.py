"""Expediente por cliente (tarea 1.38, D13 y D15): lo que el bot sabe de quien le escribe, sin cargar el historial completo.

Clave: `{orgId}_{phone}` (`core.schema.customer_id`), la misma ficha `customers/` que ya existe. Un cliente que escribe a dos marcas
tiene dos expedientes. Contenido:

  datos       lo que se sabe del cliente (hoy el nombre; los módulos podrán aportar más)
  resumenes   un resumen corto por conversación pasada, en `customers/{id}/summaries/{conversationId}`, los últimos `LAST_SUMMARIES`

La colección no tiene reglas en `firestore.rules`: el navegador no la lee. Arranca vacío (D15): no se resume lo anterior a la migración.

Los resúmenes los genera la función 3 y se piden desde un job (`jobs/summaries.py`), no al cerrar: hay ocho caminos de cierre (asesor,
inactividad, Salesforce, situación, reinicio...) y el job los cubre todos sin tocarlos y deja el cierre fuera del camino de respuesta.
"""
import logging
from datetime import datetime, timezone

from contracts.bot import Expediente, HistoryItem, SummaryRequest
from core import bot_client
from core.schema import customer_id
from core.utils import normalize_mx_phone

log = logging.getLogger(__name__)

LAST_SUMMARIES = 3
MAX_SUMMARY_CHARS = 1000
MAX_HISTORY_MESSAGES = 60
ROLES = {"customer": "customer", "bot": "bot", "agent": "bot"}     # el contrato solo distingue al cliente de quien le contesta


def _customer_ref(db, org_id: str, phone: str):
    return db.collection("customers").document(customer_id(org_id, normalize_mx_phone(phone)))


def load(db, org_id: str | None, phone: str) -> Expediente:
    """Expediente de un cliente; vacío si no hay organización, ficha ni resúmenes. Nunca lanza: el bot contesta aunque falle."""
    if not org_id or not phone:
        return Expediente()
    try:
        ref = _customer_ref(db, org_id, phone)
        snap = ref.get()
        card = (snap.to_dict() or {}) if snap.exists else {}
        datos = {"nombre": card["name"]} if card.get("name") else {}
        rows = ref.collection("summaries").order_by("closedAt", direction="DESCENDING").limit(LAST_SUMMARIES).stream()
        summaries = [(r.to_dict() or {}).get("summary", "") for r in rows]
        return Expediente(datos=datos, resumenes=[s for s in reversed(summaries) if s])      # del más viejo al más reciente
    except Exception:
        log.exception("no se pudo cargar el expediente de %s", phone)
        return Expediente()


def history_of(db, conv_id: str) -> list[HistoryItem]:
    """Mensajes de la conversación para el resumen: cliente y quien contestó, sin notas ni mensajes de sistema."""
    rows = db.collection("conversations").document(conv_id).collection("messages").order_by("createdAt").stream()
    items = []
    for row in rows:
        m = row.to_dict() or {}
        if ROLES.get(m.get("sender")) and m.get("text"):
            items.append(HistoryItem(ROLES[m["sender"]], m["text"]))
    return items[-MAX_HISTORY_MESSAGES:]


def _mark(db, conv_id: str, now: datetime | None = None) -> None:
    """`summaryAt` posterior a `closedAt` = ya resuelta. Un nuevo cierre re-estampa `closedAt` y la vuelve a pendiente."""
    db.collection("conversations").document(conv_id).update({"summaryAt": now or datetime.now(timezone.utc)})


def summarize(db, conv_id: str, conv: dict, summarizer=bot_client.summarize) -> str:
    """Pide el resumen de una conversación cerrada y lo guarda. Devuelve el resultado: `saved`, `skipped` (nada que resumir) o `failed`.

    Reescribe el resumen de la conversación si se cerró de nuevo tras una reapertura (la clave es el id de la conversación).
    """
    org_id, phone = conv.get("organizationId"), conv.get("customerPhone")
    history = history_of(db, conv_id)
    if not org_id or not phone or not any(h.role == "customer" for h in history):
        _mark(db, conv_id)        # sin cliente identificado o sin que el cliente haya escrito (p. ej. solo una campaña): no se reintenta
        return "skipped"
    ref = _customer_ref(db, org_id, phone)
    others = ref.collection("summaries").order_by("closedAt", direction="DESCENDING").limit(LAST_SUMMARIES + 1).stream()
    previous = [d for r in others if r.id != conv_id and (d := (r.to_dict() or {}).get("summary"))][:LAST_SUMMARIES]
    response = summarizer(SummaryRequest(bot_id=conv.get("botId") or "", conversation_id=conv_id, history=history,
                                         previous_summaries=list(reversed(previous))))
    if not response.ok:
        log.warning("resumen de %s falló: %s", conv_id, response.error.code if response.error else "?")
        return "failed"
    now = datetime.now(timezone.utc)
    ref.collection("summaries").document(conv_id).set({
        "conversationId": conv_id, "botId": conv.get("botId"), "summary": response.summary[:MAX_SUMMARY_CHARS],
        "closedAt": conv.get("closedAt") or now, "createdAt": now,
    })
    _mark(db, conv_id, now)
    return "saved"
