"""Actualización de las campañas de recordatorio de cita y de no-show (tarea 1.32).

Portado de los crons `appointment-reminders` y `no-show` del dashboard. Cada campaña de ese tipo recalcula sus destinatarios
desde las citas de Salesforce (`core.campaigns.refresh` en modo programado) y queda en `draft`, lista para enviarse. El envío
lo sigue pidiendo una persona desde la pantalla de la campaña.

Una campaña que sigue `sending` sin estar interrumpida se omite; una interrumpida (más de 10 minutos) se destraba y se refresca.
Cada campaña falla por separado y el resultado dice cuál y por qué.
"""
import logging

from core import campaigns
from core.db import get_db
from core.user_actions import UserActionError

log = logging.getLogger(__name__)


def run(broadcast_type: str, db=None) -> dict:
    db = db or get_db()
    snaps = list(db.collection("broadcasts").where("type", "==", broadcast_type).stream())
    if not snaps:
        return {"processed": 0, "message": f"No {broadcast_type} broadcasts found"}
    results = []
    for snap in snaps:
        try:
            outcome = campaigns.refresh(db, snap.id, snap.to_dict() or {}, scheduled=True)
            results.append({"broadcastId": snap.id, **outcome})
        except UserActionError as e:
            results.append({"broadcastId": snap.id, "error": e.message})
        except Exception as e:
            log.exception("%s: error con la campaña %s", broadcast_type, snap.id)
            results.append({"broadcastId": snap.id, "error": str(e)})
    return {"processed": len(results), "results": results}
