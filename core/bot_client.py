"""Cliente de la función 3 (bot) desde la función 2: HTTP síncrono con el secreto de servicio (tarea 1.38).

    BOT_FUNCTION_URL      URL base de la función 3 (sin la ruta); las rutas son `/bot/turn` y `/bot/summary`
    BOT_FUNCTION_SECRET   el mismo secreto que valida `ai/service.py` (`X-Service-Secret`)

Por ahora solo pide resúmenes. El turno (`/bot/turn`) lo sigue llamando el pipeline en proceso: 1.46 le enseñó a leer las acciones del endpoint, pero mover el turno
a la función 3 es un paso aparte (el pipeline aún usa el resultado crudo del motor para `situacion`, el recuento de campañas y las imágenes). Nunca lanza: un fallo vuelve como `SummaryResponse(ok=False)` con su error tipado.
"""
import json
import logging
import os

from contracts.base import ContractError
from contracts.bot import BotError, SummaryRequest, SummaryResponse
from core import http

log = logging.getLogger(__name__)

SUMMARY_TIMEOUT = 120


def summarize(request: SummaryRequest, env=None) -> SummaryResponse:
    env = os.environ if env is None else env
    base, secret = (env.get("BOT_FUNCTION_URL") or "").rstrip("/"), env.get("BOT_FUNCTION_SECRET", "")
    if not base or not secret:
        return SummaryResponse(ok=False, error=BotError("bot_function_no_configurada", "falta BOT_FUNCTION_URL o BOT_FUNCTION_SECRET"))
    try:
        _, body = http.request(f"{base}/bot/summary", json.dumps(request.to_dict()).encode("utf-8"),
                               {"Content-Type": "application/json", "X-Service-Secret": secret}, timeout=SUMMARY_TIMEOUT)
        return SummaryResponse.from_dict(json.loads(body))
    except http.HTTPError as e:
        return SummaryResponse(ok=False, error=BotError("http_error", f"HTTP {e.code}", retryable=e.code >= 500))
    except ContractError as e:
        return SummaryResponse(ok=False, error=BotError("respuesta_invalida", str(e)))
    except Exception as e:
        log.error("error pidiendo el resumen a la función 3: %s", e)
        return SummaryResponse(ok=False, error=BotError("red", str(e), retryable=True))
