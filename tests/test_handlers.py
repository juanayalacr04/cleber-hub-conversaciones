"""Handlers de Lambda (handlers.py), el adaptador de eventos (core/http_lambda.py) y los secretos del ambiente (core/entorno.py)."""
import base64
import json

import pytest

import handlers
from core import contrato_entrada, entorno, http_lambda


def evento_api(body, method="POST", headers=None, query=None, base64_=False):
    cuerpo = json.dumps(body) if isinstance(body, (dict, list)) else (body or "")
    if base64_:
        cuerpo = base64.b64encode(cuerpo.encode()).decode()
    return {"resource": "/internal/contrato", "path": "/internal/contrato", "httpMethod": method, "headers": headers or {},
            "queryStringParameters": query, "requestContext": {"stage": "dev"}, "body": cuerpo, "isBase64Encoded": base64_}


@pytest.fixture
def contrato(monkeypatch):
    recibidos = []

    def maneja(cuerpo):
        recibidos.append(cuerpo)
        return {"successful": True, "info": {"idConversacion": "c1"}}

    monkeypatch.setattr(contrato_entrada, "maneja", maneja)
    monkeypatch.delenv("SECRET_NAME", raising=False)
    return recibidos


def test_contrato_por_invocacion_directa_regresa_el_envelope(contrato):
    cuerpo = {"action": "Hub.abreConversacion", "params": {"fuente": "valuacion"}}
    assert handlers.entry_point(cuerpo) == {"successful": True, "info": {"idConversacion": "c1"}}
    assert contrato == [cuerpo]


def test_contrato_por_api_gateway(contrato):
    cuerpo = {"action": "Hub.abreConversacion", "params": {"fuente": "valuacion"}}
    r = handlers.entry_point(evento_api(cuerpo))
    assert r["statusCode"] == 200 and json.loads(r["body"])["info"]["idConversacion"] == "c1"
    assert r["headers"]["Content-Type"] == "application/json"
    assert contrato == [cuerpo]


def test_contrato_por_api_gateway_solo_post(contrato):
    assert handlers.entry_point(evento_api({}, method="GET"))["statusCode"] == 405
    assert not contrato


def test_sin_secretos_responde_configuracion(contrato, monkeypatch):
    monkeypatch.setattr(entorno, "carga_secretos", lambda: (_ for _ in ()).throw(RuntimeError("sin acceso")))
    assert handlers.entry_point({"action": "x"})["errorCode"] == "CONFIGURACION"
    assert handlers.entry_point(evento_api({}))["statusCode"] == 500


# --------------------------------------------------------------------------- adaptador

def test_peticion_de_evento_api_gateway():
    p = http_lambda.Peticion.de_evento(evento_api("To=whatsapp%3A%2B52&Body=Hola+mundo", headers={"X-Twilio-Signature": "abc"},
                                                  query={"secret": "s"}, base64_=True))
    assert p.method == "POST" and p.path == "/internal/contrato" and p.args == {"secret": "s"}
    assert p.headers.get("x-twilio-signature") == "abc" and "X-TWILIO-SIGNATURE" in p.headers
    assert p.form == {"To": "whatsapp:+52", "Body": "Hola mundo"}
    assert p.get_data(as_text=True) == "To=whatsapp%3A%2B52&Body=Hola+mundo"
    assert p.get_json(silent=True) is None


def test_peticion_de_function_url():
    p = http_lambda.Peticion.de_evento({"rawPath": "/webhook/meta", "requestContext": {"http": {"method": "get"}},
                                        "queryStringParameters": {"hub.mode": "subscribe"}, "headers": {}})
    assert p.method == "GET" and p.path == "/webhook/meta" and p.args["hub.mode"] == "subscribe" and p.get_data() == b""


def test_invocacion_directa_vs_api_gateway():
    assert http_lambda.es_invocacion_directa({"action": "Hub.abreConversacion", "params": {}})
    assert not http_lambda.es_invocacion_directa(evento_api({}))


def test_de_flask():
    assert http_lambda.de_flask(({"ok": 1}, 201)) == {"statusCode": 201, "headers": {"Content-Type": "application/json"}, "body": '{"ok": 1}'}
    assert http_lambda.de_flask(("<xml/>", 200, {"Content-Type": "text/xml"}))["headers"] == {"Content-Type": "text/xml"}
    assert http_lambda.de_flask("ok") == {"statusCode": 200, "headers": {}, "body": "ok"}


# --------------------------------------------------------------------------- secretos del ambiente

class SecretoFalso:
    def __init__(self, valores):
        self.valores, self.lecturas = valores, 0

    def get_secret_value(self, SecretId):
        self.lecturas += 1
        return {"SecretString": json.dumps(self.valores)}


def test_carga_secretos_una_vez_sin_pisar_lo_configurado(monkeypatch):
    entorno.reinicia()
    monkeypatch.setenv("SECRET_NAME", "hub/dev/entorno")
    monkeypatch.setenv("URL_API_DB", "http://definida-en-la-lambda")
    monkeypatch.delenv("CLEBER_API_KEY", raising=False)
    cliente = SecretoFalso({"CLEBER_API_KEY": "k", "URL_API_DB": "http://del-secreto", "VACIA": ""})
    entorno.carga_secretos(cliente)
    entorno.carga_secretos(cliente)
    import os
    assert os.environ["CLEBER_API_KEY"] == "k"
    assert os.environ["URL_API_DB"] == "http://definida-en-la-lambda"
    assert "VACIA" not in os.environ
    assert cliente.lecturas == 1
    os.environ.pop("CLEBER_API_KEY", None)   # la puso carga_secretos, no monkeypatch
    entorno.reinicia()


def test_sin_secret_name_no_hace_nada(monkeypatch):
    entorno.reinicia()
    monkeypatch.delenv("SECRET_NAME", raising=False)
    entorno.carga_secretos(cliente=object())   # no lo toca
