"""Tool TEMPORAL de diagnóstico para Abacus (tarea 1.47): ¿le llega al tool el id de sesión (`externalSessionId`)?

Se pega como tool de código en Abacus (parámetro `needle`, texto) y se adjunta al ChatLLM de prueba. Se usa con `probar_sesion.py`, que
llama al deployment por la API con un `externalSessionId` conocido (`diag-sesion-<números>`).

El tool busca ese patrón en todo lo que alcanza a ver (entorno, variables de quien lo llamó). NO lo busca con el `needle` del modelo: lo que
el modelo manda como argumento queda en el código que Abacus ejecuta (`__kwargs`, el texto de la celda), y eso daría falsos positivos.
El `needle` solo existe porque el tool exige un parámetro; el mensaje del script no le dice al modelo el id, así que si el patrón
aparece es porque Abacus lo puso ahí.

No escribe nada, no llama a ningún servicio y no devuelve valores sensibles: de cada variable de entorno solo da el nombre, y las que
parecen secretos van enmascaradas. Se borra al terminar la prueba: no es parte del producto.
"""
import inspect
import os
import re
import sys

SECRETOS = ("KEY", "SECRET", "TOKEN", "PASSWORD", "PASSWD", "CREDENTIAL")
PATRON = re.compile(r"diag-sesion-\d+")
PISTAS = re.compile(r"session|sesion|conv|thread|chat", re.I)  # nombres que pueden guardar el id con otra forma


def diagnostico_contexto(needle: str = None) -> dict:
    """Busca el patrón del id de sesión en el contexto del tool y lista qué ve.

    Args:
        needle: se ignora para la búsqueda (ver el docstring del módulo); solo existe porque el tool exige un parámetro.

    Returns:
        `{"encontrado_en": [...], "nombres_con_pista": [...], "variables_de_entorno": [...], "marcos": [...]}`.
    """
    found: list[str] = []
    clues: list[str] = []

    def check(where: str, value) -> None:
        try:
            if PATRON.search(str(value)):
                found.append(where)
        except Exception:  # un objeto que no se puede convertir a texto no es lo que se busca
            pass

    def clue(where: str, name: str) -> None:
        if PISTAS.search(name):
            clues.append(where)

    env_names = []
    for name, value in os.environ.items():
        env_names.append(name + (" (enmascarada)" if any(s in name.upper() for s in SECRETOS) else ""))
        check(f"entorno:{name}", value)
        clue(f"entorno:{name}", name)

    check("argv", sys.argv)

    frames = []
    for info in inspect.stack()[1:]:
        names = []
        for var, value in info.frame.f_locals.items():
            names.append(var)
            check(f"{info.function}:{var}", value)
            clue(f"{info.function}:{var}", var)
        for var, value in info.frame.f_globals.items():
            if not var.startswith("__"):
                check(f"{info.function}:global:{var}", value)
                clue(f"{info.function}:global:{var}", var)
        frames.append({"funcion": info.function, "archivo": os.path.basename(info.filename), "variables": names[:30]})

    return {"encontrado_en": found, "nombres_con_pista": sorted(set(clues)), "variables_de_entorno": sorted(env_names), "marcos": frames[:15]}
