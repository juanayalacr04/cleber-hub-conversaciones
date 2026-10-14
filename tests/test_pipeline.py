import pytest

from ai import engine
from core import tools
from core.pipeline import Incoming, process_message
from tests.fakes import FakeDB

CUSTOMER = "whatsapp:+528186019229"
BOT_NUMBER = "whatsapp:+5255000001"


def ok(response="Hola", tool_results=None, **extra):
    return {"success": True, "result": dict({"response": response, "toolResults": tool_results or []}, **extra)}


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()
    db.seed("organizations", "honda", {"name": "Honda"})
    db.seed("teams", "t1", {"organizationId": "honda", "vertical": "servicio", "assignmentMode": "manual"})
    bot = {"id": "bot1", "organizationId": "honda", "teamId": "t1", "whatsappNumberId": "n1", "type": "chatllm",
           "provider": "twilio", "name": "Bot", "category": "Servicio"}
    sent, bot_calls = [], []
    state = {"result": ok()}

    def fake_engine(bot_config, messages, conv_id=None, customer_phone=""):
        bot_calls.append({"messages": list(messages), "conv_id": conv_id, "phone": customer_phone})
        return state["result"]

    monkeypatch.setattr(engine, "send_to_bot", fake_engine)
    tools.clear()

    class Env:
        pass

    e = Env()
    e.db, e.bot, e.sent, e.bot_calls, e.state = db, bot, sent, bot_calls, state

    def send(bot_cfg, to, from_, text, media_url=None):
        sent.append({"to": to, "from": from_, "text": text, "media": media_url})

    e.send = send

    def run(body="hola", provider="twilio", bot_overrides=None, **inc):
        cfg = dict(e.bot, **(bot_overrides or {}))
        msg = Incoming(provider=provider, from_number=CUSTOMER, to_number=BOT_NUMBER, body=body, supports_media=provider == "twilio", **inc)
        process_message(msg, cfg, send, db=db)

    e.run = run
    e.conv = lambda: next(iter(db.data["conversations"].values()))
    e.msgs = lambda: [m for m in db.data.get(f"conversations/{e.conv()['id']}/messages", {}).values()]
    yield e
    tools.clear()


# ---- camino normal ----

def test_responde_guarda_y_envia(env):
    env.state["result"] = ok("Con gusto te ayudo")
    env.run("hola")
    assert [(m["sender"], m["text"]) for m in env.msgs() if m["sender"] != "system"] == [("customer", "hola"), ("bot", "Con gusto te ayudo")]
    assert env.sent == [{"to": CUSTOMER, "from": BOT_NUMBER, "text": "Con gusto te ayudo", "media": None}]
    conv = env.conv()
    assert conv["vertical"] == "servicio" and conv["lastMessageSender"] == "bot"
    assert env.bot_calls[0]["conv_id"] == conv["id"] and env.bot_calls[0]["phone"] == CUSTOMER


def test_contexto_de_telefono_solo_en_la_primera_respuesta_y_solo_twilio(env):
    env.run("hola")
    assert env.bot_calls[0]["messages"][-1]["text"].startswith('<<CONTEXTO>> Teléfono del cliente: "+528186019229"')
    assert any(m["sender"] == "system" for m in env.msgs())
    env.run("otra cosa")
    assert env.bot_calls[1]["messages"][-1]["text"] == "otra cosa"
    env.db.data.clear()
    env.db.seed("organizations", "honda", {})
    env.run("hola", provider="meta")
    assert env.bot_calls[2]["messages"][-1]["text"] == "hola"  # Meta no recibe el contexto
    env.run("hola", bot_overrides={"injectPhoneContext": True}, provider="meta")


def test_contexto_de_campana_va_al_inicio(env):
    env.db.seed("broadcasts", "b1", {"botInstructions": "Confirma la cita"})
    env.run("hola")
    env.db.data["conversations"][env.conv()["id"]]["broadcastId"] = "b1"
    env.run("sí")
    assert env.bot_calls[-1]["messages"][0] == {"is_user": False, "text": "[Contexto de campaña] Confirma la cita"}


