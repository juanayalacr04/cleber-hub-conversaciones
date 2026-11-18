"""Texto que recibió el cliente con una plantilla (channels/campaign_templates.render_text) y su uso en el contrato ①."""
import json

import pytest

from channels import campaign_templates as ct
from core import http

NUMERO = {"provider": "twilio", "twilioAccountSid": "AC1", "twilioAuthToken": "tok", "phoneNumber": "whatsapp:+5215500000001"}
CONTENIDO = {"sid": "HX1", "types": {"twilio/quick-reply": {
    "body": "Hola {{1}}, por tu {{2}} te ofrecemos {{3}}.",
    "actions": [{"title": "Me interesa", "id": "oferta_interesa"}, {"title": "No, gracias", "id": "oferta_no_interesa"}]}}}


@pytest.fixture
def twilio(monkeypatch):
    llamadas = []

    def request(url, data=None, headers=None, method="POST", timeout=30):
        llamadas.append({"url": url, "method": method, "headers": headers})
        return 200, json.dumps(CONTENIDO)

    monkeypatch.setattr(http, "request", request)
    ct._content_cache.clear()
    return llamadas


def test_cuerpo_con_variables_y_botones(twilio):
    texto = ct.render_text(NUMERO, {"contentSid": "HX1"}, {"1": "Ana", "2": "COROLLA 2020", "3": "$250,000"})
    assert texto == "Hola Ana, por tu COROLLA 2020 te ofrecemos $250,000.\n\n[Me interesa]  [No, gracias]"
    assert twilio[0]["url"] == "https://content.twilio.com/v1/Content/HX1" and twilio[0]["method"] == "GET"
    assert twilio[0]["headers"]["Authorization"].startswith("Basic ")


def test_usa_cache_por_content_sid(twilio):
    ct.render_text(NUMERO, {"contentSid": "HX1"}, {})
    ct.render_text(NUMERO, {"contentSid": "HX1"}, {})
    assert len(twilio) == 1


def test_variable_que_no_viene_se_deja(twilio):
    assert ct.render_text(NUMERO, {"contentSid": "HX1"}, {"1": "Ana"}).startswith("Hola Ana, por tu {{2}}")


def test_sin_twilio_o_si_falla_regresa_none(monkeypatch):
    assert ct.render_text({**NUMERO, "provider": "meta"}, {"templateName": "x"}, {}) is None
    assert ct.render_text({"provider": "twilio"}, {"contentSid": "HX1"}, {}) is None          # sin credenciales

    def falla(*a, **k):
        raise OSError("sin red")
    monkeypatch.setattr(http, "request", falla)
    ct._content_cache.clear()
    assert ct.render_text(NUMERO, {"contentSid": "HX9"}, {}) is None


# --------------------------------------------------------------------------- contrato ①

def test_el_chat_guarda_el_texto_de_la_plantilla_del_proveedor(monkeypatch):
    """Sin "texto" capturado en el número, el mensaje del chat es el que le llegó al cliente."""
    import tests.test_contrato_entrada as tc
    from core import contrato_entrada, credentials, outbound, postgrest
    from core.datos import numeros

    base = tc.BaseFalsa(plantillas={"ofertaValuacion": {"contentSid": "HX1", "variables": ["nombreCliente", "vehiculo", "montoOferta"]}})
    monkeypatch.setattr(postgrest, "llama", base.llama)
    numeros.clear_cache()
    monkeypatch.setenv("TWILIO_ACCOUNT_SID", "AC1")
    monkeypatch.setenv("TWILIO_AUTH_TOKEN", "tok")
    credentials.configure(type("A", (), {"lee": lambda self, db, k, i: {}})())
    vistos = []
    outbound.configure(send_campaign=lambda *a, **k: "SM1",
                       render_template=lambda number, template, variables: vistos.append(variables) or "Hola Juan Pérez…")
    try:
        assert contrato_entrada.maneja(tc.PETICION)["successful"]
    finally:
        outbound.configure()
        credentials.configure(None)
    assert base.mensajes[-1]["texto"] == "Hola Juan Pérez…"
    assert vistos == [{"1": "Juan Pérez", "2": "HONDA CIVIC 2019", "3": "$270,000"}]
