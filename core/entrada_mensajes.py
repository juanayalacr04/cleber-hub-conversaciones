"""Entrada de mensajes del cliente sobre hub_cleber (Fase 2, DISENO_BACKEND_AWS.md §2 y §5.2).

Lo corre la Lambda `hub-msj-entrantes` por cada mensaje que el router dejó en la cola SQS. Es el mismo flujo que
core/pipeline.py, pero con los datos en PostgreSQL (core/datos/) en lugar de Firestore:

    1. Número que recibió el mensaje → marca, módulo, equipo y bot (Hub.resuelveNumero, en caché).
    2. Conversación del número + cliente: abierta, reabierta o nueva (Hub.obtieneOAbreConversacion).
    3. Se guarda el mensaje del cliente. Hub.guardaMensaje es idempotente por el id del proveedor: si ya estaba, el
       evento es un reintento y no se hace nada más.
    4. /reset, opt-out, handoff por palabra clave, conversación con asesor o esperando asesor.
    5. Al bot. En el primer mensaje del cliente, el bot recibe antes lo que ya se le mandó (la plantilla y el <<CONTEXTO>>
       del contrato ①): sin eso contestaría sin saber qué oferta se envió.
    6. Clasificación del motivo, handoff pedido por el bot y tools del módulo (eventos del registro, core/tools.py).
    7. Respuesta al cliente por el proveedor del número, y se guarda con su id de proveedor.

Lo propio de cada módulo entra como handlers del registro, con los mismos eventos que core/pipeline.py (customer_replied,
opt_out, first_customer_reply, handoff_gate, handoff_applied, handoff_blocked_out_of_hours y los de tools). La
conversación que reciben tiene las llaves de Firestore que esos handlers ya conocen (`vertical`, `status`, `teamId`...),
más `hub` con el objeto Conversacion completo.

Pendiente (se agrega al mudar Ventas y Servicio, Fase 3 y 4): campañas, cambio de bot por situación, expediente del
cliente, acciones pedidas por el bot al endpoint (hub-acciones-bot) y asignación automática (round robin).
"""
import logging
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone

from ai import engine
from ai.parsing import (detect, detect_action, detect_handoff, detect_mention, expande_acciones_externas, extract_bot_response,
                        extract_image_from_text)
from ai.service import DEFAULT_AI_OUTCOME_ACTIONS, DEFAULT_AI_OUTCOME_TOOL
from contracts.messages import IncomingMessage
from core import contrato_salida, handoff as ho
from core.conversations import is_stop_message
from core.datos import bots, conversaciones, mensajes, numeros
from core.postgrest import ErrorHub
from core.tools import dispatch

log = logging.getLogger(__name__)

RESET_COMMANDS = ("/reset", "/nuevo", "/reiniciar")
RESET_MESSAGE = "Conversación reiniciada. Envía un mensaje para comenzar de nuevo."
DEFAULT_HANDOFF_MESSAGE = "Entendido, te comunico con un asesor. En un momento te atenderán."
DEFAULT_WAITING_MESSAGE = "Tu mensaje fue recibido. Un asesor te atenderá pronto."
OUT_OF_HOURS_INSTRUCTION = '__ADMIN_FOLLOW_INSTRUCTIONS_MESSAGE_OUTPUT__ , "{text}"'

# Tools que el pipeline detecta en la respuesta del bot si el bot no trae `tools` propios (mismos que core/pipeline.py)
DEFAULT_TOOLS = [
    {"name": "Guardar_Nombre_Cliente", "event": "guardar_nombre", "phase": "main"},
    {"name": "Detectar_Situacion", "event": "situacion", "phase": "main"},
    {"name": "Registrar_Cita", "event": "registrar_cita", "phase": "main"},
    {"name": "cita_agendada", "event": "registrar_cita", "phase": "main"},
    {"name": "Verificar_Telefono", "event": "verificar_telefono", "phase": "main"},
]


