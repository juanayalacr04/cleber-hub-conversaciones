"""Envío y mantenimiento de campañas (tarea 1.39): lo que hacían `api/broadcasts/[id]/send|retry|test-send|refresh|check-status`.

    send           Manda la plantilla a los destinatarios `pending`, en grupos paralelos
    retry          Reintenta los `failed` y `skipped`
    send_test      Manda un destinatario de la campaña a un teléfono de prueba
    refresh        Recalcula los destinatarios de una campaña de recordatorio o no-show desde las citas de Salesforce
                   (a mano desde la pantalla, o en `scheduled=True` por el job nocturno de `jobs/reminders.py`)
    check_status   Consulta al proveedor si lo enviado ya se entregó

Por cada destinatario: se busca su conversación abierta (o se crea una saliente con la etiqueta `broadcast`), se
guardan `<<PLANTILLA>>` y `<<CONTEXTO>>` como mensajes del bot, se le cuenta esa sesión al bot en segundo plano y se
manda la plantilla por el proveedor del número. Si el cliente ya recibió una plantilla en las últimas 24 h sin
responder, se omite (`skipped`) con la hora en que podrá recibir otra.

El envío por proveedor entra por `core.outbound` (el router de canal). Los errores de negocio salen como
`UserActionError`; el envío de un destinatario que falla no detiene a los demás: queda `failed` con el detalle.
"""
import logging
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from google.cloud import firestore

from ai import engine  # transitorio, como en core/pipeline.py: pasa a la función 3 (1.35)
from contracts.actions import DATOS_INVALIDOS, ERROR_EXTERNO, PRECONDICION_FALLIDA, RECURSO_NO_ENCONTRADO
from core import conversations as cv, outbound
from core.db import get_executor
from core.numbers import get_bot_by_id
from core.user_actions import UserActionError
from core.utils import as_utc, to_e164
from crm import campaign_events, salesforce

log = logging.getLogger(__name__)

WINDOW = timedelta(hours=24)
STALE_SENDING = timedelta(minutes=10)   # una campaña "sending" más tiempo que esto se da por interrumpida
RATE_LIMIT_DELAY = 0.05                 # ~20 mensajes por segundo por grupo
PARALLEL_GROUPS = 4
BATCH = 500
SENT_RETENTION = timedelta(days=90)   # el job programado olvida lo enviado hace más de esto: la misma cita puede volver a avisarse
TZ = ZoneInfo("America/Mexico_City")

_sleep = time.sleep

CONTEXT_FIELDS = (("taller", "TALLER"), ("auto", "AUTO"), ("operacion", "OPERACION"), ("vin", "VIN"), ("tipoCita", "TIPO CITA"),
                  ("recepcionista", "RECEPCIONISTA"), ("email", "EMAIL"), ("observaciones", "OBSERVACIONES"),
                  ("fechaCita", "FECHA CITA"), ("horaCita", "HORA CITA"), ("idReservacion", "ID RESERVACION"), ("idQuiter", "ID QUITER"))


# --------------------------------------------------------------------------- piezas puras

def context_message(name: str | None, variables: dict | None) -> str:
    parts = [f"CONTACTO: {name}"] if name else []
    parts += [f"{label}: {variables[key]}" for key, label in CONTEXT_FIELDS if variables and variables.get(key)]
    return f"<<CONTEXTO>> {', '.join(parts)}"


def recipient_context(instructions: str | None, recipient: dict) -> str | None:
    """Contexto del destinatario para el bot: las instrucciones de la campaña más sus datos."""
    parts = [instructions] if instructions else []
    if recipient.get("name"):
        parts.append(f"Nombre del cliente: {recipient['name']}")
    if recipient.get("variables"):
        parts.append("Datos adicionales: " + ", ".join(f"{k}: {v}" for k, v in recipient["variables"].items()))
    return ". ".join(parts) or None


def blocked_until(conv: dict, now: datetime) -> datetime | None:
    """Si ya se le mandó una plantilla en las últimas 24 h y no ha respondido, cuándo podrá recibir otra."""
    last_template, last_customer = as_utc(conv.get("lastTemplateSentAt")), as_utc(conv.get("lastCustomerMessageAt"))
    if last_template and now - last_template < WINDOW and (last_customer is None or last_customer < last_template):
        return last_template + WINDOW
    return None


