import json

import pytest

import main
from ai import engine
from channels import inbound, webhooks
from core import numbers as nb
from tests.fakes import FakeDB


class Recorder:
    """`run` síncrono que registra (función, args) en vez de ejecutar el trabajo."""

    def __init__(self):
        self.calls = []

    def __call__(self, fn, *args):
        self.calls.append((fn.__name__, args))


def soap(**fields):
    body = "".join(f"<sf:{k}>{v}</sf:{k}>" for k, v in fields.items())
    return ('<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>'
            '<notifications xmlns="http://soap.sforce.com/2005/09/outbound"><Notification>'
            f'<sObject xmlns:sf="urn:sobject.enterprise.soap.sforce.com">{body}</sObject>'
            "</Notification></notifications></soapenv:Body></soapenv:Envelope>")


@pytest.fixture
def db():
    return FakeDB()


# ---- Twilio ----

def test_twilio_mensaje_entrante():
    r = Recorder()
    assert webhooks.handle_twilio({"From": "whatsapp:+52A", "To": "whatsapp:+52B", "Body": " hola ", "ProfileName": " Ana "}, r) == ("", 200)
    assert r.calls == [("process_twilio_message", ("whatsapp:+52A", "whatsapp:+52B", "hola", "Ana"))]


def test_twilio_estado_no_se_procesa_como_mensaje():
    r = Recorder()
    webhooks.handle_twilio({"MessageStatus": "delivered", "MessageSid": "SM1", "ErrorMessage": ""}, r)
    assert r.calls == [("process_twilio_status", ("SM1", "delivered", ""))]


def test_twilio_sin_from_o_body_se_ignora():
    r = Recorder()
    webhooks.handle_twilio({"From": "whatsapp:+52A", "Body": "  "}, r)
    webhooks.handle_twilio({"Body": "hola"}, r)
    assert r.calls == []


# ---- ValueText ----

def test_valuetext_entrante_normaliza_telefonos_y_manda_la_fuente(db):
    r = Recorder()
    xml = soap(Id="a01", rsplus__Number__c="528186019229", rsplus__Sender_ID__c="5255000001", rsplus__Message__c="Hola",
               rsplus__Type__c="Inbound", rsplus__WA_Profile_Name__c="Ana", Last_Msg_Source__c="salesforce")
    body, status, headers = webhooks.handle_valuetext(xml, r, db=db)
    assert status == 200 and "<Ack>true</Ack>" in body and headers == {"Content-Type": "text/xml"}
    assert r.calls == [("process_valuetext_message", ("whatsapp:+528186019229", "whatsapp:+5255000001", "Hola", "Ana", "salesforce"))]


def test_valuetext_duplicado_se_ignora(db):
    r = Recorder()
    xml = soap(Id="a01", rsplus__Number__c="52818", rsplus__Message__c="Hola", rsplus__Type__c="Inbound")
    webhooks.handle_valuetext(xml, r, db=db)
    webhooks.handle_valuetext(xml, r, db=db)
    assert len(r.calls) == 1


def test_valuetext_outbound_del_bot_se_ignora_y_el_de_agente_o_template_se_guarda(db):
    r = Recorder()
    webhooks.handle_valuetext(soap(Id="1", rsplus__Number__c="5281", rsplus__Sender_ID__c="5255", rsplus__Message__c="del bot", rsplus__Type__c="Outbound", Origen__c="Plataforma IA"), r, db=db)
    webhooks.handle_valuetext(soap(Id="2", rsplus__Number__c="5281", rsplus__Sender_ID__c="5255", rsplus__Message__c="del asesor", rsplus__Type__c="Outbound",
                                   rsplus__Media_Json__c=json.dumps([{"url": "http://f"}]).replace("&", "&amp;")), r, db=db)
    webhooks.handle_valuetext(soap(Id="3", rsplus__Number__c="5281", rsplus__Sender_ID__c="5255", rsplus__Message__c="recordatorio", rsplus__Type__c="Outbound", rsplus__Template_ID__c="T1"), r, db=db)
    assert r.calls == [
        ("save_agent_outbound", ("whatsapp:+5281", "whatsapp:+5255", "del asesor", "http://f")),
        ("save_template_outbound", ("whatsapp:+5281", "whatsapp:+5255", "recordatorio")),
    ]


def test_valuetext_sin_numero_ni_mensaje_o_xml_invalido(db):
    r = Recorder()
    webhooks.handle_valuetext(soap(Id="1", rsplus__Message__c="x"), r, db=db)
    webhooks.handle_valuetext(soap(Id="2", rsplus__Number__c="52", rsplus__Message__c=""), r, db=db)
    assert webhooks.handle_valuetext("no es xml", r, db=db)[1] == 200 and r.calls == []


