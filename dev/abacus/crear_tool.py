"""Crea en Abacus el tool de PRUEBA `hub_ejecutar_accion_prueba` a partir de `ejecutar_accion.py` (tarea 1.47).

    pip install abacusai
    $env:ABACUS_API_KEY = '<tu api key>'          # en tu terminal; la clave no debe pasar por el chat ni quedar en un archivo
    python dev/abacus/crear_tool.py                muestra qué haría, sin tocar Abacus
    python dev/abacus/crear_tool.py --crear        lo crea

Opcional: HUB_ACTIONS_URL en el entorno se escribe en la constante del código que se sube a Abacus (si no, el tool se crea con el
marcador `<...>` y no funcionará hasta que lo llenes en Abacus). La clave de servicio NO va en el código: es el secreto de organización
HUB_ACTIONS_SERVICE_KEY, que se crea aparte (Manage Profile → Secrets).

Se niega a crear si ya existe un tool con ese nombre: no sobrescribe nada. Usa el tipo USERCODE_TOOL del SDK (el de Custom Code → Tools →
Python Function). No está comprobado que un tool creado por API quede igual que uno creado en la interfaz: revisa en Custom Code → Tools.
"""
import os
import re
import sys
from pathlib import Path

NOMBRE_TOOL = "hub_ejecutar_accion_prueba"
FUNCION = "ejecutar_accion"
TIMEOUT_SEGUNDOS = 120   # el del endpoint; el cliente del tool espera 115

ARGUMENTOS = [  # (nombre, tipo, requerido, descripción)
    ("conversation_id", "STRING", True, "Id de la conversación (el externalSessionId de esta sesión). Sin él el hub no sabe de qué cliente se trata."),
    ("action", "STRING", True, "Nombre de la acción, tal como está en los tools del bot: Crear_Lead, Registrar_Cita, Actualizar_Lead, Transferir_a_Asesor, Clasificar_Motivo..."),
    # Abacus no admite JSON en tools: viaja como texto y `ejecutar_accion` lo convierte
    ("data", "STRING", False, 'Objeto JSON como texto, solo con lo que el modelo conoce para esa acción, p. ej. {"fecha": "2026-10-30", "hora": "10:00"}. Nunca teléfono ni organización.'),
    ("idempotency_key", "STRING", False, "Opcional. Sin ella se calcula de conversación + acción + datos."),
]

DESCRIPCION = ("Pide una acción al hub de conversaciones (crear o actualizar el Lead, registrar una cita, transferir a un asesor, clasificar el motivo) "
               "y devuelve su resultado: {ok, status, result} o {ok: false, error: {code, message, retryable}}. Con retryable true se puede repetir la misma llamada.")


def codigo() -> str:
    fuente = (Path(__file__).parent / "ejecutar_accion.py").read_text(encoding="utf-8")
    for var in ("HUB_ACTIONS_URL",):
        if os.environ.get(var):
            fuente, n = re.subn(rf'^{var} = ".*?"', lambda _m: f'{var} = {os.environ[var]!r}'.replace("'", '"'), fuente, count=1, flags=re.M)
            assert n == 1, f"no encontré {var} en ejecutar_accion.py"
    return fuente


def main() -> int:
    crear = "--crear" in sys.argv
    fuente = codigo()
    print(f"Tool: {NOMBRE_TOOL} (función {FUNCION}, tipo USERCODE_TOOL, timeout {TIMEOUT_SEGUNDOS} s)")
    print("Argumentos:", ", ".join(f"{n}:{t}{'*' if r else ''}" for n, t, r, _ in ARGUMENTOS))
    print("URL del hub en el código:", "llenas desde el entorno" if os.environ.get("HUB_ACTIONS_URL") else "con marcadores <...> (sin llenar)")
    if not crear:
        print("\n(simulación: no se tocó Abacus. Agrega --crear para crearlo)")
        return 0
    api_key = os.environ.get("ABACUS_API_KEY")
    if not api_key:
        print("Falta ABACUS_API_KEY en el entorno.")
        return 1
    from abacusai import ApiClient
    from abacusai.api_class import PythonFunctionArgument
    client = ApiClient(api_key=api_key)
    try:
        client.describe_python_function(NOMBRE_TOOL)
        print(f"Ya existe un tool llamado {NOMBRE_TOOL}: no se sobrescribe. Bórralo en Abacus o cambia NOMBRE_TOOL.")
        return 1
    except Exception:
        pass  # no existe (o no se pudo consultar): se intenta crear
    creado = client.create_python_function(
        name=NOMBRE_TOOL, source_code=fuente, function_name=FUNCION, function_type="USERCODE_TOOL", description=DESCRIPCION, timeout=TIMEOUT_SEGUNDOS,
        function_variable_mappings=[PythonFunctionArgument(variable_type=t, name=n, is_required=r, description=d) for n, t, r, d in ARGUMENTOS])
    print("Creado:", creado)
    print("Revísalo en Custom Code → Tools y, si aparece, selecciónalo en las opciones del chatbot de prueba.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
