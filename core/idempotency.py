"""Idempotencia por (source, externalId): la que pide el contrato de entrada de la Fase 2 (tarea 1.8).

Generaliza `_is_duplicate_lead`: ya no es "lead", es cualquier evento de cualquier sistema origen.
"""
import logging
from datetime import datetime, timezone

from core.db import get_db, run_transaction

log = logging.getLogger(__name__)
COLLECTION = "processed_events"


def event_key(source: str, external_id: str) -> str:
    return f"{source}__{external_id}"


def is_duplicate(source: str, external_id: str, db=None) -> bool:
    """True si el evento ya se procesó; si no, lo marca como procesado (atómico).

    Ante un fallo devuelve False: es preferible reprocesar a perder un evento.
    """
    if not source or not external_id:
        return False
    db = db or get_db()
    ref = db.collection(COLLECTION).document(event_key(source, external_id))

    def _check_and_mark(txn):
        if ref.get(transaction=txn).exists:
            return True
        txn.set(ref, {"source": source, "externalId": external_id, "processedAt": datetime.now(timezone.utc)})
        return False

    try:
        return run_transaction(_check_and_mark, db=db)
    except Exception as e:
        log.error("idempotency_error source=%s external_id=%s error=%s", source, external_id, e)
        return False
