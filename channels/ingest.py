"""Consumidor de la cola en la función 2 (tarea 1.34): recibe los eventos del router y los aplica.

    POST /queue/incoming      push de Pub/Sub (suscripción con orden por clave y `ack deadline` largo: el turno llama a Abacus)
    Autenticación             `?secret=` o `X-Queue-Secret` == `QUEUE_PUSH_SECRET`; falla cerrado (`ALLOW_UNAUTHENTICATED_QUEUE=true`
                              en desarrollo)

El 2xx es el acuse: Pub/Sub no entrega el siguiente evento de la misma conversación hasta recibirlo, así que el evento se procesa
**antes** de responder (no en segundo plano). Por eso se respeta el orden sin tocar `core/claims.py`: dos mensajes seguidos del cliente ya
no corren en paralelo; el claim queda como defensa para lo demás (Salesforce, jobs).

La cola entrega al menos una vez, así que cada evento con ID se deduplica aquí también (`ingest`, distinto de la marca del router).
Un error transitorio responde 500 y suelta la marca, para que Pub/Sub lo reintente; un evento que no cumple el contrato responde 200
(se descarta con un error en el log): reintentarlo no lo arreglaría y bloquearía la clave de orden para siempre.
"""
import base64
import binascii
import hmac
import json
import logging
import os

from channels import inbound
from channels.meta_wa import process_meta_status
from channels.twilio_wa import process_twilio_status
from contracts.base import ContractError
from contracts.messages import ChannelEvent
from core import idempotency
from core.conversations import save_agent_outbound, save_template_outbound

log = logging.getLogger(__name__)

SOURCE = "ingest"


def authorized(args, headers, env=None) -> bool:
    env = os.environ if env is None else env
    secret = env.get("QUEUE_PUSH_SECRET", "")
    if not secret:
        return env.get("ALLOW_UNAUTHENTICATED_QUEUE", "").lower() == "true"
    given = headers.get("X-Queue-Secret") or (args or {}).get("secret") or ""
    return hmac.compare_digest(given.encode(), secret.encode())


def process_event(event: ChannelEvent, db=None) -> bool:
    """Aplica un evento. Devuelve False si era un duplicado ya aplicado."""
    if event.event_id and idempotency.is_duplicate(SOURCE, event.event_id, db=db):
        log.info("ingest: duplicado ignorado, id=%s", event.event_id)
        return False
    try:
        if event.kind == "message":
            inbound.process_incoming(event.message, db)
        elif event.kind == "status":
            s = event.status
            if s.provider == "meta":
                process_meta_status({"id": s.provider_message_id, "status": s.status}, db=db)
            else:
                process_twilio_status(s.provider_message_id, s.status, s.error, db=db)
        else:
            o = event.outbound
            if o.is_template:
                save_template_outbound(o.to_number, o.from_number, o.body, db=db)
            else:
                save_agent_outbound(o.to_number, o.from_number, o.body, o.media_url, db=db)
    except Exception:
        if event.event_id:
            idempotency.release(SOURCE, event.event_id, db=db)     # que el reintento no lo tome por duplicado
        raise
    return True


def _decode(body) -> ChannelEvent:
    """Sobre de Pub/Sub -> evento. `ContractError` si no es un evento válido."""
    message = (body or {}).get("message") if isinstance(body, dict) else None
    if not isinstance(message, dict) or not message.get("data"):
        raise ContractError("el cuerpo no es un push de Pub/Sub")
    try:
        data = json.loads(base64.b64decode(message["data"], validate=True))
    except (binascii.Error, ValueError) as e:
        raise ContractError(f"el evento no se pudo decodificar: {e}")
    return ChannelEvent.from_dict(data)


def handle(args, headers, body, env=None, db=None) -> tuple[dict, int]:
    """Entry point HTTP del push. 401 sin secreto, 200 al procesar (o al descartar lo inválido), 500 ante un fallo transitorio."""
    if not authorized(args, headers, env):
        return {"error": "Unauthorized"}, 401
    try:
        event = _decode(body)
    except ContractError as e:
        log.error("evento descartado: %s", e)
        return {"discarded": str(e)}, 200
    try:
        applied = process_event(event, db)
    except Exception:
        log.exception("error aplicando el evento %s", event.event_id or event.kind)
        return {"error": "Internal error"}, 500
    return {"ok": True, "duplicate": not applied}, 200
