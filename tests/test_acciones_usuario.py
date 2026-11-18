"""Acciones del dashboard (core/acciones_usuario.py), su Lambda (handlers.acciones_usuario) y la consulta de la plantilla
en Twilio (channels/campaign_templates.describe), sin red ni base."""
import json

import pytest

import handlers
from channels import campaign_templates as ct
from core import acciones_usuario, http, outbound, postgrest
from core.outbound import FAILED, NOT_CONFIGURED, TemplateError

CONTENIDO = {"sid": "HX1", "friendly_name": "oferta_valuacion", "language": "es_MX", "types": {"twilio/quick-reply": {
    "body": "Hola {{1}}, por tu {{2}} te ofrecemos {{3}}. {{10}}",
    "actions": [{"title": "Me interesa", "id": "oferta_interesa"}, {"title": "No, gracias", "id": "oferta_no_interesa"}]}}}
CUENTA = {"provider": "twilio", "twilioAccountSid": "AC1", "twilioAuthToken": "tok"}


def http_error(code):
    import io
    import urllib.error
    return urllib.error.HTTPError("https://content.twilio.com", code, "x", {}, io.BytesIO(b"{}"))


@pytest.fixture
def twilio(monkeypatch):
    """Content API falsa: regresa CONTENIDO o lanza lo que se ponga en `falla`."""
    class Twilio:
        llamadas = []
        falla = None

    def request(url, data=None, headers=None, method="POST", timeout=30):
        Twilio.llamadas.append({"url": url, "method": method, "headers": headers})
        if Twilio.falla:
            raise Twilio.falla
        return 200, json.dumps(CONTENIDO)

    Twilio.llamadas = []
    monkeypatch.setattr(http, "request", request)
    ct._content_cache.clear()
    return Twilio


# --------------------------------------------------------------------------- describe

def test_describe_regresa_cuerpo_botones_y_variables(twilio):
    r = ct.describe(CUENTA, "HX1")
    assert r == {"nombre": "oferta_valuacion", "idioma": "es_MX", "tipo": "twilio/quick-reply",
                 "cuerpo": "Hola {{1}}, por tu {{2}} te ofrecemos {{3}}. {{10}}",
                 "botones": [{"titulo": "Me interesa", "id": "oferta_interesa"}, {"titulo": "No, gracias", "id": "oferta_no_interesa"}],
                 "variables": ["1", "2", "3", "10"]}                     # orden numérico, no de texto
    assert twilio.llamadas[0]["url"] == "https://content.twilio.com/v1/Content/HX1" and twilio.llamadas[0]["method"] == "GET"


def test_describe_lee_fresca_aunque_este_en_cache(twilio):
    ct.describe(CUENTA, "HX1")
    ct.describe(CUENTA, "HX1")
    assert len(twilio.llamadas) == 2


def test_describe_errores(twilio):
    with pytest.raises(TemplateError) as e:
        ct.describe({"provider": "twilio"}, "HX1")
    assert e.value.kind == NOT_CONFIGURED and "TWILIO_ACCOUNT_SID" in e.value.message
    with pytest.raises(TemplateError) as e:
        ct.describe({"provider": "meta"}, "oferta")
    assert e.value.kind == NOT_CONFIGURED
    twilio.falla = http_error(404)
    with pytest.raises(TemplateError) as e:
        ct.describe(CUENTA, "HX9")
    assert e.value.kind == FAILED and "no encontró" in e.value.message
    assert len(twilio.llamadas) == 1                                    # sin cuenta o con otro proveedor no llama a Twilio


def test_describe_sin_cuerpo_de_texto(monkeypatch):
    monkeypatch.setattr(http, "request", lambda *a, **k: (200, json.dumps({"types": {"twilio/media": {"media": ["x"]}}})))
    with pytest.raises(TemplateError) as e:
        ct.describe(CUENTA, "HX2")
    assert e.value.kind == FAILED


# --------------------------------------------------------------------------- acciones

@pytest.fixture
def hub(monkeypatch):
    """Hub.consultaPermisosUsuario falso; `permisos` se puede cambiar por prueba."""
    class Hub:
        llamadas = []
        permisos = {"existe": True, "esAdministrador": True}

    def llama(accion, params=None, **k):
        Hub.llamadas.append((accion, params))
        assert accion == "Hub.consultaPermisosUsuario"
        return Hub.permisos

    Hub.llamadas = []
    monkeypatch.setattr(postgrest, "llama", llama)
    monkeypatch.setenv("TWILIO_ACCOUNT_SID", "AC-ambiente")
    monkeypatch.setenv("TWILIO_AUTH_TOKEN", "tok-ambiente")
    vistos = []
    outbound.configure(describe_template=lambda number, template_id: vistos.append((number, template_id)) or {"cuerpo": "Hola"})
    Hub.vistos = vistos
    yield Hub
    outbound.configure()


