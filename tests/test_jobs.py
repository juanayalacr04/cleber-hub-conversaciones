import importlib
import json
from datetime import datetime, timezone

import pytest

import main
from ai import engine
from core import http, numbers as nb, tools
from crm import salesforce
from jobs import inactivity
from jobs.auth import cron_authorized
from modules import ventas
from tests.fakes import FakeDB
from tests.test_ventas import SfRouter, http_error

NOW = datetime.now(timezone.utc)


def ok(text="Hola, ¿sigues interesado?"):
    return {"success": True, "result": {"response": text, "toolResults": []}}


@pytest.fixture(autouse=True)
def _limpio():
    salesforce.clear_token_cache()
    nb.clear_bot_cache()
    tools.clear()
    importlib.reload(ventas)
    yield
    tools.clear()


@pytest.fixture
def env(monkeypatch):
    for k, v in {"SF_INSTANCE_URL": "https://sf.example", "SF_CLIENT_ID": "c", "SF_CLIENT_SECRET": "s", "SF_USERNAME": "u", "SF_PASSWORD": "p"}.items():
        monkeypatch.setenv(k, v)
    db = FakeDB()
    db.seed("organizations", "honda", {"salesforceConfig": {"marcaRR": "Honda"}})
    db.seed("teams", "tv", {"vertical": "ventas"})
    db.seed("bots", "bot1", {"organizationId": "honda", "name": "Ventas", "type": "chatllm"})
    db.seed("whatsappNumbers", "n-tw", {"phoneNumber": "whatsapp:+5255000001", "provider": "twilio", "organizationId": "honda", "teamId": "tv",
                                        "twilioAccountSid": "AC", "twilioAuthToken": "t"})
    db.seed("whatsappNumbers", "n-vt", {"phoneNumber": "whatsapp:+5255000002", "provider": "valuetext", "organizationId": "honda", "teamId": "tv", "valuetextSenderId": "S1"})
    db.seed("conversations", "c1", {"status": "bot", "customerPhone": "whatsapp:+528186019229", "whatsappNumberId": "n-tw", "botId": "bot1",
                                    "inactivityRemindersSent": 0, "organizationId": "honda"})

    class Env:
        pass

    e = Env()
    e.db, e.sent, e.bot_calls = db, [], []
    e.result = {"value": ok()}
    monkeypatch.setattr(engine, "send_to_bot", lambda bot, msgs, conv_id=None, customer_phone="": (e.bot_calls.append(msgs[-1]["text"]), e.result["value"])[1])
    e.sf = SfRouter({("POST", "/sobjects/rsplus__SMS_Bucket__c/"): (201, json.dumps({"id": "a0B"}))})
    monkeypatch.setattr(http, "request", e.sf)
    e.send = lambda bot, to, frm, text, media_url=None: e.sent.append((to, frm, text))
    e.body = lambda **kw: dict({"convId": "c1", "botId": "bot1", "code": "__INACTIVITY_1__", "reminderIndex": 1}, **kw)
    e.run = lambda **kw: inactivity.run_followup(e.body(**kw), db=db, send=e.send)
    e.conv = lambda: db.data["conversations"]["c1"]
    return e


# ---- recordatorio en ventana libre ----

def test_recordatorio_en_ventana_libre(env):
    body, status = env.run()
    assert (status, body) == (200, {"success": True, "messageSent": "Hola, ¿sigues interesado?"})
    assert env.bot_calls == ["__INACTIVITY_1__"]
    assert env.sent == [("whatsapp:+528186019229", "whatsapp:+5255000001", "Hola, ¿sigues interesado?")]
    assert env.conv()["inactivityRemindersSent"] == 1 and env.conv()["status"] == "bot"


def test_datos_faltantes_y_conversaciones_que_no_aplican(env):
    assert inactivity.run_followup({"convId": "c1"}, db=env.db)[1] == 400
    assert inactivity.run_followup(env.body(reminderIndex=None), db=env.db)[1] == 400
    assert env.run(convId="nada")[0]["reason"] == "conv_not_found"
    env.conv()["status"] = "with_agent"
    assert env.run()[0]["reason"] == "status_changed"
    env.conv()["status"] = "waiting_agent"
    assert env.run()[0]["reason"] == "status_changed"
    env.conv()["inactivityEscalatedAt"] = NOW  # escalada por este mismo mecanismo: sigue la escalera
    assert env.run()[0]["success"] is True
    assert env.run()[0]["reason"] == "already_sent"  # idempotente
    assert len(env.sent) == 1


