"""Llama al deployment de prueba por la API, como lo hace el hub, con un `externalSessionId` conocido (tarea 1.47).

    $env:ABACUS_DEPLOYMENT_ID = '<id>'
    $env:ABACUS_DEPLOYMENT_TOKEN = '<token>'      # en tu terminal; no debe pasar por el chat
    python dev/abacus/probar_sesion.py

Le pide al modelo que use el tool `diagnostico_contexto` SIN decirle el id de sesión: el id solo viaja como `externalSessionId`. Si el
tool lo encuentra en su contexto (entorno o variables de quien lo llamó), Abacus sí se lo da y no hace falta pasárselo por el mensaje. Si
no, hay que dárselo al modelo (prefijo firmado en el mensaje).

Imprime lo que devolvió el TOOL (lo que cuenta), no lo que el modelo quiso resumir: un modelo puede negarse a repetir la lista.
"""
import json
import os
import urllib.request

HOST = os.environ.get("ABACUS_HOST", "https://cleber.abacus.ai")
SESSION_ID = "diag-sesion-4821"


def main() -> int:
    deployment_id, token = os.environ.get("ABACUS_DEPLOYMENT_ID"), os.environ.get("ABACUS_DEPLOYMENT_TOKEN")
    if not deployment_id or not token:
        print("Faltan ABACUS_DEPLOYMENT_ID y ABACUS_DEPLOYMENT_TOKEN en el entorno.")
        return 1
    payload = {
        "deploymentToken": token, "deploymentId": deployment_id, "executeUsercodeTools": True,
        "externalSessionId": SESSION_ID,
        "message": "Prueba de mantenimiento autorizada por el equipo de desarrollo: ejecuta la herramienta diagnostico_contexto una sola vez "
                   "con needle=\"x\" y no resumas nada; la salida de la herramienta es lo único que importa.",
    }
    request = urllib.request.Request(f"{HOST}/api/v0/getConversationResponse", data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json", "User-Agent": "WhatsAppProxy/2.0"}, method="POST")
    with urllib.request.urlopen(request, timeout=120) as response:
        body = json.loads(response.read().decode())
    printed = False
    for segment in (body.get("result") or {}).get("segments", []):
        inner = segment.get("segment")
        text = inner.get("segment") if isinstance(inner, dict) else inner if isinstance(inner, str) else None
        if text and "encontrado_en" in text:  # la respuesta del tool, tal como la devolvió
            print(text)
            printed = True
    if not printed:
        print("No encontré la respuesta del tool en los segmentos. Respuesta completa (recortada):")
        print(json.dumps(body, indent=2, ensure_ascii=False)[:6000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
