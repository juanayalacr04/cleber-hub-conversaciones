"""Envío al cliente por el canal: la costura entre la función de reglas y el router de canal (§7.7).

`core/` no importa `channels/`: `main.py` inyecta aquí lo que el router sabe hacer. Cuando exista la
función 1 (1.36), estas dos funciones pasan a pedirle el envío por la cola o por HTTP, y nadie más cambia.

    send_text(bot, to_number, from_number, text, media_url=None)         → id del mensaje, o falsy si falló
    send_template(number, to_number, variables, lead_id=None, sf_config=None)
        Plantilla de handoff a Servicio de un número (`serviceHandoff*`), por el proveedor del número.
        Lanza `TemplateError` si no está configurada o si el proveedor no la aceptó.

Campañas:
    check_campaign(number, sf_config)                              → mensaje de error o None
    send_campaign(number, broadcast, recipient, phone, sf_config, track=True) → id del mensaje; lanza `TemplateError`
    delivery_statuses(number, ids, sf_config)                      → {id: {"state", "message"}} de los que ya llegaron
"""

NOT_CONFIGURED = "not_configured"
FAILED = "failed"


class TemplateError(Exception):
    """`kind` es NOT_CONFIGURED (falta algo en el número) o FAILED (el proveedor no aceptó el envío)."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind, self.message = kind, message


_senders: dict = {}


def configure(send_text=None, send_template=None, send_campaign=None, check_campaign=None, delivery_statuses=None) -> None:
    """Inyecta los envíos del router. Sin argumentos los quita (las pruebas)."""
    _senders.clear()
    named = {"text": send_text, "template": send_template, "campaign": send_campaign,
             "check_campaign": check_campaign, "delivery_statuses": delivery_statuses}
    _senders.update({kind: fn for kind, fn in named.items() if fn})


def is_configured(kind: str = "text") -> bool:
    return kind in _senders


def send_text(bot: dict, to_number: str, from_number: str, text: str, media_url: str | None = None):
    return _senders["text"](bot, to_number, from_number, text, media_url=media_url)


def send_template(number: dict, to_number: str, variables: dict, lead_id: str | None = None, sf_config: dict | None = None):
    return _senders["template"](number, to_number, variables, lead_id=lead_id, sf_config=sf_config)


def check_campaign(number: dict, sf_config: dict | None = None) -> str | None:
    return _senders["check_campaign"](number, sf_config)


def send_campaign(number: dict, broadcast: dict, recipient: dict, phone: str, sf_config: dict | None = None, track: bool = True):
    return _senders["campaign"](number, broadcast, recipient, phone, sf_config=sf_config, track=track)


def delivery_statuses(number: dict, ids: list, sf_config: dict | None = None) -> dict:
    return _senders["delivery_statuses"](number, ids, sf_config)
