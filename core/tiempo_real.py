"""Avisos de tiempo real al dashboard (DISENO_BACKEND_AWS.md §6).

Después de que una acción `Hub.*` confirma un cambio, el backend avisa a las pantallas suscritas. El aviso dice "esto cambió",
no trae los datos: la pantalla los pide a PostgreSQL (Hub.consultaConversaciones, Hub.consultaMensajes con desde).

    tiempo_real.conversacion(conv)      # conv = objeto Conversacion de hub_cleber

Canales (AppSync Events, namespace `hub`):
    /hub/<idMarca>/<modulo>                      bandeja del módulo en la marca
    /hub/<idMarca>/<modulo>/<idConversacion>     chat abierto

El publicador se inyecta con `configure` (la Lambda pone el de AppSync; las pruebas, uno falso). Sin publicador el aviso se
descarta: un aviso perdido lo corrige el siguiente cambio de la conversación (lleva `version`) o la reconexión de la pantalla.
Publicar nunca hace fallar la operación que lo originó.
"""
import logging

log = logging.getLogger(__name__)

_publicador = None


def configure(publicador) -> None:
    """`publicador(canal: str, eventos: list[dict])`; None lo quita."""
    global _publicador
    _publicador = publicador


def aviso_de(conv: dict) -> dict:
    """Lo que viaja en el aviso: suficiente para decidir si la pantalla vuelve a consultar y para ordenar la bandeja."""
    return {
        "tipo": "conversacion",
        "idConversacion": conv.get("idConversacion"),
        "version": conv.get("version"),
        "estado": conv.get("estado"),
        "idEquipo": conv.get("idEquipo"),
        "idAgente": conv.get("idAgente"),
        "ultimoMensajeEn": conv.get("ultimoMensajeEn"),
        "ultimoRemitente": conv.get("ultimoRemitente"),
    }


def canales_de(conv: dict) -> list[str]:
    base = f"/hub/{conv.get('idMarca')}/{conv.get('modulo')}"
    return [base, f"{base}/{conv.get('idConversacion')}"]


def conversacion(conv: dict | None) -> None:
    """Avisa que la conversación cambió. Nunca lanza."""
    if not conv or _publicador is None:
        return
    aviso = aviso_de(conv)
    for canal in canales_de(conv):
        try:
            _publicador(canal, [aviso])
        except Exception:
            log.exception("tiempo_real: no se pudo publicar en %s", canal)