def test_imagen_viaja_solo_si_el_proveedor_la_soporta(env):
    env.state["result"] = ok("Mira [IMG]http://img/a.png[/IMG] esto")
    env.run("foto", provider="twilio")
    assert env.sent[-1] == {"to": CUSTOMER, "from": BOT_NUMBER, "text": "Mira  esto", "media": "http://img/a.png"}
    env.run("foto otra vez", provider="meta")
    assert env.sent[-1]["media"] is None and env.sent[-1]["text"].endswith("http://img/a.png")


# ---- estados y comandos ----

def test_con_agente_no_contesta_y_en_espera_avisa(env):
    env.run("hola")
    cid = env.conv()["id"]
    env.sent.clear()
    env.db.data["conversations"][cid]["status"] = "with_agent"
    env.run("sigo aquí")
    assert env.sent == []
    env.db.data["conversations"][cid]["status"] = "waiting_agent"
    env.run("hola?", bot_overrides={"handoffConfig": {"waitingMessage": "Pronto te contactan"}})
    assert env.sent[-1]["text"] == "Pronto te contactan"
    env.run("hola?")
    assert env.sent[-1]["text"] == "Tu mensaje fue recibido. Un asesor te atenderá pronto."


def test_mensaje_desde_sistema_con_agente_se_guarda_sin_invocar_al_bot(env):
    env.run("hola")
    cid = env.conv()["id"]
    env.db.data["conversations"][cid]["status"] = "with_agent"
    calls = len(env.bot_calls)
    env.run("respuesta", from_agent_system=True)
    assert len(env.bot_calls) == calls and any(m["text"] == "respuesta" for m in env.msgs())
    env.db.data["conversations"][cid]["status"] = "bot"
    env.run("hola de nuevo", from_agent_system=True)  # sin agente activo, el bot sí contesta
    assert len(env.bot_calls) == calls + 1


def test_reset_cierra_con_manualClose(env):
    env.run("/reset")
    conv = env.conv()
    assert conv["status"] == "closed" and conv["manualClose"] is True
    assert env.sent[-1]["text"].startswith("Conversación reiniciada")
    assert env.bot_calls == []


# ---- opt-out ----

def test_opt_out_cierra_y_despacha_el_evento(env):
    events = []
    tools.tool("opt_out", vertical="servicio")(lambda conv, p: events.append(p["action"]))
    env.run("STOP")
    assert env.conv()["status"] == "closed" and env.bot_calls == [] and events == ["close"]


def test_opt_out_se_configura_por_equipo_y_el_bot_manda(env):
    env.db.data["teams"]["t1"]["optOutAction"] = "handoff"
    env.run("hola")
    env.run("stop")
    assert env.conv()["status"] == "waiting_agent"  # lo definió el equipo
    env.db.data["conversations"][env.conv()["id"]]["status"] = "bot"
    env.run("stop", bot_overrides={"optOutAction": "close"})
    assert env.conv()["status"] == "closed"  # el bot tiene prioridad sobre el equipo
    env.db.data["teams"]["t1"]["optOutAction"] = "inventado"
    env.run("hola otra vez", bot_overrides={"optOutAction": None})
    env.run("stop", bot_overrides={"optOutAction": None})
    assert env.conv()["status"] == "closed"  # valor inválido: cierra


def test_opt_out_configurable_a_handoff(env):
    env.run("hola")
    events = []
    tools.tool("opt_out")(lambda conv, p: events.append(p["action"]))
    env.run("por favor stop", bot_overrides={"optOutAction": "handoff"})
    assert env.conv()["status"] == "waiting_agent" and events == ["handoff"]


# ---- handoff ----

HANDOFF = {"enabled": True, "triggerKeywords": ["asesor"], "handoffMessage": "Te paso con alguien."}