def test_bot_inexistente_o_respuesta_vacia_no_cambian_nada(env):
    assert env.run(botId="nada")[0] == {"success": False, "error": "bot_not_found"}
    env.result["value"] = {"success": True, "result": {"response": "", "toolResults": []}}
    body, _ = env.run()
    assert body["error"] == "empty_bot_response" and env.conv()["inactivityRemindersSent"] == 0 and env.sent == []


# ---- cierre por inactividad ----

def test_cierre_estampa_closedAt_y_outcome_inactividad(env):
    env.run(closeAfter=True)
    conv = env.conv()
    assert (conv["status"], conv["closedReason"], conv["conversationOutcome"]) == ("closed", "inactivity_bot", "inactividad")
    assert conv["closedAt"] is not None and conv["assignedAgentId"] is None


def test_cierre_no_pisa_un_outcome_terminal(env):
    env.conv()["conversationOutcome"] = "cita_bot"
    env.run(closeAfter=True)
    assert env.conv()["conversationOutcome"] == "cita_bot" and env.conv()["status"] == "closed"


def _con_lead(env, **extra):
    env.conv().update(leadId="00Q1", whatsappNumberId="n-vt", vertical="ventas", **extra)


def test_una_conversacion_sin_vertical_se_despacha_al_modulo_de_su_equipo(env):
    env.conv().update(leadId="00Q1", whatsappNumberId="n-vt", teamId="tv")  # sin campo vertical (anterior al hub)
    env.run(closeAfter=True)
    assert env.sf.patched_lead()[-1]["Validacion_Prospecto__c"] == "Sin validar"


def test_ventas_cierra_el_lead_sin_respuesta_como_sin_validar(env):
    _con_lead(env)
    env.run(closeAfter=True)
    assert env.sf.patched_lead()[-1] == {"Validacion_Prospecto__c": "Sin validar", "Status": "Nuevo", "Fecha_Deal__c": None}


def test_ventas_con_respuesta_y_sin_cita_queda_finalizado_sin_cita_y_se_reasigna(env):
    _con_lead(env, lastCustomerMessageAt=NOW)
    env.run(closeAfter=True)
    assert {"Validacion_Prospecto__c": "Finalizado sin cita"} in env.sf.patched_lead()
    assert env.sf.find("POST", "/actions/custom/flow/RRAgenteIACLEBER")


def test_con_cita_el_lead_no_se_toca(env):
    _con_lead(env, lastCustomerMessageAt=NOW, appointmentStatus="cita_agente")
    env.run(closeAfter=True)
    assert env.sf.patched_lead() == []


def test_sin_salesforce_el_cierre_no_toca_ningun_lead(env):
    env.conv()["leadId"] = "00Q1"  # número de Twilio: el bot no trae salesforceConfig
    env.run(closeAfter=True)
    assert env.sf.calls == []


# ---- plantilla (ventana de 24 h vencida, solo ValueText) ----

def test_plantilla_de_valuetext_y_aviso_al_bot(env):
    env.conv()["whatsappNumberId"] = "n-vt"
    env.sf.routes[("GET", "/query")] = (200, json.dumps({"records": [{"rsplus__WA_template_structure__c": "Hola {{1}}"}]}))
    body, _ = env.run(useTemplate=True, templateId="T55")
    assert body == {"success": True, "messageSent": None}
    bucket = env.sf.find("POST", "/sobjects/rsplus__SMS_Bucket__c/")[0]["payload"]
    assert (bucket["rsplus__Template_ID__c"], bucket["rsplus__Sender_ID__c"]) == ("T55", "S1")
    assert env.bot_calls == ["__INACTIVITY_1__\n<<PLANTILLA>> Hola {{1}}"] and env.sent == []
    msgs = [m["text"] for m in env.db.data["conversations/c1/messages"].values()]
    assert msgs == ["<<PLANTILLA>> Hola {{1}}"]
    assert (env.conv()["inactivityRemindersSent"], env.conv()["lastTemplateMessageAt"] is not None) == (1, True)


