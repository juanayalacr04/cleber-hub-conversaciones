import json
import urllib.parse
from datetime import datetime, timezone
from io import BytesIO

import pytest

from channels import campaign_templates as ct
from core import http
from core.outbound import FAILED, TemplateError
from crm import campaign_events as ev, salesforce

SF = {"instanceUrl": "https://sf.example", "clientId": "c", "clientSecret": "s", "username": "u", "password": "p"}
BROADCAST = {"templateName": "recordatorio", "templateLanguage": "es_MX", "contentSid": "HX9", "valuetextObjectApi": None,
             "templateComponents": [{"type": "body", "parameters": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]}]}
RECIPIENT = {"variables": {"1": "Ana"}, "salesforceRecordId": "00Q1"}


class FakeHttp:
    def __init__(self, *responses):
        self.calls, self._responses = [], list(responses)

    def __call__(self, url, data=None, headers=None, method="POST", timeout=30):
        self.calls.append({"url": url, "data": data, "headers": headers or {}, "method": method})
        r = self._responses.pop(0) if self._responses else (200, "{}")
        if isinstance(r, Exception):
            raise r
        return r


def http_error(code, body=b'{"error": "x"}'):
    return http.HTTPError("http://x", code, "err", {}, BytesIO(body))


@pytest.fixture(autouse=True)
def limpio(monkeypatch):
    salesforce.clear_token_cache()
    for var in ("SF_INSTANCE_URL", "SF_CLIENT_ID", "SF_CLIENT_SECRET", "SF_USERNAME", "SF_PASSWORD", "TWILIO_STATUS_CALLBACK_URL"):
        monkeypatch.delenv(var, raising=False)


def patch(monkeypatch, *responses):
    fake = FakeHttp(*responses)
    monkeypatch.setattr(http, "request", fake)
    return fake


# --------------------------------------------------------------------------- configuración del número

def test_check_ready_por_proveedor(monkeypatch):
    assert ct.check_ready({"provider": "meta"}, None) == "Meta credentials not configured"
    assert ct.check_ready({"provider": "meta", "metaPhoneNumberId": "1", "metaAccessToken": "t"}, None) is None
    assert ct.check_ready({"provider": "twilio", "twilioAccountSid": "AC"}, None) == "Twilio credentials not configured"
    assert ct.check_ready({"twilioAccountSid": "AC", "twilioAuthToken": "t", "phoneNumber": "+52"}, None) is None   # twilio por defecto
    assert ct.check_ready({"provider": "valuetext"}, {}) == "Salesforce credentials not configured (SF_* env)"
    patch(monkeypatch, http_error(401))
    assert ct.check_ready({"provider": "valuetext"}, SF) == "Salesforce auth failed"
    salesforce.clear_token_cache()
    patch(monkeypatch, (200, json.dumps({"access_token": "T"})))
    assert ct.check_ready({"provider": "valuetext"}, SF) is None


# --------------------------------------------------------------------------- componentes de Meta

def test_las_variables_del_destinatario_pisan_las_de_la_campana_por_posicion():
    comps = ct.template_components(BROADCAST["templateComponents"], {"1": "Ana"})
    assert [p["text"] for p in comps[0]["parameters"]] == ["Ana", "b"]
    assert BROADCAST["templateComponents"][0]["parameters"][0]["text"] == "a"      # no muta la campaña
    assert ct.template_components(BROADCAST["templateComponents"], None) == BROADCAST["templateComponents"]
    assert ct.template_components(None, {"1": "x"}) == []
    assert ct.template_components([{"type": "header"}], {"1": "x"}) == [{"type": "header"}]


# --------------------------------------------------------------------------- envío

def test_meta_manda_la_plantilla_con_idioma_y_componentes(monkeypatch):
    fake = patch(monkeypatch, (200, '{"messages": [{"id": "wamid.9"}]}'))
    number = {"provider": "meta", "metaPhoneNumberId": "123", "metaAccessToken": "tk"}
    assert ct.send(number, BROADCAST, RECIPIENT, "+528111111111") == "wamid.9"
    assert fake.calls[0]["url"] == "https://graph.facebook.com/v21.0/123/messages"
    payload = json.loads(fake.calls[0]["data"])
    assert payload["to"] == "528111111111" and payload["template"]["name"] == "recordatorio"
    assert payload["template"]["language"] == {"code": "es_MX"} and payload["template"]["components"][0]["parameters"][0]["text"] == "Ana"


