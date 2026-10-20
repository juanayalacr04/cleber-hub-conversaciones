"""Función 3 (bot, tarea 1.35): un turno entra por HTTP y sale como texto, sin estado.

    POST /bot/turn      contracts.BotRequest -> contracts.BotResponse
    POST /bot/summary   contracts.SummaryRequest -> contracts.SummaryResponse   (resumen al cerrar, para el expediente de 1.38)
    Header:             X-Service-Secret == BOT_FUNCTION_SECRET   (función 2 -> función 3; falla cerrado)

La función no escribe en Firestore ni ejecuta tools de negocio (D14): los bots piden sus acciones a la función 2 (`core/actions.py`).
Lee la configuración del bot por `bot_id` (con las credenciales de Abacus de `secrets`, 1.41) y llama al motor que toca (`ai/engine.py`).
Lo que devuelve es lo que el motor dijo, ya parseado (`ai/parsing.py`):

  text      la respuesta al cliente
  motivo    clasificación del motivo, si el bot la reportó dentro del vocabulario del bot (`outcomeActions`)
  handoff   el bot pidió escalar; la función 2 decide si procede (horario, módulo)
  actions   solo el bot externo, que conserva su contrato de devolver acciones

El historial solo se usa con un bot externo (que no guarda sesión); ChatLLM y los workflows la guardan en Abacus con
`externalSessionId` (= `conversation_id`). El expediente, si trae algo, se antepone al mensaje como contexto.
"""
import hmac
import json
import logging
import os

from ai import engine
from ai.parsing import EXTERNAL_TYPES, detect_action, detect_handoff, extract_bot_response
from contracts.base import ContractError
from contracts.bot import BotAction, BotError, BotRequest, BotResponse, Expediente, SummaryRequest, SummaryResponse
from core import numbers
from core.db import get_db

log = logging.getLogger(__name__)

DEFAULT_AI_OUTCOME_ACTIONS = ("interes_cita", "otro_motivo")
DEFAULT_AI_OUTCOME_TOOL = "Clasificar_Motivo"
SUMMARY_SESSION_SUFFIX = "-resumen"      # sesión aparte en Abacus: el resumen no ensucia la conversación del cliente
SUMMARY_INSTRUCTION = (
    "Resume en español, en no más de 5 líneas, la conversación siguiente entre un cliente y un asistente: qué quería el cliente, "
    "qué datos dio (nombre, vehículo, fechas) y cómo terminó. No inventes datos. Responde solo con el resumen.\n\n"
    "{previous}Conversación:\n{transcript}"
)


def authorized(headers, env=None) -> bool:
    """¿Viene de la función 2? Sin `BOT_FUNCTION_SECRET` se rechaza todo, salvo `ALLOW_UNAUTHENTICATED_BOT=true` (desarrollo local)."""
    env = os.environ if env is None else env
    secret = env.get("BOT_FUNCTION_SECRET", "")
    if not secret:
        return env.get("ALLOW_UNAUTHENTICATED_BOT", "").lower() == "true"
    return hmac.compare_digest((headers.get("X-Service-Secret") or "").encode(), secret.encode())


def _error_from(api_result: dict) -> BotError:
    detail = str(api_result.get("error", ""))
    if "timed out" in detail.lower() or "timeout" in detail.lower():
        return BotError("timeout", detail, retryable=True)
    return BotError("bot_error", detail, retryable=detail.startswith("Error:"))     # fallo de red sí se reintenta; un HTTP 4xx/5xx del motor no


def with_expediente(message: str, expediente: Expediente) -> str:
    if not expediente.datos and not expediente.resumenes:
        return message
    lines = ["[Expediente del cliente]"]
    if expediente.datos:
        lines.append("Datos: " + json.dumps(expediente.datos, ensure_ascii=False))
    lines += [f"Conversación anterior: {s}" for s in expediente.resumenes]
    return "\n".join(lines) + "\n\n" + message


