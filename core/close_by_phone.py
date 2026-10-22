"""Cierre de conversaciones por teléfono desde Salesforce (tarea 1.39): antes `api/conversations/close-by-phone` del dashboard.

    POST /integrations/close-by-phone?secret=<EXTERNAL_API_SECRET>     (o la cabecera X-Api-Secret)

Dos formas de llamarlo:
  - Outbound Message de Salesforce (SOAP XML): trae `rsplus__Phone_Number__c` de cada registro. Se cierran las conversaciones de
    cada teléfono y siempre se responde el ACK que Salesforce espera, para que no reintente aunque algo falle.
  - JSON `{phone, reason?}` (pruebas manuales y otros consumidores): responde cuántas se cerraron y con qué variantes del teléfono.

Se cierran todas las conversaciones activas (`bot`, `waiting_agent`, `with_agent`) de ese teléfono, sin importar la organización,
como `closedBy: "salesforce"` y cierre manual (`manualClose`: la reapertura no las devuelve al bot). Salesforce no puede mandar
cabeceras, de ahí el secreto por query string.

Falla cerrado: sin `EXTERNAL_API_SECRET` se rechaza todo, salvo `ALLOW_UNAUTHENTICATED_INTEGRATIONS=true` en desarrollo.
"""
import hmac
import json
import logging
import os
import re

from google.cloud import firestore

from core.db import get_db

log = logging.getLogger(__name__)

ACTIVE_STATUSES = ["bot", "waiting_agent", "with_agent"]
BATCH = 400
SOAP_ACK = ('<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">'
            '<soapenv:Body><notificationsResponse xmlns="http://soap.sforce.com/2005/09/outbound"><Ack>true</Ack>'
            '</notificationsResponse></soapenv:Body></soapenv:Envelope>')
PHONE_TAG = re.compile(r"<(?:\w+:)?rsplus__Phone_Number__c(?:\s[^>]*)?>([^<]+)</(?:\w+:)?rsplus__Phone_Number__c>")


def authorized(headers, args, env=None) -> bool:
    env = os.environ if env is None else env
    secret = env.get("EXTERNAL_API_SECRET", "")
    if not secret:
        return env.get("ALLOW_UNAUTHENTICATED_INTEGRATIONS", "").lower() == "true"
    received = headers.get("X-Api-Secret") or (args or {}).get("secret") or ""
    return hmac.compare_digest(received.encode(), secret.encode())


def phone_variants(raw: str) -> list[str]:
    """Formas en que `customerPhone` puede estar guardado: la moderna (+52) y la legacy (+521), en formato `whatsapp:`.

    Acepta el teléfono suelto (10 dígitos, 52..., +52..., whatsapp:+52..., 521...). Si no es un móvil mexicano reconocible, usa
    el valor tal cual como única variante.
    """
    digits = re.sub(r"\D", "", raw)
    ten = None
    if len(digits) == 10:
        ten = digits
    elif len(digits) == 12 and digits.startswith("52"):
        ten = digits[2:]
    elif len(digits) == 13 and digits.startswith("521"):
        ten = digits[3:]
    if ten:
        return [f"whatsapp:+52{ten}", f"whatsapp:+521{ten}"]
    return [raw if raw.startswith("whatsapp:") else f"whatsapp:{'' if raw.startswith('+') else '+'}{raw}"]


def extract_phones(xml: str) -> list[str]:
    return [m.strip() for m in PHONE_TAG.findall(xml) if m.strip()]


def close_conversations(db, phone: str, reason: str) -> list[str]:
    """Cierra las conversaciones activas del teléfono y devuelve sus ids."""
    found = {}
    for variant in phone_variants(phone):
        query = db.collection("conversations").where("customerPhone", "==", variant).where("status", "in", ACTIVE_STATUSES)
        for snap in query.stream():
            found[snap.id] = snap
    ids, batch, pending = [], db.batch(), 0
    for snap in found.values():
        batch.update(snap.reference, {
            "status": "closed", "assignedAgentId": None, "assignedAt": None, "waitingStartedAt": None, "firstAgentResponseAt": None,
            "responseTimeSecs": None, "closedAt": firestore.SERVER_TIMESTAMP, "closedReason": reason, "closedBy": "salesforce",
            "manualClose": True,
        })
        ids.append(snap.id)
        pending += 1
        if pending == BATCH:
            batch.commit()
            batch, pending = db.batch(), 0
    if pending:
        batch.commit()
    return ids


def handle(headers, args, raw_body: str, db=None, env=None) -> tuple[str, int, str]:
    """Entrada HTTP. Devuelve (cuerpo, estado, content-type)."""
    if not authorized(headers, args, env):
        return json.dumps({"error": "Unauthorized"}), 401, "application/json"
    db = db or get_db()
    content_type = (headers.get("Content-Type") or "").lower()
    if "xml" in content_type or raw_body.lstrip().startswith("<"):
        closed = 0
        for phone in extract_phones(raw_body):
            try:
                ids = close_conversations(db, phone, "salesforce")
                closed += len(ids)
                log.info("close-by-phone (xml) cerró %d para %s: %s", len(ids), phone, ids)
            except Exception:
                log.exception("close-by-phone (xml): error con %s", phone)
        log.info("close-by-phone (xml): %d conversaciones cerradas", closed)
        return SOAP_ACK, 200, "text/xml"   # siempre el ACK: así Salesforce no reintenta

    try:
        body = json.loads(raw_body)
    except ValueError:
        body = None
    if not isinstance(body, dict):
        return json.dumps({"error": "Invalid body (expected SOAP XML or JSON)"}), 400, "application/json"
    phone = body.get("phone").strip() if isinstance(body.get("phone"), str) else ""
    if not phone:
        return json.dumps({"error": "Missing 'phone' in body"}), 400, "application/json"
    reason = body.get("reason").strip() if isinstance(body.get("reason"), str) and body["reason"].strip() else "salesforce"
    ids = close_conversations(db, phone, reason)
    variants = phone_variants(phone)
    if not ids:
        return json.dumps({"closed": 0, "message": "No active conversations for phone", "variants": variants}), 200, "application/json"
    return json.dumps({"closed": len(ids), "conversationIds": ids, "variants": variants}), 200, "application/json"