# ---- Meta ----

def meta_payload(messages=None, statuses=None, name="Ana"):
    return {"entry": [{"changes": [{"value": {
        "metadata": {"phone_number_id": "123"}, "contacts": [{"profile": {"name": name}}],
        "messages": messages or [], "statuses": statuses or []}}]}]}


def test_meta_mensaje_de_texto_y_estado():
    r = Recorder()
    payload = meta_payload(
        [{"type": "text", "from": "5218186019229", "text": {"body": " hola "}}, {"type": "image", "from": "52"}, {"type": "text", "from": "52", "text": {"body": " "}}],
        [{"id": "wamid.1", "status": "delivered"}],
    )
    assert webhooks.handle_meta(payload, r) == ("OK", 200)
    assert r.calls == [
        ("process_meta_status", ({"id": "wamid.1", "status": "delivered"},)),
        ("process_meta_message", ("whatsapp:+528186019229", "123", "hola", "Ana")),  # +521 legacy -> +52
    ]


def test_meta_cuerpo_vacio_o_malformado_responde_ok():
    r = Recorder()
    assert webhooks.handle_meta(None, r) == ("OK", 200)
    assert webhooks.handle_meta({"entry": [{"changes": "mal"}]}, r) == ("OK", 200) and r.calls == []


def test_meta_verificacion_del_webhook(db):
    db.seed("whatsappNumbers", "n1", {"provider": "meta", "metaWebhookVerifyToken": "secreto", "status": "active"})
    db.seed("whatsappNumbers", "n2", {"provider": "meta", "metaWebhookVerifyToken": "pausado", "status": "paused"})
    ok = {"hub.mode": "subscribe", "hub.verify_token": "secreto", "hub.challenge": "abc"}
    assert webhooks.handle_meta_verification(ok, db=db) == ("abc", 200)
    assert webhooks.handle_meta_verification(dict(ok, **{"hub.verify_token": "otro"}), db=db) == ("Forbidden", 403)
    assert webhooks.handle_meta_verification(dict(ok, **{"hub.verify_token": "pausado"}), db=db) == ("Forbidden", 403)
    assert webhooks.handle_meta_verification({"hub.mode": "otro"}, db=db) == ("Bad Request", 400)


# ---- de extremo a extremo: webhook -> pipeline -> respuesta ----

def test_mensaje_de_twilio_recorre_todo_el_camino(db, monkeypatch):
    nb.clear_bot_cache()
    db.seed("organizations", "honda", {"name": "Honda"})
    db.seed("whatsappNumbers", "n1", {"organizationId": "honda", "status": "active", "phoneNumber": "whatsapp:+5255000001",
                                      "defaultBotId": "bot1", "provider": "twilio", "twilioAccountSid": "AC", "twilioAuthToken": "t"})
    db.seed("bots", "bot1", {"organizationId": "honda", "name": "Bot", "type": "chatllm"})
    sent = []
    monkeypatch.setattr(engine, "send_to_bot", lambda bot, msgs, conv_id=None, customer_phone="": {"success": True, "result": {"response": "¡Hola!", "toolResults": []}})
    monkeypatch.setattr(inbound, "send_whatsapp_message", lambda bot, to, from_, text, media_url=None: sent.append((to, from_, text)))
    original = inbound.process_twilio_message
    webhooks.handle_twilio({"From": "whatsapp:+5218186019229", "To": "whatsapp:+5255000001", "Body": "hola"},
                           lambda fn, *a: original(*a, db=db) if fn is original else fn(*a))
    assert sent == [("whatsapp:+528186019229", "whatsapp:+5255000001", "¡Hola!")]
    assert next(iter(db.data["conversations"].values()))["customerPhone"] == "whatsapp:+528186019229"


# ---- entry points de las funciones ----

class FakeRequest:
    def __init__(self, method="POST", form=None, args=None, data="", json_body=None):
        self.method, self.form, self.args, self._data, self._json = method, form or {}, args or {}, data, json_body

    def get_data(self, as_text=False):
        return self._data

    def get_json(self, silent=False):
        return self._json


def test_entry_points_responden_a_get_sin_procesar():
    assert main.whatsapp_webhook(FakeRequest("GET")) == ("OK", 200)
    assert main.valuetext_webhook(FakeRequest("GET")) == ("OK", 200)
    assert main.meta_webhook(FakeRequest("PUT")) == ("OK", 200)
    assert main.health(FakeRequest("GET"))[1] == 200