def _ahora() -> str:
    return datetime.now(timezone.utc).isoformat()


# --------------------------------------------------------------------------- registros
# Una linea por decision del turno, con el mismo formato (`turno.<evento> conv=<id> k=v ...`) para buscarla en CloudWatch:
#   fields @timestamp, @message | filter @message like /conv=<idConversacion>/ | sort @timestamp asc
# Los textos del cliente y del bot solo se registran con LOG_CONTENIDO=true (datos personales): sin eso van su longitud y sus tools.

def _contenido() -> bool:
    return (os.environ.get("LOG_CONTENIDO") or "").strip().lower() == "true"


def _texto(valor, limite: int = 160) -> str:
    texto = " ".join(str(valor or "").split())
    return (texto[:limite] + "...") if len(texto) > limite else texto


def _ev(t, nombre: str, /, **campos) -> None:
    partes = [f"conv={t.conv_id or '-'}"] + [f"{k}={v!r}" for k, v in campos.items() if v is not None]
    log.info("turno.%s %s", nombre, " ".join(partes))


def resumen_resultado(api_result: dict) -> dict:
    """Que trajo la respuesta del bot, para el registro: error, tools que pidio y segmentos de accion. No incluye el texto."""
    if not isinstance(api_result, dict):
        return {"forma": type(api_result).__name__}
    if "error" in api_result:
        return {"error": _texto(api_result["error"], 300)}
    resultado = api_result.get("result")
    if not api_result.get("success") or not isinstance(resultado, dict):
        return {"success": api_result.get("success"), "claves": sorted(api_result)[:10]}
    respuesta = resultado.get("response")
    segmentos = respuesta.get("segments", []) if isinstance(respuesta, dict) else []
    # Forma de la respuesta, sin texto: de qué partes viene (p. ej. dónde llega el razonamiento de un modelo que "piensa")
    forma = {"claves": sorted(resultado)[:15]}
    if isinstance(resultado.get("segments"), list):
        forma["segments"] = [{"tipo": s.get("type"), "id": s.get("id"), "titulo": _texto(s.get("title"), 60)}
                             for s in resultado["segments"][:15] if isinstance(s, dict)]
    if isinstance(resultado.get("messages"), list):
        forma["mensajes"] = [{"usuario": m.get("is_user"), "claves": sorted(m)[:10]} for m in resultado["messages"][-4:] if isinstance(m, dict)]
    return {
        "tools": [x.get("toolName") for x in (resultado.get("toolResults") or []) if isinstance(x, dict)],
        "acciones": [str(s.get("segment", "")).strip() for s in segmentos if isinstance(s, dict) and s.get("id") == "action"],
        "respuesta_chars": len(extract_bot_response(api_result) or ""),
        "forma": forma,
    }


def conv_para_handlers(conv: dict) -> dict:
    """Conversación de hub_cleber con las llaves de Firestore que usan los handlers de módulo y core/handoff.py."""
    meta = conv.get("metadatos") or {}
    return {
        "id": conv.get("idConversacion"),
        "organizationId": conv.get("idMarca"),
        "vertical": conv.get("modulo"),
        "teamId": conv.get("idEquipo"),
        "whatsappNumberId": conv.get("idNumero"),
        "status": conv.get("estado"),
        "customerPhone": conv.get("telefonoCliente"),
        "customerName": conv.get("nombreCliente"),
        "assignedAgentId": conv.get("idAgente"),
        "source": conv.get("fuente"),
        "externalId": conv.get("idExterno"),
        "lastCustomerMessageAt": conv.get("ultimoMensajeClienteEn"),
        "handoffBlockedAt": meta.get("handoffBloqueadoEn"),
        "metadatos": meta,
        "hub": conv,
    }


@dataclass
class Contexto:
    """Lo que el número trae resuelto: su forma de canal, su equipo y su bot (ya en forma del motor, o None)."""
    numero: dict
    equipo: dict | None
    bot: dict | None


