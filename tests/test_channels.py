import json
import urllib.parse
from io import BytesIO

import pytest

from channels import send_whatsapp_message, twilio_wa
from channels.valuetext_wa import parse_salesforce_outbound_message, send_valuetext_message
from core import http
from crm import salesforce


class FakeHttp:
    """Reemplaza core.http.request: guarda las llamadas y responde según un guion."""

    def __init__(self, *responses):
        self.calls, self._responses = [], list(responses)

    def __call__(self, url, data=None, headers=None, method="POST", timeout=30):
        self.calls.append({"url": url, "data": data, "headers": headers or {}, "timeout": timeout})
        r = self._responses.pop(0) if self._responses else (200, "{}")
        if isinstance(r, Exception):
            raise r
        return r


def _http_error(code):
    return http.HTTPError("http://x", code, "err", {}, BytesIO(b'{"error":"x"}'))


@pytest.fixture(autouse=True)
def _limpio(monkeypatch):
    salesforce.clear_token_cache()
    monkeypatch.setattr(twilio_wa, "_sleep", lambda s: None)


def _patch(monkeypatch, fake):
    monkeypatch.setattr(http, "request", fake)
    return fake


TWILIO_BOT = {"provider": "twilio", "twilioConfig": {"accountSid": "AC1", "authToken": "tok"}}
SF = {"instanceUrl": "https://sf.example", "clientId": "c", "clientSecret": "s", "username": "u", "password": "p"}
VT_BOT = {"provider": "valuetext", "salesforceConfig": SF, "valuetextSenderId": "SENDER"}
META_BOT = {"provider": "meta", "metaPhoneNumberId": "123", "metaAccessToken": "tk"}


# ---- Twilio ----

def test_twilio_envia_form_con_basic_auth_y_media(monkeypatch):
    fake = _patch(monkeypatch, FakeHttp((201, json.dumps({"sid": "SM1"}))))
    assert send_whatsapp_message(TWILIO_BOT, "whatsapp:+52A", "whatsapp:+52B", "hola", media_url="http://img") == "SM1"
    call = fake.calls[0]
    assert call["url"].endswith("/Accounts/AC1/Messages.json") and call["headers"]["Authorization"].startswith("Basic ")
    form = urllib.parse.parse_qs(call["data"].decode())
    assert form == {"To": ["whatsapp:+52A"], "From": ["whatsapp:+52B"], "Body": ["hola"], "MediaUrl": ["http://img"]}


def test_twilio_reintenta_y_se_rinde_tras_tres_intentos(monkeypatch):
    fake = _patch(monkeypatch, FakeHttp(OSError("socket muerto"), (201, json.dumps({"sid": "SM2"}))))
    assert twilio_wa.send_twilio_message(TWILIO_BOT, "a", "b", "x") == "SM2"
    assert len(fake.calls) == 2
    fake = _patch(monkeypatch, FakeHttp(OSError("1"), OSError("2"), OSError("3")))
    assert twilio_wa.send_twilio_message(TWILIO_BOT, "a", "b", "x") is None
    assert len(fake.calls) == 3


# ---- Meta ----

def test_meta_envia_json_sin_prefijos(monkeypatch):
    fake = _patch(monkeypatch, FakeHttp((200, json.dumps({"messages": [{"id": "wamid.1"}]}))))
    assert send_whatsapp_message(META_BOT, "whatsapp:+528186019229", "ignorado", "hola") == "wamid.1"
    call = fake.calls[0]
    assert call["url"] == "https://graph.facebook.com/v21.0/123/messages" and call["headers"]["Authorization"] == "Bearer tk"
    assert json.loads(call["data"])["to"] == "528186019229"


def test_meta_sin_credenciales_o_con_error_http_devuelve_none(monkeypatch):
    fake = _patch(monkeypatch, FakeHttp())
    assert send_whatsapp_message({"provider": "meta"}, "+52", "x", "hola") is None and fake.calls == []
    _patch(monkeypatch, FakeHttp(_http_error(400)))
    assert send_whatsapp_message(META_BOT, "+52", "x", "hola") is None


# ---- ValueText / Salesforce ----

def test_valuetext_inserta_sms_bucket_con_marca_de_origen(monkeypatch):
    fake = _patch(monkeypatch, FakeHttp((200, json.dumps({"access_token": "T1"})), (201, '{"id":"a0X"}')))
    assert send_whatsapp_message(VT_BOT, "whatsapp:+528186019229", "x", "hola") == '{"id":"a0X"}'
    token_call, insert_call = fake.calls
    assert token_call["url"] == "https://sf.example/services/oauth2/token"
    assert insert_call["url"].endswith("/sobjects/rsplus__SMS_Bucket__c/")
    body = json.loads(insert_call["data"])
    assert body == {"rsplus__Number__c": "+528186019229", "rsplus__Message__c": "hola", "rsplus__Sender_ID__c": "SENDER", "Origen__c": "Plataforma IA"}


def test_valuetext_reintenta_una_vez_con_token_nuevo_ante_401(monkeypatch):
    fake = _patch(monkeypatch, FakeHttp(
        (200, json.dumps({"access_token": "viejo"})), _http_error(401),
        (200, json.dumps({"access_token": "nuevo"})), (201, "ok"),
    ))
    assert send_valuetext_message(VT_BOT, "+52", "hola") == "ok"
    assert fake.calls[-1]["headers"]["Authorization"] == "Bearer nuevo"
    _patch(monkeypatch, FakeHttp((200, json.dumps({"access_token": "t"})), _http_error(401), (200, json.dumps({"access_token": "t2"})), _http_error(401)))
    salesforce.clear_token_cache()
    assert send_valuetext_message(VT_BOT, "+52", "hola") is None  # solo se reintenta una vez


def test_token_de_salesforce_se_cachea(monkeypatch):
    fake = _patch(monkeypatch, FakeHttp((200, json.dumps({"access_token": "T"}))))
    assert salesforce.get_salesforce_token(SF) == "T" and salesforce.get_salesforce_token(SF) == "T"
    assert len(fake.calls) == 1


def test_valuetext_sin_credenciales(monkeypatch):
    fake = _patch(monkeypatch, FakeHttp())
    assert send_valuetext_message({"provider": "valuetext", "salesforceConfig": {}}, "+52", "x") is None and fake.calls == []


def test_parsea_el_outbound_message_de_salesforce():
    xml = """<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>
      <notifications xmlns="http://soap.sforce.com/2005/09/outbound"><Notification>
        <sObject xmlns:sf="urn:sobject.enterprise.soap.sforce.com"><sf:Id>a0X1</sf:Id>
          <sf:rsplus__Number__c> +528186019229 </sf:rsplus__Number__c><sf:rsplus__Message__c>Hola</sf:rsplus__Message__c>
          <sf:Origen__c>Plataforma IA</sf:Origen__c><sf:Name>ignorado</sf:Name></sObject>
      </Notification></notifications></soapenv:Body></soapenv:Envelope>"""
    assert parse_salesforce_outbound_message(xml) == [{
        "_sobject_id": "a0X1", "rsplus__Number__c": "+528186019229", "rsplus__Message__c": "Hola", "Origen__c": "Plataforma IA",
    }]
    assert parse_salesforce_outbound_message("no es xml") == []
