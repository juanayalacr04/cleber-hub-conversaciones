"""Acciones del dashboard (core/acciones_usuario.py), su Lambda (handlers.acciones_usuario) y la consulta de la plantilla
en Twilio (channels/campaign_templates.describe), sin red ni base."""
import json
from datetime import datetime, timedelta, timezone

import pytest

import handlers
from channels import campaign_templates as ct
from core import acciones_usuario, http, outbound, postgrest
from core.postgrest import ErrorHub
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


# --------------------------------------------------------------------------- Hub.enviaInvitacion

INVITA = {"action": "Hub.enviaInvitacion", "params": {"email": "Nuevo@Cleber.com", "idMarca": "to", "modulo": "valuacion", "nombreMarca": "Toyota <b>",
                                                      "origen": "https://dev.hub.test"}}


@pytest.fixture
def invita(monkeypatch):
    class Invita:
        permisos_destino = {"existe": True, "rol": "asesor", "esAdministrador": False}
        correos = []
        respuesta = {"successful": True, "info": [{"email": "nuevo@cleber.com", "status": "sent", "_id": "1", "reject_reason": None}]}
        falla = None

    def llama(accion, params=None, **k):
        if accion == "Hub.consultaPermisosUsuario":
            return {"existe": True, "esAdministrador": True} if params["email"] == "ana@cleber.com" else Invita.permisos_destino
        assert accion == "Hub.consultaRolesModulo"
        return {"roles": [{"rol": "asesor", "nombre": "Asesor de valuación"}]}

    def request(url, data=None, headers=None, method="POST", timeout=30):
        if Invita.falla:
            raise Invita.falla
        Invita.correos.append((url, headers, json.loads(data)))
        return 200, json.dumps(Invita.respuesta)

    Invita.correos = []
    monkeypatch.setattr(postgrest, "llama", llama)
    monkeypatch.setattr(http, "request", request)
    monkeypatch.setenv("INVITE_EMAIL_WEBHOOK_URL", "https://correo.test/enviar")
    monkeypatch.setenv("INVITE_EMAIL_API_KEY", "k-correo")
    return Invita


def test_envia_invitacion(invita):
    assert acciones_usuario.maneja(INVITA, "ana@cleber.com") == {"successful": True, "info": {"enviado": True}}
    (url, headers, cuerpo), = invita.correos
    assert url == "https://correo.test/enviar" and headers["x-api-key"] == "k-correo" and cuerpo["action"] == "Cleber.enviarEmail"
    p = cuerpo["params"]
    assert p["to"] == ["nuevo@cleber.com"] and p["cc"] == [] and p["bcc"] == []
    assert p["fromName"] == "CLEBER - HUB Conversaciones" and "Toyota &lt;b&gt;" in p["subject"]
    assert p["content"].startswith("<!DOCTYPE html>") and "Asesor de valuación" in p["content"]
    assert 'href="https://dev.hub.test"' in p["content"]
    assert p["subject"].startswith("Invitación al módulo de Valuación") and "<h2>Invitación al módulo de Valuación</h2>" in p["content"]


def test_invitacion_solo_a_quien_tiene_rol(invita):
    invita.permisos_destino = {"existe": True, "rol": None, "esAdministrador": False}
    assert acciones_usuario.maneja(INVITA, "ana@cleber.com")["errorCode"] == "ESTADO_INVALIDO"
    assert not invita.correos


def test_invitacion_con_fallo_del_envio_o_sin_configurar(invita, monkeypatch):
    invita.falla = OSError("sin red")
    assert acciones_usuario.maneja(INVITA, "ana@cleber.com")["errorCode"] == "ERROR_CORREO"
    invita.falla = None
    invita.respuesta = {"successful": True, "info": [{"email": "nuevo@cleber.com", "status": "rejected", "reject_reason": "hard-bounce"}]}
    assert acciones_usuario.maneja(INVITA, "ana@cleber.com")["errorCode"] == "ERROR_CORREO"
    invita.respuesta = {"successful": False, "errorMessage": "x"}
    assert acciones_usuario.maneja(INVITA, "ana@cleber.com")["errorCode"] == "ERROR_CORREO"
    monkeypatch.delenv("INVITE_EMAIL_WEBHOOK_URL")
    assert acciones_usuario.maneja(INVITA, "ana@cleber.com")["errorCode"] == "CONFIGURACION"


def test_invitacion_sin_api_key_no_manda_el_header(invita, monkeypatch):
    monkeypatch.setenv("INVITE_EMAIL_API_KEY", "")
    assert acciones_usuario.maneja(INVITA, "ana@cleber.com")["successful"]
    assert "x-api-key" not in invita.correos[0][1]


def test_enlace_segun_el_origen(invita):
    def enlace(origen):
        invita.correos.clear()
        r = acciones_usuario.maneja({**INVITA, "params": {**INVITA["params"], "origen": origen}}, "ana@cleber.com")
        return r, invita.correos and invita.correos[0][2]["params"]["content"]
    assert 'href="http://localhost:3000"' in enlace("http://localhost:3000/")[1]
    for malo in ("", "javascript:alert(1)", "https://malo.test/ruta", "https://u:p@malo.test", "ftp://malo.test"):
        r, correo = enlace(malo)
        assert r["errorCode"] == "CAMPO_REQUERIDO" and not correo, malo


