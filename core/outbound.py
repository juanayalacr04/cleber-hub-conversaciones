"""Envío al cliente por el canal: la costura entre la función de reglas y el router de canal (§7.7).

`core/` no importa `channels/`: `main.py` inyecta aquí lo que el router sabe hacer. Cuando exista la
función 1 (1.36), estas dos funciones pasan a pedirle el envío por la cola o por HTTP, y nadie más cambia.

    send_text(bot, to_number, from_number, text, media_url=None)         → id del mensaje, o falsy si falló
    send_template(number, to_number, variables, lead_id=None, sf_config=None)
        Plantilla de handoff a Servicio de un número (`serviceHandoff*`), por el proveedor del número.
        Lanza `TemplateError` si no está configurada o si el proveedor no la aceptó.
"""

NOT_CONFIGURED = "not_configured"
FAILED = "failed"


class TemplateError(Exception):
    """`kind` es NOT_CONFIGURED (falta algo en el número) o FAILED (el proveedor no aceptó el envío)."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind, self.message = kind, message


_senders: dict = {}


def configure(send_text=None, send_template=None) -> None:
    """Inyecta los envíos del router. Sin argumentos los quita (las pruebas)."""
    _senders.clear()
    if send_text:
        _senders["text"] = send_text
    if send_template:
        _senders["template"] = send_template


def is_configured(kind: str = "text") -> bool:
    return kind in _senders


def send_text(bot: dict, to_number: str, from_number: str, text: str, media_url: str | None = None):
    return _senders["text"](bot, to_number, from_number, text, media_url=media_url)


def send_template(number: dict, to_number: str, variables: dict, lead_id: str | None = None, sf_config: dict | None = None):
    return _senders["template"](number, to_number, variables, lead_id=lead_id, sf_config=sf_config)