def format_available_at(when: datetime) -> str:
    local, today = when.astimezone(TZ), datetime.now(TZ).date()
    hour = local.strftime("%H:%M")
    if local.date() == today:
        return f"hoy a las {hour} (CDMX)"
    if local.date() == today + timedelta(days=1):
        return f"mañana a las {hour} (CDMX)"
    return f"{local.day}/{local.month}/{local.year} a las {hour} (CDMX)"


def _skip_message(until: datetime) -> str:
    return f"Plantilla sin respuesta en las últimas 24h — puedes enviar {format_available_at(until)}"


def _background(fn, *args) -> None:
    get_executor().submit(fn, *args)


def _stale(broadcast: dict, now: datetime) -> bool:
    started = as_utc(broadcast.get("sendingStartedAt"))
    return started is None or now - started > STALE_SENDING


# --------------------------------------------------------------------------- campaña en curso

class Campaign:
    """Una campaña lista para enviar: su número, la configuración de Salesforce y su bot ya resueltos."""

    def __init__(self, db, broadcast_id: str, broadcast: dict):
        self.db, self.id, self.broadcast = db, broadcast_id, broadcast
        self.ref = db.collection("broadcasts").document(broadcast_id)
        self.org_id = broadcast["organizationId"]
        snap = db.collection("whatsappNumbers").document(broadcast["whatsappNumberId"]).get()
        if not snap.exists:
            raise UserActionError(RECURSO_NO_ENCONTRADO, "WhatsApp number not found")
        self.number = snap.to_dict() or {}
        org = db.collection("organizations").document(self.org_id).get().to_dict() or {}
        self.sf_config = salesforce.resolve_config(org.get("salesforceConfig"), broadcast.get("vertical"))
        self.bot = get_bot_by_id(broadcast["botId"], db) if broadcast.get("botId") else None

    def ensure_ready(self) -> None:
        error = outbound.check_campaign(self.number, self.sf_config)
        if error:
            raise UserActionError(PRECONDICION_FALLIDA, error)

    # -- conversación

    def _record(self, conv_id: str, plantilla: str, contexto: str, updates: dict) -> None:
        """Guarda `<<PLANTILLA>>` y `<<CONTEXTO>>` como mensajes del bot y actualiza la conversación, en un lote."""
        conv_ref = self.db.collection("conversations").document(conv_id)
        batch, now = self.db.batch(), firestore.SERVER_TIMESTAMP
        for text in (plantilla, contexto):
            msg = conv_ref.collection("messages").document()
            batch.set(msg, {"id": msg.id, "conversationId": conv_id, "sender": "bot", "agentId": None, "text": text,
                            "mediaUrl": None, "createdAt": now})
        batch.update(conv_ref, {"lastMessageAt": now, "lastMessageSender": "bot", "lastMessagePreview": plantilla[:100],
                                "broadcastId": self.id, "broadcastName": self.broadcast.get("name"), **updates})
        batch.commit()

    def _create_conversation(self, phone: str, name: str | None, tags: list, extra: dict) -> str:
        conv_id, _, _ = cv.create_new_conversation(
            self.db, self.broadcast.get("botId"), self.org_id, f"whatsapp:{phone}", self.number.get("teamId"),
            self.broadcast["whatsappNumberId"], bot_config=self.bot, customer_name=name, direction="outbound", source="broadcast")
        vertical = self.broadcast.get("vertical")
        self.db.collection("conversations").document(conv_id).update({"tags": tags, **({"vertical": vertical} if vertical else {}), **extra})
        return conv_id

    def _messages(self, recipient: dict) -> tuple[str, str]:
        body = self.broadcast.get("templateBody") or self.broadcast.get("templateName")
        return f"<<PLANTILLA>> {body}", context_message(recipient.get("name"), recipient.get("variables"))

    def _prime(self, conv_id: str, plantilla: str, contexto: str) -> None:
        # En segundo plano: son 1-2 llamadas lentas a Abacus por destinatario y esperarlas en serie fue la causa de que
        # el envío venciera a medias. La sesión solo necesita estar lista antes de que el cliente conteste.
        if self.bot:
            _background(engine.prime_session, self.bot, conv_id, f"{plantilla}\n{contexto}")

    # -- un destinatario

    def process(self, snap, resume: bool = False) -> str:
        """Procesa un destinatario y devuelve `sent`, `failed` o `skipped`. Nunca lanza."""
        rec, phone = snap.to_dict() or {}, (snap.to_dict() or {}).get("phone", "")
        try:
            conv_id = rec.get("conversationId") if resume else None
            conv_id = conv_id or cv.find_open_conversation(self.db, f"whatsapp:{phone}", self.org_id)
            conv = None
            if conv_id:
                found = self.db.collection("conversations").document(conv_id).get()
                conv = found.to_dict() if found.exists else None
            if conv:
                until = blocked_until(conv, datetime.now(timezone.utc))
                if until:
                    snap.reference.update({"status": "skipped", "errorMessage": _skip_message(until)})
                    return "skipped"
            plantilla, contexto = self._messages(rec)
            link = {"lastBroadcastRecipientId": snap.id}
            if not conv:
                conv_id = self._create_conversation(phone, rec.get("name"), ["broadcast"], {
                    **link, "broadcastContext": recipient_context(self.broadcast.get("botInstructions"), rec)})
                self._record(conv_id, plantilla, contexto, {})
                self._prime(conv_id, plantilla, contexto)
            elif not resume:
                # Conversación abierta: se le agrega el contexto. En un reintento ya lo tiene del primer intento.
                self._record(conv_id, plantilla, contexto, link)
                self._prime(conv_id, plantilla, contexto)

            message_id = outbound.send_campaign(self.number, self.broadcast, rec, phone, self.sf_config)
            # La ventana de 24 h corre desde que el proveedor aceptó la plantilla, no desde que se preparó el envío
            self.db.collection("conversations").document(conv_id).update(
                {"lastTemplateSentAt": firestore.SERVER_TIMESTAMP, "broadcastId": self.id, "broadcastName": self.broadcast.get("name")})
            snap.reference.update({"status": "sent", "conversationId": conv_id, "whatsappMessageId": message_id,
                                   "errorMessage": None, "sentAt": firestore.SERVER_TIMESTAMP})
            _sleep(RATE_LIMIT_DELAY)
            return "sent"
        except Exception as e:
            log.error("Error enviando la campaña %s a %s: %s", self.id, phone, e)
            snap.reference.update({"status": "failed", "errorMessage": getattr(e, "message", None) or str(e) or "Unknown error"})
            return "failed"