def test_twilio_manda_content_sid_con_variables_y_callback(monkeypatch):
    monkeypatch.setenv("TWILIO_STATUS_CALLBACK_URL", "https://router.example/twilio-status")
    fake = patch(monkeypatch, (200, '{"sid": "SM7"}'))
    number = {"provider": "twilio", "twilioAccountSid": "AC1", "twilioAuthToken": "tok", "phoneNumber": "whatsapp:+528100000000"}
    assert ct.send(number, BROADCAST, RECIPIENT, "+528111111111") == "SM7"
    form = dict(urllib.parse.parse_qsl(fake.calls[0]["data"].decode()))
    assert (form["To"], form["From"], form["ContentSid"]) == ("whatsapp:+528111111111", "whatsapp:+528100000000", "HX9")
    assert json.loads(form["ContentVariables"]) == {"1": "Ana"} and form["StatusCallback"] == "https://router.example/twilio-status"
    assert "Body" not in form and fake.calls[0]["headers"]["Authorization"].startswith("Basic ")


def test_twilio_sin_content_sid_manda_cuerpo_y_en_prueba_no_pide_callback(monkeypatch):
    monkeypatch.setenv("TWILIO_STATUS_CALLBACK_URL", "https://router.example/twilio-status")
    fake = patch(monkeypatch, (200, '{"sid": "SM7"}'))
    number = {"twilioAccountSid": "AC1", "twilioAuthToken": "tok", "phoneNumber": "+52"}
    ct.send(number, {"templateName": "promo"}, {}, "+528111111111", track=False)
    form = dict(urllib.parse.parse_qsl(fake.calls[0]["data"].decode()))
    assert form["Body"] == "[Template: promo]" and "ContentSid" not in form and "StatusCallback" not in form


def test_valuetext_inserta_el_sms_bucket_con_plantilla_y_registro(monkeypatch):
    fake = patch(monkeypatch, (200, json.dumps({"access_token": "T"})), (201, '{"id": "a0X1"}'))
    number = {"provider": "valuetext", "valuetextSenderId": "SENDER"}
    assert ct.send(number, BROADCAST, RECIPIENT, "+528111111111", SF) == "a0X1"
    record = json.loads(fake.calls[1]["data"])
    assert record == {"rsplus__Number__c": "+528111111111", "rsplus__Sender_ID__c": "SENDER", "Origen__c": "Plataforma IA",
                      "rsplus__Template_ID__c": "recordatorio", "rsplus__Related_To__c": "00Q1"}


def test_valuetext_con_plantilla_por_objeto(monkeypatch):
    fake = patch(monkeypatch, (200, json.dumps({"access_token": "T"})), (201, '{"id": "a0X1"}'))
    ct.send({"provider": "valuetext"}, {**BROADCAST, "valuetextObjectApi": "Lead"}, RECIPIENT, "+52811", SF)
    record = json.loads(fake.calls[1]["data"])
    assert record["rsplus__Object_API__c"] == "Lead" and record["rsplus__Record_Id__c"] == "00Q1"
    assert record["rsplus__Message__c"] == "[Template: recordatorio]"


@pytest.mark.parametrize("number, script, expected", [
    ({"provider": "meta", "metaPhoneNumberId": "1", "metaAccessToken": "t"}, [http_error(400, b"plantilla no aprobada")],
     "Meta API error 400: plantilla no aprobada"),
    ({"twilioAccountSid": "AC", "twilioAuthToken": "t", "phoneNumber": "+52"}, [http_error(401, b"auth")], "Twilio API error 401: auth"),
    ({"twilioAccountSid": "AC", "twilioAuthToken": "t", "phoneNumber": "+52"}, [OSError("sin red")], "sin red"),
    ({"provider": "valuetext"}, [(200, json.dumps({"access_token": "T"})), http_error(400, b"INVALID_FIELD")],
     "Salesforce API error 400: INVALID_FIELD"),
])
def test_un_rechazo_del_proveedor_lleva_el_detalle(monkeypatch, number, script, expected):
    patch(monkeypatch, *script)
    with pytest.raises(TemplateError) as e:
        ct.send(number, BROADCAST, RECIPIENT, "+528111111111", SF)
    assert e.value.kind == FAILED and e.value.message == expected


