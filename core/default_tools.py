"""Handlers por defecto del núcleo: lo que un tool hace igual en todos los módulos.

Se registran sin vertical (nivel 2 de la resolución de §4.3). Un módulo que necesite otra cosa
registra el suyo para `(evento, vertical)` y gana. `register_defaults()` es idempotente.
"""
from google.cloud import firestore

from ai.parsing import extract_bot_response
from core import outcomes, routing, scheduled_contact
from core.numbers import apply_active_bot_override
from contracts.actions import DATOS_INVALIDOS, ActionResponse
from core.tools import ActionSpec, Field, declare, resolve, tool


def _guardar_nombre(conv_data: dict, params: dict) -> ActionResponse:
    """El nombre que captura el tool es la fuente autoritativa: pisa el derivado del perfil de WhatsApp.

    Va antes de `situacion` (orden de DEFAULT_TOOLS): si el bot guarda el nombre y detecta una
    situación en el mismo turno, el handler de la situación ya debe ver el nombre actualizado.
    """
    turn = params["turn"]
    name = ((params.get("input") or {}).get("nombre") or "").strip()
    if not name:
        return ActionResponse.failure(DATOS_INVALIDOS, "Falta el nombre del cliente")
    if conv_data.get("customerName") != name:
        conv_data["customerName"] = name
        turn.fire(turn.db.collection("conversations").document(turn.conv_id).update, {"customerName": name})
    return ActionResponse.success({"nombre": name})


def _registrar_cita(conv_data: dict, params: dict) -> None:
    """El bot indicó que se agendó una cita: se marca la conversación y su outcome."""
    turn = params["turn"]
    turn.fire(turn.db.collection("conversations").document(turn.conv_id).update,
              {"appointmentStatus": "cita_bot", "appointmentDate": firestore.SERVER_TIMESTAMP})
    turn.fire(outcomes.set_conversation_outcome, turn.conv_id, "cita_bot", db=turn.db)


def _situacion(conv_data: dict, params: dict) -> None:
    """El bot detectó una situación fuera de su alcance: se resuelve según la ruta configurada."""
    turn = params["turn"]
    tool_input = params.get("input") or {}
    result = routing.process_situacion_handoff(
        turn.bot, conv_data, turn.conv_id, tool_input.get("situacion", ""), tool_input.get("motivo", ""), tool_input, db=turn.db)
    if result == "switched":
        # El bot destino contesta este mismo mensaje y se descarta la respuesta del bot original.
        turn.bot = apply_active_bot_override(turn.bot, conv_data, turn.db)
        turn.api_result = routing.run_switched_bot(turn.bot, turn.conv_id, conv_data, turn.messages, turn.customer)
        turn.response = extract_bot_response(turn.api_result)
    elif result:
        turn.say(turn.response)
        turn.handled = True


# Contrato de cada acción del núcleo (1.43). `situacion` no se expone: cambia de bot y reemplaza la
# respuesta del turno, así que entra con el handoff en 1.46.
SPECS = (
    ActionSpec("guardar_nombre", exposed=True, description="Guarda el nombre que dio el cliente",
               fields=(Field("nombre", required=True),)),
    ActionSpec("registrar_cita", exposed=True, description="Marca que el bot agendó una cita"),
    ActionSpec("agendar_recordatorio", exposed=True, description="Programa un recontacto con el cliente",
               fields=(Field("fecha_hora", required=True, description="fecha y hora ISO, en la zona de la organización"),)),
    ActionSpec("cancelar_recordatorio", exposed=True, description="Cancela el recontacto programado"),
    ActionSpec("situacion", description="Situación fuera del alcance del bot",
               fields=(Field("situacion"), Field("motivo"))),
)

DEFAULTS = {"situacion": _situacion, "guardar_nombre": _guardar_nombre, "registrar_cita": _registrar_cita, **scheduled_contact.DEFAULT_HANDLERS}


def register_defaults() -> None:
    for spec in SPECS:
        declare(spec)
    for event, handler in DEFAULTS.items():
        if resolve(event, None) is None:
            tool(event)(handler)