class Turno:
    """Un mensaje del cliente de punta a punta. Los handlers de módulo leen y modifican `response`, `handled` y `stop`."""

    def __init__(self, mensaje: IncomingMessage, ctx: Contexto, send):
        self.incoming, self.ctx, self.send = mensaje, ctx, send
        self.bot = ctx.bot or {}
        self.customer = mensaje.from_number
        self.conv: dict = {}
        self.conv_data: dict = {}
        self.conv_id = ""
        self.historial: list[dict] = []
        self.api_result: dict = {}
        self.response = ""
        self.handled = False
        self.stop = False
        self.flags: dict = {}
        self.salida: list = []          # eventos para el sistema origen (contrato 3): salen al terminar el turno

    @property
    def org_id(self):
        return self.conv.get("idMarca")

    def refresca(self, conv: dict) -> None:
        self.conv = conv
        self.conv_data = conv_para_handlers(conv)

    def say(self, text: str, media_url: str | None = None) -> None:
        """Envía al cliente por el proveedor del número y guarda el mensaje con su id de proveedor."""
        if not text and not media_url:
            return
        sid = None
        try:
            sid = self.send(self.bot, self.customer, self.ctx.numero.get("phoneNumber") or self.incoming.to_number, text,
                            media_url=media_url)
        except Exception:
            log.exception("no se pudo enviar la respuesta de la conversación %s", self.conv_id)
        _ev(self, "respuesta_enviada", sid=sid, chars=len(text or ""), media=bool(media_url),
            texto=_texto(text) if _contenido() else None)
        info = mensajes.guarda(self.conv_id, "bot", text, media_url=media_url, id_proveedor=sid or None)
        self.refresca(info["conversacion"])

    def send_plain(self, bot, to, from_, text):
        return self.send(bot, to, from_, text)

    def emit(self, event: str, **params) -> None:
        dispatch(event, self.conv_data, {"turn": self, "bot": self.bot, "conv_id": self.conv_id, **params})


def resuelve_contexto(mensaje: IncomingMessage) -> Contexto | None:
    """Número, equipo y bot del mensaje. None si el número no está dado de alta (o está inactivo) en hub_cleber."""
    try:
        if mensaje.provider == "meta":
            info = numeros.resuelve(meta_phone_number_id=mensaje.phone_number_id)
        else:
            info = numeros.resuelve(telefono=mensaje.to_number)
    except ErrorHub as e:
        if e.codigo == "RECURSO_NO_ENCONTRADO":
            log.warning("mensaje para un número que no está en hub_cleber (%s %s)", mensaje.provider,
                        mensaje.to_number or mensaje.phone_number_id)
            return None
        raise
    numero = numeros.para_canal(info["numero"])
    bot_hub = info.get("botDefault")
    bot = bots.para_motor(bot_hub, numero) if bot_hub and bot_hub.get("esActivo", True) else None
    return Contexto(numero=numero, equipo=info.get("equipo"), bot=bot)


def procesa(mensaje: IncomingMessage, send) -> None:
    """Procesa un mensaje del cliente. Lanza ante un error transitorio (la cola lo reintenta; guardar el mensaje es
    idempotente). `send(bot, to, from, texto, media_url=None)` envía por el proveedor (channels.send_whatsapp_message)."""
    ctx = resuelve_contexto(mensaje)
    if ctx is None:
        return
    t = Turno(mensaje, ctx, send)
    try:
        _turno(t, mensaje, ctx)
    finally:
        # Despues de contestarle al cliente; un fallo del destino no deshace el turno (contrato_salida.envia no lanza)
        contrato_salida.envia(t.conv, t.salida)


