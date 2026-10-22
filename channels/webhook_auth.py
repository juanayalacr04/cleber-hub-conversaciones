"""Autenticación de los webhooks de los proveedores (tarea 1.42): quién puede mandarnos mensajes.

Sin esto, cualquiera que conozca la URL puede inyectar mensajes al bot (con el costo y el riesgo que eso trae). Cada proveedor se
valida distinto, y todas fallan cerrado:

    Twilio     firma `X-Twilio-Signature` con el token del número que recibe (o envía, en los callbacks de estado) el mensaje
    Meta       firma `X-Hub-Signature-256` con el secreto de la app de Meta: `META_APP_SECRET` (varios, separados por comas, si hay
               más de una app)
    ValueText  secreto compartido en la URL (`?secret=`) o en `X-Api-Secret`: `VALUETEXT_WEBHOOK_SECRET`. Salesforce no puede firmar
               un Outbound Message ni mandar cabeceras, así que el secreto va en la URL que se configura en Salesforce.

Sin la configuración necesaria se rechaza todo, salvo `ALLOW_UNAUTHENTICATED_WEBHOOKS=true` (desarrollo local, con curl o los stubs).

Twilio firma la URL exacta que tiene configurada. Detrás del balanceador de Google la que ve Flask puede diferir (esquema, host, y en
las funciones el nombre de la función no está en la ruta): con `PUBLIC_BASE_URL` se fija el prefijo público de ESA función, por ejemplo
`https://us-central1-<proyecto>.cloudfunctions.net/router`; la ruta (`/webhook/twilio`) se suma sola.
"""
import logging
import os

from channels import signatures
from core import numbers

log = logging.getLogger(__name__)


def _env(env):
    return os.environ if env is None else env


def allow_unauthenticated(env=None) -> bool:
    return _env(env).get("ALLOW_UNAUTHENTICATED_WEBHOOKS", "").lower() == "true"


def public_url(request, env=None) -> str:
    """URL pública con la que el proveedor llamó a esta petición (la que firma Twilio)."""
    env = _env(env)
    base = (env.get("PUBLIC_BASE_URL") or "").strip().rstrip("/")
    path = "" if request.path == "/" else request.path    # el nombre de la función no viaja en la ruta, y la raíz no suma barra
    if base:
        url = base + path
    else:
        proto = (request.headers.get("X-Forwarded-Proto") or request.scheme).split(",")[0].strip()
        host = (request.headers.get("X-Forwarded-Host") or request.host).split(",")[0].strip()
        url = f"{proto}://{host}{request.path}"
    query = request.query_string.decode("utf-8") if request.query_string else ""
    return f"{url}?{query}" if query else url


def twilio_authorized(url: str, form, headers, db=None, env=None) -> bool:
    """¿La firma de Twilio corresponde al token del número de WhatsApp involucrado?

    El número es el destinatario (`To`) de un mensaje entrante o el remitente (`From`) de un callback de estado. El token sale del
    número (o del bot, en el modelo antiguo), nunca de la petición.
    """
    if allow_unauthenticated(env):
        return True
    received = headers.get("X-Twilio-Signature") or ""
    for candidate in (form.get("To", ""), form.get("From", "")):
        if not candidate:
            continue
        bot = numbers.get_bot_by_phone(candidate, db)
        token = ((bot or {}).get("twilioConfig") or {}).get("authToken")
        if signatures.valid_twilio(token or "", url, form, received):
            return True
    log.warning("webhook de Twilio rechazado: firma inválida o número desconocido (To=%s)", form.get("To", ""))
    return False


def meta_authorized(raw_body: bytes, headers, env=None) -> bool:
    if allow_unauthenticated(env):
        return True
    secrets = [s.strip() for s in (_env(env).get("META_APP_SECRET") or "").split(",") if s.strip()]
    if signatures.valid_meta(secrets, raw_body, headers.get("X-Hub-Signature-256") or ""):
        return True
    log.warning("webhook de Meta rechazado: %s", "firma inválida" if secrets else "falta META_APP_SECRET")
    return False


def valuetext_authorized(args, headers, env=None) -> bool:
    if allow_unauthenticated(env):
        return True
    expected = _env(env).get("VALUETEXT_WEBHOOK_SECRET", "")
    if signatures.same_secret(expected, headers.get("X-Api-Secret") or (args or {}).get("secret") or ""):
        return True
    log.warning("webhook de ValueText rechazado: %s", "secreto inválido" if expected else "falta VALUETEXT_WEBHOOK_SECRET")
    return False
