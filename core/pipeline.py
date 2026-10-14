"""Pipeline único de mensajes entrantes.

Reemplaza los tres flujos casi duplicados de las plataformas (`_process_twilio_message`,
`_process_valuetext_message` y `_process_meta_message`): el proveedor solo aporta cómo llega el
mensaje y cómo se contesta (`Incoming` y la función `send`). Todo lo demás es un solo flujo.

El núcleo detecta y despacha; no decide. Lo propio de cada módulo (crear un Lead, agendar una
cita de taller...) entra como handlers del registro (`core.tools`), con estos eventos:

  customer_replied      el cliente escribió (p. ej. limpiar un recontacto programado)
  opt_out               el cliente pidió no ser contactado
  first_customer_reply  primer mensaje del cliente en la conversación
  handoff_gate          antes de escalar a un asesor; el handler puede frenarlo (turn.stop = True)
  handoff_applied       el handoff se aplicó
  handoff_blocked_out_of_hours
  <evento de tool>      uno por tool del bot (ver DEFAULT_TOOLS)

Cada handler recibe `(conv_data, params)` con `params = {"turn": Turn, "bot": ..., "conv_id": ...,
"input": ...}`. `turn.response` puede reemplazarse, `turn.handled = True` indica que el handler ya
contestó, y `turn.flags` comparte estado entre handlers del mismo turno.

Diferencias entre plataformas que se resolvieron como CONFIGURACIÓN del bot, no como código:
  optOutAction                    "close" (por defecto) o "handoff"
  handoffConfig.handoffMessage    texto al escalar
  handoffConfig.waitingMessage    texto mientras espera asesor
  scheduleConfig.viaBot           True: el bot redacta el aviso de fuera de horario
  injectPhoneContext              antepone el teléfono a la primera respuesta (por defecto, solo Twilio)
  tools                           [{"name", "event", "phase": "early"|"main"}]; sin esto, DEFAULT_TOOLS
  outcomeActions / outcomeTool    vocabulario de clasificación del motivo
  broadcastResponseCounters       {acción: contador} de respuesta a campañas
"""
import logging
from concurrent.futures import as_completed
from dataclasses import dataclass

from ai import engine
from ai.parsing import detect, detect_action, detect_handoff, detect_mention, extract_bot_response, extract_image_from_text
from core import broadcasts, conversations as cv, handoff as ho, outcomes
from core.db import get_db, get_executor
from core.default_tools import register_defaults
from core.numbers import apply_active_bot_override
from core.tools import dispatch
from core.utils import normalize_mx_phone

log = logging.getLogger(__name__)

RESET_COMMANDS = ("/reset", "/nuevo", "/reiniciar")
RESET_MESSAGE = "Conversación reiniciada. Envía un mensaje para comenzar de nuevo."
DEFAULT_HANDOFF_MESSAGE = "Entendido, te comunico con un asesor. En un momento te atenderán."
DEFAULT_WAITING_MESSAGE = "Tu mensaje fue recibido. Un asesor te atenderá pronto."
OUT_OF_HOURS_INSTRUCTION = '__ADMIN_FOLLOW_INSTRUCTIONS_MESSAGE_OUTPUT__ , "{text}"'
DEFAULT_AI_OUTCOME_ACTIONS = ("interes_cita", "otro_motivo")
DEFAULT_AI_OUTCOME_TOOL = "Clasificar_Motivo"

# Tools conocidos por los bots actuales. Un bot con `tools[]` propio ignora esta lista; agregar
# un tool nuevo es agregar una entrada a la configuración del bot, no una función.
DEFAULT_TOOLS = [
    {"name": "Crear_Lead", "event": "crear_lead", "phase": "early"},
    {"name": "Guardar_Nombre_Cliente", "event": "guardar_nombre", "phase": "main"},
    {"name": "Detectar_Situacion", "event": "situacion", "phase": "main"},
    {"name": "Registrar_Cita", "event": "registrar_cita", "phase": "main"},
    {"name": "cita_agendada", "event": "registrar_cita", "phase": "main"},
    {"name": "Actualizar_Lead", "event": "actualizar_lead", "phase": "main"},
    {"name": "Crear_Cita_Ventas_Salesforce", "event": "crear_cita", "phase": "main"},
    {"name": "Agendar_Recordatorio", "event": "agendar_recordatorio", "phase": "main"},
    # Sin parámetros: Abacus lo reporta en lugares distintos, así que se detecta por mención
    {"name": "Cancelar_Recordatorio", "event": "cancelar_recordatorio", "phase": "main", "match": "mention"},
]


