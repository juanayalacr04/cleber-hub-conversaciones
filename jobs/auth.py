"""Autenticación de los jobs que invoca el cron del dashboard."""
import hmac
import os


def cron_authorized(headers, env=None) -> bool:
    """¿La petición trae el secreto del cron (`X-Cron-Secret` == `CRON_SECRET`)?

    Falla cerrado: sin `CRON_SECRET` configurado se rechaza todo, salvo que se pida explícitamente
    lo contrario con `ALLOW_UNAUTHENTICATED_CRON=true` (desarrollo local). Antes, sin secreto el
    endpoint quedaba abierto, y estas funciones mandan mensajes a clientes.
    """
    env = os.environ if env is None else env
    secret = env.get("CRON_SECRET", "")
    if not secret:
        return env.get("ALLOW_UNAUTHENTICATED_CRON", "").lower() == "true"
    return hmac.compare_digest((headers.get("X-Cron-Secret") or "").encode(), secret.encode())
