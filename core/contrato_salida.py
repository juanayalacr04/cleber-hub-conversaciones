"""Contrato ③: el hub avisa al sistema que abrió la conversación lo que pasa en ella (DISENO_BACKEND_AWS.md §5.2).

El núcleo no sabe qué hace cada sistema con los eventos: cada fuente registra su destino (`registra_destino`) y el módulo decide
cuándo emite (modules/valuacion.py). Aquí solo está el mecanismo:

    t.salida.append(Evento(...))                  # los handlers de módulo encolan durante el turno
    contrato_salida.envia(t.conv, t.salida)       # al terminar el turno, DESPUÉS de contestarle al cliente

Entrega: una acción del sistema destino por core/postgrest.py (modo sistema, con la identidad del hub), con los params
`{ idEvento, tipo, externalId, idConversacion, accion?, carga }`. El destino decide qué hace con el evento y responde con éxito
aunque lo ignore o lo rechace (reintentar no cambiaría nada); solo un error inesperado se reporta como fallo.

Un evento que no se pudo entregar NO hace fallar el turno (el mensaje del cliente ya se atendió y reintentar la cola no
reenviaría el evento: el mensaje se detecta como duplicado). Queda en el log (`turno.evento_error`) y en la bitácora de la
conversación (`evento_salida_fallido`, con el evento completo) para reenviarlo: `idEvento` es estable y el destino es idempotente.
"""
import logging
from dataclasses import dataclass, field

from core import postgrest

log = logging.getLogger(__name__)

# Tipos de evento (los de `tipo` del contrato)
RESPONDIO, HANDOFF, RESULTADO, CERRADA = "conversation.replied", "conversation.handoff", "conversation.outcome", "conversation.closed"


@dataclass
class Evento:
    """Un aviso al sistema origen. `id_evento` es estable: el mismo hecho siempre genera el mismo id (idempotencia del destino)."""
    id_evento: str
    tipo: str
    accion: str | None = None
    carga: dict = field(default_factory=dict)


@dataclass
class Destino:
    """A dónde se entrega a una fuente: la acción que recibe los eventos, p. ej. `Valuacion.registraResultadoConversacion`."""
    accion: str


_DESTINOS: dict[str, Destino] = {}
_entrega = None


def registra_destino(fuente: str, destino: Destino) -> None:
    _DESTINOS[fuente] = destino


def configure(entrega) -> None:
    """`entrega(accion: str, params: dict) -> dict` (lanza ErrorHub si el destino rechaza). Por omisión, postgrest.llama; las
    pruebas ponen una falsa."""
    global _entrega
    _entrega = entrega


def fuente_de(conv: dict | None) -> str | None:
    """La fuente con destino registrado que abrió esta conversación (None si no la abrió un sistema, o no hay destino)."""
    fuente = (conv or {}).get("fuente")
    return fuente if fuente in _DESTINOS and (conv or {}).get("idExterno") else None


def envia(conv: dict, eventos: list[Evento]) -> None:
    """Entrega los eventos de una conversación a su sistema origen. Nunca lanza."""
    fuente = fuente_de(conv)
    if not fuente or not eventos:
        return
    destino = _DESTINOS[fuente]
    for evento in eventos:
        params = {"idEvento": evento.id_evento, "tipo": evento.tipo, "externalId": str(conv["idExterno"]),
                  "idConversacion": conv["idConversacion"], "carga": evento.carga}
        if evento.accion:
            params["accion"] = evento.accion
        try:
            info = (_entrega or postgrest.llama)(destino.accion, params)
        except postgrest.ErrorHub as e:
            _falla(conv, fuente, evento, params, e.codigo, e.mensaje)
            continue
        except Exception as e:
            _falla(conv, fuente, evento, params, "TRANSPORTE", str(e))
            continue
        log.info("turno.evento_enviado conv=%s fuente=%r tipo=%r id=%r resultado=%r", conv.get("idConversacion"), fuente,
                 evento.tipo, evento.id_evento, (info or {}).get("resultado"))


def _falla(conv: dict, fuente: str, evento: Evento, params: dict, codigo, mensaje) -> None:
    log.error("turno.evento_error conv=%s fuente=%r tipo=%r id=%r codigo=%r mensaje=%r", conv.get("idConversacion"), fuente,
              evento.tipo, evento.id_evento, codigo, str(mensaje)[:300])
    try:
        postgrest.llama("Hub.registraBitacora", {"idConversacion": conv["idConversacion"], "accion": "evento_salida_fallido",
                                                 "origen": "sistema", "datos": {"fuente": fuente, "codigo": codigo,
                                                                                "mensaje": str(mensaje)[:300], "evento": params}})
    except Exception:
        log.exception("no se pudo registrar en la bitácora el evento %s", evento.id_evento)