PETICION = {"action": "Hub.consultaPlantillaProveedor", "params": {"idMarca": "to", "modulo": "Valuacion", "idPlantilla": "HX1"}}


def test_consulta_plantilla_con_la_cuenta_del_ambiente(hub):
    assert acciones_usuario.maneja(PETICION, " Ana@Cleber.com ") == {"successful": True, "info": {"cuerpo": "Hola"}}
    assert hub.llamadas == [("Hub.consultaPermisosUsuario", {"email": "ana@cleber.com", "idMarca": "TO", "modulo": "valuacion"})]
    assert hub.vistos == [({"provider": "twilio", "twilioAccountSid": "AC-ambiente", "twilioAuthToken": "tok-ambiente"}, "HX1")]


def test_sin_permiso(hub):
    hub.permisos = {"existe": True, "esAdministrador": False}
    assert acciones_usuario.maneja(PETICION, "ana@cleber.com")["errorCode"] == "SIN_PERMISO"
    hub.permisos = {"existe": False}
    assert acciones_usuario.maneja(PETICION, "ana@cleber.com")["errorCode"] == "SIN_PERMISO"
    assert acciones_usuario.maneja(PETICION, None)["errorCode"] == "SIN_PERMISO"
    assert not hub.vistos


def test_peticiones_invalidas(hub):
    assert acciones_usuario.maneja(None, "a@b.c")["errorCode"] == "PETICION_INVALIDA"
    assert acciones_usuario.maneja({"action": "Hub.otra"}, "a@b.c")["errorCode"] == "ACCION_INVALIDA"
    r = acciones_usuario.maneja({"action": "Hub.consultaPlantillaProveedor", "params": {"idMarca": "TO", "modulo": "valuacion"}}, "a@b.c")
    assert r["errorCode"] == "CAMPO_REQUERIDO" and r["info"] == {"campo": "idPlantilla"}


@pytest.mark.parametrize("kind, codigo", [(NOT_CONFIGURED, "PROVEEDOR_NO_CONFIGURADO"), (FAILED, "ERROR_PROVEEDOR")])
def test_errores_del_proveedor(hub, kind, codigo):
    def falla(number, template_id):
        raise TemplateError(kind, "detalle")
    outbound.configure(describe_template=falla)
    assert acciones_usuario.maneja(PETICION, "a@b.c") == {"successful": False, "errorCode": codigo, "errorMessage": "detalle"}


def test_error_inesperado(hub, monkeypatch):
    monkeypatch.setattr(postgrest, "llama", lambda *a, **k: 1 / 0)
    assert acciones_usuario.maneja(PETICION, "a@b.c")["errorCode"] == "ERROR_INTERNO"


# --------------------------------------------------------------------------- Lambda

def evento(body, method="POST", email="ana@cleber.com"):
    contexto = {"stage": "dev", **({"authorizer": {"email": email}} if email else {})}
    return {"resource": "/hub-acciones", "path": "/hub-acciones", "httpMethod": method, "headers": {},
            "requestContext": contexto, "body": json.dumps(body), "isBase64Encoded": False}


@pytest.fixture
def maneja(monkeypatch):
    recibidos = []
    monkeypatch.setattr(acciones_usuario, "maneja", lambda cuerpo, email: recibidos.append((cuerpo, email)) or {"successful": True, "info": {}})
    monkeypatch.delenv("SECRET_NAME", raising=False)
    return recibidos


def test_lambda_pasa_el_email_del_authorizer(maneja):
    r = handlers.acciones_usuario(evento(PETICION))
    assert r["statusCode"] == 200 and json.loads(r["body"]) == {"successful": True, "info": {}}
    assert maneja == [(PETICION, "ana@cleber.com")]


def test_lambda_sin_authorizer_o_invocacion_directa(maneja):
    handlers.acciones_usuario(evento(PETICION, email=None))
    assert maneja == [(PETICION, None)]                                         # maneja responde SIN_PERMISO
    assert handlers.acciones_usuario(PETICION)["errorCode"] == "SIN_PERMISO"
    assert len(maneja) == 1


def test_lambda_solo_post(maneja):
    assert handlers.acciones_usuario(evento(PETICION, method="GET"))["statusCode"] == 405
    assert not maneja
