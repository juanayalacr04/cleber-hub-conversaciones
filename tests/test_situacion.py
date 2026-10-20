import json
import urllib.parse
from io import BytesIO

import pytest

import main
from ai import engine
from core import http, outbound, situacion
from crm import salesforce
from tests.fakes import FakeDB

SECRET = "s3cret"
SF = {"instanceUrl": "https://sf.example", "clientId": "c", "clientSecret": "s", "username": "u", "password": "p"}


class FakeHttp:
    """Reemplaza core.http.request: guarda las llamadas y responde según un guion."""

    def __init__(self, *responses):
        self.calls, self._responses = [], list(responses)

    def __call__(self, url, data=None, headers=None, method="POST", timeout=30):
        self.calls.append({"url": url, "data": data, "headers": headers or {}})
        r = self._responses.pop(0) if self._responses else (200, "{}")
        if isinstance(r, Exception):
            raise r
        return r


def http_error(code):
    return http.HTTPError("http://x", code, "err", {}, BytesIO(b"{}"))


@pytest.fixture(autouse=True)
def entorno(monkeypatch):
    from channels import send_handoff_template
    monkeypatch.setenv("SITUACION_API_SECRET", SECRET)
    for var in ("SF_INSTANCE_URL", "SF_CLIENT_ID", "SF_CLIENT_SECRET", "SF_USERNAME", "SF_PASSWORD"):
        monkeypatch.delenv(var, raising=False)
    salesforce.clear_token_cache()
    outbound.configure(send_template=send_handoff_template)
    yield
    outbound.configure()
    main.outbound.configure(send_text=main.send_whatsapp_message, send_template=main.send_handoff_template)


@pytest.fixture
def prime(monkeypatch):
    calls = []
    monkeypatch.setattr(engine, "prime_session", lambda bot, conv_id, message: calls.append((bot, conv_id, message)) or True)
    return calls


@pytest.fixture
def db():
    d = FakeDB()
    d.seed("organizations", "honda", {"name": "Honda", "salesforceConfig": SF})
    d.seed("teams", "servicio", {"organizationId": "honda", "vertical": "servicio"})
    d.seed("bots", "bot-serv", {"organizationId": "honda", "name": "Bot Servicio", "category": "Servicio", "type": "workflow"})
    d.seed("whatsappNumbers", "n-twilio", {
        "organizationId": "honda", "teamId": "servicio", "defaultBotId": "bot-serv", "status": "active", "provider": "twilio",
        "phoneNumber": "whatsapp:+528100000000", "twilioAccountSid": "AC1", "twilioAuthToken": "tok", "serviceHandoffContentSid": "HX1"})
    d.seed("whatsappNumbers", "n-meta", {
        "organizationId": "honda", "teamId": "servicio", "defaultBotId": "bot-serv", "status": "active", "provider": "meta",
        "phoneNumber": "+528100000001", "metaPhoneNumberId": "123", "metaAccessToken": "tk",
        "serviceHandoffTemplateName": "handoff_servicio", "serviceHandoffTemplateLanguage": "es_MX"})
    d.seed("whatsappNumbers", "n-vt", {
        "organizationId": "honda", "teamId": "servicio", "defaultBotId": "bot-serv", "status": "active", "provider": "valuetext",
        "phoneNumber": "+528100000002", "valuetextSenderId": "SENDER", "serviceHandoffTemplateName": "T0999"})
    d.seed("whatsappNumbers", "n-inactivo", {"organizationId": "honda", "status": "inactive", "provider": "twilio", "phoneNumber": "+528100000003"})
    return d


BODY = {"event": "situacion_detectada", "situacion": "queja_servicio", "targetPhone": "whatsapp:+528100000000",
        "phone": "whatsapp:+5218186019229", "customerName": "Laura", "motivo": "Falla en frenos", "leadId": "00Q1",
        "organizationId": "ventas-honda", "sourceConversationId": "conv-ventas-1"}


def post(db, body=None, headers=None, args=None, **kwargs):
    return situacion.handle({"X-Api-Secret": SECRET} if headers is None else headers, args or {}, BODY if body is None else body, db=db, **kwargs)


def sent_form(fake):
    return dict(urllib.parse.parse_qsl(fake.calls[0]["data"].decode()))


# --------------------------------------------------------------------------- autenticación y cuerpo

def test_sin_secreto_valido_es_401_y_no_se_envia_nada(db, monkeypatch):
    fake = FakeHttp()
    monkeypatch.setattr(http, "request", fake)
    for headers, args in (({}, {}), ({"X-Api-Secret": "otro"}, {}), ({}, {"secret": "otro"})):
        assert post(db, headers=headers, args=args)[1] == 401
    assert fake.calls == [] and "conversations" not in db.data