# --------------------------------------------------------------------------- Hub.enviaMensajeAgente

MENSAJE = {"action": "Hub.enviaMensajeAgente", "params": {"idConversacion": "c1", "texto": "Hola, soy tu valuador"}}
NUMERO = {"idNumero": "n1", "idMarca": "TO", "modulo": "valuacion", "proveedor": "twilio", "telefono": "+5215550000000"}


@pytest.fixture
def agente(monkeypatch):
    class Agente:
        llamadas = []
        enviados = []
        sid = "SMx"
        ultimo_cliente = None

    def llama(accion, params=None, como=None, **k):
        Agente.llamadas.append((accion, params, como))
        if accion == "Hub.autorizaMensajeAgente":
            return {"conversacion": {"idConversacion": "c1", "telefonoCliente": "+528112345678",
                                     "ultimoMensajeClienteEn": Agente.ultimo_cliente}, "numero": NUMERO}
        assert accion == "Hub.registraMensajeAgente"
        return {"mensaje": {"idMensaje": "m1"}, "conversacion": {"estado": "with_agent"}, "duplicado": False}

    def envia(bot, to, from_, text, media_url=None):
        Agente.enviados.append({"bot": bot, "to": to, "from": from_, "text": text})
        return Agente.sid

    Agente.llamadas, Agente.enviados = [], []
    Agente.ultimo_cliente = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    monkeypatch.setattr(postgrest, "llama", llama)
    monkeypatch.setenv("TWILIO_ACCOUNT_SID", "AC-amb")
    monkeypatch.setenv("TWILIO_AUTH_TOKEN", "tok-amb")
    outbound.configure(send_text=envia)
    yield Agente
    outbound.configure()


def test_mensaje_del_agente_autoriza_envia_y_guarda_en_nombre_del_usuario(agente):
    r = acciones_usuario.maneja(MENSAJE, "Ana@Cleber.com")
    assert r["successful"] and r["info"]["conversacion"]["estado"] == "with_agent"
    (envio,) = agente.enviados
    assert envio["to"] == "whatsapp:+528112345678" and envio["from"] == "whatsapp:+5215550000000"
    assert envio["text"] == "Hola, soy tu valuador" and envio["bot"]["twilioConfig"]["accountSid"] == "AC-amb"
    assert [(a, c) for a, _, c in agente.llamadas] == [("Hub.autorizaMensajeAgente", "ana@cleber.com"),
                                                       ("Hub.registraMensajeAgente", "ana@cleber.com")]
    assert agente.llamadas[1][1] == {"idConversacion": "c1", "texto": "Hola, soy tu valuador", "idMensajeProveedor": "SMx"}


@pytest.mark.parametrize("ultimo", [None, "hace_25_h"])
def test_fuera_de_la_ventana_de_24_horas_no_se_envia(agente, ultimo):
    agente.ultimo_cliente = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat() if ultimo else None
    r = acciones_usuario.maneja(MENSAJE, "ana@cleber.com")
    assert r["errorCode"] == "FUERA_DE_VENTANA" and "24 horas" in r["errorMessage"]
    assert not agente.enviados and [a for a, _, _ in agente.llamadas] == ["Hub.autorizaMensajeAgente"]


def test_ventana_con_fecha_de_la_base():
    ahora = datetime(2026, 11, 19, 12, tzinfo=timezone.utc)
    assert acciones_usuario._dentro_de_ventana("2026-11-18T13:00:00+00:00", ahora)
    assert not acciones_usuario._dentro_de_ventana("2026-11-18T11:59:00Z", ahora)


def test_mensaje_que_whatsapp_no_acepta_no_se_guarda(agente):
    agente.sid = None
    r = acciones_usuario.maneja(MENSAJE, "ana@cleber.com")
    assert r["errorCode"] == "ERROR_PROVEEDOR" and "24 horas" in r["errorMessage"]
    assert [a for a, _, _ in agente.llamadas] == ["Hub.autorizaMensajeAgente"]


def test_mensaje_sin_permiso_no_se_envia(agente, monkeypatch):
    def niega(accion, params=None, como=None, **k):
        raise postgrest.ErrorHub("SIN_PERMISO", "La atiende otro asesor")
    monkeypatch.setattr(postgrest, "llama", niega)
    r = acciones_usuario.maneja(MENSAJE, "ana@cleber.com")
    assert r == {"successful": False, "errorCode": "SIN_PERMISO", "errorMessage": "La atiende otro asesor"}
    assert not agente.enviados


def test_mensaje_vacio_o_largo(agente):
    vacio = acciones_usuario.maneja({**MENSAJE, "params": {"idConversacion": "c1", "texto": "  "}}, "a@b.c")
    largo = acciones_usuario.maneja({**MENSAJE, "params": {"idConversacion": "c1", "texto": "x" * 4097}}, "a@b.c")
    assert vacio["errorCode"] == "CAMPO_REQUERIDO" and largo["errorCode"] == "CAMPO_INVALIDO"
    assert not agente.enviados


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
