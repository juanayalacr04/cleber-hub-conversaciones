"""Canal ValueText: se envía insertando un SMS_Bucket__c en Salesforce, que ValueText recoge.

Se recibe por Outbound Message de Salesforce (SOAP XML). El nombre engaña: no es "Salesforce
genérico", es el canal ValueText, que vive sobre un objeto de Salesforce.
"""
import json
import logging
import xml.etree.ElementTree as ET

from core import http
from crm import salesforce

log = logging.getLogger(__name__)
SMS_BUCKET = "rsplus__SMS_Bucket__c"
ORIGIN_MARK = "Plataforma IA"  # el webhook ignora el rebote de lo que envió la plataforma


def send_valuetext_message(bot_config: dict, to_number: str, message: str) -> str | None:
    """Envía un mensaje insertando SMS_Bucket__c. Devuelve la respuesta de Salesforce o None."""
    sf_config = bot_config.get("salesforceConfig", {})
    if not salesforce.has_credentials(sf_config):
        log.error("Credenciales de Salesforce sin configurar")
        return None

    record = json.dumps({
        "rsplus__Number__c": to_number.replace("whatsapp:", ""),
        "rsplus__Message__c": message,
        "rsplus__Sender_ID__c": bot_config.get("valuetextSenderId", ""),
        "Origen__c": ORIGIN_MARK,
    }).encode("utf-8")
    url = f"{sf_config['instanceUrl']}/services/data/{salesforce.API_VERSION}/sobjects/{SMS_BUCKET}/"

    for attempt in range(2):
        token = salesforce.get_salesforce_token(sf_config)
        if not token:
            return None
        try:
            _, body = http.request(url, record, {"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
            return body
        except http.HTTPError as e:
            if e.code == 401 and attempt == 0:
                log.warning("Salesforce 401: token vencido, se reintenta con uno nuevo")
                salesforce.invalidate_token(sf_config)
                continue
            log.error("Error insertando SMS_Bucket: HTTP %s: %s", e.code, e.read().decode("utf-8", "replace"))
            return None
        except Exception as e:
            log.error("Error insertando SMS_Bucket: %s", e)
            return None
    return None


def parse_salesforce_outbound_message(raw_xml: str) -> list[dict]:
    """Parsea el SOAP de un Outbound Message: un dict por sObject (SMS_Bucket__c) en el sobre.

    Salesforce puede mandar varias notificaciones en un solo POST. El Id del sObject queda bajo
    `_sobject_id` para la idempotencia.
    """
    try:
        root = ET.fromstring(raw_xml)
        results = []
        for elem in root.iter():
            if elem.tag.split("}")[-1] != "sObject":
                continue
            fields = {}
            for child in elem:
                tag = child.tag.split("}")[-1]
                if tag == "Id" and child.text:
                    fields["_sobject_id"] = child.text.strip()
                elif tag.startswith("rsplus__") and child.text:
                    fields[tag] = child.text.strip()
                elif tag.endswith("__c") and child.text and tag not in fields:
                    fields[tag] = child.text.strip()
            if fields:
                results.append(fields)
        return results
    except Exception as e:
        log.error("Error parseando el XML de Salesforce: %s", e)
        return []
