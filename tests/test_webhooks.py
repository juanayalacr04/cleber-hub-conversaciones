import json

import pytest

import main
from ai import engine
from channels import event_queue, inbound, ingest, webhooks
from core import numbers as nb
from tests.fakes import FakeDB


class Queue(list):
    """`publish` que guarda los eventos. Con `fail=True` simula una cola caída."""

    def __init__(self, fail=False):
        super().__init__()
        self.fail = fail

    def __call__(self, event):
        if self.fail:
            raise RuntimeError("pubsub caído")
        self.append(event)


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

def test_twilio_mensaje_entrante(db):
    q = Queue()
    form = {"From": "whatsapp:+5218186019229", "To": "whatsapp:+52B", "Body": " hola ", "ProfileName": " Ana ", "MessageSid": "SM1"}
    assert webhooks.handle_twilio(form, q, db=db) == ("", 200)
    (event,) = q
    m = event.message
    assert event.kind == "message" and (m.provider, m.message_id, m.from_number, m.to_number, m.body, m.contact_name) == \
        ("twilio", "SM1", "whatsapp:+528186019229", "whatsapp:+52B", "hola", "Ana")    # el +521 legacy llega normalizado
    assert m.supports_media and m.received_at


def test_twilio_estado_viaja_como_estado_no_como_mensaje():
    q = Queue()
    webhooks.handle_twilio({"MessageStatus": "delivered", "MessageSid": "SM1", "ErrorMessage": "x"}, q)
    (event,) = q
    assert event.kind == "status" and (event.status.provider, event.status.provider_message_id, event.status.status, event.status.error) == \
        ("twilio", "SM1", "delivered", "x")


def test_twilio_sin_from_o_body_se_ignora():
    q = Queue()
    webhooks.handle_twilio({"From": "whatsapp:+52A", "Body": "  "}, q)
    webhooks.handle_twilio({"Body": "hola"}, q)
    webhooks.handle_twilio({"MessageStatus": "sent"}, q)        # un estado sin SID no se puede correlacionar
    assert q == []


def test_twilio_duplicado_por_message_sid_se_ignora(db):
    q = Queue()
    form = {"From": "whatsapp:+52A", "To": "whatsapp:+52B", "Body": "hola", "MessageSid": "SM1"}
    webhooks.handle_twilio(form, q, db=db)
    webhooks.handle_twilio(form, q, db=db)
    webhooks.handle_twilio({**form, "MessageSid": "SM2"}, q, db=db)
    assert [e.message.message_id for e in q] == ["SM1", "SM2"]


def test_los_estados_de_twilio_con_el_mismo_sid_no_se_deduplican(db):
    q = Queue()
    for status in ("sent", "delivered", "read"):
        webhooks.handle_twilio({"MessageSid": "SM1", "MessageStatus": status}, q, db=db)
    assert [e.status.status for e in q] == ["sent", "delivered", "read"]


def test_si_la_cola_falla_responde_500_y_el_reintento_si_pasa(db):
    form = {"From": "whatsapp:+52A", "To": "whatsapp:+52B", "Body": "hola", "MessageSid": "SM1"}
    assert webhooks.handle_twilio(form, Queue(fail=True), db=db) == ("", 500)
    q = Queue()
    assert webhooks.handle_twilio(form, q, db=db) == ("", 200) and len(q) == 1      # la marca de duplicado se soltó


# ---- ValueText ----

def test_valuetext_entrante_normaliza_telefonos_y_manda_la_fuente(db):
    q = Queue()
    xml = soap(Id="a01", rsplus__Number__c="528186019229", rsplus__Sender_ID__c="5255000001", rsplus__Message__c="Hola",
               rsplus__Type__c="Inbound", rsplus__WA_Profile_Name__c="Ana", Last_Msg_Source__c="salesforce")
    body, status, headers = webhooks.handle_valuetext(xml, q, db=db)
    assert status == 200 and "<Ack>true</Ack>" in body and headers == {"Content-Type": "text/xml"}
    m = q[0].message
    assert (m.provider, m.message_id, m.from_number, m.to_number, m.body, m.contact_name, m.from_agent_system) == \
        ("valuetext", "a01", "whatsapp:+528186019229", "whatsapp:+5255000001", "Hola", "Ana", True)
    assert not m.supports_media


def test_valuetext_duplicado_se_ignora(db):
    q = Queue()
    xml = soap(Id="a01", rsplus__Number__c="52818", rsplus__Message__c="Hola", rsplus__Type__c="Inbound")
    webhooks.handle_valuetext(xml, q, db=db)
    webhooks.handle_valuetext(xml, q, db=db)
    assert len(q) == 1