def _turno(t: Turno, mensaje: IncomingMessage, ctx: Contexto) -> None:
    log.info("turno.inicio proveedor=%r mensaje=%r numero=%r bot=%r tipo=%r modulo=%r cliente=****%s chars=%d",
             mensaje.provider, mensaje.message_id, ctx.numero.get("id"), (ctx.bot or {}).get("id"), (ctx.bot or {}).get("type"),
             ctx.numero.get("vertical"), "".join(c for c in mensaje.from_number if c.isdigit())[-4:], len(mensaje.body or ""))

    # 1. Conversación y mensaje del cliente
    abierta = conversaciones.obtiene_o_abre(ctx.numero["id"], t.customer, nombre=mensaje.contact_name or None)
    t.refresca(abierta["conversacion"])
    t.conv_id = t.conv["idConversacion"]
    t.historial = abierta.get("historial") or []
    primera_del_cliente = not any(m.get("remitente") == "customer" for m in t.historial)
    ya_habia_contestado = bool(t.conv.get("ultimoMensajeClienteEn"))
    estado = t.conv.get("estado", "bot")

    _ev(t, "conversacion", origen=abierta.get("origen"), estado=estado, mensajes_previos=len(t.historial),
        primera_del_cliente=primera_del_cliente, texto=_texto(mensaje.body) if _contenido() else None)
    guardado = mensajes.guarda(t.conv_id, "customer", mensaje.body, id_proveedor=mensaje.message_id or None)
    if guardado.get("duplicado"):
        log.info("mensaje %s ya procesado (reintento del proveedor o de la cola)", mensaje.message_id)
        return
    t.refresca(guardado["conversacion"])
    if mensaje.button_payload:
        # El cliente pulso un boton de la plantilla. El texto del boton sigue su camino normal (el bot lo lee como cualquier mensaje);
        # ademas el modulo se entera por el evento `customer_button` (contrato 3 de Valuacion: oferta_interesa / oferta_no_interesa)
        _ev(t, "boton", payload=mensaje.button_payload, texto=mensaje.button_text)
        t.emit("customer_button", payload=mensaje.button_payload, text=mensaje.button_text)

    # 2. Un humano ya atiende desde otro sistema (Salesforce): solo se guarda
    if mensaje.from_agent_system and estado == "with_agent":
        _ev(t, "omitido", motivo="lo atiende un humano desde otro sistema")
        return
    if not t.bot:
        log.warning("el número %s no tiene bot activo: el mensaje queda en la conversación %s", ctx.numero.get("id"), t.conv_id)
        return
    t.emit("customer_replied")

    # 3. Reinicio (pruebas): cierre manual, para que el siguiente mensaje abra una conversación nueva
    if mensaje.body.strip().lower() in RESET_COMMANDS:
        _ev(t, "reset")
        t.refresca(conversaciones.actualiza(t.conv_id, estado="closed", cierreManual=True))
        t.say(RESET_MESSAGE)
        return

    # 4. Opt-out universal
    if is_stop_message(mensaje.body):
        accion = _accion_opt_out(t)
        _ev(t, "opt_out", accion=accion)
        if accion == "handoff":
            _aplica_handoff(t, "opt_out")
        else:
            t.refresca(conversaciones.actualiza(t.conv_id, estado="closed", resultado="opt_out"))
        t.emit("opt_out", action=accion)
        return

    if not ya_habia_contestado:
        t.emit("first_customer_reply")

    # 5. Handoff por palabra clave
    hc = t.bot.get("handoffConfig", {}) or {}
    if hc.get("enabled") and ho.check_handoff_keywords(mensaje.body, hc.get("triggerKeywords", [])):
        _ev(t, "handoff_detectado", origen="palabra clave")
        if _handoff_bloqueado(t, "keyword"):
            return
        _aplica_handoff(t, "keyword")
        t.emit("handoff_applied", trigger="keyword", motivo="keyword")
        t.say(hc.get("handoffMessage") or DEFAULT_HANDOFF_MESSAGE)
        return

    # 6. Estado
    if estado == "with_agent":
        _ev(t, "omitido", motivo="la conversacion esta con un asesor")
        return
    if estado == "waiting_agent":
        _ev(t, "esperando_asesor", accion="aviso de espera, sin bot")
        t.say(hc.get("waitingMessage") or DEFAULT_WAITING_MESSAGE)
        return

    # 7. Al bot
    texto = mensaje.body
    if primera_del_cliente:
        texto = _con_preambulo(t, texto)
    entrada = ho.apply_out_of_hours_context([{"is_user": True, "text": texto}], t.conv_data, t.bot.get("scheduleConfig"))
    _ev(t, "bot_llamada", bot=t.bot.get("id"), tipo=t.bot.get("type"), deployment=(t.bot.get("abacusConfig") or {}).get("deploymentId"),
        preambulo=primera_del_cliente and texto != mensaje.body, chars_enviados=len(texto))
    inicio = time.monotonic()
    t.api_result = expande_acciones_externas(engine.send_to_bot(t.bot, entrada, conv_id=t.conv_id, customer_phone=t.customer))
    tipo = t.bot.get("type", "chatllm")
    resumen = resumen_resultado(t.api_result)
    if "error" in resumen:
        log.error("turno.bot_error conv=%s bot=%s ms=%d error=%s", t.conv_id, t.bot.get("id"), (time.monotonic() - inicio) * 1000, resumen["error"])
    else:
        _ev(t, "bot_respuesta", ms=int((time.monotonic() - inicio) * 1000), **resumen,
            texto=_texto(extract_bot_response(t.api_result)) if _contenido() else None)

    # 8. Clasificación del motivo (antes del handoff, para que quede aunque escale)
    motivo = detect_action(t.api_result, tipo, t.bot.get("outcomeActions") or DEFAULT_AI_OUTCOME_ACTIONS,
                           tool_name=t.bot.get("outcomeTool", DEFAULT_AI_OUTCOME_TOOL))
    if motivo:
        _ev(t, "motivo_clasificado", motivo=motivo)
        t.refresca(conversaciones.actualiza(t.conv_id, resultado=motivo))
        t.emit("outcome_classified", motivo=motivo)

    hechos: set[str] = set()
    _corre_tools(t, "early", hechos)

    # 9. Handoff pedido por el bot
    handoff = detect_handoff(t.api_result, tipo)
    _ev(t, "handoff_revisado", detectado=handoff["triggered"], motivo=handoff.get("motivo"))
    if handoff["triggered"]:
        if _handoff_bloqueado(t, "tool call"):
            return
        t.say(extract_bot_response(t.api_result))
        _aplica_handoff(t, handoff["motivo"] or "bot")
        t.emit("handoff_applied", trigger="tool call", motivo=handoff["motivo"])
        return

    # 10. Respuesta y tools del turno
    t.response = extract_bot_response(t.api_result)
    _corre_tools(t, "main", hechos)
    if t.handled:
        return
    imagen, texto_respuesta = extract_image_from_text(t.response)
    if imagen and not mensaje.supports_media:
        texto_respuesta, imagen = f"{texto_respuesta}\n{imagen}".strip(), None
    t.say(texto_respuesta, media_url=imagen)