# --------------------------------------------------------------------------- estado de entrega

def test_estado_de_entrega_de_twilio(monkeypatch):
    bodies = {"S1": {"status": "delivered"}, "S2": {"status": "read"}, "S3": {"status": "undelivered", "error_message": "Sin WhatsApp"},
              "S4": {"status": "failed"}, "S5": {"status": "sent"}}

    def fake(url, data=None, headers=None, method="POST", timeout=30):
        sid = url.rsplit("/", 1)[1].removesuffix(".json")
        if sid == "S6":
            raise OSError("sin red")
        return 200, json.dumps(bodies[sid])
    monkeypatch.setattr(http, "request", fake)
    number = {"provider": "twilio", "twilioAccountSid": "AC1", "twilioAuthToken": "tok"}
    assert ct.delivery_statuses(number, ["S1", "S2", "S3", "S4", "S5", "S6"]) == {
        "S1": {"state": "delivered", "message": None}, "S2": {"state": "read", "message": None},
        "S3": {"state": "failed", "message": "Sin WhatsApp"}, "S4": {"state": "failed", "message": "Delivery failed"}}


def test_estado_de_entrega_de_valuetext_en_lotes(monkeypatch):
    monkeypatch.setattr(ct, "SF_BATCH", 2)
    queries = []

    def query(cfg, soql, timeout=30):
        queries.append(soql)
        return [{"Id": "A", "rsplus__Processed__c": True, "rsplus__Status__c": "Delivered"},
                {"Id": "B", "rsplus__Processed__c": True, "rsplus__Status__c": "FAIL", "rsplus__Status_Message__c": "Número inválido"},
                {"Id": "C", "rsplus__Processed__c": False, "rsplus__Status__c": "Delivered"},
                {"Id": "D", "rsplus__Processed__c": True, "rsplus__Status__c": "Read", "rsplus__Status_Message__c": "ok"}][:2 if len(queries) == 1 else 4]
    monkeypatch.setattr(salesforce, "query", query)
    states = ct.delivery_statuses({"provider": "valuetext"}, ["A", "B", "C"], SF)
    assert len(queries) == 2 and "IN ('A','B')" in queries[0] and "IN ('C')" in queries[1]
    assert states["A"] == {"state": "delivered", "message": None} and states["B"] == {"state": "failed", "message": "Número inválido"}
    assert "C" not in states and states["D"] == {"state": "read", "message": "ok"}


def test_si_salesforce_no_responde_no_hay_estados(monkeypatch):
    monkeypatch.setattr(salesforce, "query", lambda *a, **k: None)
    assert ct.delivery_statuses({"provider": "valuetext"}, ["A"], SF) == {}


# --------------------------------------------------------------------------- citas de Salesforce

def test_parseo_de_campos_de_la_descripcion():
    text = "CONTACTO: Ana Pérez\r\nTALLER:   Norte \nVIN:\nAUTO: CR-V"
    assert ev.parse_description_field(text, "CONTACTO") == "Ana Pérez" and ev.parse_description_field(text, "TALLER") == "Norte"
    assert ev.parse_description_field(text, "VIN") is None and ev.parse_description_field(text, "COLOR") is None
    assert ev.parse_description_field("A.B: x", "A.B") == "x" and ev.parse_description_field(None, "X") is None


@pytest.mark.parametrize("raw, expected", [
    ("8111111111", "+528111111111"), ("+52 811 111 1111", "+528111111111"), ("5218111111111", "+528111111111"),
    ("0052 8111111111", "+528111111111"), ("(811) 111-1111", "+528111111111"), ("123", None), ("", None), (None, None),
    ("+14155551234", None),
])
def test_normaliza_telefonos_de_citas(raw, expected):
    assert ev.normalize_phone(raw) == expected


