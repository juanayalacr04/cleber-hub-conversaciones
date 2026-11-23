"""Consumidor de la cola SQS FIFO `hub-entrantes` (DISENO_BACKEND_AWS.md §4.3): lo que el router publicó, aplicado en orden.

La Lambda recibe un lote (de 1, configurado en el disparador) y reporta los fallos parciales: un registro que falla vuelve a
la cola y SQS lo reintenta; tras N intentos va a la DLQ. Mientras tanto SQS no entrega el siguiente del mismo grupo
(número + cliente), así que el orden de la conversación se respeta.

Un registro que no cumple el contrato se descarta con un error en el log: reintentarlo no lo arreglaría y bloquearía el
grupo hasta que llegara a la DLQ.

El disparador debe tener `ReportBatchItemFailures` activado; sin eso, el retorno se ignora y un fallo reintenta el lote.
"""
import json
import logging

from contracts.base import ContractError
from contracts.messages import ChannelEvent

log = logging.getLogger(__name__)


def consume(event: dict, aplica) -> dict:
    """`aplica(ChannelEvent)` procesa un evento y lanza ante un error transitorio. Regresa la respuesta de lote parcial."""
    fallidos = []
    for registro in (event or {}).get("Records", []):
        id_mensaje = registro.get("messageId", "")
        try:
            evento = ChannelEvent.from_dict(json.loads(registro.get("body") or "null"))
        except (ContractError, ValueError) as e:
            log.error("evento descartado (%s): %s", id_mensaje, e)
            continue
        try:
            aplica(evento)
        except Exception:
            log.exception("error aplicando el evento %s (%s): vuelve a la cola", evento.event_id or evento.kind, id_mensaje)
            fallidos.append({"itemIdentifier": id_mensaje})
    return {"batchItemFailures": fallidos}