def _con_preambulo(t: Turno, texto: str) -> str:
    """Primer mensaje del cliente: antepone lo que la conversación ya trae (plantilla enviada, <<CONTEXTO>>) y, si el bot
    lo pide, su teléfono. El bot solo recibe el último mensaje (su sesión vive en Abacus), así que es su única oportunidad."""
    partes = []
    for m in t.historial:
        if m.get("remitente") == "system" and m.get("texto"):
            partes.append(m["texto"])
        elif m.get("remitente") == "bot" and m.get("esPlantilla") and m.get("texto"):
            partes.append(f"<<PLANTILLA>> Mensaje que se le envió al cliente: \"{m['texto']}\"")
    if t.bot.get("injectPhoneContext", t.incoming.provider == "twilio"):
        telefono = f'<<CONTEXTO>> Teléfono del cliente: "{t.customer.replace("whatsapp:", "")}"'
        mensajes.guarda(t.conv_id, "system", telefono)
        partes.append(telefono)
    return "\n\n".join([*partes, texto]) if partes else texto


def _accion_opt_out(t: Turno) -> str:
    """Qué hacer ante un "stop": el bot manda; si no define nada, el equipo; si no, cerrar."""
    accion = t.bot.get("optOutAction") or (t.ctx.equipo or {}).get("accionOptOut")
    return accion if accion in ("close", "handoff") else "close"