def test_valuetext_outbound_del_bot_se_ignora_y_el_de_agente_o_template_viaja_como_eco(db):
    q = Queue()
    webhooks.handle_valuetext(soap(Id="1", rsplus__Number__c="5281", rsplus__Sender_ID__c="5255", rsplus__Message__c="del bot", rsplus__Type__c="Outbound", Origen__c="Plataforma IA"), q, db=db)
    webhooks.handle_valuetext(soap(Id="2", rsplus__Number__c="5281", rsplus__Sender_ID__c="5255", rsplus__Message__c="del asesor", rsplus__Type__c="Outbound",
                                   rsplus__Media_Json__c=json.dumps([{"url": "http://f"}]).replace("&", "&amp;")), q, db=db)
    webhooks.handle_valuetext(soap(Id="3", rsplus__Number__c="5281", rsplus__Sender_ID__c="5255", rsplus__Message__c="recordatorio", rsplus__Type__c="Outbound", rsplus__Template_ID__c="T1"), q, db=db)
    assert [(e.kind, e.outbound.body, e.outbound.media_url, e.outbound.is_template, e.outbound.source_id, e.outbound.to_number, e.outbound.from_number) for e in q] == [
        ("outbound", "del asesor", "http://f", False, "2", "whatsapp:+5281", "whatsapp:+5255"),
        ("outbound", "recordatorio", None, True, "3", "whatsapp:+5281", "whatsapp:+5255"),
    ]


def test_valuetext_sin_numero_ni_mensaje_o_xml_invalido(db):
    q = Queue()
    webhooks.handle_valuetext(soap(Id="1", rsplus__Message__c="x"), q, db=db)
    webhooks.handle_valuetext(soap(Id="2", rsplus__Number__c="52", rsplus__Message__c=""), q, db=db)
    assert webhooks.handle_valuetext("no es xml", q, db=db)[1] == 200 and q == []


def test_valuetext_con_la_cola_caida_no_da_ack_y_el_reintento_publica_todo(db):
    xml = soap(Id="a01", rsplus__Number__c="52818", rsplus__Message__c="Hola", rsplus__Type__c="Inbound")
    body, status, _ = webhooks.handle_valuetext(xml, Queue(fail=True), db=db)
    assert status == 500 and "<Ack>" not in body
    q = Queue()
    assert webhooks.handle_valuetext(xml, q, db=db)[1] == 200 and len(q) == 1


# ---- Meta ----

def meta_payload(messages=None, statuses=None, name="Ana"):
    return {"entry": [{"changes": [{"value": {
        "metadata": {"phone_number_id": "123"}, "contacts": [{"profile": {"name": name}}],
        "messages": messages or [], "statuses": statuses or []}}]}]}


def test_meta_mensaje_de_texto_y_estado(db):
    q = Queue()
    payload = meta_payload(
        [{"id": "wamid.2", "type": "text", "from": "5218186019229", "text": {"body": " hola "}}, {"type": "image", "from": "52"},
         {"type": "text", "from": "52", "text": {"body": " "}}],
        [{"id": "wamid.1", "status": "delivered"}],
    )
    assert webhooks.handle_meta(payload, q, db=db) == ("OK", 200)
    status, message = q
    assert (status.kind, status.status.provider, status.status.provider_message_id, status.status.status) == ("status", "meta", "wamid.1", "delivered")
    m = message.message
    assert (m.provider, m.message_id, m.from_number, m.to_number, m.phone_number_id, m.body, m.contact_name) == \
        ("meta", "wamid.2", "whatsapp:+528186019229", "", "123", "hola", "Ana")        # +521 legacy -> +52


def test_meta_duplicado_por_id_se_ignora(db):
    q = Queue()
    payload = meta_payload([{"id": "wamid.1", "type": "text", "from": "528186019229", "text": {"body": "Hola"}}])
    webhooks.handle_meta(payload, q, db=db)
    webhooks.handle_meta(payload, q, db=db)
    assert len(q) == 1


def test_meta_con_la_cola_caida_responde_500_para_que_meta_reintente(db):
    payload = meta_payload([{"id": "wamid.1", "type": "text", "from": "528186019229", "text": {"body": "Hola"}}])
    assert webhooks.handle_meta(payload, Queue(fail=True), db=db)[1] == 500
    q = Queue()
    assert webhooks.handle_meta(payload, q, db=db) == ("OK", 200) and len(q) == 1


