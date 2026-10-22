"""Resultado de la conversación (outcome): cierre de ciclo que Comercial no tenía y Servicio sí.

Base del contrato de salida hacia otros sistemas. El vocabulario y cuáles outcomes son terminales
son configuración del módulo; los valores por defecto son los de Servicio.
"""
import logging
from datetime import datetime, timezone

from google.cloud import firestore

from core.db import get_db, run_transaction

log = logging.getLogger(__name__)
DEFAULT_TERMINAL_OUTCOMES = frozenset({"cita_bot", "cita_agente_bdc"})


def _set_outcome(txn, conv_ref, outcome: str, source: str, terminal: frozenset) -> None:
    current = (conv_ref.get(transaction=txn).to_dict() or {}).get("conversationOutcome")
    if source == "auto" and current in terminal:
        return
    now = datetime.now(timezone.utc)
    txn.update(conv_ref, {
        "conversationOutcome": outcome,
        "conversationOutcomeAt": now,
        "conversationOutcomeHistory": firestore.ArrayUnion([{"outcome": outcome, "at": now}]),
    })


def set_conversation_outcome(conv_id: str, outcome: str, ai_outcome: str | None = None, source: str = "auto",
                             terminal_outcomes=DEFAULT_TERMINAL_OUTCOMES, db=None) -> None:
    """Escribe conversationOutcome (el último gana) y lo acumula en conversationOutcomeHistory.

    Si `source == "auto"` (bot o crons) y el outcome actual ya es terminal, no escribe nada.
    `source == "manual"` (acción explícita del agente) siempre escribe. Va en transacción porque
    los webhooks corren en instancias concurrentes.
    """
    try:
        db = db or get_db()
        conv_ref = db.collection("conversations").document(conv_id)
        run_transaction(_set_outcome, conv_ref, outcome, source, frozenset(terminal_outcomes), db=db)
        if ai_outcome:
            conv_ref.update({"aiOutcome": ai_outcome})
    except Exception as e:
        log.error("Error guardando el outcome de %s: %s", conv_id, e)
