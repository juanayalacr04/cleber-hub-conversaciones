"""Citas de Salesforce (objeto Event) como destinatarios de las campañas de recordatorio y no-show (tarea 1.39).

Portado de `api/broadcasts/[id]/refresh`. La consulta trae las citas del día objetivo y de cada una se
extraen el teléfono y las variables de la plantilla, que viven en el campo `Description` como líneas
`CAMPO: valor`; los nombres de campo cambian por marca (`sfBrandCode`).
"""
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from crm import salesforce

TZ = ZoneInfo("America/Mexico_City")
REMINDER_TYPES = ("appointment_reminder", "no_show")

EVENT_FIELDS = ("Id, Subject, Description, Location, WhoId, ActivityDate, ActivityDateTime, Tel_fono_Prospecto__c, "
                "Celular_Prospecto__c, VIN__c, EventLeadConcesionaria__c, EventLead__c, IdQuiter__c")

# Nombre del campo en `Description`, por marca. KI (Kia) usa otros rótulos; el resto, los de Honda.
BRAND_FIELD_MAP = {
    "KI": {"name": "CONTACTO", "phone": "TELEFONO", "taller": "TALLER", "operacion": "SERVICIO", "auto": "MODELO DEL VEHICULO",
           "vin": "VIN", "tipoCita": "ESTADO", "recepcionista": "ASESOR DE SERVICIO", "email": "EMAIL", "observaciones": "NOTAS"},
    "default": {"name": "CONTACTO", "phone": "TELEFONO", "taller": "TALLER", "operacion": "OPERACION", "auto": "AUTO",
                "vin": "VIN", "tipoCita": "TIPO CITA", "recepcionista": "RECEPCIONISTA", "email": "EMAIL",
                "observaciones": "OBSERVACIONES"},
}


def field_map(sf_brand_code: str | None) -> dict:
    return BRAND_FIELD_MAP.get(sf_brand_code or "", BRAND_FIELD_MAP["default"])


def parse_description_field(description: str, field: str) -> str | None:
    """Valor de la línea `CAMPO: valor` de la descripción, o None."""
    match = re.search(rf"{re.escape(field)}:[ \t]*([^\r\n]+)", description or "")
    return match.group(1).strip() or None if match else None


def normalize_phone(raw: str) -> str | None:
    """Teléfono mexicano a `+52` más 10 dígitos, o None si no tiene un formato reconocible."""
    digits = re.sub(r"\D", "", raw or "")
    if digits.startswith("00"):
        digits = digits[2:]
    if len(digits) == 10:
        return f"+52{digits}"
    if len(digits) == 12 and digits.startswith("52"):
        return f"+{digits}"
    if len(digits) == 13 and digits.startswith("521"):
        return f"+52{digits[3:]}"
    return None


def build_query(broadcast: dict, org: dict, now: datetime | None = None) -> str:
    """SOQL de las citas objetivo de la campaña: las de hoy ya vencidas sin asistir (no-show) o las de dentro de
    `daysBefore` días sin resultado registrado (recordatorio)."""
    now = now or datetime.now(timezone.utc)
    config = broadcast.get("reminderConfig") or {}
    if broadcast.get("type") == "no_show":
        when = f"ActivityDate = TODAY AND ActivityDateTime < {now.strftime('%Y-%m-%dT%H:%M:%SZ')}"
        attended = " AND GCL_SeRealizo__c = 'No'"
    else:
        target = (now.astimezone(TZ) + timedelta(days=config["daysBefore"])).date().isoformat()
        when = f"ActivityDate = {target}"
        attended = " AND GCL_SeRealizo__c = null"
    calendar = org.get("sfCalendario")
    calendar_filter = f" AND Calendario__c = '{salesforce.soql_quote(calendar)}'" if calendar else ""
    return (f"SELECT {EVENT_FIELDS} FROM Event WHERE Type = '{salesforce.soql_quote(config['eventType'])}' AND {when}"
            f"{attended}{calendar_filter} AND Journey_borrar__c = false")


def _hour(iso: str | None) -> str:
    if not iso:
        return ""
    try:
        when = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return ""
    return when.astimezone(TZ).strftime("%H:%M")


def build_recipients(events: list[dict], fields: dict, variable_mapping: list | None) -> tuple[list[dict], list[dict]]:
    """(destinatarios, omitidos): un destinatario por cita con teléfono válido; las demás van a `omitidos`."""
    recipients, skipped = [], []
    for event in events:
        text = event.get("Description") or ""
        field = lambda key: parse_description_field(text, fields[key]) or ""   # noqa: E731
        variables = {
            "taller": event.get("Location") or field("taller"), "auto": field("auto"), "operacion": field("operacion"),
            "vin": event.get("VIN__c") or field("vin"), "recepcionista": field("recepcionista"), "email": field("email"),
            "observaciones": field("observaciones"), "fechaCita": event.get("ActivityDate") or "",
            "horaCita": _hour(event.get("ActivityDateTime")),
            "idReservacion": parse_description_field(text, "RESERVACION") or "", "idQuiter": event.get("IdQuiter__c") or "",
        }
        name = field("name")
        # Variables numeradas ({{1}}, {{2}}...) según el mapeo definido al crear la campaña: así el mensaje de
        # WhatsApp, y no solo el contexto del bot, las incluye.
        for index, key in enumerate(variable_mapping or [], start=1):
            value = name if key == "name" else variables.get(key)
            if value:
                variables[str(index)] = value

        raw = event.get("Tel_fono_Prospecto__c") or event.get("Celular_Prospecto__c") or parse_description_field(text, fields["phone"])
        if not raw:
            skipped.append({"id": event["Id"], "reason": "no_phone_field", "rawPhone": None, "name": name})
            continue
        phone = normalize_phone(raw)
        if not phone:
            skipped.append({"id": event["Id"], "reason": "invalid_phone_format", "rawPhone": raw, "name": name})
            continue
        recipients.append({"phone": phone, "name": name, "salesforceRecordId": event["Id"], "variables": variables})
    return recipients, skipped
