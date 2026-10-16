"""Registro de handlers por vertical (§4.2). El núcleo detecta y despacha; no decide.

Orden de resolución (§4.3):
  1. handler de (tool, vertical)
  2. handler por defecto del tool
  3. no-op + log

Además de los handlers, cada acción puede declarar su contrato (`ActionSpec`, tarea 1.43): los
datos que acepta, y si un bot puede pedirla desde fuera. Un solo catálogo, dos puertas:
  - `dispatch`: la puerta del pipeline. Lo que detectó el núcleo; el resultado se ignora.
  - `execute`:  la puerta del endpoint de acciones (1.44). Valida, ejecuta y devuelve un
                `ActionResponse`; una acción no expuesta a bots no se puede invocar desde fuera.

Un handler puede devolver `None` (listo), un `dict` (listo, con ese resultado) o un
`ActionResponse` (para reportar un fallo o un estado distinto de "done").
"""
import logging
from dataclasses import dataclass
from typing import Any, Callable

from contracts.actions import (ACCION_DESCONOCIDA, ACCION_NO_PERMITIDA, DATOS_INVALIDOS, ERROR_INTERNO,
                               ActionResponse)

log = logging.getLogger(__name__)

Handler = Callable[[dict, dict], Any]
_handlers: dict[tuple[str, str | None], Handler] = {}
_specs: dict[str, "ActionSpec"] = {}


@dataclass(frozen=True)
class Field:
    """Un dato de `data` de una acción. Los campos no declarados se aceptan (solo se agregan opcionales)."""
    name: str
    kind: type = str
    required: bool = False
    description: str = ""


@dataclass(frozen=True)
class ActionSpec:
    name: str                       # el evento del registro (`crear_lead`), no el nombre del tool en Abacus
    fields: tuple[Field, ...] = ()
    exposed: bool = False           # True: un bot puede pedirla por el endpoint de acciones
    description: str = ""


def declare(spec: ActionSpec) -> ActionSpec:
    """Declara el contrato de una acción. Idempotente; dos contratos distintos para el mismo nombre fallan."""
    current = _specs.get(spec.name)
    if current is not None and current != spec:
        raise ValueError(f"contrato duplicado y distinto para la acción {spec.name!r}")
    _specs[spec.name] = spec
    return spec


def spec_for(name: str) -> ActionSpec | None:
    return _specs.get(name)


def exposed_actions() -> list[str]:
    """Acciones que un bot puede pedir desde fuera."""
    return sorted(n for n, s in _specs.items() if s.exposed)


def tool(name: str, vertical: str | None = None):
    """Registra un handler. `vertical=None` lo vuelve el handler por defecto del tool."""
    def register(fn: Handler) -> Handler:
        key = (name, vertical)
        if key in _handlers:
            raise ValueError(f"handler duplicado para {key}")
        _handlers[key] = fn
        return fn
    return register


def resolve(name: str, vertical: str | None) -> Handler | None:
    return _handlers.get((name, vertical)) or _handlers.get((name, None))


def dispatch(name: str, conversation: dict, params: dict) -> bool:
    """Despacha el tool al handler de la vertical de la conversación. True si hubo handler."""
    handler = resolve(name, conversation.get("vertical"))
    if handler is None:
        log.info("tool %r sin handler para vertical %r: no-op", name, conversation.get("vertical"))
        return False
    handler(conversation, params)
    return True


def validate(spec: ActionSpec | None, data: dict) -> str | None:
    """Mensaje de error si `data` no cumple el contrato; None si es válido."""
    if spec is None:
        return None
    for f in spec.fields:
        value = data.get(f.name)
        if value is None or (f.kind is str and isinstance(value, str) and not value.strip()):
            if f.required:
                return f"Falta el dato obligatorio {f.name!r}" + (f" ({f.description})" if f.description else "")
            continue
        if not isinstance(value, f.kind):
            return f"El dato {f.name!r} debe ser de tipo {f.kind.__name__}"
    return None


def _as_response(value: Any) -> ActionResponse:
    if isinstance(value, ActionResponse):
        return value
    if isinstance(value, dict):
        return ActionResponse.success(value)
    return ActionResponse.success()


def execute(name: str, conversation: dict, params: dict, *, from_bot: bool = False) -> ActionResponse:
    """Ejecuta una acción y devuelve su resultado tipado. Nunca lanza.

    `params["input"]` son los datos de la acción. Con `from_bot=True` solo corren las acciones
    expuestas a bots; el resto se rechaza como si no existieran para quien llama.
    """
    spec = spec_for(name)
    if from_bot and (spec is None or not spec.exposed):
        return ActionResponse.failure(ACCION_NO_PERMITIDA, f"La acción {name!r} no está disponible para bots")
    handler = resolve(name, conversation.get("vertical"))
    if handler is None:
        return ActionResponse.failure(ACCION_DESCONOCIDA, f"No hay una acción {name!r} para este módulo")
    problem = validate(spec, params.get("input") or {})
    if problem:
        return ActionResponse.failure(DATOS_INVALIDOS, problem)
    try:
        return _as_response(handler(conversation, params))
    except Exception:
        log.exception("error ejecutando la acción %r", name)
        return ActionResponse.failure(ERROR_INTERNO, "La acción falló por un error interno")


def clear() -> None:
    """Solo para pruebas."""
    _handlers.clear()
    _specs.clear()