def test_el_secreto_tambien_se_acepta_por_query_por_compatibilidad(db, monkeypatch, prime):
    monkeypatch.setattr(http, "request", FakeHttp((200, '{"sid": "SM1"}')))
    assert post(db, headers={}, args={"secret": SECRET})[1] == 200


def test_sin_secreto_configurado_falla_cerrado(db, monkeypatch):
    monkeypatch.delenv("SITUACION_API_SECRET")
    assert post(db)[1] == 401
    monkeypatch.setenv("ALLOW_UNAUTHENTICATED_INTEGRATIONS", "true")
    monkeypatch.setattr(http, "request", FakeHttp((200, '{"sid": "SM1"}')))
    monkeypatch.setattr(engine, "prime_session", lambda *a: True)
    assert post(db, headers={})[1] == 200


@pytest.mark.parametrize("change", [{"event": "otro"}, {"situacion": None}, {"targetPhone": ""}, {"phone": 5}, {"event": None}])
def test_cuerpo_invalido_es_400(db, change):
    assert post(db, body={**BODY, **change})[1] == 400


def test_cuerpo_que_no_es_objeto_es_400(db):
    assert post(db, body=[1, 2])[1] == 400 and post(db, body="x")[1] == 400


def test_numero_inexistente_o_inactivo_es_404(db, monkeypatch):
    fake = FakeHttp()
    monkeypatch.setattr(http, "request", fake)
    assert post(db, body={**BODY, "targetPhone": "+520000"})[1] == 404
    body, status = post(db, body={**BODY, "targetPhone": "+528100000003"})   # existe pero inactivo
    assert status == 404 and body == {"error": "targetPhone not configured"} and fake.calls == []


# --------------------------------------------------------------------------- envío por proveedor

def test_twilio_manda_el_content_template_con_nombre_y_motivo(db, monkeypatch, prime):
    fake = FakeHttp((200, '{"sid": "SM1"}'))
    monkeypatch.setattr(http, "request", fake)
    assert post(db)[1] == 200
    assert fake.calls[0]["url"] == "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json"
    form = sent_form(fake)
    assert (form["To"], form["From"], form["ContentSid"]) == ("whatsapp:+528186019229", "whatsapp:+528100000000", "HX1")
    assert json.loads(form["ContentVariables"]) == {"1": "Laura", "2": "Falla en frenos"}


def test_el_numero_del_cliente_se_normaliza_a_52_mas_diez_digitos(db, monkeypatch, prime):
    fake = FakeHttp((200, '{"sid": "SM1"}'))
    monkeypatch.setattr(http, "request", fake)
    for raw, expected in (("whatsapp:+5218186019229", "+528186019229"), ("8186019229", "+528186019229"), ("+528186019229", "+528186019229"),
                          ("+14155551234", "+14155551234")):
        assert situacion.normalize_phone(raw) == expected
    post(db, body={**BODY, "phone": "8186019229"})
    assert sent_form(fake)["To"] == "whatsapp:+528186019229"


def test_meta_manda_la_plantilla_con_las_variables_en_orden(db, monkeypatch, prime):
    fake = FakeHttp((200, '{"messages": [{"id": "wamid.1"}]}'))
    monkeypatch.setattr(http, "request", fake)
    assert post(db, body={**BODY, "targetPhone": "+528100000001"})[1] == 200
    assert fake.calls[0]["url"] == "https://graph.facebook.com/v21.0/123/messages"
    payload = json.loads(fake.calls[0]["data"])
    assert payload["to"] == "528186019229" and payload["type"] == "template"
    assert payload["template"] == {"name": "handoff_servicio", "language": {"code": "es_MX"},
                                   "components": [{"type": "body", "parameters": [{"type": "text", "text": "Laura"}, {"type": "text", "text": "Falla en frenos"}]}]}


def test_valuetext_inserta_el_sms_bucket_con_la_plantilla_y_el_lead(db, monkeypatch, prime):
    fake = FakeHttp((200, json.dumps({"access_token": "T"})), (201, '{"id": "a0X"}'))
    monkeypatch.setattr(http, "request", fake)
    assert post(db, body={**BODY, "targetPhone": "+528100000002"})[1] == 200
    record = json.loads(fake.calls[1]["data"])
    assert record == {"rsplus__Number__c": "8186019229", "rsplus__Sender_ID__c": "SENDER", "rsplus__Template_ID__c": "T0999",
                      "rsplus__Related_To__c": "00Q1", "Origen__c": "Plataforma IA"}


