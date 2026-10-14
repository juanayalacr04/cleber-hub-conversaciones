"""Envío del mensaje al bot, un motor por `bots/{id}.type` (la elección es configuración, no código).

  chatllm   Abacus ChatLLM (getConversationResponse)
  workflow  Abacus IA Workflow (executeSyncConversationAgent en el proxy endpoint)
  external  bot HTTP que implementa el contrato de la plataforma ("vertex_ai" es alias, por el bot
            Toyota en producción)

Todos devuelven un `api_result` con la forma que entiende `ai.parsing`.
"""
import json
import logging
import os
import urllib.parse

from core import http

log = logging.getLogger(__name__)

MAX_HISTORY_MESSAGES = int(os.environ.get("MAX_HISTORY_MESSAGES", "10"))
# Host dedicado de la cuenta (no comparte rate limit con api.abacus.ai). Se puede fijar por bot
# con abacusConfig.apiHost.
DEFAULT_CHATLLM_HOST = os.environ.get("ABACUS_CHATLLM_HOST", "https://cleber.abacus.ai")
ABACUS_API = "https://api.abacus.ai"
EXTERNAL_TYPES = ("external", "vertex_ai")

_proxy_cache: dict[str, str] = {}


def get_abacus_proxy_endpoint(deployment_id: str, deployment_token: str) -> str | None:
    """proxyEndpoint de un deployment de Abacus (caché)."""
    key = f"{deployment_id}|{deployment_token}"
    if key in _proxy_cache:
        return _proxy_cache[key]
    url = (f"{ABACUS_API}/api/v0/getApiEndpoint?deploymentId={urllib.parse.quote(deployment_id or '')}"
           f"&deploymentToken={urllib.parse.quote(deployment_token or '')}")
    try:
        _, body = http.request(url, method="GET")
        proxy = json.loads(body).get("result", {}).get("proxyEndpoint")
        if proxy:
            _proxy_cache[key] = proxy
        return proxy
    except Exception as e:
        log.error("Error obteniendo el proxy endpoint de Abacus: %s", e)
        return None


def clear_caches() -> None:
    _proxy_cache.clear()


def _last_user_message(messages: list) -> str:
    for msg in reversed(messages):
        if msg.get("is_user"):
            return msg.get("text", "")
    return ""


def _post_json(url: str, payload: dict, headers: dict, timeout: int = 120) -> dict:
    try:
        _, body = http.request(url, json.dumps(payload).encode("utf-8"), headers, timeout=timeout)
        return json.loads(body)
    except http.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        log.error("Bot HTTP %s: %s", e.code, detail)
        return {"error": f"HTTP {e.code}: {detail}"}
    except Exception as e:
        log.error("Error llamando al bot: %s", e)
        return {"error": f"Error: {e}"}


def _send_external(bot_config: dict, messages: list, conv_id: str | None, customer_phone: str) -> dict:
    ext = bot_config.get("externalConfig") or bot_config.get("vertexAiConfig", {})
    endpoint = ext.get("endpoint", "")
    if not endpoint:
        return {"error": "externalConfig.endpoint not configured"}

    history = [
        {"role": "customer" if m.get("is_user") else "bot", "text": m.get("text", "")}
        for m in messages[-(MAX_HISTORY_MESSAGES * 2):]
    ]
    payload = {
        "message": _last_user_message(messages), "session_id": conv_id or "",
        "customer_phone": customer_phone, "history": history,
    }
    headers = {"Content-Type": "application/json"}
    if ext.get("apiKey"):
        headers["Authorization"] = f"Bearer {ext['apiKey']}"

    result = _post_json(endpoint, payload, headers)
    if "error" in result:
        return result
    return normalize_external_result(result)


def normalize_external_result(result: dict) -> dict:
    """Contrato del bot externo -> api_result.

    Un bot nuevo responde con `actions: [{"name", "params"}]`, que pasa tal cual. Los bots viejos
    (Toyota) responden con un solo `action` que se traduce a su tool equivalente.
    """
    out = {"response": result.get("response", ""), "toolResults": []}
    if result.get("actions"):
        out["actions"] = result["actions"]
    action = result.get("action", "ninguna")
    metadata = result.get("metadata", {}) or {}
    if action == "handoff":
        motivo = metadata.get("motivo", "handoff")
        out["toolResults"].append({"toolName": "Transferir_a_Asesor", "input": {"motivo": motivo}, "output": motivo})
    elif action == "guardar_nombre" and metadata.get("nombre"):
        out["toolResults"].append({"toolName": "Guardar_Nombre_Cliente", "input": {"nombre": metadata["nombre"]}})
    elif action == "cita_agendada":
        out["toolResults"].append({"toolName": "Registrar_Cita"})
    return {"success": True, "result": out}


def send_to_bot(bot_config: dict, messages: list, conv_id: str | None = None, customer_phone: str = "") -> dict:
    """Envía el último mensaje del cliente al bot y devuelve su `api_result`, o {"error": ...}."""
    abacus = bot_config.get("abacusConfig", {})
    bot_type = bot_config.get("type", "chatllm")
    if bot_type in EXTERNAL_TYPES:
        return _send_external(bot_config, messages, conv_id, customer_phone)

    last = _last_user_message(messages)
    headers = {"Content-Type": "application/json"}

    if bot_type == "workflow":
        # Los workflows usan executeSyncConversationAgent en el proxy endpoint, con el header
        # APIKEY (mayúsculas) para que externalSessionId persista la sesión.
        proxy = get_abacus_proxy_endpoint(abacus.get("deploymentId"), abacus.get("deploymentToken"))
        if not proxy:
            return {"error": "Could not get Abacus proxy endpoint"}
        url = (f"{proxy}/api/executeSyncConversationAgent?deploymentToken={urllib.parse.quote(abacus.get('deploymentToken', ''))}"
               f"&deploymentId={urllib.parse.quote(abacus.get('deploymentId', ''))}")
        args = {abacus.get("workflowInputName", "message"): last}
        if customer_phone:
            args["telefono_cliente"] = customer_phone
        payload = {"keywordArguments": args}
        if abacus.get("apiKey"):
            headers["APIKEY"] = abacus["apiKey"]
        else:
            headers["User-Agent"] = "WhatsAppProxy/2.0"
    else:
        host = abacus.get("apiHost") or DEFAULT_CHATLLM_HOST
        url = f"{host}/api/v0/getConversationResponse"
        payload = {
            "deploymentToken": abacus.get("deploymentToken"), "deploymentId": abacus.get("deploymentId"),
            "message": last, "executeUsercodeTools": True,
        }
        headers["User-Agent"] = "WhatsAppProxy/2.0"

    if conv_id:
        payload["externalSessionId"] = conv_id
    return _post_json(url, payload, headers)
