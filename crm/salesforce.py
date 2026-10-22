"""Mecánica compartida de Salesforce: autenticación y llamadas. Las reglas de Lead y cita viven en modules/ventas.py."""
import json
import logging
import os
import time
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime
from zoneinfo import ZoneInfo

from core import http

log = logging.getLogger(__name__)

TOKEN_TTL_SECS = 55 * 60  # el token dura ~1 hora
API_VERSION = "v59.0"
_tokens: dict[str, dict] = {}  # "instanceUrl|username" -> {"token": ..., "expires": ...}


# Credenciales de la conexión a Salesforce: son las mismas para todas las organizaciones, así que
# viven en variables de entorno (en Cloud Functions, montadas desde Secret Manager) y NO en
# Firestore, donde cualquier usuario de la organización podría leerlas.
CREDENTIAL_ENV = {
    "instanceUrl": "SF_INSTANCE_URL",
    "clientId": "SF_CLIENT_ID",
    "clientSecret": "SF_CLIENT_SECRET",
    "username": "SF_USERNAME",
    "password": "SF_PASSWORD",
}


def env_credentials(vertical: str | None = None) -> dict:
    """Credenciales desde el entorno. `SF_<VERTICAL>_<CAMPO>` (p. ej. SF_VENTAS_USERNAME) gana sobre `SF_<CAMPO>`."""
    creds = {}
    for field, var in CREDENTIAL_ENV.items():
        specific = f"SF_{vertical.upper()}_{var[3:]}" if vertical else None
        value = (os.environ.get(specific) if specific else None) or os.environ.get(var)
        if value:
            creds[field] = value
    return creds


def resolve_config(org_config: dict | None, vertical: str | None = None) -> dict:
    """Configuración de Salesforce de una organización, con las credenciales del entorno.

    `org_config` (organizations/{id}.salesforceConfig) conserva lo que sí cambia por marca y no es
    secreto: sfBrandCode/marcaRR, RecordTypeId, owners, owner de BDC, nombre del Flow. Las
    credenciales vienen del entorno y ganan sobre cualquier credencial que aún esté en Firestore.
    Mientras el entorno no las defina se usan las de Firestore, con una advertencia: es el camino
    de migración.
    """
    config = dict(org_config or {})
    creds = env_credentials(vertical)
    if all(f in creds for f in CREDENTIAL_ENV):
        config.update(creds)
    elif has_credentials(config):
        log.warning("Salesforce: usando credenciales de Firestore; muévelas a variables de entorno (SF_*)")
    elif creds:
        config.update(creds)  # credenciales parciales en el entorno: se usan tal cual y fallará con un error claro
    return config


def _cache_key(sf_config: dict) -> str:
    return f"{sf_config.get('instanceUrl', '')}|{sf_config.get('username', '')}"


def invalidate_token(sf_config: dict) -> None:
    _tokens.pop(_cache_key(sf_config), None)


def clear_token_cache() -> None:
    _tokens.clear()


