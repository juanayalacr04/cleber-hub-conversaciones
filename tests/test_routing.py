import json
from datetime import datetime, timezone
from io import BytesIO

import pytest

from ai import engine
from ai.parsing import detect_mention
from core import http, numbers as nb, routing, tools
from core.pipeline import Incoming, process_message
from core.scheduled_contact import local_to_utc, org_timezone, parse_scheduled_contact_time
from crm import salesforce, templates
from tests.fakes import FakeDB

SF = {"instanceUrl": "https://sf.example", "clientId": "c", "clientSecret": "s", "username": "u", "password": "p"}


def _payload(data):
    """JSON si lo es; el token de Salesforce se manda como formulario."""
    try:
        return json.loads(data) if data else None
    except ValueError:
        return data.decode()


class Script:
    def __init__(self, *responses):
        self.calls, self._r = [], list(responses)

    def __call__(self, url, data=None, headers=None, method="POST", timeout=30):
        self.calls.append({"url": url, "method": method, "payload": _payload(data), "headers": headers or {}})
        r = self._r.pop(0) if self._r else (200, "{}")
        if isinstance(r, Exception):
            raise r
        return r


def tok():
    return 200, json.dumps({"access_token": "T"})


def err(code, body=b"{}"):
    return http.HTTPError("u", code, "x", {}, BytesIO(body))


@pytest.fixture(autouse=True)
def _limpio():
    salesforce.clear_token_cache()
    nb.clear_bot_cache()
    tools.clear()
    yield
    tools.clear()


# ---- cliente de Salesforce ----

def test_call_reintenta_una_vez_con_token_nuevo_ante_401(monkeypatch):
    s = Script(tok(), err(401), tok(), (200, '{"id": "00Q1"}'))
    monkeypatch.setattr(http, "request", s)
    ok, data = salesforce.call(SF, "POST", "/x", {"a": 1})
    assert (ok, data) == (True, {"id": "00Q1"}) and len(s.calls) == 4
    monkeypatch.setattr(http, "request", Script(tok(), err(401), tok(), err(401)))
    salesforce.clear_token_cache()
    assert salesforce.call(SF, "GET", "/x")[0] is False


def test_patch_lead_y_create_lead_sin_reglas_de_asignacion(monkeypatch):
    s = Script(tok(), (204, ""), (201, '{"id": "00QNEW"}'))
    monkeypatch.setattr(http, "request", s)
    assert salesforce.patch_lead(SF, "00Q1", {"Status": "Cita"}) is True
    assert salesforce.create_lead(SF, {"LastName": "Ana"}) == "00QNEW"
    patch, create = s.calls[1], s.calls[2]
    assert patch["method"] == "PATCH" and patch["url"].endswith("/sobjects/Lead/00Q1") and patch["headers"]["Sforce-Auto-Assign"] == "FALSE"
    assert create["url"].endswith("/v60.0/sobjects/Lead/") and create["headers"]["Sforce-Auto-Assign"] == "FALSE"


def test_flow_get_lead_field_y_query(monkeypatch):
    s = Script(tok(), (200, '[{"isSuccess": true}]'), (200, '{"GCL_ComentarioLanding__c": "previo"}'), err(500), (200, '{"records": [{"Id": "e1"}]}'))
    monkeypatch.setattr(http, "request", s)
    assert salesforce.call_flow(SF, "MiFlow", [{"leadId": "L"}]) is True
    assert s.calls[1]["url"].endswith("/actions/custom/flow/MiFlow")
    assert salesforce.get_lead_field(SF, "L", "GCL_ComentarioLanding__c") == (True, "previo")
    assert salesforce.get_lead_field(SF, "L", "X") == (False, None)
    assert salesforce.query(SF, "SELECT Id FROM Event") == [{"Id": "e1"}]


