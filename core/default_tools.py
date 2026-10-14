"""Handlers por defecto del núcleo: lo que un tool hace igual en todos los módulos.

Se registran sin vertical (nivel 2 de la resolución de §4.3). Un módulo que necesite otra cosa
registra el suyo para `(evento, vertical)` y gana. `register_defaults()` es idempotente.
"""
from google.cloud import firestore

from core import outcomes
from core.tools import resolve, tool


def _guardar_nombre(conv_data: dict, params: dict) -> None:
    """El nombre que captura el tool es la fuente autoritativa: pisa el derivado del perfil de WhatsApp.

    Va antes de `situacion` (orden de DEFAULT_TOOLS): si el bot guarda el nombre y detecta una
    situación en el mismo turno, el handler de la situación ya debe ver el nombre actualizado.
    """
    turn = params["turn"]
    name = ((params.get("input") or {}).get("nombre") or "").strip()
    if name and conv_data.get("customerName") != name:
        conv_data["customerName"] = name
        turn.fire(turn.db.collection("conversations").document(turn.conv_id).update, {"customerName": name})


def _registrar_cita(conv_data: dict, params: dict) -> None:
    """El bot indicó que se agendó una cita: se marca la conversación y su outcome."""
    turn = params["turn"]
    turn.fire(turn.db.collection("conversations").document(turn.conv_id).update,
              {"appointmentStatus": "cita_bot", "appointmentDate": firestore.SERVER_TIMESTAMP})
    turn.fire(outcomes.set_conversation_outcome, turn.conv_id, "cita_bot", db=turn.db)


DEFAULTS = {"guardar_nombre": _guardar_nombre, "registrar_cita": _registrar_cita}


def register_defaults() -> None:
    for event, handler in DEFAULTS.items():
        if resolve(event, None) is None:
            tool(event)(handler)
