"""Contactos programados que ya llegaron a su hora (tarea 1.32).

Portado del cron `scheduled-contact` del dashboard. El cliente pidió que lo recontactaran (`scheduledContactAt`): si su ventana de
24 h de WhatsApp sigue abierta, el bot redacta el mensaje; si no, hace falta la plantilla de contacto programado del número
(`scheduledContactTemplateId`). Sin plantilla configurada se omite sin limpiar el campo, para que se reintente cuando la haya.
"""
import logging
from datetime import datetime, timedelta, timezone

from core.db import get_db, get_executor
from core.utils import as_utc
from jobs import inactivity

log = logging.getLogger(__name__)
WINDOW = timedelta(hours=24)


def run(db=None, now: datetime | None = None) -> dict:
    db = db or get_db()
    now = now or datetime.now(timezone.utc)
    due = list(db.collection("conversations").where("status", "==", "bot").where("scheduledContactAt", "<=", now).stream())
    results, numbers, todo = {"processed": 0, "skipped": 0, "errors": 0}, {}, []
    for snap in due:
        conv = snap.to_dict() or {}
        last_customer = as_utc(conv.get("lastCustomerMessageAt"))
        use_template = not (last_customer and now - last_customer < WINDOW)
        template_id = None
        if use_template:
            wa_id = conv.get("whatsappNumberId")
            if wa_id:
                if wa_id not in numbers:
                    numbers[wa_id] = db.collection("whatsappNumbers").document(wa_id).get().to_dict() or {}
                template_id = numbers[wa_id].get("scheduledContactTemplateId")
            if not template_id:
                log.warning("scheduled-contact: la conversación %s no tiene plantilla de contacto programado", snap.id)
                results["skipped"] += 1
                continue
        todo.append({"type": "scheduled_contact", "convId": snap.id, "botId": conv.get("botId"), "useTemplate": use_template,
                     "templateId": template_id})

    def execute(body) -> bool:
        try:
            return inactivity.run_followup(body, db)[1] == 200
        except Exception:
            log.exception("scheduled-contact: error con la conversación %s", body["convId"])
            return False

    for ok in get_executor().map(execute, todo):
        results["processed" if ok else "errors"] += 1
    return results
