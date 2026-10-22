"""Webhook `situacion-detectada` (tarea 1.39): lo recibe el bot de Ventas cuando detecta que un cliente necesita
Servicio o Postventa. Antes era una ruta pública del dashboard; ahora es un entry point de la función 2.

    POST /integrations/situacion-detectada
    Headers: X-Api-Secret: <SITUACION_API_SECRET>   (se acepta `?secret=` por compatibilidad con el integrador actual)
    Cuerpo:  {event: "situacion_detectada", situacion, targetPhone, phone, customerName?, leadId?,
              organizationId?, motivo?, sourceConversationId?}

Qué hace, en orden:
  1. Resuelve el número de Servicio (`targetPhone`) entre los números activos.
  2. Manda al cliente la plantilla de handoff de ese número por su proveedor (twilio, meta o valuetext),
     con dos variables: {{1}} = nombre del cliente, {{2}} = motivo.
  3. Reusa la conversación abierta del cliente con ese número o abre una nueva (saliente, etiqueta
     `situacion_detectada`) y guarda `<<PLANTILLA>>` y `<<CONTEXTO>>` como mensajes del bot.
  4. Le cuenta esos dos mensajes a la sesión del bot para que tenga el contexto cuando el cliente responda.

Falla cerrado: sin `SITUACION_API_SECRET` se rechaza todo (antes quedaba abierto, y este endpoint manda
plantillas de WhatsApp a cualquier teléfono), salvo `ALLOW_UNAUTHENTICATED_INTEGRATIONS=true` en desarrollo.

Estados: 401 sin secreto válido, 400 cuerpo inválido, 404 número no configurado, 500 plantilla sin configurar,
502 el proveedor no aceptó el envío.
"""
import hmac
import logging
import os

from google.cloud import firestore

from ai import engine  # transitorio, como en core/pipeline.py: pasa a la función 3 (1.35)
from core import conversations as cv, credentials, outbound
from core.db import get_db
from core.numbers import get_bot_by_id
from core.utils import to_e164
from crm import salesforce

log = logging.getLogger(__name__)

EVENT = "situacion_detectada"
SOURCE = "situacion_detectada"


def authorized(headers, args, env=None) -> bool:
    env = os.environ if env is None else env
    secret = env.get("SITUACION_API_SECRET", "")
    if not secret:
        return env.get("ALLOW_UNAUTHENTICATED_INTEGRATIONS", "").lower() == "true"
    received = headers.get("X-Api-Secret") or (args or {}).get("secret") or ""
    return hmac.compare_digest(received.encode(), secret.encode())


normalize_phone = to_e164


def _text(value) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _sf_config(db, org_id: str, vertical: str | None) -> dict:
    org = db.collection("organizations").document(org_id).get().to_dict() or {}
    return salesforce.resolve_config(org.get("salesforceConfig"), vertical)


def handle(headers, args, body, db=None, env=None) -> tuple[dict, int]:
    """Entrada HTTP. Devuelve (cuerpo, estado)."""
    if not authorized(headers, args, env):
        return {"error": "Unauthorized"}, 401
    body = body if isinstance(body, dict) else {}
    situacion, target, phone = _text(body.get("situacion")), _text(body.get("targetPhone")), _text(body.get("phone"))
    if body.get("event") != EVENT or not (situacion and target and phone):
        return {"error": "Missing or invalid required fields"}, 400
    customer_name, motivo, lead_id = _text(body.get("customerName")), _text(body.get("motivo")), _text(body.get("leadId"))

    db = db or get_db()
    raw_target = target.replace("whatsapp:", "")
    numbers = list(db.collection("whatsappNumbers").where("phoneNumber", "in", [raw_target, f"whatsapp:{raw_target}"])
                   .where("status", "==", "active").limit(1).stream())
    if not numbers:
        log.error("situacion-detectada: no hay número activo para targetPhone=%s", target)
        return {"error": "targetPhone not configured"}, 404
    number_id = numbers[0].id
    number = credentials.reveal(db, "numbers", number_id, numbers[0].to_dict() or {})
    bot_id, org_id, team_id = number.get("defaultBotId"), number.get("organizationId"), number.get("teamId")
    vertical = cv.resolve_vertical(db, team_id, None)  # el número no guarda la vertical: la tiene su equipo

    e164 = normalize_phone(phone.replace("whatsapp:", ""))
    variables = {"1": customer_name or "Cliente", "2": motivo or ""}
    try:
        outbound.send_template(number, e164, variables, lead_id=lead_id, sf_config=_sf_config(db, org_id, vertical))
    except outbound.TemplateError as e:
        return {"error": e.message}, 500 if e.kind == outbound.NOT_CONFIGURED else 502

    # Conversación: la abierta de este cliente con este número, o una nueva
    customer_phone = f"whatsapp:{e164}"
    bot = get_bot_by_id(bot_id, db) if bot_id else None
    conv_id = cv.find_open_conversation(db, customer_phone, org_id)
    if conv_id is None:
        conv_id, _, _ = cv.create_new_conversation(db, bot_id, org_id, customer_phone, team_id, number_id, bot_config=bot,
                                                   customer_name=customer_name, direction="outbound", source=SOURCE)

    preview = number.get("serviceHandoffTemplatePreview") or number.get("serviceHandoffTemplateName") \
        or number.get("serviceHandoffContentSid") or "Handoff a Servicio"
    plantilla = f"<<PLANTILLA>> {preview}"
    contexto = f"<<CONTEXTO>> NOMBRE: {customer_name or 'Cliente'}, MOTIVO: {motivo or situacion}"
    conv_ref = db.collection("conversations").document(conv_id)
    now = firestore.SERVER_TIMESTAMP
    batch = db.batch()
    for text in (plantilla, contexto):
        msg = conv_ref.collection("messages").document()
        batch.set(msg, {"id": msg.id, "conversationId": conv_id, "sender": "bot", "agentId": None, "text": text,
                        "mediaUrl": None, "createdAt": now})
    batch.update(conv_ref, {
        "lastMessageAt": now, "lastMessagePreview": plantilla[:100], "lastMessageSender": "bot", "lastTemplateSentAt": now,
        "sourceLeadId": lead_id, "sourceOrganizationId": _text(body.get("organizationId")),
        "sourceConversationId": _text(body.get("sourceConversationId")),
        "tags": firestore.ArrayUnion([SOURCE]),
    })
    batch.commit()

    if bot:
        engine.prime_session(bot, conv_id, f"{plantilla}\n{contexto}")
    return {"success": True, "conversationId": conv_id}, 200