def test_si_la_plantilla_falla_no_avanza_el_contador(env):
    env.conv()["whatsappNumberId"] = "n-vt"
    env.sf.routes[("POST", "/sobjects/rsplus__SMS_Bucket__c/")] = http_error(400)
    assert env.run(useTemplate=True, templateId="T55")[0] == {"success": False, "error": "template_send_failed"}
    assert env.conv()["inactivityRemindersSent"] == 0


def test_plantilla_con_otro_proveedor_no_envia_nada_pero_avanza(env):
    body, _ = env.run(useTemplate=True, templateId="T55")  # número de Twilio
    assert body["success"] is True and env.sent == [] and env.bot_calls == [] and env.conv()["inactivityRemindersSent"] == 1


# ---- contacto programado ----

def sched(env, **kw):
    return inactivity.run_followup({"type": "scheduled_contact", "convId": "c1", "botId": "bot1", **kw}, db=env.db, send=env.send)


def test_contacto_programado_en_ventana_libre(env):
    env.conv()["scheduledContactAt"] = NOW
    body, _ = sched(env)
    assert body["success"] is True and env.bot_calls == ["__ADMIN_SCHEDULED_CONTACT__"]
    assert env.sent[0][2] == "Hola, ¿sigues interesado?" and "scheduledContactAt" not in env.conv()


def test_contacto_programado_guards(env):
    assert inactivity.run_followup({"type": "scheduled_contact", "convId": "c1"}, db=env.db)[1] == 400
    assert sched(env)[0]["reason"] == "already_cleared"
    env.conv().update(scheduledContactAt=NOW, status="with_agent")
    assert sched(env)[0]["reason"] == "status_changed"
    assert sched(env, convId="nada")[0]["reason"] == "conv_not_found"


def test_contacto_programado_con_plantilla(env):
    env.conv().update(scheduledContactAt=NOW, whatsappNumberId="n-vt", leadId="00Q1")
    body, _ = sched(env, useTemplate=True, templateId="T9")
    assert body["success"] is True and env.sf.find("POST", "/sobjects/rsplus__SMS_Bucket__c/")
    assert "scheduledContactAt" not in env.conv() and env.conv()["lastTemplateMessageAt"] is not None


# ---- bot de una conversación y autenticación ----

def test_bot_de_una_conversacion_trae_la_config_de_su_numero(env):
    bot, number = nb.get_bot_for_conversation("bot1", "n-vt", env.db)
    assert (bot["provider"], bot["valuetextSenderId"], bot["teamId"], number) == ("valuetext", "S1", "tv", "whatsapp:+5255000002")
    assert bot["salesforceConfig"]["marcaRR"] == "Honda" and bot["salesforceConfig"]["username"] == "u"
    bot, number = nb.get_bot_for_conversation("bot1", None, env.db)
    assert number == "" and "provider" not in bot
    assert nb.get_bot_for_conversation("nada", "n-vt", env.db) == (None, "")


def test_la_autenticacion_del_cron_falla_cerrada():
    assert cron_authorized({"X-Cron-Secret": "s3"}, {"CRON_SECRET": "s3"}) is True
    assert cron_authorized({"X-Cron-Secret": "otro"}, {"CRON_SECRET": "s3"}) is False
    assert cron_authorized({}, {"CRON_SECRET": "s3"}) is False
    assert cron_authorized({}, {}) is False  # sin secreto configurado, todo se rechaza
    assert cron_authorized({}, {"ALLOW_UNAUTHENTICATED_CRON": "true"}) is True  # solo si se pide explícitamente


class Req:
    def __init__(self, method="POST", headers=None, body=None):
        self.method, self.headers, self._body = method, headers or {}, body

    def get_json(self, silent=False):
        return self._body


def test_entry_point_del_job(env, monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "s3")
    monkeypatch.setattr(inactivity, "run_followup", lambda body, **kw: ({"success": True, "echo": body}, 200))
    assert main.inactivity_followup(Req("GET"))[1] == 405
    assert main.inactivity_followup(Req(headers={}))[1] == 401
    body, status, _ = main.inactivity_followup(Req(headers={"X-Cron-Secret": "s3"}, body={"convId": "c1"}))
    assert status == 200 and json.loads(body)["echo"] == {"convId": "c1"}
    monkeypatch.setattr(inactivity, "run_followup", lambda body, **kw: 1 / 0)
    assert main.inactivity_followup(Req(headers={"X-Cron-Secret": "s3"}))[1] == 500
