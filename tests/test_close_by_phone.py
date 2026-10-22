import json

import pytest

import main
from core import close_by_phone as cbp
from tests.fakes import FakeDB

SECRET = "s3cret"
SOAP = """<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>
  <notifications xmlns="http://soap.sforce.com/2005/09/outbound"><Notification>
    <sObject xmlns:sf="urn:sobject.enterprise.soap.sforce.com"><sf:Id>a0X1</sf:Id><sf:rsplus__Phone_Number__c> +528111111111 </sf:rsplus__Phone_Number__c></sObject>
  </Notification><Notification>
    <sObject xmlns:sf="urn:sobject.enterprise.soap.sforce.com"><sf:Id>a0X2</sf:Id><sf:rsplus__Phone_Number__c>8122222222</sf:rsplus__Phone_Number__c></sObject>
  </Notification></notifications></soapenv:Body></soapenv:Envelope>"""


@pytest.fixture(autouse=True)
def entorno(monkeypatch):
    monkeypatch.setenv("EXTERNAL_API_SECRET", SECRET)
    monkeypatch.delenv("ALLOW_UNAUTHENTICATED_INTEGRATIONS", raising=False)


@pytest.fixture
def db():
    d = FakeDB()
    live = {"assignedAgentId": "ag1", "assignedAt": "t", "waitingStartedAt": "t", "firstAgentResponseAt": "t", "responseTimeSecs": 9}
    d.seed("conversations", "c-moderna", {"customerPhone": "whatsapp:+528111111111", "status": "with_agent", **live})
    d.seed("conversations", "c-legacy", {"customerPhone": "whatsapp:+5218111111111", "status": "bot"})
    d.seed("conversations", "c-espera", {"customerPhone": "whatsapp:+528111111111", "status": "waiting_agent", "organizationId": "kia"})
    d.seed("conversations", "c-cerrada", {"customerPhone": "whatsapp:+528111111111", "status": "closed"})
    d.seed("conversations", "c-otra", {"customerPhone": "whatsapp:+528133333333", "status": "bot"})
    d.seed("conversations", "c-2", {"customerPhone": "whatsapp:+528122222222", "status": "bot"})
    return d


def call(db, body, headers=None, args=None, **kw):
    h = {"X-Api-Secret": SECRET} if headers is None else headers
    return cbp.handle(h, args or {}, body, db=db, **kw)


def status_of(db, cid):
    return db.data["conversations"][cid]["status"]


# --------------------------------------------------------------------------- autenticación

def test_sin_secreto_valido_es_401_y_no_cierra_nada(db):
    for headers, args in (({}, {}), ({"X-Api-Secret": "otro"}, {}), ({}, {"secret": "otro"})):
        body, status, ctype = call(db, SOAP, headers, args)
        assert status == 401 and ctype == "application/json" and json.loads(body) == {"error": "Unauthorized"}
    assert status_of(db, "c-moderna") == "with_agent"


def test_el_secreto_por_query_string_es_valido_porque_salesforce_no_manda_cabeceras(db):
    assert call(db, SOAP, {}, {"secret": SECRET})[1] == 200 and status_of(db, "c-moderna") == "closed"


def test_sin_secreto_configurado_falla_cerrado(db, monkeypatch):
    monkeypatch.delenv("EXTERNAL_API_SECRET")
    assert call(db, SOAP, {})[1] == 401
    monkeypatch.setenv("ALLOW_UNAUTHENTICATED_INTEGRATIONS", "true")
    assert call(db, SOAP, {})[1] == 200


# --------------------------------------------------------------------------- SOAP

def test_outbound_message_cierra_las_conversaciones_de_cada_telefono_y_responde_el_ack(db):
    body, status, ctype = call(db, SOAP, {"X-Api-Secret": SECRET, "Content-Type": "text/xml"})
    assert (status, ctype, body) == (200, "text/xml", cbp.SOAP_ACK)
    assert [status_of(db, c) for c in ("c-moderna", "c-legacy", "c-espera", "c-2")] == ["closed"] * 4    # variantes +52 y +521, cualquier organización
    assert status_of(db, "c-otra") == "bot" and status_of(db, "c-cerrada") == "closed"


def test_la_conversacion_queda_cerrada_a_mano_y_sin_asesor(db):
    call(db, SOAP)
    c = db.data["conversations"]["c-moderna"]
    assert (c["closedReason"], c["closedBy"], c["manualClose"]) == ("salesforce", "salesforce", True)
    assert c["closedAt"] is not None
    for field in ("assignedAgentId", "assignedAt", "waitingStartedAt", "firstAgentResponseAt", "responseTimeSecs"):
        assert c[field] is None


def test_se_reconoce_el_xml_por_el_cuerpo_aunque_no_venga_el_content_type(db):
    assert call(db, "  \n" + SOAP, {"X-Api-Secret": SECRET})[2] == "text/xml"


