"""Endpoint de acciones (tarea 1.44, §7.8): los bots piden cada acción al hub y reciben el resultado.

    POST /actions/execute
    Headers: Authorization: Bearer <clave de servicio>            (un solo tool de Abacus para todos los bots)
             o bien X-Bot-Id: <bot> + Authorization: Bearer <clave del bot>   (un workflow con su propia clave)
    Cuerpo:  contracts.ActionRequest   Respuesta: contracts.ActionResponse

Reglas:
  - El servidor pone el contexto: teléfono, organización, equipo y vertical salen de la conversación,
    nunca de `data`. El bot solo manda lo que conoce (fecha, hora, modelo...).
  - Un bot solo pide las acciones de su `tools[]` y que el registro (`core.tools`) expone a bots.
  - Un bot solo actúa sobre conversaciones suyas (bot de la conversación, asignado o activo).
  - Con la clave de servicio no se dice qué bot es: sale de la conversación (`_conversation_bot`) y desde ahí rige igual su `tools[]`.
  - Un mismo `idempotencyKey` no repite el efecto: devuelve el resultado ya calculado.
  - Los handlers corren con un `ActionContext`: igual que el `Turn` del pipeline, pero cada operación
    en segundo plano (`fire`) se ejecuta en el momento, para devolverle al bot el resultado real
    y no un "recibido". Un fallo de Salesforce o de Firestore llega como `error_externo`.

Estados HTTP: 401 sin autenticación válida, 400 si el cuerpo no cumple el contrato, 200 para todo lo
demás (el motivo de un rechazo de negocio va en `error.code`: un workflow no pierde el cuerpo) y
202 si el resultado quedó pendiente.
"""
import hmac
import json
import logging
import os
from concurrent.futures import Future

from contracts.actions import (CONVERSACION_NO_ENCONTRADA, ERROR_EXTERNO, NO_AUTORIZADO, ACCION_NO_PERMITIDA,
                               ActionRequest, ActionResponse)
from contracts.base import ContractError
from core import action_log, idempotency, tools
from core.db import get_db
from core.default_tools import register_defaults
from core.numbers import get_bot_for_conversation
from core.pipeline import DEFAULT_TOOLS
from core.tools import dispatch

log = logging.getLogger(__name__)

IDEMPOTENCY_SOURCE = "action"
PENDING_RESULT = {"estado": "en_proceso"}


class ActionContext:
    """Lo que un handler espera de `Turn`, para correr fuera del pipeline.

    `fire` ejecuta en el momento y recuerda lo que pasó; `response`, `handled` y `stop` existen porque
    los handlers los escriben, pero aquí no hay respuesta al cliente que reemplazar.
    """

    def __init__(self, bot: dict, conv_id: str, conv_data: dict, db):
        self.bot, self.conv_id, self.db = bot, conv_id, db
        self.customer = conv_data.get("customerPhone", "")
        self.conv_data, self.messages = conv_data, []
        self.response, self.handled, self.stop = "", False, False
        self.stop_reason = ""       # por qué un handler de `handoff_gate` frenó la acción (se le devuelve al bot)
        self.via_endpoint = True    # los handlers que le hablan al cliente (`turn.say`) no deben hacerlo aquí: lo dice el pipeline
        self.flags: dict = {}
        self.futures: list[Future] = []

    @property
    def org_id(self):
        return self.conv_data.get("organizationId") or self.bot.get("organizationId")

    def fire(self, fn, *args, **kwargs) -> Future:
        future: Future = Future()
        try:
            future.set_result(fn(*args, **kwargs))
        except Exception as e:
            log.exception("error en una operación de la acción %s", getattr(fn, "__name__", fn))
            future.set_exception(e)
        self.futures.append(future)
        return future

    def wait(self, futures=None) -> None:
        """Nada que esperar: todo corrió en `fire`."""

    def emit(self, event: str, **params) -> None:
        dispatch(event, self.conv_data, {"turn": self, "bot": self.bot, "conv_id": self.conv_id, **params})

    def failed(self) -> bool:
        """Una operación lanzó, o devolvió False (las de Salesforce devuelven False si no se confirmó)."""
        return any(f.exception() is not None or f.result() is False for f in self.futures)


# --------------------------------------------------------------------------- autenticación

def _bearer(headers) -> str:
    return (headers.get("Authorization") or "").removeprefix("Bearer ").strip()


def is_service_caller(headers, env=None) -> bool:
    """La petición trae la clave de servicio (`ACTIONS_SERVICE_KEY`): un tool compartido por todos los bots. Falla cerrado.

    La clave no identifica a un bot: quien la usa puede pedir acciones sobre cualquier conversación, y el bot se resuelve
    desde la conversación (su `tools[]` sigue limitando qué acciones puede pedir). Se rota cambiando la variable y el secreto del tool.
    """
    env = os.environ if env is None else env
    expected, token = (env.get("ACTIONS_SERVICE_KEY") or "").strip(), _bearer(headers)
    return bool(expected and token) and hmac.compare_digest(token.encode(), expected.encode())


