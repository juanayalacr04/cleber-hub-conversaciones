"""Plantillas de campaña por proveedor y estado de entrega (tarea 1.39).

Portado de `api/broadcasts/[id]/send|test-send|retry|check-status`, que repetían este código tres veces.

    check_ready(number, sf_config)                  → mensaje de error o None: ¿el número tiene lo que su proveedor exige?
    send(number, broadcast, recipient, phone, ...)  → id del mensaje; lanza `TemplateError(FAILED, detalle)`
    delivery_statuses(number, ids, sf_config)       → {id: {"state": delivered|read|failed, "message": ...}} solo de los que ya
                                                      llegaron a un estado final (lo demás sigue en tránsito)
"""
import base64
import copy
import json
import logging
import os
import urllib.parse

from channels.meta_wa import GRAPH_VERSION
from core import http
from core.db import get_executor
from core.outbound import FAILED, TemplateError
from crm import salesforce

log = logging.getLogger(__name__)

SF_BATCH = 500
SMS_BUCKET = "rsplus__SMS_Bucket__c"
ORIGIN_MARK = "Plataforma IA"


def check_ready(number: dict, sf_config: dict | None) -> str | None:
    provider = number.get("provider", "twilio")
    if provider == "meta" and not (number.get("metaPhoneNumberId") and number.get("metaAccessToken")):
        return "Meta credentials not configured"
    if provider == "twilio" and not (number.get("twilioAccountSid") and number.get("twilioAuthToken") and number.get("phoneNumber")):
        return "Twilio credentials not configured"
    if provider == "valuetext":
        if not salesforce.has_credentials(sf_config or {}):
            return "Salesforce credentials not configured (SF_* env)"
        if not salesforce.get_salesforce_token(sf_config):
            return "Salesforce auth failed"
    return None


def template_components(defaults: list | None, variables: dict | None) -> list:
    """Componentes de la plantilla de Meta con las variables del destinatario (1-indexadas) sobre las de la campaña."""
    if not variables or not defaults:
        return defaults or []
    out = []
    for component in defaults:
        cloned = copy.deepcopy(component)
        if cloned.get("type") == "body" and isinstance(cloned.get("parameters"), list):
            cloned["parameters"] = [
                {**param, "type": "text", "text": variables[str(i)]} if variables.get(str(i)) else param
                for i, param in enumerate(cloned["parameters"], start=1)
            ]
        out.append(cloned)
    return out


def _error(provider: str, e: Exception) -> TemplateError:
    if isinstance(e, http.HTTPError):
        detail = f"{provider} API error {e.code}: {e.read().decode('utf-8', 'replace')}"
    else:
        detail = str(e) or e.__class__.__name__
    return TemplateError(FAILED, detail)


def _send_meta(number: dict, broadcast: dict, recipient: dict, phone: str) -> str | None:
    payload = json.dumps({
        "messaging_product": "whatsapp", "to": phone.replace("+", ""), "type": "template",
        "template": {"name": broadcast["templateName"], "language": {"code": broadcast.get("templateLanguage") or "es"},
                     "components": template_components(broadcast.get("templateComponents"), recipient.get("variables"))},
    }).encode("utf-8")
    try:
        _, body = http.request(f"https://graph.facebook.com/{GRAPH_VERSION}/{number['metaPhoneNumberId']}/messages", payload,
                               {"Authorization": f"Bearer {number['metaAccessToken']}", "Content-Type": "application/json"})
        return (json.loads(body).get("messages") or [{}])[0].get("id")
    except Exception as e:
        raise _error("Meta", e)


def _send_twilio(number: dict, broadcast: dict, recipient: dict, phone: str, track: bool) -> str | None:
    form = {"To": f"whatsapp:{phone}", "From": number["phoneNumber"]}
    callback = os.environ.get("TWILIO_STATUS_CALLBACK_URL")
    if track and callback:
        form["StatusCallback"] = callback
    if broadcast.get("contentSid"):
        form["ContentSid"] = broadcast["contentSid"]
        if recipient.get("variables"):
            form["ContentVariables"] = json.dumps(recipient["variables"])
    else:
        form["Body"] = f"[Template: {broadcast['templateName']}]"
    headers = {"Authorization": "Basic " + base64.b64encode(f"{number['twilioAccountSid']}:{number['twilioAuthToken']}".encode()).decode(),
               "Content-Type": "application/x-www-form-urlencoded"}
    try:
        _, body = http.request(f"https://api.twilio.com/2010-04-01/Accounts/{number['twilioAccountSid']}/Messages.json",
                               urllib.parse.urlencode(form).encode("utf-8"), headers, timeout=15)
        return json.loads(body).get("sid")
    except Exception as e:
        raise _error("Twilio", e)