@dataclass
class Incoming:
    """Un mensaje del cliente, ya normalizado por el adaptador del proveedor."""
    provider: str
    from_number: str            # teléfono del cliente tal como llegó
    to_number: str = ""         # número del bot ("" en Meta, que contesta por phone_number_id)
    body: str = ""
    contact_name: str = ""
    supports_media: bool = False
    from_agent_system: bool = False  # el mensaje viene de un sistema donde un humano ya atiende (p. ej. Salesforce)


class Turn:
    """Estado de un turno: lo que los handlers de módulo pueden leer y modificar."""

    def __init__(self, incoming: Incoming, bot: dict, send, db):
        self.incoming, self.bot, self.send, self.db = incoming, bot, send, db
        self.customer = normalize_mx_phone(incoming.from_number)
        self.conv_id, self.conv_data, self.messages = "", {}, []
        self.api_result: dict = {}
        self.response = ""
        self.handled = False
        self.stop = False
        self.flags: dict = {}
        self._futures: list = []

    @property
    def org_id(self):
        return self.bot.get("organizationId")

    def fire(self, fn, *args, **kwargs):
        future = get_executor().submit(fn, *args, **kwargs)
        self._futures.append(future)
        return future

    def wait(self, futures=None) -> None:
        for f in as_completed(futures if futures is not None else list(self._futures)):
            try:
                f.result()
            except Exception:
                log.exception("error en una operación paralela del turno")

    def send_plain(self, bot, to, from_, text):
        return self.send(bot, to, from_, text)

    def say(self, text: str, media_url: str | None = None) -> None:
        """Guarda el mensaje del bot y lo envía, en paralelo."""
        saves = self.fire(cv.add_message, self.conv_id, "bot", text, media_url=media_url, db=self.db)
        sends = self.fire(self.send, self.bot, self.customer, self.incoming.to_number, text, media_url=media_url)
        self.wait([saves, sends])

    def emit(self, event: str, **params) -> None:
        dispatch(event, self.conv_data, {"turn": self, "bot": self.bot, "conv_id": self.conv_id, **params})


def process_message(incoming: Incoming, bot: dict | None, send, db=None) -> None:
    """Procesa un mensaje entrante de punta a punta. Nunca lanza: corre en un hilo de fondo.

    `send(bot, to_number, from_number, text, media_url=None)` lo inyecta el canal.
    """
    if not bot:
        log.info("sin bot activo para el mensaje de %s (%s)", incoming.from_number, incoming.provider)
        return
    register_defaults()
    turn = Turn(incoming, bot, send, db or get_db())
    try:
        _run(turn)
    except Exception:
        log.exception("error procesando el mensaje (%s)", incoming.provider)
    finally:
        turn.wait()


def _handoff_config(t: Turn) -> dict:
    return t.bot.get("handoffConfig", {}) or {}


def _opt_out_action(t: Turn) -> str:
    """Qué hacer ante un "stop": el bot manda; si no define nada, el equipo; si no, cerrar."""
    action = t.bot.get("optOutAction")
    team_id = t.conv_data.get("teamId")
    if not action and team_id:
        team = t.db.collection("teams").document(team_id).get()
        action = team.to_dict().get("optOutAction") if team.exists else None
    return action if action in ("close", "handoff") else "close"


def _tools(bot: dict, phase: str) -> list[dict]:
    return [s for s in (bot.get("tools") or DEFAULT_TOOLS) if s.get("phase", "main") == phase]