def get_salesforce_token(sf_config: dict) -> str | None:
    """Token de acceso (flujo password), con caché de 55 minutos."""
    key = _cache_key(sf_config)
    cached = _tokens.get(key)
    if cached and time.time() < cached["expires"]:
        return cached["token"]

    params = urllib.parse.urlencode({
        "grant_type": "password",
        "client_id": sf_config.get("clientId", ""),
        "client_secret": sf_config.get("clientSecret", ""),
        "username": sf_config.get("username", ""),
        "password": sf_config.get("password", ""),
    })
    try:
        _, body = http.request(
            f"{sf_config.get('instanceUrl', '')}/services/oauth2/token",
            data=params.encode("utf-8"),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        token = json.loads(body).get("access_token")
        if token:
            _tokens[key] = {"token": token, "expires": time.time() + TOKEN_TTL_SECS}
        return token
    except Exception as e:
        log.error("Error obteniendo el token de Salesforce: %s", e)
        _tokens.pop(key, None)
        return None


def has_credentials(sf_config: dict | None) -> bool:
    keys = ("instanceUrl", "clientId", "clientSecret", "username", "password")
    return bool(sf_config) and all(sf_config.get(k) for k in keys)


# --------------------------------------------------------------------------- llamadas REST

def call(sf_config: dict, method: str, path: str, payload: dict | None = None,
         extra_headers: dict | None = None, timeout: int = 30) -> tuple[bool, dict]:
    """Llamada REST a Salesforce con token en caché. Devuelve (ok, datos).

    Un 401 (token vencido) invalida la caché y reintenta una vez con un token nuevo. Un fallo no
    lanza: devuelve (False, {"status", "body"} o {"error"}) para que el llamador decida.
    """
    for attempt in range(2):
        token = get_salesforce_token(sf_config)
        if not token:
            return False, {"error": "no_token"}
        headers = {"Authorization": f"Bearer {token}", **(extra_headers or {})}
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            _, body = http.request(f"{sf_config.get('instanceUrl', '')}{path}", data, headers, method=method, timeout=timeout)
            return True, (json.loads(body) if body.strip() else {})
        except http.HTTPError as e:
            if e.code == 401 and attempt == 0:
                invalidate_token(sf_config)
                continue
            detail = e.read().decode("utf-8", "replace") if e.fp else ""
            log.error("Salesforce %s %s: HTTP %s %s", method, path, e.code, detail)
            return False, {"status": e.code, "body": detail}
        except Exception as e:
            log.error("Salesforce %s %s: %s", method, path, e)
            return False, {"error": str(e)}
    return False, {"error": "unauthorized"}


def sobject_path(sobject: str, record_id: str = "", version: str = API_VERSION) -> str:
    return f"/services/data/{version}/sobjects/{sobject}/{record_id}"


NO_AUTO_ASSIGN = {"Sforce-Auto-Assign": "FALSE"}  # evita que las reglas de asignación reasignen al editar


def patch_lead(sf_config: dict, lead_id: str, fields: dict) -> bool:
    ok, _ = call(sf_config, "PATCH", sobject_path("Lead", lead_id), fields, NO_AUTO_ASSIGN)
    return ok


def create_lead(sf_config: dict, record: dict) -> str | None:
    """Crea un Lead (sin reglas de asignación) y devuelve su Id, o None si falla."""
    ok, data = call(sf_config, "POST", sobject_path("Lead", version="v60.0"), record, NO_AUTO_ASSIGN)
    return (data.get("id") or None) if ok else None


def query(sf_config: dict, soql: str, timeout: int = 30) -> list[dict] | None:
    """Registros de una consulta SOQL, o None si falló."""
    ok, data = call(sf_config, "GET", f"/services/data/{API_VERSION}/query?q={urllib.parse.quote(soql)}", timeout=timeout)
    return data.get("records", []) if ok else None


def query_all(sf_config: dict, soql: str, timeout: int = 30) -> list[dict] | None:
    """Todos los registros de una consulta SOQL, siguiendo `nextRecordsUrl`. None si algún tramo falló."""
    path, records = f"/services/data/{API_VERSION}/query?q={urllib.parse.quote(soql)}", []
    while path:
        ok, data = call(sf_config, "GET", path, timeout=timeout)
        if not ok:
            return None
        records += data.get("records", [])
        path = data.get("nextRecordsUrl")
    return records


def soql_quote(value: str) -> str:
    """Escapa un valor para usarlo entre comillas simples en SOQL."""
    return value.replace("\\", "\\\\").replace("'", "\\'")


def call_flow(sf_config: dict, flow_name: str, inputs: list[dict]) -> bool:
    """Invoca un Flow de Salesforce. True si el primer resultado reporta éxito."""
    ok, data = call(sf_config, "POST", f"/services/data/v66.0/actions/custom/flow/{flow_name}", {"inputs": inputs})
    return bool(ok and isinstance(data, list) and data and data[0].get("isSuccess"))


def get_lead_field(sf_config: dict, lead_id: str, field_name: str) -> tuple[bool, str | None]:
    """Valor actual de un campo del Lead, para hacer append sin pisar datos.

    `ok=False` significa que no se pudo leer, no que el campo esté vacío: quien hace append debe
    abortar en ese caso para no pisar el historial.
    """
    ok, data = call(sf_config, "GET", f"{sobject_path('Lead', lead_id)}?fields={field_name}", timeout=10)
    return (True, data.get(field_name)) if ok else (False, None)


def build_appended_comment(current_value: str | None, new_comment: str, timezone_name: str = "America/Mexico_City") -> str:
    """Agrega `new_comment` al final con marca de tiempo, sin borrar lo existente."""
    entry = f"[{datetime.now(ZoneInfo(timezone_name)).strftime('%d/%m/%Y %H:%M')}] {new_comment}"
    base = (current_value or "").rstrip()
    return f"{base}\n{entry}" if base else entry


def parse_lead_outbound_message(raw_xml: str) -> list[dict]:
    """Parsea un Outbound Message SOAP cuyo sObject es un Lead.

    Captura todos los campos del sObject sin distinción de prefijo (estándar y custom); el Id queda
    bajo `_lead_id`.
    """
    try:
        results = []
        for elem in ET.fromstring(raw_xml).iter():
            if elem.tag.split("}")[-1] != "sObject":
                continue
            fields = {}
            for child in elem:
                tag = child.tag.split("}")[-1]
                if tag == "Id" and child.text:
                    fields["_lead_id"] = child.text.strip()
                elif child.text:
                    fields[tag] = child.text.strip()
            if fields:
                results.append(fields)
        return results
    except Exception as e:
        log.error("Error parseando el XML del Lead: %s", e)
        return []