# --------------------------------------------------------------------------- operaciones

def send(db, broadcast_id: str, broadcast: dict) -> dict:
    """Envía los destinatarios pendientes. Reanudable: una campaña `sending` interrumpida vuelve a correr."""
    if broadcast.get("status") not in ("draft", "sending"):
        raise UserActionError(PRECONDICION_FALLIDA, f"Broadcast is already {broadcast.get('status')}")
    campaign = Campaign(db, broadcast_id, broadcast)
    campaign.ensure_ready()
    if broadcast["status"] == "draft":
        campaign.ref.update({"status": "sending", "sendingStartedAt": firestore.SERVER_TIMESTAMP})

    pending = list(campaign.ref.collection("recipients").where("status", "==", "pending").stream())

    def run_group(group) -> dict:
        counts = {"sent": 0, "failed": 0, "skipped": 0}
        for snap in group:
            counts[campaign.process(snap)] += 1
        campaign.ref.update({"sentCount": firestore.Increment(counts["sent"]), "failedCount": firestore.Increment(counts["failed"]),
                             "skippedCount": firestore.Increment(counts["skipped"])})
        return counts

    results = list(get_executor().map(run_group, [pending[i::PARALLEL_GROUPS] for i in range(PARALLEL_GROUPS)]))
    total = {k: sum(r[k] for r in results) for k in ("sent", "failed", "skipped")}
    campaign.ref.update({"status": "failed" if total["sent"] == 0 and total["failed"] > 0 else "completed",
                         "completedAt": firestore.SERVER_TIMESTAMP})
    return {"done": True, "sentCount": total["sent"], "failedCount": total["failed"], "skippedCount": total["skipped"]}


def retry(db, broadcast_id: str, broadcast: dict) -> dict:
    """Reintenta los destinatarios `failed` y `skipped`. Una campaña `sending` interrumpida (sin avance en 10 min) se recupera."""
    if broadcast.get("status") == "sending" and not _stale(broadcast, datetime.now(timezone.utc)):
        raise UserActionError(PRECONDICION_FALLIDA, "Broadcast is currently sending")
    campaign = Campaign(db, broadcast_id, broadcast)
    campaign.ensure_ready()
    recipients = campaign.ref.collection("recipients")
    before = {"failed": list(recipients.where("status", "==", "failed").stream()),
              "skipped": list(recipients.where("status", "==", "skipped").stream())}
    todo = [(state, snap) for state, snaps in before.items() for snap in snaps]
    if not todo:
        return {"message": "No failed or skipped recipients to retry", "retriedCount": 0, "failedCount": 0}

    campaign.ref.update({"status": "sending", "sendingStartedAt": firestore.SERVER_TIMESTAMP})
    after = {"sent": 0, "failed": 0, "skipped": 0}
    for _, snap in todo:
        after[campaign.process(snap, resume=True)] += 1
    # Los contadores cambian por la diferencia entre cómo estaban y cómo quedaron
    campaign.ref.update({
        "status": "failed" if after["sent"] == 0 and after["failed"] > 0 else "completed",
        "sentCount": firestore.Increment(after["sent"]),
        "failedCount": firestore.Increment(after["failed"] - len(before["failed"])),
        "skippedCount": firestore.Increment(after["skipped"] - len(before["skipped"])),
        "completedAt": firestore.SERVER_TIMESTAMP,
    })
    return {"retriedCount": after["sent"], "failedCount": after["failed"], "skippedCount": after["skipped"], "total": len(todo)}