def _run(t: Turn) -> None:
    inc, bot, db = t.incoming, t.bot, t.db

    # 1. Conversación (abierta, reabierta o nueva) y bot activo
    t.conv_id, t.conv_data, t.messages = cv.get_or_create_conversation(
        bot.get("id"), t.org_id, t.customer, bot.get("teamId"), bot.get("whatsappNumberId"),
        bot_config=bot, customer_name=inc.contact_name, db=db,
    )
    t.bot = bot = apply_active_bot_override(bot, t.conv_data, db)
    status = t.conv_data.get("status", "bot")

    # 2. Un humano ya atiende desde otro sistema: se guarda el mensaje y el bot no interviene.
    #    Solo cuenta si hay agente activo en Firestore: el campo de origen del mensaje nunca se limpia.
    if inc.from_agent_system and status == "with_agent":
        t.fire(cv.add_message, t.conv_id, "customer", inc.body, db=db)
        return

    # 3. Guardar el mensaje del cliente y reiniciar la inactividad
    is_new = len(t.messages) == 0
    bot_text = inc.body
    if is_new and bot.get("injectPhoneContext", inc.provider == "twilio"):
        # El bot no conoce el teléfono por sí mismo; se antepone al texto en la MISMA llamada
        # (sin round-trip extra) y se guarda aparte en la plataforma.
        context = f'<<CONTEXTO>> Teléfono del cliente: "{t.customer.replace("whatsapp:", "")}"'
        t.fire(cv.add_message, t.conv_id, "system", context, db=db)
        bot_text = f"{context}\n\n{inc.body}"
    t.fire(cv.add_message, t.conv_id, "customer", inc.body, db=db)
    t.fire(cv.reset_inactivity, t.conv_id, t.conv_data.get("inactivityRemindersSent", 0), db=db)
    t.messages.append({"is_user": True, "text": bot_text})
    t.emit("customer_replied")

    # 4. Comando de reinicio (pruebas). manualClose evita que la reapertura reutilice la conversación.
    if inc.body.strip().lower() in RESET_COMMANDS:
        cv.update_conversation_status(t.conv_id, "closed", db=db)
        db.collection("conversations").document(t.conv_id).update({"manualClose": True})
        t.say(RESET_MESSAGE)
        return

    # 5. Opt-out universal: cierra la conversación (o la escala, según la config del bot).
    if cv.is_stop_message(inc.body):
        action = _opt_out_action(t)
        if action == "handoff":
            ho.apply_handoff_status(t.conv_id, t.conv_data.get("teamId"), t.org_id, handoff_reason="opt_out", db=db)
        else:
            cv.update_conversation_status(t.conv_id, "closed", db=db)
        t.emit("opt_out", action=action)
        return

    if not t.conv_data.get("lastCustomerMessageAt"):
        t.emit("first_customer_reply")

    # 6. Handoff por palabra clave
    hc = _handoff_config(t)
    if hc.get("enabled") and ho.check_handoff_keywords(inc.body, hc.get("triggerKeywords", [])):
        if _handoff_blocked(t, "keyword"):
            return
        ho.apply_handoff_status(t.conv_id, t.conv_data.get("teamId"), t.org_id, handoff_reason="keyword", db=db)
        t.emit("handoff_applied", trigger="keyword", motivo="keyword")
        t.say(hc.get("handoffMessage") or DEFAULT_HANDOFF_MESSAGE)
        return

    # 7. Estado de la conversación
    if status == "with_agent":
        return
    if status == "waiting_agent":
        t.say(hc.get("waitingMessage") or DEFAULT_WAITING_MESSAGE)
        return

    # 8. Al bot. Antes se espera a que el mensaje del cliente y el reinicio de inactividad estén
    #    escritos: los handlers del turno (p. ej. resetear lastCustomerMessageAt) no deben competir con ellos.
    t.wait()
    messages = t.messages[-(engine.MAX_HISTORY_MESSAGES * 2):]
    campaign = t.conv_data.get("broadcastContext")
    if not campaign and t.conv_data.get("broadcastId"):
        campaign = broadcasts.get_broadcast_instructions(t.conv_data["broadcastId"], db=db)
    if campaign:
        messages.insert(0, {"is_user": False, "text": f"[Contexto de campaña] {campaign}"})
    messages = ho.apply_out_of_hours_context(messages, t.conv_data, bot.get("scheduleConfig"))
    t.messages = messages

    t.api_result = engine.send_to_bot(bot, messages, conv_id=t.conv_id, customer_phone=t.customer)
    bot_type = bot.get("type", "chatllm")

    # 9. Clasificación del motivo: antes del handoff, para que quede etiquetada aunque escale
    motivo = detect_action(t.api_result, bot_type, bot.get("outcomeActions") or DEFAULT_AI_OUTCOME_ACTIONS,
                           tool_name=bot.get("outcomeTool", DEFAULT_AI_OUTCOME_TOOL))
    if motivo:
        t.fire(outcomes.set_conversation_outcome, t.conv_id, motivo, motivo, db=db)

    # 10. Tools tempranos: deben resolverse antes del handoff (p. ej. crear el Lead que el handoff exige)
    done: set[str] = set()
    _run_tools(t, "early", done)

    # 11. Handoff pedido por el bot
    handoff = detect_handoff(t.api_result, bot_type)
    if handoff["triggered"]:
        if _handoff_blocked(t, "tool call"):
            return
        t.say(extract_bot_response(t.api_result))
        ho.apply_handoff_status(t.conv_id, t.conv_data.get("teamId"), t.org_id, handoff_reason=handoff["motivo"], db=db)
        db.collection("conversations").document(t.conv_id).update({"handoffReason": handoff["motivo"]})
        t.emit("handoff_applied", trigger="tool call", motivo=handoff["motivo"])
        return

    # 12. Respuesta y tools del turno
    t.response = extract_bot_response(t.api_result)
    _run_tools(t, "main", done)

    counters = bot.get("broadcastResponseCounters") or broadcasts.DEFAULT_RESPONSE_COUNTERS
    campaign_action = detect_action(t.api_result, bot_type, counters.keys())
    if campaign_action:
        t.fire(broadcasts.record_broadcast_response, t.conv_data, campaign_action, counters, db=db)

    if t.handled:
        return

    # 13. Responder (la imagen marcada con [IMG] solo viaja en proveedores que la soportan)
    image_url, text = extract_image_from_text(t.response)
    if image_url and not inc.supports_media:
        text = f"{text}\n{image_url}".strip()
        image_url = None
    t.say(text, media_url=image_url)


