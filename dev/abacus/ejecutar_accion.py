"""Tool para Abacus: pide una acción al hub (`hub-actions-execute`, §7.8 del plan, tarea 1.47).

Se pega tal cual como tool de código en el ChatLLM. Solo usa la biblioteca estándar.

Qué hace: manda `POST <HUB_ACTIONS_URL>` con `{action, conversationId, idempotencyKey, data}` y devuelve la respuesta del hub
(`{ok, status, result}` o `{ok: false, error: {code, message, retryable}}`). El hub pone el cliente, la organización, la vertical
y el BOT a partir de `conversation_id`; el modelo solo manda lo que conoce (fecha, hora, modelo...). Por eso es un solo tool para todos
los bots (Honda, Kia, Toyota; Ventas y Servicio): no lleva `botId`.

Antes de pegarlo: llena HUB_ACTIONS_URL y crea en Abacus (Manage Profile → Secrets) el secreto HUB_ACTIONS_SERVICE_KEY con el valor de
ACTIONS_SERVICE_KEY de la función hub-actions-execute. El secreto solo se lee dentro de un entorno administrado por Abacus (el runtime
del tool); fuera de él llega enmascarado. No lo restrinjas a un grupo de usuarios que no incluya a quien chatea: el tool corre como ese usuario.
"""
import hashlib
import json
import os
import urllib.error
import urllib.request

HUB_ACTIONS_URL = "<URL de hub-actions-execute, sin ruta>"   # gcloud functions describe hub-actions-execute --gen2 ...
SECRET_NAME = "HUB_ACTIONS_SERVICE_KEY"   # secreto de organización en Abacus; NO pegar la clave en este archivo

# Más que el timeout del endpoint (120 s) no sirve: si vence aquí, el reintento con la misma clave de idempotencia no repite el efecto
TIMEOUT_SECONDS = 115


def ejecutar_accion(conversation_id: str, action: str, data: str = None, idempotency_key: str = None) -> dict:
    """Pide una acción al hub y devuelve su resultado.

    Args:
        conversation_id: id de la conversación (el mismo `externalSessionId` de esta sesión). Sin él el hub no sabe de qué cliente se trata.
        action: nombre de la acción, tal como está en los tools del bot (p. ej. "Crear_Lead", "Registrar_Cita",
            "Actualizar_Lead", "Transferir_a_Asesor", "Clasificar_Motivo").
        data: objeto JSON como TEXTO (Abacus no admite JSON en los tools), solo con lo que el modelo conoce para esa acción
            (fecha, hora, sede, modelo...), p. ej. '{"fecha": "2026-10-30", "hora": "10:00"}'. Nunca teléfono ni organización.
        idempotency_key: opcional. Si no se manda, se calcula de conversación + acción + datos, así repetir la misma llamada
            (un reintento del modelo) no duplica el Lead ni la cita.

    Returns:
        `{"ok": true, "status": "done"|"duplicate"|"accepted", "result": {...}}` o
        `{"ok": false, "error": {"code": "...", "message": "...", "retryable": bool}}`. Si `retryable` es true se puede reintentar tal cual.
    """
    if isinstance(data, str):
        try:
            data = json.loads(data) if data.strip() else {}
        except ValueError:
            return _error("datos_invalidos", "`data` debe ser un objeto JSON válido en texto", retryable=False)
    data = data or {}
    if not isinstance(data, dict):
        return _error("datos_invalidos", "`data` debe ser un objeto JSON, no una lista ni un valor suelto", retryable=False)
    key =idempotency_key or hashlib.sha256(
        json.dumps([conversation_id, action, data], sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()[:32]
    body = json.dumps({"schemaVersion": 1, "action": action, "conversationId": conversation_id, "idempotencyKey": key, "data": data},
                      ensure_ascii=False, default=str).encode("utf-8")
    try:
        request = urllib.request.Request(HUB_ACTIONS_URL, data=body, method="POST", headers={
            "Content-Type": "application/json", "Authorization": "Bearer " + _service_key()})
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8"))
        except ValueError:
            return _error("error_externo", f"El hub respondió {e.code}", retryable=e.code >= 500)
    except Exception as e:  # sin red, timeout...
        return _error("error_externo", f"No se pudo hablar con el hub: {e}", retryable=True)


def _service_key() -> str:
    """La clave de servicio: del secreto de Abacus; la variable de entorno solo sirve para probar fuera de Abacus."""
    if os.environ.get(SECRET_NAME):
        return os.environ[SECRET_NAME]
    from abacusai import ApiClient
    value = ApiClient().get_organization_secret(secret_key=SECRET_NAME).value
    if not value:
        raise RuntimeError(f"el secreto {SECRET_NAME} no tiene valor (¿no existe, o se leyó fuera de un entorno de Abacus?)")
    return value


def _error(code: str, message: str, retryable: bool) -> dict:
    return {"ok": False, "status": None, "result": {}, "error": {"code": code, "message": message, "retryable": retryable}}