def _send_valuetext(number: dict, broadcast: dict, recipient: dict, phone: str, sf_config: dict) -> str | None:
    record_id = recipient.get("salesforceRecordId")
    record = {"rsplus__Number__c": phone, "rsplus__Sender_ID__c": number.get("valuetextSenderId", ""), "Origen__c": ORIGIN_MARK}
    if broadcast.get("templateName"):
        record["rsplus__Template_ID__c"] = broadcast["templateName"]
    if record_id:
        record["rsplus__Related_To__c"] = record_id
    if broadcast.get("valuetextObjectApi"):  # plantillas ValueText por objeto de Salesforce (capacidad de Comercial)
        record["rsplus__Object_API__c"] = broadcast["valuetextObjectApi"]
        record["rsplus__Message__c"] = f"[Template: {broadcast['templateName']}]"
        if record_id:
            record["rsplus__Record_Id__c"] = record_id
    ok, data = salesforce.call(sf_config, "POST", salesforce.sobject_path(SMS_BUCKET), record)
    if not ok:
        detail = data.get("body") or data.get("error") or ""
        raise TemplateError(FAILED, f"Salesforce API error {data['status']}: {detail}" if data.get("status") else f"Salesforce error: {detail}")
    return data.get("id")


def send(number: dict, broadcast: dict, recipient: dict, phone: str, sf_config: dict | None = None, track: bool = True) -> str | None:
    """Manda la plantilla de la campaña a `phone` (E.164 con `+`). `track` pide al proveedor el callback de estado."""
    provider = number.get("provider", "twilio")
    if provider == "meta":
        return _send_meta(number, broadcast, recipient, phone)
    if provider == "valuetext":
        return _send_valuetext(number, broadcast, recipient, phone, sf_config or {})
    return _send_twilio(number, broadcast, recipient, phone, track)


def _valuetext_states(sf_config: dict, ids: list[str]) -> dict:
    states = {}
    for start in range(0, len(ids), SF_BATCH):
        in_clause = ",".join(f"'{salesforce.soql_quote(i)}'" for i in ids[start:start + SF_BATCH])
        records = salesforce.query(sf_config, f"SELECT Id, rsplus__Processed__c, rsplus__Status__c, rsplus__Status_Message__c "
                                              f"FROM {SMS_BUCKET} WHERE Id IN ({in_clause})")
        for record in records or []:
            if not record.get("rsplus__Processed__c"):  # sigue procesándose
                continue
            if record.get("rsplus__Status__c") == "FAIL":
                states[record["Id"]] = {"state": "failed", "message": record.get("rsplus__Status_Message__c") or "Delivery failed"}
            else:
                states[record["Id"]] = {"state": "read" if record.get("rsplus__Status__c") == "Read" else "delivered",
                                        "message": record.get("rsplus__Status_Message__c") or None}
    return states


def _twilio_state(number: dict, sid: str) -> tuple[str, dict | None]:
    headers = {"Authorization": "Basic " + base64.b64encode(f"{number['twilioAccountSid']}:{number['twilioAuthToken']}".encode()).decode()}
    try:
        _, body = http.request(f"https://api.twilio.com/2010-04-01/Accounts/{number['twilioAccountSid']}/Messages/{sid}.json",
                               headers=headers, method="GET", timeout=15)
        msg = json.loads(body)
    except Exception as e:
        log.error("Error consultando el estado de Twilio de %s: %s", sid, e)
        return sid, None
    status = msg.get("status")
    if status in ("failed", "undelivered"):
        return sid, {"state": "failed", "message": msg.get("error_message") or "Delivery failed"}
    if status in ("delivered", "read"):
        return sid, {"state": status, "message": None}
    return sid, None  # queued, sending, sent: en tránsito


def delivery_statuses(number: dict, ids: list[str], sf_config: dict | None = None) -> dict:
    if number.get("provider") == "valuetext":
        return _valuetext_states(sf_config or {}, ids)
    results = get_executor().map(lambda sid: _twilio_state(number, sid), ids)
    return {sid: state for sid, state in results if state}
