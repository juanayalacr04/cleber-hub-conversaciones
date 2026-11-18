"""Conversaciones en hub_cleber para el backend (modo sistema): el pipeline de entrada y los jobs.

    info = conversaciones.obtiene_o_abre(id_numero, telefono)   # { conversacion, origen, historial }
    conv = conversaciones.actualiza(id_conversacion, estado="waiting_agent", motivoHandoff="keyword")

Cada cambio avisa a las pantallas (core/tiempo_real.py). Las operaciones del asesor (tomar, cerrar, transferir) no van
aquí: tienen acciones propias con los permisos del usuario (core/acciones_usuario.py).
"""
from core import postgrest, tiempo_real

LIMITE_HISTORIAL = 40


def obtiene_o_abre(id_numero: str, telefono: str, *, nombre: str | None = None, limite: int = LIMITE_HISTORIAL) -> dict:
    """Hub.obtieneOAbreConversacion: la abierta, una cerrada reciente reabierta o una nueva, con su historial
    cronológico (incluye los mensajes de sistema, como el <<CONTEXTO>> del contrato ①)."""
    params = {"idNumero": id_numero, "telefonoCliente": telefono, "limiteHistorial": limite}
    if nombre:
        params["nombreCliente"] = nombre
    info = postgrest.llama("Hub.obtieneOAbreConversacion", params)
    if info.get("origen") != "abierta":
        tiempo_real.conversacion(info.get("conversacion"))
    return info


def actualiza(id_conversacion: str, **campos) -> dict:
    """Hub.actualizaConversacion con los campos de su contrato (estado, motivoHandoff, resultado, metadatos...).
    Regresa la conversación al día."""
    conv = postgrest.llama("Hub.actualizaConversacion", {"idConversacion": id_conversacion, **campos})["conversacion"]
    tiempo_real.conversacion(conv)
    return conv