def test_un_fallo_con_un_telefono_no_impide_el_ack_ni_los_demas(db, monkeypatch):
    real = cbp.close_conversations

    def explota_con_uno(db_, phone, reason):
        if "8111111111" in phone:
            raise RuntimeError("Firestore caído")
        return real(db_, phone, reason)
    monkeypatch.setattr(cbp, "close_conversations", explota_con_uno)
    body, status, ctype = call(db, SOAP)
    assert (status, ctype, body) == (200, "text/xml", cbp.SOAP_ACK)
    assert status_of(db, "c-2") == "closed" and status_of(db, "c-moderna") == "with_agent"


def test_soap_sin_telefonos_solo_responde_el_ack(db):
    assert call(db, "<a><b>nada</b></a>")[0] == cbp.SOAP_ACK


# --------------------------------------------------------------------------- JSON

def test_json_cierra_y_devuelve_los_ids_y_las_variantes(db):
    body, status, ctype = call(db, json.dumps({"phone": "8111111111", "reason": "venta cerrada"}))
    out = json.loads(body)
    assert status == 200 and ctype == "application/json" and out["closed"] == 3
    assert sorted(out["conversationIds"]) == ["c-espera", "c-legacy", "c-moderna"]
    assert out["variants"] == ["whatsapp:+528111111111", "whatsapp:+5218111111111"]
    assert db.data["conversations"]["c-moderna"]["closedReason"] == "venta cerrada"


def test_json_sin_conversaciones_activas(db):
    body, status, _ = call(db, json.dumps({"phone": "+528199999999"}))
    assert status == 200 and json.loads(body)["closed"] == 0 and "No active conversations" in json.loads(body)["message"]


@pytest.mark.parametrize("body, expected", [("no es json", "Invalid body"), ("[1]", "Invalid body"), ("{}", "Missing 'phone'"),
                                            ('{"phone": "  "}', "Missing 'phone'"), ('{"phone": 5}', "Missing 'phone'")])
def test_json_invalido_es_400(db, body, expected):
    out, status, _ = call(db, body)
    assert status == 400 and expected in json.loads(out)["error"]


def test_la_razon_por_defecto_es_salesforce(db):
    call(db, json.dumps({"phone": "8122222222", "reason": "  "}))
    assert db.data["conversations"]["c-2"]["closedReason"] == "salesforce"


# --------------------------------------------------------------------------- piezas

@pytest.mark.parametrize("raw, expected", [
    ("8111111111", ["whatsapp:+528111111111", "whatsapp:+5218111111111"]),
    ("+52 811 111 1111", ["whatsapp:+528111111111", "whatsapp:+5218111111111"]),
    ("5218111111111", ["whatsapp:+528111111111", "whatsapp:+5218111111111"]),
    ("whatsapp:+528111111111", ["whatsapp:+528111111111", "whatsapp:+5218111111111"]),
    ("+14155551234", ["whatsapp:+14155551234"]), ("14155551234", ["whatsapp:+14155551234"]), ("whatsapp:+14155551234", ["whatsapp:+14155551234"]),
])
def test_variantes_del_telefono(raw, expected):
    assert cbp.phone_variants(raw) == expected


def test_cierre_en_lotes(db, monkeypatch):
    monkeypatch.setattr(cbp, "BATCH", 2)
    for i in range(5):
        db.seed("conversations", f"x{i}", {"customerPhone": "whatsapp:+528144444444", "status": "bot"})
    assert len(cbp.close_conversations(db, "8144444444", "salesforce")) == 5
    assert all(db.data["conversations"][f"x{i}"]["status"] == "closed" for i in range(5))


# --------------------------------------------------------------------------- entry point

class Req:
    def __init__(self, method="POST", headers=None, args=None, body=""):
        self.method, self.headers, self.args, self._body = method, headers or {}, args or {}, body

    def get_data(self, as_text=False):
        return self._body


def test_entry_point(monkeypatch):
    assert main.close_by_phone(Req("GET"))[1] == 405
    body, status, headers = main.close_by_phone(Req(body=SOAP))
    assert status == 401 and headers["Content-Type"] == "application/json"

    monkeypatch.setattr(cbp, "handle", lambda h, a, b, **k: (cbp.SOAP_ACK, 200, "text/xml"))
    body, status, headers = main.close_by_phone(Req(headers={"X-Api-Secret": SECRET}, body=SOAP))
    assert (body, status, headers["Content-Type"]) == (cbp.SOAP_ACK, 200, "text/xml")

    def explota(*a, **k):
        raise RuntimeError("detalle")
    monkeypatch.setattr(cbp, "handle", explota)
    body, status, _ = main.close_by_phone(Req(headers={"X-Api-Secret": SECRET}, body=SOAP))
    assert status == 500 and "detalle" not in body
