"""Crea en Abacus el tool TEMPORAL `hub_diagnostico_contexto` a partir de `diagnostico_contexto.py` (tarea 1.47), sin pasar por el notebook.

    $env:ABACUS_API_KEY = '<tu api key>'          # en tu terminal; la clave no debe pasar por el chat ni quedar en un archivo
    python dev/abacus/crear_tool_diagnostico.py            muestra qué haría, sin tocar Abacus
    python dev/abacus/crear_tool_diagnostico.py --crear    lo crea
    python dev/abacus/crear_tool_diagnostico.py --actualizar    sube el código nuevo a un tool que ya existe (no cambia sus parámetros)

Mismo método que `crear_tool.py` (USERCODE_TOOL por el SDK). Se niega a crear si ya existe un tool con ese nombre. Se borra de Abacus
(Custom Code → Tools) al terminar la prueba.
"""
import os
import sys
from pathlib import Path

NOMBRE_TOOL = "hub_diagnostico_contexto"
FUNCION = "diagnostico_contexto"
TIMEOUT_SEGUNDOS = 30
DESCRIPCION = ("Herramienta de diagnóstico: busca un valor (needle) en el contexto desde el que corre y devuelve dónde lo encontró. "
               "Úsala solo cuando se te pida explícitamente.")


def main() -> int:
    actualizar = "--actualizar" in sys.argv
    crear = "--crear" in sys.argv or actualizar
    fuente = (Path(__file__).parent / "diagnostico_contexto.py").read_text(encoding="utf-8")
    print(f"Tool: {NOMBRE_TOOL} (función {FUNCION}, tipo USERCODE_TOOL, timeout {TIMEOUT_SEGUNDOS} s). Argumento: needle:STRING")
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
    if actualizar:
        actualizado = client.update_python_function(name=NOMBRE_TOOL, source_code=fuente, function_name=FUNCION, description=DESCRIPCION, timeout=TIMEOUT_SEGUNDOS)
        print("Actualizado:", actualizado)
        print("Si el chatbot no usa el código nuevo, puede que guarde una copia: vuelve a seleccionar el tool en su configuración.")
        return 0
    try:
        client.describe_python_function(NOMBRE_TOOL)
        print(f"Ya existe un tool llamado {NOMBRE_TOOL}: no se sobrescribe. Bórralo en Abacus o cambia NOMBRE_TOOL.")
        return 1
    except Exception:
        pass  # no existe (o no se pudo consultar): se intenta crear
    creado = client.create_python_function(
        name=NOMBRE_TOOL, source_code=fuente, function_name=FUNCION, function_type="USERCODE_TOOL", description=DESCRIPCION, timeout=TIMEOUT_SEGUNDOS,
        function_variable_mappings=[PythonFunctionArgument(
            variable_type="STRING", name="needle", is_required=True,
            description="El valor a buscar en el contexto del tool (el externalSessionId que se mandó).")])
    print("Creado:", creado)
    print("Revísalo en Custom Code → Tools y selecciónalo en las opciones del chatbot de prueba.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
