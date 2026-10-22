"""Handlers por defecto del núcleo: lo que un tool hace igual en todos los módulos.

Se registran sin vertical (nivel 2 de la resolución de §4.3). Un módulo que necesite otra cosa
registra el suyo para `(evento, vertical)` y gana. `register_defaults()` es idempotente.
"""
from google.cloud import firestore

from ai.parsing import extract_bot_response
from core import handoff as ho, outcomes, routing, scheduled_contact
from core.numbers import apply_active_bot_override
from contracts.actions import DATOS_INVALIDOS, PRECONDICION_FALLIDA, ActionResponse
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


def _clasificar_motivo(conv_data: dict, params: dict) -> ActionResponse:
    """El bot clasifica el motivo de la conversación. Va antes del handoff para que quede etiquetada aunque escale."""
    from ai.service import DEFAULT_AI_OUTCOME_ACTIONS
    turn = params["turn"]
    motivo = ((params.get("input") or {}).get("motivo") or "").strip()
    allowed = tuple(turn.bot.get("outcomeActions") or DEFAULT_AI_OUTCOME_ACTIONS)
    if motivo not in allowed:
        return ActionResponse.failure(DATOS_INVALIDOS, f"El motivo {motivo!r} no es válido; los motivos posibles son: {', '.join(allowed)}")
    turn.fire(outcomes.set_conversation_outcome, turn.conv_id, motivo, motivo, db=turn.db)
    return ActionResponse.success({"motivo": motivo})


def _transferir_a_asesor(conv_data: dict, params: dict) -> ActionResponse:
    """El bot pide pasar la conversación a un asesor. El hub decide: el gate del módulo, el horario y el estado salen del resultado.

    escalado           la conversación ya quedó con (o esperando) un asesor
    ya_escalado        ya lo estaba; no se repite
    fuera_de_horario   no se escaló: sigue con el bot, marcada para el cron; `mensaje` es el aviso al cliente
    precondicion_fallida (error)   un módulo exige algo antes (p. ej. Ventas: crear el Lead); el mensaje dice qué
    El aviso al cliente no se manda aquí: lo manda el pipeline, que es quien tiene el canal.
    """
    turn, bot = params["turn"], params["bot"]
    if conv_data.get("status") in ("waiting_agent", "with_agent"):
        return ActionResponse.success({"estado": "ya_escalado"})
    motivo = ((params.get("input") or {}).get("motivo") or "").strip() or "solicitado por el agente"

    turn.stop, turn.stop_reason = False, ""
    turn.emit("handoff_gate", trigger="tool call")
    if turn.stop:
        return ActionResponse.failure(PRECONDICION_FALLIDA, turn.stop_reason or "Un requisito del módulo impide transferir ahora")

    schedule = bot.get("scheduleConfig", {}) or {}
    if not ho.check_business_hours(schedule):
        ho.mark_handoff_blocked(turn.conv_id, conv_data, bot, "tool call", db=turn.db)
        return ActionResponse.success({"estado": "fuera_de_horario", "mensaje": ho.build_out_of_hours_message(schedule)})

    ho.apply_handoff_status(turn.conv_id, conv_data.get("teamId"), turn.org_id, handoff_reason=motivo, db=turn.db)
    turn.db.collection("conversations").document(turn.conv_id).update({"handoffReason": motivo})
    conv_data["handoffReason"] = motivo
    turn.emit("handoff_applied", trigger="tool call", motivo=motivo)
    return ActionResponse.success({"estado": "escalado"})


# Contrato de cada acción del núcleo (1.43). `situacion` no se expone: cambia de bot y reemplaza la
# respuesta del turno, así que sigue por el camino del pipeline (ver 1.46 en TAREAS_PENDIENTES).
SPECS = (
    ActionSpec("guardar_nombre", exposed=True, description="Guarda el nombre que dio el cliente",
               fields=(Field("nombre", required=True),)),
    ActionSpec("registrar_cita", exposed=True, description="Marca que el bot agendó una cita"),
    ActionSpec("agendar_recordatorio", exposed=True, description="Programa un recontacto con el cliente",
               fields=(Field("fecha_hora", required=True, description="fecha y hora ISO, en la zona de la organización"),)),
    ActionSpec("cancelar_recordatorio", exposed=True, description="Cancela el recontacto programado"),
    ActionSpec("clasificar_motivo", exposed=True, description="Clasifica el motivo de la conversación",
               fields=(Field("motivo", required=True, description="uno de los motivos del bot (`outcomeActions`)"),)),
    ActionSpec("transferir_a_asesor", exposed=True, description="Pasa la conversación a un asesor, si el horario y el módulo lo permiten",
               fields=(Field("motivo", description="por qué se transfiere"),)),
    ActionSpec("situacion", description="Situación fuera del alcance del bot",
               fields=(Field("situacion"), Field("motivo"))),
)

DEFAULTS = {"situacion": _situacion, "clasificar_motivo": _clasificar_motivo, "transferir_a_asesor": _transferir_a_asesor, "guardar_nombre": _guardar_nombre, "registrar_cita": _registrar_cita, **scheduled_contact.DEFAULT_HANDLERS}


def register_defaults() -> None:
    for spec in SPECS:
        declare(spec)
    for event, handler in DEFAULTS.items():
        if resolve(event, None) is None:
            tool(event)(handler)