def _run_tools(t: Turn, phase: str, done: set) -> None:
    bot_type = t.bot.get("type", "chatllm")
    for spec in _tools(t.bot, phase):
        event = spec["event"]
        if event in done:
            continue
        if spec.get("match") == "mention":
            hit = detect_mention(t.api_result, spec["name"])
        else:
            hit = detect(t.api_result, bot_type, spec["name"])
        if hit["triggered"]:
            done.add(event)
            t.emit(event, input=hit["input"], tool=spec["name"])
            if t.handled:
                break


def _handoff_blocked(t: Turn, trigger: str) -> bool:
    """True si el handoff NO debe continuar: un módulo lo frenó o estamos fuera de horario."""
    t.stop = False
    t.emit("handoff_gate", trigger=trigger)
    if t.stop:
        return True
    schedule = t.bot.get("scheduleConfig", {}) or {}
    if ho.check_business_hours(schedule):
        return False

    text = None
    if schedule.get("viaBot"):
        # El bot redacta el aviso con su propio tono
        instruction = OUT_OF_HOURS_INSTRUCTION.format(text=ho.build_out_of_hours_message(schedule))
        text = extract_bot_response(engine.send_to_bot(t.bot, [{"is_user": True, "text": instruction}]))
    ho.block_handoff_out_of_hours(
        t.conv_id, t.conv_data, t.bot, t.customer, t.incoming.to_number, schedule, trigger,
        send=t.send_plain, db=t.db, text=text,
    )
    return True