def test_comentario_se_anexa_con_marca_de_tiempo_y_soql_se_escapa():
    out = salesforce.build_appended_comment("Anterior\n", "Nuevo")
    assert out.startswith("Anterior\n[") and out.endswith("] Nuevo")
    assert salesforce.build_appended_comment(None, "Solo").startswith("[")
    assert salesforce.soql_quote("O'Brien\\x") == "O\\'Brien\\\\x"


def test_parsea_el_outbound_message_de_un_lead():
    xml = ('<e xmlns:sf="urn:x"><sObject><sf:Id>00Q1</sf:Id><sf:FirstName>Ana</sf:FirstName><sf:Celular__c>5518</sf:Celular__c></sObject></e>')
    assert salesforce.parse_lead_outbound_message(xml) == [{"_lead_id": "00Q1", "FirstName": "Ana", "Celular__c": "5518"}]
    assert salesforce.parse_lead_outbound_message("mal") == []


def test_plantilla_de_valuetext(monkeypatch):
    s = Script(tok(), (201, '{"id": "a0B"}'), tok(), (201, '{"id": "a0C"}'), (200, '{"records": [{"rsplus__WA_template_structure__c": "Hola {{1}}"}]}'))
    monkeypatch.setattr(http, "request", s)
    assert templates.send_valuetext_template(SF, "SENDER", "whatsapp:+528186019229", "00Q1") == "a0B"
    body = s.calls[1]["payload"]
    assert body["rsplus__Number__c"] == "8186019229" and body["rsplus__Template_ID__c"] == "T0716" and body["Origen__c"] == "Plataforma IA"
    salesforce.clear_token_cache()
    assert templates.send_valuetext_template(dict(SF, defaultTemplateId="T9"), "S", "+52", "L", template_id="T5") == "a0C"
    assert s.calls[3]["payload"]["rsplus__Template_ID__c"] == "T5"
    assert templates.get_template_structure(SF, "T5'x") == "Hola {{1}}"
    assert "T5\\'x" in s.calls[4]["url"] or "T5%5C%27x" in s.calls[4]["url"]


# ---- ruteo de situaciones ----

@pytest.fixture
def db():
    d = FakeDB()
    d.seed("organizations", "honda", {"salesforceConfig": {"marcaRR": "Honda"}, "settings": {"timezone": "America/Mexico_City"}})
    d.seed("teams", "tv", {"vertical": "ventas"})
    d.seed("teams", "ts", {"vertical": "servicio"})
    d.seed("bots", "bot-serv", {"organizationId": "honda", "name": "Servicio", "category": "Servicio", "teamId": "ts", "status": "active"})
    d.seed("bots", "bot-pausado", {"organizationId": "honda", "name": "Pausado", "status": "paused"})
    d.seed("conversations", "c1", {"customerPhone": "whatsapp:+528186019229", "customerName": "Ana", "leadId": "00Q1", "vertical": "ventas", "status": "bot", "organizationId": "honda"})
    return d


def route(**kw):
    return {"situacion": "servicio_postventa", **kw}


def test_cambiar_bot_redenormaliza_la_vertical_y_deja_el_contexto(db):
    conv = db.data["conversations"]["c1"]
    bot = {"id": "bot-ventas", "situationRouting": [route(destino="cambiar_bot", internalBotId="bot-serv")]}
    assert routing.process_situacion_handoff(bot, conv, "c1", "servicio_postventa", "quiere servicio", db=db) == "switched"
    assert (conv["activeBotId"], conv["vertical"]) == ("bot-serv", "servicio")
    stored = db.data["conversations"]["c1"]
    assert (stored["activeBotId"], stored["vertical"], stored["botName"], stored["botBrand"]) == ("bot-serv", "servicio", "Servicio", "Honda")
    ctx = conv["_switchContext"]
    assert 'Situación: "servicio_postventa"' in ctx and 'Cliente: "Ana"' in ctx and 'Teléfono: "+528186019229"' in ctx and 'Lead ID: "00Q1"' in ctx
    assert "desde el bot de ventas" in ctx
    # una sola vía: la segunda situación ya no cambia nada
    assert routing.process_situacion_handoff(bot, conv, "c1", "servicio_postventa", "", db=db) is False