def _aplica_handoff(t: Turno, motivo: str) -> None:
    """Pasa la conversación a asesor según el modo de asignación del equipo.

    salesforce: with_agent sin asesor (se asigna en Salesforce). Los demás: waiting_agent; con round_robin o least_busy
    la base elige al asesor (Hub.asignaAgenteAutomatico) y, si no hay ninguno disponible, queda esperando a que la tomen.
    """
    modo = (t.ctx.equipo or {}).get("modoAsignacion")
    estado = "with_agent" if modo == "salesforce" else "waiting_agent"
    _ev(t, "handoff_aplicado", estado_destino=estado, modo_asignacion=modo, motivo=motivo)
    t.refresca(conversaciones.actualiza(t.conv_id, estado=estado, motivoHandoff=motivo))
    if modo in ("round_robin", "least_busy"):
        try:
            conv, id_agente = conversaciones.asigna_automatico(t.conv_id)
        except ErrorHub as e:   # la conversación ya quedó esperando: la toma un asesor
            log.error("turno.asignacion_error conv=%s modo=%s codigo=%s mensaje=%s", t.conv_id, modo, e.codigo, e.mensaje)
            return
        t.refresca(conv)
        _ev(t, "asignacion_automatica", modo=modo, agente=id_agente or "sin asesor disponible")


def _handoff_bloqueado(t: Turno, trigger: str) -> bool:
    """True si el handoff NO debe continuar: un módulo lo frenó o estamos fuera de horario (avisa al cliente y marca)."""
    t.stop = False
    t.emit("handoff_gate", trigger=trigger)
    if t.stop:
        _ev(t, "handoff_bloqueado", motivo="lo freno el modulo", trigger=trigger)
        return True
    horario = t.bot.get("scheduleConfig", {}) or {}
    if ho.check_business_hours(horario):
        return False
    _ev(t, "handoff_bloqueado", motivo="fuera de horario", trigger=trigger)
    texto = None
    if horario.get("viaBot"):
        instruccion = OUT_OF_HOURS_INSTRUCTION.format(text=ho.build_out_of_hours_message(horario))
        texto = extract_bot_response(engine.send_to_bot(t.bot, [{"is_user": True, "text": instruccion}]))
    t.say(texto or ho.build_out_of_hours_message(horario))
    if not t.conv_data.get("handoffBlockedAt"):
        t.refresca(conversaciones.actualiza(t.conv_id, metadatos={"handoffBloqueadoEn": _ahora()}))
    dispatch("handoff_blocked_out_of_hours", t.conv_data, {"bot": t.bot, "trigger": trigger})
    return True


def _corre_tools(t: Turno, fase: str, hechos: set) -> None:
    tipo = t.bot.get("type", "chatllm")
    for spec in [s for s in (t.bot.get("tools") or DEFAULT_TOOLS) if s.get("phase", "main") == fase]:
        evento = spec["event"]
        if evento in hechos:
            continue
        hit = detect_mention(t.api_result, spec["name"]) if spec.get("match") == "mention" else detect(t.api_result, tipo, spec["name"])
        _ev(t, "tool_revisado", tool=spec["name"], evento=evento, fase=fase, detectado=hit["triggered"])
        if hit["triggered"]:
            hechos.add(evento)
            _ev(t, "tool_detectado", tool=spec["name"], evento=evento, params=sorted((hit["input"] or {}).keys()))
            t.emit(evento, input=hit["input"], tool=spec["name"])
            if t.handled:
                break
