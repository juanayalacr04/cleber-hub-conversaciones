"""Mecánica compartida de Salesforce: autenticación y llamadas. Las reglas de Lead y cita viven en modules/ventas.py."""
import json
import logging
import os
import time
import urllib.parse

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
