"""Capa de parseo de las respuestas de los bots (tareas 1.1 a 1.4).

La diferencia entre motores muere aquí: el núcleo y los handlers de `modules/` reciben datos
normalizados y no saben con qué motor se generaron.

Estrategias por motor (`bots/{id}.type`):
  chatllm   toolResults; si no, result.segments[].title == "Executing <tool>"
  workflow  toolResults; si no, result.response.segments[] con id == "action"
  external  toolResults ya normalizados por el motor, más el contrato `actions: [...]`
            ("vertex_ai" se mantiene como alias de "external" por el bot Toyota en producción)

Los nombres de tool y los vocabularios de acciones son configuración del bot
(`bots/{id}.tools[]`, vocabularios), no constantes de este módulo.
"""
import json
import logging
import re

log = logging.getLogger(__name__)

NOT_TRIGGERED = {"triggered": False}
EXTERNAL_TYPES = ("external", "vertex_ai")


def _ok_result(api_result: dict) -> dict | None:
    if not isinstance(api_result, dict) or not api_result.get("success") or "result" not in api_result:
        return None
    result = api_result["result"]
    return result if isinstance(result, dict) else None


# --------------------------------------------------------------------------- chatllm

def parse_params_from_segment(segment: dict) -> dict | None:
    """Extrae el dict de params del segmento interno de un tool call de Abacus ChatLLM.

    Abacus devuelve los params como bloque ```python\\nparams = {...}\\n``` en el campo
    segment.segment del collapsible_component. Se decodifica con raw_decode desde la primera
    llave, así soporta dicts anidados (el regex original cortaba en la primera `}`).
    """
    inner = segment.get("segment", {})
    text = inner.get("segment", "") if isinstance(inner, dict) else ""
    match = re.search(r"params\s*=\s*(?=\{)", text)
    if not match:
        return None
    try:
        value, _ = json.JSONDecoder().raw_decode(text[match.end():])
    except (json.JSONDecodeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def find_tool_params_in_segments(result: dict, tool_name: str) -> dict | None:
    """Busca un tool call del ChatLLM en los segments y retorna sus params.

    TRAMPA CONOCIDA: Abacus emite DOS segments con el mismo title "Executing <tool>": primero
    uno de tipo text (sin params) y después el collapsible_component que sí los trae. Hay que
    recorrer todos y quedarse con el primero que parsee params, no con el primero que haga
    match del title: quedarse con el primero perdía el 100% de los params (ej. una cita
    agendada a la fecha y hora por defecto en vez de la pedida). Cubierto en tests/test_parsing.py.

    Retorna None si el tool no aparece en ningún segment, o el dict de params
    ({} si aparece pero no se pudieron parsear).
    """
    found = False
    for segment in result.get("segments", []):
        if tool_name not in (segment.get("title") or ""):
            continue
        found = True
        params = parse_params_from_segment(segment)
        if params:
            return params
    return {} if found else None


def _tool_result_input(result: dict, tool_name: str) -> dict | None:
    for tool_result in result.get("toolResults", []) or []:
        if tool_result.get("toolName") == tool_name:
            return tool_result.get("input", {}) or {}
    return None


def _detect_chatllm(result: dict, tool_name: str) -> dict:
    params = _tool_result_input(result, tool_name)
    if params is not None:
        return {"triggered": True, "input": params}
    params = find_tool_params_in_segments(result, tool_name)
    if params is not None:
        return {"triggered": True, "input": params}
    return NOT_TRIGGERED


# --------------------------------------------------------------------------- workflow

def _workflow_action_segments(result: dict) -> list[str]:
    response = result.get("response", "")
    if not isinstance(response, dict):
        return []
    return [
        seg["segment"].strip()
        for seg in response.get("segments", [])
        if seg.get("id") == "action" and isinstance(seg.get("segment"), str)
    ]


def _detect_workflow(result: dict, tool_name: str) -> dict:
    params = _tool_result_input(result, tool_name)
    if params is not None:
        return {"triggered": True, "input": params}
    # En un workflow el segmento "action" trae el nombre de la acción como texto plano.
    if tool_name in _workflow_action_segments(result):
        return {"triggered": True, "input": {}}
    return NOT_TRIGGERED


# --------------------------------------------------------------------------- external

def _detect_external(result: dict, tool_name: str) -> dict:
    params = _tool_result_input(result, tool_name)
    if params is not None:
        return {"triggered": True, "input": params}
    for action in result.get("actions", []) or []:
        if action.get("name") == tool_name:
            return {"triggered": True, "input": action.get("params", {}) or {}}
    return NOT_TRIGGERED


_STRATEGIES = {
    "chatllm": _detect_chatllm,
    "workflow": _detect_workflow,
    "external": _detect_external,
    "vertex_ai": _detect_external,
}


def detect(api_result: dict, bot_type: str, tool_name: str) -> dict:
    """¿El bot llamó a `tool_name`? Devuelve {"triggered": bool, "input": dict}.

    Reemplaza a las seis `check_*_tool_call` de Comercial: el nombre del tool es config del bot.
    """
    result = _ok_result(api_result)
    if result is None:
        return NOT_TRIGGERED
    strategy = _STRATEGIES.get(bot_type or "chatllm")
    if strategy is None:
        log.warning("tipo de bot sin estrategia de parseo: %r", bot_type)
        return NOT_TRIGGERED
    try:
        return strategy(result, tool_name)
    except Exception:
        log.exception("error detectando el tool %r (bot %r)", tool_name, bot_type)
        return NOT_TRIGGERED


def detect_action(api_result: dict, bot_type: str, vocabulary, tool_name: str | None = None, param: str = "motivo") -> str | None:
    """Acción clasificada por el bot dentro de un vocabulario configurable.

    Reemplaza a `get_ai_outcome_action` y `get_broadcast_response_action` de Servicio. En un
    workflow la acción puede venir como segmento `action` de texto plano; si el bot la reporta
    con un tool (`tool_name`), se lee de su campo `param`. Devuelve None si no hay acción válida.
    """
    result = _ok_result(api_result)
    if result is None:
        return None
    vocab = set(vocabulary)
    try:
        if tool_name:
            hit = detect(api_result, bot_type, tool_name)
            if hit["triggered"]:
                value = str(hit["input"].get(param, "")).strip()
                if value in vocab:
                    return value
        if (bot_type or "chatllm") == "workflow":
            for action in _workflow_action_segments(result):
                if action in vocab:
                    return action
        if bot_type in EXTERNAL_TYPES:
            for action in result.get("actions", []) or []:
                if action.get("name") in vocab:
                    return action["name"]
    except Exception:
        log.exception("error leyendo la acción del bot")
    return None


# --------------------------------------------------------------------------- texto

def clean_chatllm_text(text: str, tool_names: tuple[str, ...] = ()) -> str:
    """Elimina artefactos que Abacus ChatLLM embebe en el response text.

    `tool_names` son los tools del bot (config): sirven para quitar las líneas donde el modelo
    narra la invocación de un tool.
    """
    if not isinstance(text, str):
        return text
    # "Executing ToolName\n\n..." — prefijo de ejecución de tool
    text = re.sub(r"^Executing \w+\n+", "", text)
    # Líneas iniciales donde el modelo narra la invocación de un tool. Solo se quitan si queda
    # respuesta real después: si el mensaje entero es el eco, se prefiere dejarlo a devolver
    # vacío y que extract_bot_response repita un mensaje anterior.
    if tool_names:
        echo = re.compile(r"^(?:[ \t]*(?:%s)\b.*(?:\n|$))+" % "|".join(re.escape(n) for n in tool_names))
        stripped = echo.sub("", text)
        if stripped.strip():
            text = stripped
    # Fragmentos de JSON de parámetros de tool call, e.g. `tech" "honda_hr-v"}`
    text = re.sub(r'^\s*(?:[\w]+"\s+"[\w\-\.]+"\}\s*)+', "", text)
    # Bloques JSON completos solos al inicio, e.g. `{"key": "value"}`
    text = re.sub(r"^\s*\{[^{}]*\}\s*", "", text)
    # Bloques de código markdown con lenguaje: el LLM a veces incluye el código del interpreter
    text = re.sub(r"```[\w]*\n.*?```\n?", "", text, flags=re.DOTALL)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_bot_response(api_result: dict, tool_names: tuple[str, ...] = ()) -> str:
    """Extrae el texto de respuesta del bot del resultado del API."""
    if "error" in api_result:
        return "Lo siento, hubo un error procesando tu mensaje. Por favor intenta de nuevo."
    try:
        result = _ok_result(api_result)
        if result is not None:
            # Formato getConversationResponse / executeSyncConversationAgent
            if "response" in result:
                response = result.get("response", "Sin respuesta disponible")
                # Workflow devuelve {"response": {"response": "texto"}} o {"response": {"segments": [...]}}
                if isinstance(response, dict):
                    segments = response.get("segments", [])
                    if segments:
                        text_parts = [s.get("segment", "") for s in segments if s.get("type") == "text" and s.get("id") != "action"]
                        if text_parts:
                            return "\n".join(text_parts)
                    return response.get("response", "Sin respuesta disponible")
                return clean_chatllm_text(response, tool_names)
            # Formato chatLLM: result tiene "messages" array
            for msg in reversed(result.get("messages", [])):
                if not msg.get("is_user", True):
                    text = clean_chatllm_text(msg.get("text", ""), tool_names)
                    if text:
                        return text
        return "Lo siento, no pude procesar tu mensaje en este momento. ¿Puedes intentarlo de nuevo?"
    except Exception:
        log.exception("error parseando la respuesta del bot")
        return "Error procesando la respuesta. Por favor intenta de nuevo."
