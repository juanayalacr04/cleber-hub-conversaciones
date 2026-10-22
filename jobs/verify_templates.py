"""Verificación de las plantillas de Lead de ValueText (tarea 1.32).

Portado del cron `verify-lead-templates` del dashboard. Tres minutos después de mandar la plantilla de un Lead (`smsBucketId`),
se consulta en Salesforce si ValueText ya la procesó. Si falló, el cliente nunca la recibió: la conversación pasa a `with_agent`
(`templateFailed`) y el módulo hace lo suyo con el CRM por el evento `template_failed` (Ventas marca el Lead "Error plantilla" y
pide asesor). Si salió bien, solo se marca `templateVerified`. Las conversaciones de Servicio no tienen Leads: no se tocan.
"""
import logging
from datetime import datetime, timedelta, timezone

from google.cloud import firestore

from channels.valuetext_wa import bucket_statuses
from core import handoff as ho
from core.conversations import resolve_vertical
from core.db import get_db
from core.numbers import sf_config_for
from core.tools import dispatch
from core.utils import as_utc
from crm import salesforce

log = logging.getLogger(__name__)

SETTLE = timedelta(minutes=3)   # ValueText tarda un poco en procesar el SMS_Bucket
LEAD_VERTICAL = "ventas"        # las credenciales de Salesforce de este job son las de Ventas


def run(db=None, now: datetime | None = None) -> dict:
    db = db or get_db()
    now = now or datetime.now(timezone.utc)
    by_org = {}
    for snap in db.collection("conversations").where("templateVerified", "==", False).stream():
        conv = snap.to_dict() or {}
        sent_at = as_utc(conv.get("lastTemplateMessageAt"))
        if not (sent_at and conv.get("smsBucketId") and conv.get("organizationId")) or conv.get("vertical") == "servicio":
            continue
        if sent_at > now - SETTLE:
            continue   # aún muy reciente
        by_org.setdefault(conv["organizationId"], []).append((snap, conv))

    verified = escalated = 0
    bots = {}
    for org_id, items in by_org.items():
        sf_config = sf_config_for(db, org_id, LEAD_VERTICAL)
        if not salesforce.has_credentials(sf_config):
            log.error("verify-lead-templates: faltan las credenciales SF_* en el entorno")
            continue
        statuses = bucket_statuses(sf_config, [conv["smsBucketId"] for _, conv in items])
        for snap, conv in items:
            state = statuses.get(conv["smsBucketId"])
            if not state or not state["processed"]:
                continue   # sigue pendiente en ValueText
            if state["status"] != "FAIL":
                snap.reference.update({"templateVerified": True})
                verified += 1
                continue
            bot_id = conv.get("botId")
            if bot_id and bot_id not in bots:
                bots[bot_id] = db.collection("bots").document(bot_id).get().to_dict() or {}
            bot = bots.get(bot_id)
            snap.reference.update({"status": "with_agent", "templateVerified": True, "templateFailed": True,
                                   "templateFailedAt": firestore.SERVER_TIMESTAMP})
            if not conv.get("vertical"):
                conv["vertical"] = resolve_vertical(db, conv.get("teamId"), bot)
            dispatch("template_failed", conv, {"bot": bot, "conv_id": snap.id, "db": db, "sf_config": sf_config,
                                               "within_hours": ho.check_business_hours((bot or {}).get("scheduleConfig"))})
            escalated += 1
    log.info("verify-lead-templates: verified=%d escalated=%d", verified, escalated)
    return {"verified": verified, "escalated": escalated}
