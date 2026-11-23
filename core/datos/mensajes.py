"""Mensajes en hub_cleber para el backend (modo sistema).

    info = mensajes.guarda(id_conversacion, "customer", "Hola", id_proveedor="SM123")
    if info["duplicado"]: ...      # el proveedor reintentó: ya estaba guardado

Hub.guardaMensaje es idempotente por id del proveedor: sustituye a processed_events de Firestore.
"""
from core import postgrest, tiempo_real

REMITENTES = ("customer", "bot", "agent", "system")


def guarda(id_conversacion: str, remitente: str, texto: str | None = None, *, media_url: str | None = None,
           id_proveedor: str | None = None, es_plantilla: bool = False, id_agente: str | None = None) -> dict:
    """Hub.guardaMensaje. Regresa { mensaje, conversacion, duplicado }. Avisa a las pantallas si hubo cambio visible."""
    if remitente not in REMITENTES:
        raise ValueError(f"remitente inválido: {remitente!r}")
    params = {"idConversacion": id_conversacion, "remitente": remitente}
    if texto:
        params["texto"] = texto
    if media_url:
        params["mediaUrl"] = media_url
    if id_proveedor:
        params["idMensajeProveedor"] = id_proveedor
    if es_plantilla:
        params["esPlantilla"] = True
    if id_agente:
        params["idAgente"] = id_agente
    info = postgrest.llama("Hub.guardaMensaje", params)
    if remitente != "system" and not info.get("duplicado"):
        tiempo_real.conversacion(info.get("conversacion"))
    return info