def test_meta_cuerpo_vacio_o_malformado_responde_ok():
    q = Queue()
    assert webhooks.handle_meta(None, q) == ("OK", 200)
    assert webhooks.handle_meta({"entry": [{"changes": "mal"}]}, q) == ("OK", 200) and q == []


def test_meta_verificacion_del_webhook(db):
    db.seed("whatsappNumbers", "n1", {"provider": "meta", "metaWebhookVerifyToken": "secreto", "status": "active"})
    db.seed("whatsappNumbers", "n2", {"provider": "meta", "metaWebhookVerifyToken": "pausado", "status": "paused"})
    ok = {"hub.mode": "subscribe", "hub.verify_token": "secreto", "hub.challenge": "abc"}
    assert webhooks.handle_meta_verification(ok, db=db) == ("abc", 200)
    assert webhooks.handle_meta_verification(dict(ok, **{"hub.verify_token": "otro"}), db=db) == ("Forbidden", 403)
    assert webhooks.handle_meta_verification(dict(ok, **{"hub.verify_token": "pausado"}), db=db) == ("Forbidden", 403)
    assert webhooks.handle_meta_verification({"hub.mode": "otro"}, db=db) == ("Bad Request", 400)


# ---- de extremo a extremo: webhook -> cola -> consumidor -> pipeline -> respuesta ----

def test_mensaje_de_twilio_recorre_todo_el_camino(db, monkeypatch):
    nb.clear_bot_cache()
    db.seed("organizations", "honda", {"name": "Honda"})
    db.seed("whatsappNumbers", "n1", {"organizationId": "honda", "status": "active", "phoneNumber": "whatsapp:+5255000001",
                                      "defaultBotId": "bot1", "provider": "twilio", "twilioAccountSid": "AC", "twilioAuthToken": "t"})
    db.seed("bots", "bot1", {"organizationId": "honda", "name": "Bot", "type": "chatllm"})
    sent = []
    monkeypatch.setattr(engine, "send_to_bot", lambda bot, msgs, conv_id=None, customer_phone="": {"success": True, "result": {"response": "¡Hola!", "toolResults": []}})
    monkeypatch.setattr(inbound, "send_whatsapp_message", lambda bot, to, from_, text, media_url=None: sent.append((to, from_, text)))
    q = Queue()
    webhooks.handle_twilio({"From": "whatsapp:+5218186019229", "To": "whatsapp:+5255000001", "Body": "hola", "MessageSid": "SM9"}, q, db=db)
    assert sent == []                                                         # el router solo publicó
    assert ingest.process_event(q[0], db) is True
    assert sent == [("whatsapp:+528186019229", "whatsapp:+5255000001", "¡Hola!")]
    assert next(iter(db.data["conversations"].values()))["customerPhone"] == "whatsapp:+528186019229"


# ---- entry points de las funciones ----

class FakeRequest:
    def __init__(self, method="POST", form=None, args=None, data="", json_body=None, path="/"):
        self.path = path
        self.method, self.form, self.args, self._data, self._json = method, form or {}, args or {}, data, json_body

    def get_data(self, as_text=False):
        return self._data

    def get_json(self, silent=False):
        return self._json


def test_entry_points_responden_a_get_sin_procesar():
    assert main.router(FakeRequest("GET", path="/webhook/twilio")) == ("OK", 200)
    assert main.router(FakeRequest("GET", path="/webhook/valuetext")) == ("OK", 200)
    assert main.router(FakeRequest("PUT", path="/webhook/meta")) == ("OK", 200)
    assert main.health(FakeRequest("GET"))[1] == 200


# ---- función 1: una sola función con las tres rutas ----

def test_ruta_desconocida_responde_404_sin_procesar(monkeypatch):
    q = Queue()
    monkeypatch.setattr(event_queue, "_publisher", type("P", (), {"publish": lambda self, e: q(e)})())
    for path in ("/", "/webhook", "/webhook/otro", "/webhook/twilio/extra"):
        assert main.router(FakeRequest("POST", path=path, form={"From": "a", "Body": "hola"})) == ("Not Found", 404)
    assert q == []


def test_el_router_tolera_barra_final_y_prefijo_de_la_funcion():
    assert main.router(FakeRequest("GET", path="/webhook/twilio/")) == ("OK", 200)
    assert main.router(FakeRequest("GET", path="/router/webhook/valuetext")) == ("OK", 200)
