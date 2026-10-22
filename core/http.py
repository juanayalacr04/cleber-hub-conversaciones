"""Cliente HTTP mínimo (urllib) compartido por canales y CRM.

Se usa urllib y no un SDK a propósito: abre una conexión fresca en cada llamada, lo que evita que
sockets keep-alive muertos (los que Twilio cierra del lado servidor) cuelguen el envío ~60 s. Los
tests reemplazan `request` para no tocar la red.
"""
import ssl
import urllib.error
import urllib.request

ssl_context = ssl.create_default_context()

HTTPError = urllib.error.HTTPError


def request(url: str, data: bytes | None = None, headers: dict | None = None,
            method: str = "POST", timeout: int = 30) -> tuple[int, str]:
    """Hace la petición y devuelve (status, cuerpo). Lanza HTTPError ante 4xx y 5xx."""
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=timeout, context=ssl_context) as resp:
        return resp.status, resp.read().decode("utf-8")
