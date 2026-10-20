"""Registro de las acciones que un bot pidió por el endpoint (tarea 1.46).

El endpoint (`core/actions.py`) ejecuta la acción en medio del turno; el pipeline, que está esperando la respuesta del bot, no se
entera. Para saber qué pasó sin parsear lo que el bot dijo, cada acción exitosa queda en `conversations/{id}/actionLog/{idempotencyKey}`
con el `turnId` que el pipeline dejó en la conversación antes de llamar al bot. Al volver, el pipeline lee las de su turno.

Un `turnId` en vez de una hora: no depende de que los relojes de dos funciones coincidan, y una acción pedida fuera de un turno
(un job, una prueba manual) se queda con el id del último y no contamina el siguiente.
La subcolección no tiene reglas de lectura (`firestore.rules`): el navegador no la ve.
"""
import logging
import uuid
from datetime import datetime, timezone

from core.db import get_db

log = logging.getLogger(__name__)
COLLECTION = "actionLog"


def new_turn_id() -> str:
    return uuid.uuid4().hex


def mark_turn(conv_id: str, turn_id: str, db=None) -> None:
    """Deja el id del turno en curso en la conversación, para que el endpoint lo copie al registro."""
    (db or get_db()).collection("conversations").document(conv_id).update({"turnId": turn_id})


def record(conv_id: str, idempotency_key: str, event: str, tool: str, response: dict, turn_id: str | None, db=None) -> None:
    """Guarda una acción exitosa. Nunca lanza: un fallo aquí no debe tumbar la acción que ya se ejecutó."""
    try:
        (db or get_db()).collection("conversations").document(conv_id).collection(COLLECTION).document(idempotency_key.replace("/", "_")).set({
            "event": event, "tool": tool, "turnId": turn_id, "status": response.get("status"),
            "result": response.get("result") or {}, "recordedAt": datetime.now(timezone.utc),
        })
    except Exception as e:
        log.error("action_log_error conv_id=%s event=%s error=%s", conv_id, event, e)


def executed_in_turn(conv_id: str, turn_id: str, db=None) -> dict[str, dict]:
    """Las acciones del turno por evento (`{"crear_lead": {"status", "result", ...}}`). Si hubo varias del mismo evento, la última."""
    try:
        docs = (db or get_db()).collection("conversations").document(conv_id).collection(COLLECTION).where("turnId", "==", turn_id).stream()
        rows = sorted((d.to_dict() for d in docs), key=lambda r: r.get("recordedAt") or datetime.min.replace(tzinfo=timezone.utc))
    except Exception as e:
        log.error("action_log_read_error conv_id=%s error=%s", conv_id, e)
        return {}
    return {r["event"]: r for r in rows if r.get("event")}