@pytest.mark.parametrize("seed, target", [
    ({"n-twilio": {"serviceHandoffContentSid": ""}}, "+528100000000"),
    ({"n-meta": {"serviceHandoffTemplateName": ""}}, "+528100000001"),
    ({"n-vt": {"serviceHandoffTemplateName": ""}}, "+528100000002"),
])
def test_plantilla_sin_configurar_es_500_sin_llamar_al_proveedor(db, monkeypatch, seed, target):
    for doc_id, change in seed.items():
        db.data["whatsappNumbers"][doc_id].update(change)
    fake = FakeHttp()
    monkeypatch.setattr(http, "request", fake)
    body, status = post(db, body={**BODY, "targetPhone": target})
    assert status == 500 and "not configured" in body["error"] and fake.calls == [] and "conversations" not in db.data


@pytest.mark.parametrize("target, script", [
    ("+528100000000", [http_error(400)]),
    ("+528100000001", [http_error(500)]),
    ("+528100000002", [(200, json.dumps({"access_token": "T"})), http_error(400)]),
])
def test_si_el_proveedor_no_acepta_es_502_y_no_se_crea_la_conversacion(db, monkeypatch, target, script):
    monkeypatch.setattr(http, "request", FakeHttp(*script))
    body, status = post(db, body={**BODY, "targetPhone": target})
    assert status == 502 and body == {"error": "Failed to send WhatsApp template"} and "conversations" not in db.data


# --------------------------------------------------------------------------- conversación

def test_crea_una_conversacion_saliente_con_plantilla_contexto_y_origen(db, monkeypatch, prime):
    monkeypatch.setattr(http, "request", FakeHttp((200, '{"sid": "SM1"}')))
    body, status = post(db)
    assert status == 200 and body["success"]
    conv = db.data["conversations"][body["conversationId"]]
    assert (conv["customerPhone"], conv["organizationId"], conv["teamId"], conv["vertical"]) == ("whatsapp:+528186019229", "honda", "servicio", "servicio")
    assert (conv["status"], conv["direction"], conv["botId"], conv["whatsappNumberId"], conv["botName"]) == ("bot", "outbound", "bot-serv", "n-twilio", "Bot Servicio")
    assert conv["tags"] == ["situacion_detectada"] and conv["source"] == "situacion_detectada" and conv["customerName"] == "Laura"
    assert (conv["sourceLeadId"], conv["sourceOrganizationId"], conv["sourceConversationId"]) == ("00Q1", "ventas-honda", "conv-ventas-1")
    assert conv["lastMessageSender"] == "bot" and conv["lastTemplateSentAt"] is not None and conv["customerId"] == "honda_528186019229"
    texts = sorted(m["text"] for m in db.data[f"conversations/{body['conversationId']}/messages"].values())
    assert texts == ["<<CONTEXTO>> NOMBRE: Laura, MOTIVO: Falla en frenos", "<<PLANTILLA>> HX1"]
    assert conv["lastMessagePreview"] == "<<PLANTILLA>> HX1"


def test_reusa_la_conversacion_abierta_y_no_crea_otra(db, monkeypatch, prime):
    monkeypatch.setattr(http, "request", FakeHttp((200, '{"sid": "SM1"}')))
    db.seed("conversations", "c-cerrada", {"customerPhone": "whatsapp:+528186019229", "organizationId": "honda", "status": "closed", "lastMessageAt": 3})
    db.seed("conversations", "c-abierta", {"customerPhone": "whatsapp:+528186019229", "organizationId": "honda", "status": "with_agent",
                                           "lastMessageAt": 2, "tags": ["vip"]})
    db.seed("conversations", "c-otra-marca", {"customerPhone": "whatsapp:+528186019229", "organizationId": "kia", "status": "bot", "lastMessageAt": 9})
    body, _ = post(db)
    assert body["conversationId"] == "c-abierta" and len(db.data["conversations"]) == 3
    c = db.data["conversations"]["c-abierta"]
    assert c["tags"] == ["vip", "situacion_detectada"] and c["status"] == "with_agent" and c["sourceLeadId"] == "00Q1"
    assert len(db.data["conversations/c-abierta/messages"]) == 2