def test_handoff_por_keyword(env):
    applied = []
    tools.tool("handoff_applied")(lambda conv, p: applied.append(p["trigger"]))
    env.run("quiero un asesor", bot_overrides={"handoffConfig": HANDOFF})
    assert env.conv()["status"] == "waiting_agent" and env.sent[-1]["text"] == "Te paso con alguien." and applied == ["keyword"]
    assert env.bot_calls == []


SCHEDULE_CERRADO = {"enabled": True, "timezone": "America/Mexico_City", "outOfHoursMessage": "Cerrado.", "schedule": []}


def test_handoff_fuera_de_horario_avisa_y_marca(env):
    blocked = []
    tools.tool("handoff_blocked_out_of_hours")(lambda conv, p: blocked.append(p["trigger"]))
    env.run("quiero un asesor", bot_overrides={"handoffConfig": HANDOFF, "scheduleConfig": SCHEDULE_CERRADO})
    conv = env.conv()
    assert conv["status"] == "bot" and conv["handoffBlockedAt"] is not None
    assert env.sent[-1]["text"].startswith("Cerrado.") and blocked == ["keyword"]


def test_aviso_fuera_de_horario_redactado_por_el_bot(env):
    env.state["result"] = ok("Ahorita no hay nadie, pero te escribimos mañana.")
    env.run("quiero un asesor", bot_overrides={"handoffConfig": HANDOFF, "scheduleConfig": dict(SCHEDULE_CERRADO, viaBot=True)})
    assert env.sent[-1]["text"] == "Ahorita no hay nadie, pero te escribimos mañana."
    assert "__ADMIN_FOLLOW_INSTRUCTIONS_MESSAGE_OUTPUT__" in env.bot_calls[0]["messages"][0]["text"]


def test_handoff_por_tool_responde_y_escala_con_el_motivo(env):
    env.state["result"] = ok("Te conecto con un asesor.", [{"toolName": "Transferir_a_Asesor", "input": {"motivo": "cotización"}}])
    env.run("necesito precio")
    conv = env.conv()
    assert (conv["status"], conv["handoffReason"]) == ("waiting_agent", "cotización")
    assert env.sent[-1]["text"] == "Te conecto con un asesor."


def test_un_modulo_puede_frenar_el_handoff_con_el_gate(env):
    def gate(conv, p):
        p["turn"].say("Primero necesito tus datos.")
        p["turn"].stop = True
    tools.tool("handoff_gate", vertical="servicio")(gate)
    env.run("quiero un asesor", bot_overrides={"handoffConfig": HANDOFF})
    assert env.conv()["status"] == "bot" and env.sent[-1]["text"] == "Primero necesito tus datos."


# ---- tools ----

def test_tool_temprano_corre_antes_del_handoff_y_comparte_estado(env):
    order = []

    def crear_lead(conv, p):
        order.append("crear_lead")
        p["turn"].flags["lead_attempted"] = True
        conv["leadId"] = "L1"

    tools.tool("crear_lead", vertical="servicio")(crear_lead)
    tools.tool("handoff_gate")(lambda conv, p: order.append(f"gate:{conv.get('leadId')}:{p['turn'].flags.get('lead_attempted')}"))
    env.state["result"] = ok("Listo", [
        {"toolName": "Transferir_a_Asesor", "input": {"motivo": "x"}},
        {"toolName": "Crear_Lead", "input": {"nombre": "Ana"}},
    ])
    env.run("hola")
    assert order == ["crear_lead", "gate:L1:True"]


def test_handlers_se_resuelven_por_la_vertical_de_la_conversacion(env):
    seen = []
    tools.tool("crear_cita", vertical="ventas")(lambda conv, p: seen.append("ventas"))
    tools.tool("crear_cita", vertical="servicio")(lambda conv, p: seen.append(("servicio", p["input"]["fecha"])))
    env.state["result"] = ok("Agendado", [{"toolName": "Crear_Cita_Ventas_Salesforce", "input": {"fecha": "2026-10-20"}}])
    env.run("agenda")
    assert seen == [("servicio", "2026-10-20")]


