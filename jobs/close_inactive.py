"""Cierre por inactividad de las conversaciones atendidas por un asesor (tarea 1.32).

Portado del cron `close-inactive` del dashboard. Cierra las conversaciones `waiting_agent` y `with_agent` (y las `bot` con cita,
que no reciben recordatorios) sin mensajes hace más de `inactivityCloseHours` de su número de WhatsApp (2 por defecto). Las
`bot` sin cita las maneja la escalera de recordatorios (`jobs/inactivity_ladder.py`).

`statusBeforeClose` y `agentBeforeClose` los lee la reapertura: si la conversación ya la traía un asesor al cerrarse, vuelve con
él y no al bot. El outcome pasa a `inactividad`, salvo que ya sea terminal (cita agendada).
"""
import logging
from datetime import datetime, timedelta, timezone

from google.cloud import firestore

from core.db import get_db
from core.outcomes import DEFAULT_TERMINAL_OUTCOMES
from core.utils import as_utc

log = logging.getLogger(__name__)

DEFAULT_INACTIVITY_HOURS = 2
BATCH = 400
APPOINTMENT_STATUSES = ("cita_bot", "cita_agente")


def run(db=None, now: datetime | None = None) -> dict:
    db = db or get_db()
    now = now or datetime.now(timezone.utc)
    hours_by_number, min_hours = {}, DEFAULT_INACTIVITY_HOURS
    for snap in db.collection("whatsappNumbers").where("status", "==", "active").stream():
        hours = (snap.to_dict() or {}).get("inactivityCloseHours")
        hours = hours if isinstance(hours, (int, float)) and not isinstance(hours, bool) and hours > 0 else DEFAULT_INACTIVITY_HOURS
        hours_by_number[snap.id] = hours
        min_hours = min(min_hours, hours)

    candidates = db.collection("conversations").where("status", "in", ["bot", "waiting_agent", "with_agent"]) \
        .where("lastMessageAt", "<", now - timedelta(hours=min_hours)).stream()
    closed, batch, pending = [], db.batch(), 0
    for snap in candidates:
        conv = snap.to_dict() or {}
        hours = hours_by_number.get(conv.get("whatsappNumberId"), DEFAULT_INACTIVITY_HOURS)
        last = as_utc(conv.get("lastMessageAt"))
        if not last or last >= now - timedelta(hours=hours):
            continue
        if conv.get("status") == "bot" and conv.get("appointmentStatus") not in APPOINTMENT_STATUSES:
            continue   # las maneja la escalera de recordatorios
        updates = {"status": "closed", "statusBeforeClose": conv.get("status"), "agentBeforeClose": conv.get("assignedAgentId"),
                   "assignedAgentId": None, "assignedAt": None, "closedAt": firestore.SERVER_TIMESTAMP, "closedReason": "inactivity"}
        if conv.get("conversationOutcome") not in DEFAULT_TERMINAL_OUTCOMES:
            updates.update({"conversationOutcome": "inactividad", "conversationOutcomeAt": firestore.SERVER_TIMESTAMP,
                            "conversationOutcomeHistory": firestore.ArrayUnion([{"outcome": "inactividad", "at": now}])})
        batch.update(snap.reference, updates)
        closed.append(snap.id)
        pending += 1
        if pending == BATCH:
            batch.commit()
            batch, pending = db.batch(), 0
    if pending:
        batch.commit()
    log.info("close-inactive: %d conversaciones cerradas", len(closed))
    return {"closed": len(closed), "conversationIds": closed}