def test_cambiar_bot_con_destino_invalido_o_inactivo_no_hace_nada(db):
    conv = db.data["conversations"]["c1"]
    for target in ("no-existe", "bot-pausado", ""):
        bot = {"situationRouting": [route(destino="cambiar_bot", internalBotId=target)]}
        assert routing.process_situacion_handoff(bot, conv, "c1", "servicio_postventa", "", db=db) is False
    assert "activeBotId" not in db.data["conversations"]["c1"]


def test_sin_ruta_no_hay_efectos(db):
    conv = db.data["conversations"]["c1"]
    assert routing.process_situacion_handoff({"situationRouting": []}, conv, "c1", "otra", "", db=db) is False
    assert db.data["conversations"]["c1"]["status"] == "bot"


def test_destino_externo_manda_el_payload_y_cierra(db, monkeypatch):
    s = Script((200, "ok"))
    monkeypatch.setattr(http, "request", s)
    events = []
    tools.tool("situacion_resuelta")(lambda conv, p: events.append((p["situacion"], p["motivo"])))
    conv = db.data["conversations"]["c1"]
    bot = {"id": "b", "situationRouting": [route(destino="externo", externalUrl="https://ext.example/hook", externalTargetPhone="+52X")]}
    assert routing.process_situacion_handoff(bot, conv, "c1", "servicio_postventa", "taller", db=db) is True
    sent = s.calls[0]["payload"]
    assert sent["event"] == "situacion_detectada" and sent["leadId"] == "00Q1" and sent["targetPhone"] == "+52X" and sent["sourceConversationId"] == "c1"
    stored = db.data["conversations"]["c1"]
    assert (stored["status"], stored["closedReason"], stored["manualClose"]) == ("closed", "situation_handoff", True)
    assert events == [("servicio_postventa", "taller")]


def test_destino_externo_que_falla_deja_la_conversacion_abierta(db, monkeypatch):
    monkeypatch.setattr(http, "request", Script(err(500)))
    bot = {"situationRouting": [route(destino="externo", externalUrl="https://ext.example/hook")]}
    assert routing.process_situacion_handoff(bot, db.data["conversations"]["c1"], "c1", "servicio_postventa", "", db=db) is False
    assert db.data["conversations"]["c1"]["status"] == "bot"
    assert routing.notify_situacion_externa({}, {}, "c1", "x", "") is False  # sin URL


def test_destino_ninguno_solo_cierra(db):
    bot = {"situationRouting": [route(destino="ninguno")]}
    assert routing.process_situacion_handoff(bot, db.data["conversations"]["c1"], "c1", "servicio_postventa", "", db=db) is True
    assert db.data["conversations"]["c1"]["status"] == "closed"


def test_destino_interno_abre_conversacion_en_el_otro_numero_y_manda_la_plantilla(db, monkeypatch):
    monkeypatch.setenv("SF_INSTANCE_URL", "https://sf.example")
    for k in ("CLIENT_ID", "CLIENT_SECRET", "USERNAME", "PASSWORD"):
        monkeypatch.setenv(f"SF_{k}", "x")
    db.seed("whatsappNumbers", "wa-serv", {"organizationId": "honda", "teamId": "ts", "provider": "valuetext", "defaultBotId": "bot-serv",
                                           "valuetextSenderId": "SENDER", "situationTemplateId": "T77"})
    db.seed("whatsappNumbers", "wa-twilio", {"organizationId": "honda", "provider": "twilio", "defaultBotId": "bot-serv"})
    s = Script(tok(), (201, '{"id": "a0B"}'))
    monkeypatch.setattr(http, "request", s)
    conv = db.data["conversations"]["c1"]
    assert routing.notify_situacion_interna({"internalWhatsappNumberId": "wa-serv"}, conv, "taller", db=db) is True
    new = next(c for cid, c in db.data["conversations"].items() if cid != "c1")
    assert (new["teamId"], new["vertical"], new["leadId"], new["botId"]) == ("ts", "servicio", "00Q1", "bot-serv")
    assert s.calls[1]["payload"]["rsplus__Template_ID__c"] == "T77" and s.calls[1]["payload"]["rsplus__Sender_ID__c"] == "SENDER"
    # proveedor sin soporte, número inexistente
    assert routing.notify_situacion_interna({"internalWhatsappNumberId": "wa-twilio"}, conv, "x", db=db) is False
    assert routing.notify_situacion_interna({"internalWhatsappNumberId": "nada"}, conv, "x", db=db) is False