def send_test(db, broadcast_id: str, broadcast: dict, test_phone: str, recipient_id: str | None = None) -> dict:
    """Manda a `test_phone` el mensaje de un destinatario de la campaña (el indicado, o el primero), sin tocarlo."""
    campaign = Campaign(db, broadcast_id, broadcast)
    campaign.ensure_ready()
    recipients = campaign.ref.collection("recipients")
    if recipient_id:
        snap = recipients.document(recipient_id).get()
        if not snap.exists:
            raise UserActionError(RECURSO_NO_ENCONTRADO, "Destinatario no encontrado")
        chosen = [snap]
    else:
        chosen = list(recipients.limit(1).stream())

    phone = to_e164(test_phone)
    results = []
    for index, snap in enumerate(chosen, start=1):
        rec = snap.to_dict() or {}
        try:
            conv_id = cv.find_open_conversation(db, f"whatsapp:{phone}", campaign.org_id)
            conv = db.collection("conversations").document(conv_id).get().to_dict() if conv_id else None
            until = blocked_until(conv, datetime.now(timezone.utc)) if conv else None
            if until:
                results.append({"index": index, "success": False, "error": _skip_message(until)})
                continue
            outbound.send_campaign(campaign.number, broadcast, rec, phone, campaign.sf_config, track=False)
            plantilla, contexto = campaign._messages(rec)
            if conv_id:
                campaign._record(conv_id, plantilla, contexto, {"lastTemplateSentAt": firestore.SERVER_TIMESTAMP})
            else:
                conv_id = campaign._create_conversation(phone, None, ["broadcast", "test"], {"lastTemplateSentAt": firestore.SERVER_TIMESTAMP})
                campaign._record(conv_id, plantilla, contexto, {})
            if campaign.bot:
                engine.prime_session(campaign.bot, conv_id, f"{plantilla}\n{contexto}")
            results.append({"index": index, "success": True, "conversationId": conv_id})
            _sleep(RATE_LIMIT_DELAY)
        except Exception as e:
            results.append({"index": index, "success": False, "error": getattr(e, "message", None) or str(e) or "Unknown error"})
    sent = sum(1 for r in results if r["success"])
    return {"sent": sent, "failed": len(results) - sent,
            "conversationId": next((r["conversationId"] for r in results if r.get("conversationId")), None), "results": results}


