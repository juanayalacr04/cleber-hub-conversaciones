"""Mecánica compartida de Salesforce: autenticación y llamadas. Las reglas de Lead y cita viven en modules/ventas.py."""
import json
import logging
import time
import urllib.parse

from core import http

log = logging.getLogger(__name__)

TOKEN_TTL_SECS = 55 * 60  # el token dura ~1 hora
API_VERSION = "v59.0"
_tokens: dict[str, dict] = {}  # "instanceUrl|username" -> {"token": ..., "expires": ...}


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