def test_destino_lead_lo_resuelve_el_modulo(db):
    seen = []

    def handler(conv, p):
        seen.append((p["route"]["seminuevoOwnerId"], p["tool_input"]["motivo"]))
        p["result"] = True
    tools.tool("situacion_destino_lead", vertical="ventas")(handler)
    bot = {"situationRouting": [route(situacion="seminuevo", destino="lead", seminuevoOwnerId="005Z")]}
    assert routing.process_situacion_handoff(bot, db.data["conversations"]["c1"], "c1", "seminuevo", "m", {"motivo": "presupuesto"}, db=db) is True
    assert seen == [("005Z", "presupuesto")]
    assert routing.process_situacion_handoff(dict(bot, situationRouting=[route(situacion="seminuevo", destino="lead")]), {"vertical": "servicio"}, "c1", "seminuevo", "", db=db) is False  # sin handler


# ---- en el pipeline ----

def _incoming():
    return Incoming(provider="twilio", from_number="whatsapp:+528186019229", to_number="whatsapp:+5255000001", body="necesito servicio", supports_media=True)


def test_el_bot_nuevo_contesta_el_mismo_mensaje_y_se_descarta_la_respuesta_del_original(db, monkeypatch):
    db.data["conversations"].clear()
    sent, calls = [], []

    def fake_engine(bot, messages, conv_id=None, customer_phone=""):
        calls.append((bot.get("id"), messages[-1]["text"]))
        if bot.get("id") == "bot-ventas":
            return {"success": True, "result": {"response": "Respuesta del bot de ventas",
                                                "toolResults": [{"toolName": "Detectar_Situacion", "input": {"situacion": "servicio_postventa", "motivo": "taller"}}]}}
        return {"success": True, "result": {"response": "Hola, soy el bot de servicio", "toolResults": []}}

    monkeypatch.setattr(engine, "send_to_bot", fake_engine)
    bot = {"id": "bot-ventas", "organizationId": "honda", "teamId": "tv", "type": "chatllm", "name": "Ventas", "provider": "twilio",
           "situationRouting": [route(destino="cambiar_bot", internalBotId="bot-serv")]}
    process_message(_incoming(), bot, lambda b, to, frm, text, media_url=None: sent.append(text), db=db)
    assert [c[0] for c in calls] == ["bot-ventas", "bot-serv"]
    assert calls[1][1].startswith("<<CONTEXTO>> Conversación transferida desde el bot de ventas")
    assert sent == ["Hola, soy el bot de servicio"]  # no la del bot de ventas
    conv = next(iter(db.data["conversations"].values()))
    assert (conv["activeBotId"], conv["vertical"]) == ("bot-serv", "servicio")


def test_situacion_resuelta_responde_con_el_texto_original_y_para(db, monkeypatch):
    db.data["conversations"].clear()
    sent = []
    monkeypatch.setattr(engine, "send_to_bot", lambda bot, m, conv_id=None, customer_phone="": {"success": True, "result": {
        "response": "Te canalizo con servicio", "toolResults": [{"toolName": "Detectar_Situacion", "input": {"situacion": "servicio_postventa"}}]}})
    bot = {"id": "bot-ventas", "organizationId": "honda", "teamId": "tv", "type": "chatllm", "provider": "twilio", "situationRouting": [route(destino="ninguno")]}
    process_message(_incoming(), bot, lambda b, to, frm, text, media_url=None: sent.append(text), db=db)
    assert sent == ["Te canalizo con servicio"]
    assert next(iter(db.data["conversations"].values()))["status"] == "closed"