def refresh(db, broadcast_id: str, broadcast: dict, scheduled: bool = False) -> dict:
    """Recalcula los destinatarios desde las citas de Salesforce: conserva los ya enviados y reemplaza el resto.

    A mano (`scheduled=False`) se conservan todos los enviados y los contadores se reinician. El job programado
    (`scheduled=True`) solo conserva lo enviado en los últimos 90 días, no toca los contadores y usa las credenciales
    de Servicio si la campaña no declara módulo.
    """
    if broadcast.get("type") not in campaign_events.REMINDER_TYPES:
        raise UserActionError(DATOS_INVALIDOS, "Solo broadcasts de tipo appointment_reminder o no_show pueden refrescarse")
    ref = db.collection("broadcasts").document(broadcast_id)
    if broadcast.get("status") == "sending":
        if not _stale(broadcast, datetime.now(timezone.utc)):
            raise UserActionError(PRECONDICION_FALLIDA, "No se puede refrescar mientras se está enviando")
        ref.update({"status": "failed", "completedAt": firestore.SERVER_TIMESTAMP})  # interrumpida: se destraba
        broadcast = {**broadcast, "status": "failed"}
    config = broadcast.get("reminderConfig") or {}
    if not config.get("eventType"):
        raise UserActionError(DATOS_INVALIDOS, "Missing reminderConfig.eventType")
    if broadcast["type"] == "appointment_reminder" and config.get("daysBefore") is None:
        raise UserActionError(DATOS_INVALIDOS, "Missing reminderConfig.daysBefore")

    org = db.collection("organizations").document(broadcast["organizationId"]).get().to_dict() or {}
    sf_config = salesforce.resolve_config(org.get("salesforceConfig"), broadcast.get("vertical") or ("servicio" if scheduled else None))
    if not salesforce.has_credentials(sf_config):
        raise UserActionError(PRECONDICION_FALLIDA, "Salesforce no configurado (variables SF_*)")
    events = salesforce.query_all(sf_config, campaign_events.build_query(broadcast, org))
    if events is None:
        raise UserActionError(ERROR_EXTERNO, "No se pudieron consultar las citas en Salesforce", retryable=True)
    recipients, skipped = campaign_events.build_recipients(events, campaign_events.field_map(org.get("sfBrandCode")),
                                                           broadcast.get("variableMapping"))

    recipients_ref = ref.collection("recipients")
    sent_ids, stale_refs = set(), []
    keep_since = datetime.now(timezone.utc) - SENT_RETENTION
    for snap in recipients_ref.stream():
        data = snap.to_dict() or {}
        sent_at = as_utc(data.get("sentAt"))
        if data.get("status") in ("sent", "delivered", "read") and (not scheduled or (sent_at and sent_at > keep_since)):
            if data.get("salesforceRecordId"):
                sent_ids.add(data["salesforceRecordId"])
        else:
            stale_refs.append(snap.reference)
    for start in range(0, len(stale_refs), BATCH):
        batch = db.batch()
        for stale in stale_refs[start:start + BATCH]:
            batch.delete(stale)
        batch.commit()

    new = [r for r in recipients if r["salesforceRecordId"] not in sent_ids]
    for start in range(0, len(new), BATCH):
        batch = db.batch()
        for r in new[start:start + BATCH]:
            doc = recipients_ref.document()
            batch.set(doc, {"id": doc.id, **r, "conversationId": None, "status": "pending", "errorMessage": None,
                            "whatsappMessageId": None, "sentAt": None})
        batch.commit()

    preserved = len(sent_ids)
    if scheduled:
        ref.update({"status": "draft" if new else broadcast.get("status"), "totalRecipients": preserved + len(new),
                    "completedAt": None if new else broadcast.get("completedAt"), "lastRefreshedAt": firestore.SERVER_TIMESTAMP})
        return {"recipients": len(recipients), "skipped": len(skipped)}
    ref.update({"status": "draft" if new else broadcast.get("status"), "totalRecipients": len(new) + preserved, "sentCount": preserved,
                "deliveredCount": 0, "failedCount": 0, "skippedCount": 0, "completedAt": None,
                "lastRefreshedAt": firestore.SERVER_TIMESTAMP})
    return {"recipients": len(new), "preserved": preserved, "skipped": len(skipped), "skippedDetails": skipped}


def check_status(db, broadcast_id: str, broadcast: dict) -> dict:
    """Consulta al proveedor (ValueText o Twilio) el estado de entrega de lo enviado. Un estado final no se vuelve a consultar."""
    campaign = Campaign(db, broadcast_id, broadcast)
    if campaign.number.get("provider") not in ("valuetext", "twilio"):
        raise UserActionError(DATOS_INVALIDOS, "Solo disponible para campañas ValueText o Twilio")
    sent = list(campaign.ref.collection("recipients").where("status", "==", "sent").stream())
    pending = {(s.to_dict() or {})["whatsappMessageId"]: s for s in sent
               if (s.to_dict() or {}).get("whatsappMessageId") and not (s.to_dict() or {}).get("deliveryStatus")}
    if not pending:
        return {"checked": 0, "delivered": 0, "failed": 0}
    campaign.ensure_ready()

    delivered = failed = 0
    for message_id, result in outbound.delivery_statuses(campaign.number, list(pending), campaign.sf_config).items():
        if message_id not in pending:
            continue
        pending[message_id].reference.update({"deliveryStatus": result["state"], "deliveryStatusMessage": result.get("message")})
        failed, delivered = (failed + 1, delivered) if result["state"] == "failed" else (failed, delivered + 1)
    updates = {**({"deliveredCount": firestore.Increment(delivered)} if delivered else {}),
               **({"failedCount": firestore.Increment(failed)} if failed else {})}
    if updates:
        campaign.ref.update(updates)
    return {"checked": len(pending), "delivered": delivered, "failed": failed}
