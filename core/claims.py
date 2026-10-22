"""Claims transaccionales (tarea 1.9): el patrón de `claim_lead_creation`, sin la parte de Lead.

Dos mensajes seguidos del cliente llegan como dos invocaciones paralelas del webhook y cada una
trae su propio snapshot de la conversación: un guard contra el snapshot en memoria no ve lo que
la otra invocación acaba de crear (caso real: dos Leads para la misma conversación con 10 s de
diferencia). El guard real se hace contra Firestore, en una transacción.
"""
import logging
from datetime import datetime, timezone

from google.cloud import firestore

from core.db import get_db, run_transaction
from core.utils import hours_since

log = logging.getLogger(__name__)
DEFAULT_CLAIM_TTL_SECS = 120


def claim(conv_id: str, done_field: str, claim_field: str, ttl_secs: int = DEFAULT_CLAIM_TTL_SECS, db=None) -> tuple[bool, str]:
    """Reclama atómicamente el derecho a crear el recurso que `done_field` guarda en la conversación.

    Retorna (True, "") si esta invocación debe crearlo; (False, valor) si ya existe; y
    (False, "") si otra invocación lo está creando ahora mismo (el claim vence a los `ttl_secs`).
    Un fallo de la transacción devuelve (True, ""): quedarse sin el recurso rompe más cosas que
    duplicarlo.
    """
    db = db or get_db()
    conv_ref = db.collection("conversations").document(conv_id)

    def _claim(txn):
        data = conv_ref.get(transaction=txn).to_dict() or {}
        existing = data.get(done_field) or ""
        if existing:
            return False, existing
        age = hours_since(data.get(claim_field))
        if age is not None and age * 3600 < ttl_secs:
            return False, ""
        txn.update(conv_ref, {claim_field: datetime.now(timezone.utc)})
        return True, ""

    try:
        return run_transaction(_claim, db=db)
    except Exception as e:
        log.error("claim_error conv_id=%s field=%s error=%s", conv_id, done_field, e)
        return True, ""


def release_claim(conv_id: str, claim_field: str, db=None) -> None:
    """Libera el claim cuando la creación falló, para que el siguiente turno reintente."""
    try:
        (db or get_db()).collection("conversations").document(conv_id).update({claim_field: firestore.DELETE_FIELD})
    except Exception as e:
        log.error("claim_release_error conv_id=%s field=%s error=%s", conv_id, claim_field, e)
