"""Firmas de los webhooks de los proveedores (tarea 1.42): funciones puras, sin red ni Firestore.

    Twilio     X-Twilio-Signature     base64(HMAC-SHA1(auth token, URL + parámetros del formulario ordenados, cada uno como nombre+valor))
    Meta       X-Hub-Signature-256    "sha256=" + hex(HMAC-SHA256(secreto de la app, cuerpo crudo))
    ValueText  sin firma: Salesforce no puede firmar un Outbound Message; se usa un secreto compartido en la URL

Todas comparan en tiempo constante. `core`/`channels/webhook_auth.py` decide qué token o secreto corresponde a cada petición.
"""
import base64
import hashlib
import hmac
from urllib.parse import urlsplit, urlunsplit


def twilio_signature(token: str, url: str, params) -> str:
    """Firma que Twilio manda para `url` con los parámetros `params` (un dict, o algo con `getlist` como el formulario de Flask)."""
    signed = url
    for name in sorted(set(params)):
        values = params.getlist(name) if hasattr(params, "getlist") else [params[name]]
        for value in sorted(set(values)):
            signed += name + value
    return base64.b64encode(hmac.new(token.encode("utf-8"), signed.encode("utf-8"), hashlib.sha1).digest()).decode("utf-8")


def _url_variants(url: str) -> list[str]:
    """La URL tal cual y con el puerto por defecto añadido o quitado: Twilio firma la que tiene configurada, con o sin puerto."""
    parts = urlsplit(url)
    default = {"https": 443, "http": 80}.get(parts.scheme)
    host = parts.hostname or ""
    if parts.port is None:
        with_port = parts._replace(netloc=f"{host}:{default}") if default else parts
        return [url, urlunsplit(with_port)]
    if parts.port == default:
        return [url, urlunsplit(parts._replace(netloc=host))]
    return [url]


def valid_twilio(token: str, url: str, params, received: str) -> bool:
    if not token or not received:
        return False
    return any(hmac.compare_digest(twilio_signature(token, candidate, params), received) for candidate in _url_variants(url))


def meta_signature(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


def valid_meta(secrets, body: bytes, received: str) -> bool:
    """¿La firma corresponde al cuerpo con alguno de los secretos de app (Meta firma con el de la app que envía)?"""
    if not received:
        return False
    return any(hmac.compare_digest(meta_signature(secret, body), received) for secret in secrets if secret)


def same_secret(expected: str, received: str) -> bool:
    return bool(expected) and bool(received) and hmac.compare_digest(expected.encode("utf-8"), received.encode("utf-8"))