def test_con_la_conversacion_mas_reciente_abierta_gana_esa(db, monkeypatch, prime):
    monkeypatch.setattr(http, "request", FakeHttp((200, '{"sid": "SM1"}')))
    for cid, ts in (("c1", 1), ("c2", 5)):
        db.seed("conversations", cid, {"customerPhone": "whatsapp:+528186019229", "organizationId": "honda", "status": "bot", "lastMessageAt": ts})
    assert post(db)[0]["conversationId"] == "c2"


def test_valores_por_omision_cuando_faltan_nombre_y_motivo(db, monkeypatch, prime):
    fake = FakeHttp((200, '{"sid": "SM1"}'))
    monkeypatch.setattr(http, "request", fake)
    minimal = {k: BODY[k] for k in ("event", "situacion", "targetPhone", "phone")}
    body, _ = post(db, body=minimal)
    assert json.loads(sent_form(fake)["ContentVariables"]) == {"1": "Cliente", "2": ""}
    texts = [m["text"] for m in db.data[f"conversations/{body['conversationId']}/messages"].values()]
    assert "<<CONTEXTO>> NOMBRE: Cliente, MOTIVO: queja_servicio" in texts   # sin motivo, el contexto usa la situación
    assert db.data["conversations"][body["conversationId"]]["customerName"] is None


# --------------------------------------------------------------------------- bot

def test_le_cuenta_plantilla_y_contexto_a_la_sesion_del_bot(db, monkeypatch, prime):
    monkeypatch.setattr(http, "request", FakeHttp((200, '{"sid": "SM1"}')))
    body, _ = post(db)
    (bot, conv_id, message), = prime
    assert bot["id"] == "bot-serv" and conv_id == body["conversationId"]
    assert message == "<<PLANTILLA>> HX1\n<<CONTEXTO>> NOMBRE: Laura, MOTIVO: Falla en frenos"


def test_numero_sin_bot_no_prepara_sesion(db, monkeypatch, prime):
    db.data["whatsappNumbers"]["n-twilio"].pop("defaultBotId")
    monkeypatch.setattr(http, "request", FakeHttp((200, '{"sid": "SM1"}')))
    body, status = post(db)
    assert status == 200 and prime == [] and db.data["conversations"][body["conversationId"]]["botId"] is None


def test_prime_session_de_workflow_y_chatllm_sin_ejecutar_herramientas(monkeypatch):
    fake = FakeHttp((200, json.dumps({"result": {"proxyEndpoint": "https://proxy.example"}})), (200, '{"result": {}}'))
    monkeypatch.setattr(http, "request", fake)
    engine.clear_caches()
    wf = {"type": "workflow", "abacusConfig": {"deploymentId": "D", "deploymentToken": "T", "apiKey": "K"}}
    assert engine.prime_session(wf, "conv-1", "hola") is True
    payload = json.loads(fake.calls[1]["data"])
    assert payload == {"keywordArguments": {"message": "hola"}, "externalSessionId": "conv-1"}
    assert fake.calls[1]["headers"]["APIKEY"] == "K"

    fake = FakeHttp((200, '{"result": {}}'))
    monkeypatch.setattr(http, "request", fake)
    chat = {"type": "chatllm", "abacusConfig": {"deploymentId": "D", "deploymentToken": "T"}}
    assert engine.prime_session(chat, "conv-2", "hola") is True
    payload = json.loads(fake.calls[0]["data"])
    assert payload["externalSessionId"] == "conv-2" and payload["message"] == "hola" and "executeUsercodeTools" not in payload


def test_prime_session_ignora_bots_externos_y_no_lanza(monkeypatch):
    fake = FakeHttp(http_error(500))
    monkeypatch.setattr(http, "request", fake)
    assert engine.prime_session({"type": "external"}, "c", "x") is False and fake.calls == []
    assert engine.prime_session({"type": "chatllm", "abacusConfig": {}}, "c", "x") is False


# --------------------------------------------------------------------------- entry point

def test_entry_point_metodo_y_errores(monkeypatch):
    class Req:
        def __init__(self, method, headers=None, body=None, args=None):
            self.method, self.headers, self._body, self.args = method, headers or {}, body, args or {}

        def get_json(self, silent=False):
            return self._body

    assert main.situacion_detectada(Req("GET"))[1] == 405
    body, status, _ = main.situacion_detectada(Req("POST", {}, BODY))
    assert status == 401 and json.loads(body) == {"error": "Unauthorized"}

    def explota(*a, **k):
        raise RuntimeError("detalle")
    monkeypatch.setattr(situacion, "handle", explota)
    body, status, _ = main.situacion_detectada(Req("POST", {"X-Api-Secret": SECRET}, BODY))
    assert status == 500 and "detalle" not in body
