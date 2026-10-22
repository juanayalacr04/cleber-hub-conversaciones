"""Plantillas de ValueText: se envían insertando un SMS_Bucket__c en Salesforce (tarea 1.11).

`send_valuetext_template` era `send_lead_template`: el nombre engañaba, porque no es "mandar una
plantilla" en general sino la de ValueText. Esa es la raíz de que las notificaciones internas solo
funcionen con un proveedor.
"""
import logging

from crm import salesforce

log = logging.getLogger(__name__)
DEFAULT_TEMPLATE_ID = "T0716"
ORIGIN_MARK = "Plataforma IA"  # el webhook ignora el rebote de lo que envió la plataforma


def get_template_structure(sf_config: dict, template_id: str) -> str | None:
    """Texto/estructura de una plantilla de ValueText desde Salesforce."""
    if not template_id or not sf_config:
        return None
    records = salesforce.query(
        sf_config,
        "SELECT rsplus__WA_template_structure__c FROM rsplus__RSP_Templates__c "
        f"WHERE Name = '{salesforce.soql_quote(template_id)}' LIMIT 1",
        timeout=10,
    )
    return (records[0].get("rsplus__WA_template_structure__c") or None) if records else None


def send_valuetext_template(sf_config: dict, sender_id: str, to_number: str, lead_id: str,
                            template_id: str | None = None) -> str | None:
    """Envía una plantilla de WhatsApp al cliente. Devuelve el Id del SMS_Bucket o None.

    ValueText usa `rsplus__Related_To__c` (Id del Lead) para llenar las variables de la plantilla
    desde el registro de Salesforce. La plantilla por defecto es `defaultTemplateId` de la config.
    """
    digits = "".join(c for c in to_number if c.isdigit())
    ok, data = salesforce.call(sf_config, "POST", salesforce.sobject_path("rsplus__SMS_Bucket__c"), {
        "rsplus__Number__c": digits[-10:],
        "rsplus__Sender_ID__c": sender_id,
        "rsplus__Template_ID__c": template_id or sf_config.get("defaultTemplateId") or DEFAULT_TEMPLATE_ID,
        "rsplus__Related_To__c": lead_id,
        "Origen__c": ORIGIN_MARK,
    })
    bucket_id = data.get("id") if ok else None
    log.info("valuetext_template %s lead_id=%s bucket_id=%s", "enviada" if ok else "fallo", lead_id, bucket_id)
    return bucket_id