def test_los_rotulos_de_kia_son_distintos():
    kia, honda = ev.field_map("KI"), ev.field_map("HO")
    assert kia["auto"] == "MODELO DEL VEHICULO" and kia["recepcionista"] == "ASESOR DE SERVICIO" and honda["auto"] == "AUTO"
    assert ev.field_map(None) is honda


def test_construye_la_consulta_de_recordatorio_y_no_show():
    now = datetime(2026, 10, 20, 3, 0, tzinfo=timezone.utc)      # en CDMX todavía es 19 de octubre
    reminder = ev.build_query({"type": "appointment_reminder", "reminderConfig": {"daysBefore": 1, "eventType": "Cita"}}, {}, now)
    assert "ActivityDate = 2026-10-20" in reminder and "GCL_SeRealizo__c = null" in reminder and "Calendario__c" not in reminder
    noshow = ev.build_query({"type": "no_show", "reminderConfig": {"eventType": "Cita"}}, {"sfCalendario": "Norte"}, now)
    assert "ActivityDate = TODAY AND ActivityDateTime < 2026-10-20T03:00:00Z" in noshow
    assert "GCL_SeRealizo__c = 'No'" in noshow and "Calendario__c = 'Norte'" in noshow and noshow.endswith("Journey_borrar__c = false")


def test_variables_de_la_cita_y_prioridad_de_los_campos():
    event = {"Id": "E1", "Description": "CONTACTO: Ana\nTALLER: Desc\nAUTO: CR-V\nRESERVACION: R77", "Location": "Sucursal Centro",
             "ActivityDate": "2026-10-21", "ActivityDateTime": "2026-10-21T20:30:00.000+0000", "VIN__c": None,
             "Tel_fono_Prospecto__c": None, "Celular_Prospecto__c": "8111111111", "IdQuiter__c": None}
    (rec,), skipped = ev.build_recipients([event], ev.field_map(None), ["name", "horaCita", "noexiste"])
    assert skipped == [] and rec["phone"] == "+528111111111" and rec["name"] == "Ana" and rec["salesforceRecordId"] == "E1"
    v = rec["variables"]
    assert v["taller"] == "Sucursal Centro" and v["auto"] == "CR-V" and v["idReservacion"] == "R77" and v["horaCita"] == "14:30"
    assert v["1"] == "Ana" and v["2"] == "14:30" and "3" not in v and v["vin"] == "" and v["idQuiter"] == ""


def test_el_telefono_sale_de_tres_fuentes_en_orden():
    base = {"Id": "E", "Description": "TELEFONO: 8333333333", "Celular_Prospecto__c": "8222222222", "Tel_fono_Prospecto__c": "8111111111"}
    assert ev.build_recipients([base], ev.field_map(None), None)[0][0]["phone"] == "+528111111111"
    assert ev.build_recipients([{**base, "Tel_fono_Prospecto__c": None}], ev.field_map(None), None)[0][0]["phone"] == "+528222222222"
    assert ev.build_recipients([{**base, "Tel_fono_Prospecto__c": None, "Celular_Prospecto__c": None}], ev.field_map(None), None)[0][0]["phone"] == "+528333333333"


def test_query_all_sigue_las_paginas(monkeypatch):
    pages = {"/services/data/v59.0/query?q=SELECT%20Id": (True, {"records": [{"Id": 1}], "nextRecordsUrl": "/next/1"}),
             "/next/1": (True, {"records": [{"Id": 2}]})}
    monkeypatch.setattr(salesforce, "call", lambda cfg, method, path, *a, **k: pages[path])
    assert salesforce.query_all(SF, "SELECT Id") == [{"Id": 1}, {"Id": 2}]
    monkeypatch.setattr(salesforce, "call", lambda cfg, method, path, *a, **k: (False, {}))
    assert salesforce.query_all(SF, "SELECT Id") is None