def _messages(request: BotRequest, bot_type: str) -> list[dict]:
    history = [{"is_user": h.role == "customer", "text": h.text} for h in (request.history or [])] if bot_type in EXTERNAL_TYPES else []
    return history + [{"is_user": True, "text": with_expediente(request.message, request.expediente)}]


def parse_result(bot: dict, api_result: dict) -> BotResponse:
    """`api_result` del motor -> contrato de respuesta."""
    if "error" in api_result:
        return BotResponse(ok=False, error=_error_from(api_result))
    bot_type = bot.get("type", "chatllm")
    tool_names = tuple(t["name"] for t in bot.get("tools") or [] if t.get("name"))
    handoff = detect_handoff(api_result, bot_type)
    raw_actions = (api_result.get("result") or {}).get("actions") or [] if bot_type in EXTERNAL_TYPES else []
    return BotResponse(
        ok=True, text=extract_bot_response(api_result, tool_names),
        motivo=detect_action(api_result, bot_type, bot.get("outcomeActions") or DEFAULT_AI_OUTCOME_ACTIONS,
                             tool_name=bot.get("outcomeTool", DEFAULT_AI_OUTCOME_TOOL)),
        handoff=handoff["triggered"], handoff_motivo=handoff.get("motivo") if handoff["triggered"] else None,
        actions=[BotAction(a["name"], a.get("params") or {}) for a in raw_actions if isinstance(a, dict) and a.get("name")],
    )


def run_turn(request: BotRequest, db=None) -> BotResponse:
    """Un turno del bot. Un fallo vuelve como `ok=false` con su error tipado."""
    bot = numbers.get_bot_by_id(request.bot_id, db or get_db())
    if not bot:
        return BotResponse(ok=False, error=BotError("bot_no_configurado", f"no existe el bot {request.bot_id!r}"))
    api_result = engine.send_to_bot(bot, _messages(request, bot.get("type", "chatllm")), conv_id=request.conversation_id,
                                    customer_phone=request.customer_phone)
    return parse_result(bot, api_result)


def run_summary(request: SummaryRequest, db=None) -> SummaryResponse:
    """Resumen de una conversación cerrada."""
    bot = numbers.get_bot_by_id(request.bot_id, db or get_db())
    if not bot:
        return SummaryResponse(ok=False, error=BotError("bot_no_configurado", f"no existe el bot {request.bot_id!r}"))
    transcript = "\n".join(f"{'Cliente' if h.role == 'customer' else 'Asistente'}: {h.text}" for h in request.history)
    previous = "".join(f"Resumen anterior: {s}\n" for s in request.previous_summaries)
    prompt = SUMMARY_INSTRUCTION.format(previous=f"{previous}\n" if previous else "", transcript=transcript)
    api_result = engine.send_to_bot(bot, [{"is_user": True, "text": prompt}], conv_id=request.conversation_id + SUMMARY_SESSION_SUFFIX)
    if "error" in api_result:
        return SummaryResponse(ok=False, error=_error_from(api_result))
    summary = extract_bot_response(api_result).strip()
    if not summary:
        return SummaryResponse(ok=False, error=BotError("sin_resumen", "el bot no devolvió texto", retryable=True))
    return SummaryResponse(ok=True, summary=summary)


def handle(path: str, headers, body, env=None, db=None) -> tuple[dict, int]:
    """Entry point HTTP. 401 sin secreto, 404 si la ruta no existe, 400 si el cuerpo incumple el contrato; el resto, 200."""
    if not authorized(headers, env):
        return {"error": "Unauthorized"}, 401
    route = (path or "").rstrip("/")
    try:
        if route.endswith("/bot/turn"):
            return run_turn(BotRequest.from_dict(body), db).to_dict(), 200
        if route.endswith("/bot/summary"):
            return run_summary(SummaryRequest.from_dict(body), db).to_dict(), 200
    except ContractError as e:
        return {"error": str(e)}, 400
    return {"error": "Not Found"}, 404