def test_tool_de_modulo_puede_reemplazar_la_respuesta_o_responder_por_si_mismo(env):
    def cita(conv, p):
        p["turn"].response = "Repíteme la fecha, por favor."
    tools.tool("crear_cita")(cita)
    env.state["result"] = ok("Cita agendada", [{"toolName": "Crear_Cita_Ventas_Salesforce", "input": {}}])
    env.run("agenda")
    assert env.sent[-1]["text"] == "Repíteme la fecha, por favor."

    def responde(conv, p):
        p["turn"].say("Respondí yo")
        p["turn"].handled = True
    tools.clear()
    tools.tool("agendar_recordatorio")(responde)
    env.state["result"] = ok("normal", [{"toolName": "Agendar_Recordatorio", "input": {}}])
    env.run("recuérdame")
    assert [s["text"] for s in env.sent[-1:]] == ["Respondí yo"]
    assert "normal" not in [s["text"] for s in env.sent]


def test_tools_configurables_por_bot(env):
    seen = []
    tools.tool("mi_evento")(lambda conv, p: seen.append(p["input"]))
    env.state["result"] = ok("ok", [{"toolName": "Mi_Tool", "input": {"x": 1}}, {"toolName": "Guardar_Nombre_Cliente", "input": {"nombre": "Ana"}}])
    env.run("hola", bot_overrides={"tools": [{"name": "Mi_Tool", "event": "mi_evento", "phase": "main"}]})
    assert seen == [{"x": 1}]
    assert env.conv().get("customerName") is None  # el bot reemplazó la lista: el nombre ya no se captura


def test_nombre_capturado_pisa_el_del_perfil(env):
    env.state["result"] = ok("Gracias", [{"toolName": "Guardar_Nombre_Cliente", "input": {"nombre": " Ana López "}}])
    env.run("soy Ana", contact_name="Bot PRUEBA")
    assert env.conv()["customerName"] == "Ana López"


def test_cita_registrada_marca_conversacion_y_outcome(env):
    env.state["result"] = ok("Listo", [{"toolName": "Registrar_Cita", "input": {}}])
    env.run("agenda")
    conv = env.conv()
    assert conv["appointmentStatus"] == "cita_bot" and conv["conversationOutcome"] == "cita_bot"


def test_clasificacion_del_motivo_y_respuesta_a_campana_con_workflow(env):
    env.db.seed("broadcasts", "b1", {"confirmedCount": 0})
    env.db.seed("broadcasts/b1/recipients", "r1", {"status": "sent"})
    env.run("hola", bot_overrides={"type": "workflow"})
    cid = env.conv()["id"]
    env.db.data["conversations"][cid].update(broadcastId="b1", lastBroadcastRecipientId="r1")
    env.state["result"] = {"success": True, "result": {"response": {"segments": [
        {"type": "text", "id": "reply", "segment": "Confirmada"}, {"type": "text", "id": "action", "segment": "confirmar_cita"}]}}}
    env.run("sí, confirmo", bot_overrides={"type": "workflow"})
    assert env.sent[-1]["text"] == "Confirmada"
    assert env.db.data["broadcasts/b1/recipients"]["r1"]["response"] == "confirmar_cita"
    env.state["result"] = ok("Ok", [{"toolName": "Clasificar_Motivo", "input": {"motivo": "interes_cita"}}])
    env.run("quiero una cita")
    conv = env.db.data["conversations"][cid]
    assert (conv["conversationOutcome"], conv["aiOutcome"]) == ("interes_cita", "interes_cita")


def test_sin_bot_no_hace_nada(env):
    process_message(Incoming(provider="twilio", from_number=CUSTOMER, body="hola"), None, env.send, db=env.db)
    assert env.sent == [] and "conversations" not in env.db.data


def test_un_error_del_motor_no_tumba_el_turno(env):
    env.state["result"] = {"error": "HTTP 500"}
    env.run("hola")
    assert env.sent[-1]["text"].startswith("Lo siento, hubo un error")