# ---- contacto programado y detección por mención ----

def test_la_hora_del_recordatorio_se_interpreta_en_la_zona_de_la_organizacion(db):
    assert parse_scheduled_contact_time("2026-10-20T10:00:00", "America/Mexico_City") == datetime(2026, 10, 20, 16, 0, tzinfo=timezone.utc)
    assert parse_scheduled_contact_time("2026-10-20T10:00:00-05:00") == datetime(2026, 10, 20, 15, 0, tzinfo=timezone.utc)  # offset explícito gana
    assert parse_scheduled_contact_time("mañana") is None
    assert org_timezone("honda", db) == "America/Mexico_City" and org_timezone("nadie", db) == "America/Mexico_City"
    db.data["organizations"]["honda"]["settings"]["timezone"] = "America/Bogota"
    assert org_timezone("honda", db) == "America/Bogota"
    assert local_to_utc(datetime(2026, 10, 20, 10, 0), "America/Bogota").hour == 15


def test_agendar_cancelar_y_responder_manejan_el_recontacto(db, monkeypatch):
    db.data["conversations"].clear()
    bot = {"id": "b", "organizationId": "honda", "teamId": "tv", "type": "chatllm", "provider": "twilio"}
    result = {"success": True, "result": {"response": "Listo", "toolResults": [{"toolName": "Agendar_Recordatorio", "input": {"fecha_hora": "2026-10-20T10:00:00"}}]}}
    monkeypatch.setattr(engine, "send_to_bot", lambda b, m, conv_id=None, customer_phone="": result)
    send = lambda b, to, frm, text, media_url=None: None
    process_message(_incoming(), bot, send, db=db)
    cid, conv = next(iter(db.data["conversations"].items()))
    assert conv["scheduledContactAt"] == datetime(2026, 10, 20, 16, 0, tzinfo=timezone.utc)
    # el cliente responde: el recontacto se limpia
    result["result"]["toolResults"] = []
    process_message(_incoming(), bot, send, db=db)
    assert "scheduledContactAt" not in db.data["conversations"][cid]
    # y el bot lo cancela por mención en el texto de un segmento
    db.data["conversations"][cid]["scheduledContactAt"] = datetime.now(timezone.utc)
    db.data["conversations"][cid]["lastCustomerMessageAt"] = datetime.now(timezone.utc)
    del db.data["conversations"][cid]["scheduledContactAt"]
    db.data["conversations"][cid]["scheduledContactAt"] = datetime.now(timezone.utc)
    result["result"].update(toolResults=[], segments=[{"title": None, "segment": "Executing Cancelar_Recordatorio"}])
    process_message(_incoming(), bot, send, db=db)
    assert "scheduledContactAt" not in db.data["conversations"][cid]


def test_deteccion_por_mencion_en_los_cuatro_lugares():
    ok = lambda **r: {"success": True, "result": r}
    assert detect_mention(ok(toolResults=[{"toolName": "T"}]), "T")["triggered"]
    assert detect_mention(ok(segments=[{"title": "Executing T"}]), "T")["triggered"]
    assert detect_mention(ok(segments=[{"title": None, "segment": "Executing T\n"}]), "T")["triggered"]
    assert detect_mention(ok(messages=[{"text": "ya llamé a T"}]), "T")["triggered"]
    assert detect_mention(ok(response="Executing T\n\nHecho"), "T")["triggered"]
    assert detect_mention(ok(response="nada", segments=[{"title": None}]), "T") == {"triggered": False}
    assert detect_mention({"error": "x"}, "T") == {"triggered": False}
