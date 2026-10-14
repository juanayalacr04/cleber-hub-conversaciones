"""Registro de handlers por vertical (§4.2). El núcleo detecta y despacha; no decide.

Orden de resolución (§4.3):
  1. handler de (tool, vertical)
  2. handler por defecto del tool
  3. no-op + log
"""
import logging
from typing import Callable

log = logging.getLogger(__name__)

Handler = Callable[[dict, dict], None]
_handlers: dict[tuple[str, str | None], Handler] = {}


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


def clear() -> None:
    """Solo para pruebas."""
    _handlers.clear()
