"""Resumen de las conversaciones cerradas para el expediente del cliente (tarea 1.38).

Busca las conversaciones que se cerraron en los últimos `WINDOW_DAYS` días y no tienen resumen posterior al cierre (`summaryAt` vacío
o anterior a `closedAt`: una reapertura y nuevo cierre la vuelve pendiente), y pide el resumen a la función 3. Cubre cualquier camino
de cierre. Lo anterior a la ventana no se resume (D15: el expediente arranca vacío). Un fallo se reintenta en el siguiente tick.
"""
import logging
from datetime import datetime, timedelta, timezone

from core import bot_client, expediente
from core.db import get_db
from core.utils import as_utc

log = logging.getLogger(__name__)

WINDOW_DAYS = 3
MAX_PER_TICK = 25          # cada resumen es una llamada a un LLM: un tick no debe pasar del timeout de la función


def run(db=None, now: datetime | None = None, summarizer=bot_client.summarize) -> dict:
    db = db or get_db()
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=WINDOW_DAYS)
    result = {"saved": 0, "skipped": 0, "failed": 0}
    handled = 0
    for snap in db.collection("conversations").where("status", "==", "closed").where("closedAt", ">", since).stream():
        conv = snap.to_dict() or {}
        closed, summarized = as_utc(conv.get("closedAt")), as_utc(conv.get("summaryAt"))
        if summarized and closed and summarized >= closed:
            continue
        if handled == MAX_PER_TICK:
            break
        handled += 1
        try:
            result[expediente.summarize(db, snap.id, conv, summarizer)] += 1
        except Exception:
            log.exception("error resumiendo la conversación %s", snap.id)
            result["failed"] += 1
    log.info("conversation-summaries: %s", result)
    return result