def authenticate(headers, env=None) -> str | None:
    """Id del bot que hace la petición con una clave PROPIA, o None. Falla cerrado.

    Las claves viven en `BOT_ACTION_KEYS` (JSON `{botId: clave}`, montado desde Secret Manager), no en
    Firestore: los usuarios de la organización pueden leer los documentos de `bots`.
    """
    env = os.environ if env is None else env
    try:
        keys = json.loads(env.get("BOT_ACTION_KEYS") or "{}")
    except ValueError:
        log.error("BOT_ACTION_KEYS no es un JSON válido")
        return None
    bot_id = (headers.get("X-Bot-Id") or "").strip()
    token = _bearer(headers)
    expected = keys.get(bot_id) if isinstance(keys, dict) else None
    if not bot_id or not token or not isinstance(expected, str) or not expected:
        return None
    return bot_id if hmac.compare_digest(token.encode(), expected.encode()) else None


def _conversation_bot(conv: dict) -> str | None:
    """El bot que atiende ahora la conversación: el activo (lo pone el ruteo al cambiar de bot), si no el asignado, si no el del canal."""
    return conv.get("activeBotId") or conv.get("assignedBotId") or conv.get("botId") or None


# --------------------------------------------------------------------------- ejecución

def _find_tool(bot: dict, action: str) -> dict | None:
    """El tool del bot que corresponde a `action` (su nombre en Abacus o su evento)."""
    for spec in bot.get("tools") or DEFAULT_TOOLS:
        if action in (spec.get("name"), spec.get("event")):
            return spec
    return None


def _confirmed(response: ActionResponse, ctx: ActionContext) -> ActionResponse:
    """Con todo ya ejecutado, un "recibido" se vuelve "listo" o fallo, según lo que pasó de verdad."""
    if response.ok and ctx.failed():
        return ActionResponse.failure(ERROR_EXTERNO, "La operación no se confirmó en Salesforce o en la base de datos", retryable=True)
    if response.ok and response.status == "accepted":
        result = {k: ("ok" if v == "en_proceso" else v) for k, v in response.result.items()}
        return ActionResponse.success(result)
    return response


def execute_action(request: ActionRequest, bot_id: str | None, db=None) -> ActionResponse:
    """Ejecuta la acción pedida por el bot `bot_id` (ya autenticado). Nunca lanza.

    Con `bot_id=None` (clave de servicio) el bot es el que atiende la conversación."""
    register_defaults()  # los contratos y handlers del núcleo; el pipeline hace lo mismo en cada mensaje
    db = db or get_db()
    snap = db.collection("conversations").document(request.conversation_id).get()
    if not snap.exists:
        return ActionResponse.failure(CONVERSACION_NO_ENCONTRADA, "La conversación no existe")
    conv = snap.to_dict() or {}
    conv["id"] = request.conversation_id
    if bot_id is None:
        bot_id = _conversation_bot(conv)
        if bot_id is None:
            return ActionResponse.failure(NO_AUTORIZADO, "La conversación no tiene bot")
    owners = {conv.get("botId"), conv.get("assignedBotId"), conv.get("activeBotId")} - {None}
    if bot_id not in owners:
        return ActionResponse.failure(NO_AUTORIZADO, "Esta conversación no pertenece al bot")

    bot, _ = get_bot_for_conversation(bot_id, conv.get("whatsappNumberId"), db)
    if not bot:
        return ActionResponse.failure(NO_AUTORIZADO, "El bot no existe")
    tool_spec = _find_tool(bot, request.action)
    if tool_spec is None:
        return ActionResponse.failure(ACCION_NO_PERMITIDA, f"El bot no tiene habilitada la acción {request.action!r}")

    key = f"{request.conversation_id}__{request.idempotency_key}"
    if idempotency.is_duplicate(IDEMPOTENCY_SOURCE, key, db):
        stored = idempotency.get_result(IDEMPOTENCY_SOURCE, key, db)
        if stored is None:  # otra petición con la misma clave sigue en curso
            return ActionResponse.success(dict(PENDING_RESULT), status="accepted")
        return ActionResponse.success(stored.get("result") or {}, status="duplicate")

    ctx = ActionContext(bot, request.conversation_id, conv, db)
    params = {"turn": ctx, "bot": bot, "conv_id": request.conversation_id, "input": request.data, "tool": tool_spec.get("name")}
    response = _confirmed(tools.execute(tool_spec["event"], conv, params, from_bot=True), ctx)

    if response.ok:
        idempotency.save_result(IDEMPOTENCY_SOURCE, key, response.to_dict(), db)
        action_log.record(request.conversation_id, request.idempotency_key, tool_spec["event"], tool_spec.get("name", ""),
                          response.to_dict(), conv.get("turnId"), db)
    else:
        idempotency.release(IDEMPOTENCY_SOURCE, key, db)  # un reintento con la misma clave debe volver a correr
    return response


def handle(headers, body, db=None, env=None) -> tuple[dict, int]:
    """Entrada HTTP: autentica, valida el contrato y ejecuta. Devuelve (cuerpo, estado)."""
    service = is_service_caller(headers, env)
    bot_id = None if service else authenticate(headers, env)
    if bot_id is None and not service:
        return {"error": "Unauthorized"}, 401
    try:
        request = ActionRequest.from_dict(body)
    except ContractError as e:
        return {"error": str(e)}, 400
    response = execute_action(request, bot_id, db)
    return response.to_dict(), 202 if response.ok and response.status == "accepted" else 200
