"""core/postgrest.py: envelope, modos sistema/usuario y errores, sin red (se reemplaza core.http.request)."""
import io
import json
import urllib.error

import pytest

from core import http, postgrest
from core.postgrest import ErrorHub


@pytest.fixture
def entorno(monkeypatch):
    monkeypatch.setenv("URL_API_DB", "http://postgrest.interno/")
    monkeypatch.setenv("CLEBER_API_KEY", "clave-sistema")
    monkeypatch.setenv("API_GATEWAY_URL", "https://api.cleber.test/dev")
    monkeypatch.setenv("API_GATEWAY_KEY", "clave-gateway")
    monkeypatch.delenv("API_GATEWAY_TOKEN_HEADER", raising=False)


@pytest.fixture
def red(monkeypatch):
    """Guarda las llamadas y responde lo que se le ponga en `red.respuesta` (o lanza `red.error`)."""
    class Red:
        llamadas = []
        respuesta = {"successful": True, "info": {"ok": 1}}
        error = None

    def falsa(url, data=None, headers=None, method="POST", timeout=30):
        Red.llamadas.append({"url": url, "cuerpo": json.loads(data), "headers": headers, "timeout": timeout})
        if Red.error:
            raise Red.error
        return 200, json.dumps(Red.respuesta)

    Red.llamadas = []
    monkeypatch.setattr(http, "request", falsa)
    return Red


def _http_error(codigo, cuerpo=""):
    return urllib.error.HTTPError("http://x", codigo, "error", {}, io.BytesIO(cuerpo.encode()))


def test_funcion_de_convierte_la_accion_al_nombre_de_postgrest():
    assert postgrest.funcion_de("Hub.obtieneOAbreConversacion") == "obtiene_o_abre_conversacion"
    assert postgrest.funcion_de("Hub.guardaMensaje") == "guarda_mensaje"
    assert postgrest.funcion_de("Valuacion.marcaEnviada") == "marca_enviada"
    with pytest.raises(ValueError):
        postgrest.funcion_de("sinPrefijo")


def test_modo_sistema(entorno, red):
    info = postgrest.llama("Hub.guardaMensaje", {"idConversacion": "c1", "texto": "Hola"})
    assert info == {"ok": 1}
    (ll,) = red.llamadas
    assert ll["url"] == "http://postgrest.interno/rpc/guarda_mensaje"
    assert ll["cuerpo"] == {"action": "Hub.guardaMensaje", "params": {"idConversacion": "c1", "texto": "Hola"}}
    h = ll["headers"]
    assert h["Content-Profile"] == "hub_cleber"
    assert h["X-User-Email"] == "sistema@hub-conversaciones.internal"
    assert h["x-api-key"] == "clave-sistema"
    assert h["Prefer"] == "params=single-object"


def test_en_nombre_de_un_usuario_va_por_la_ruta_interna_con_su_email(entorno, red):
    postgrest.llama("Hub.autorizaMensajeAgente", {"idConversacion": "c1"}, como="ana@cleber.com")
    (ll,) = red.llamadas
    assert ll["url"] == "http://postgrest.interno/rpc/autoriza_mensaje_agente"
    assert ll["headers"]["X-User-Email"] == "ana@cleber.com" and ll["headers"]["Content-Profile"] == "hub_cleber"


def test_modo_sistema_sin_api_key_no_manda_el_header(entorno, red, monkeypatch):
    monkeypatch.delenv("CLEBER_API_KEY")
    postgrest.llama("Hub.resuelveNumero", {"telefono": "+525512345678"})
    assert "x-api-key" not in red.llamadas[0]["headers"]


def test_el_schema_sale_del_prefijo(entorno, red):
    postgrest.llama("Valuacion.marcaEnviada", {"idOferta": 1})
    assert red.llamadas[0]["headers"]["Content-Profile"] == "valuacion"


def test_modo_usuario_va_por_el_gateway_con_el_token(entorno, red):
    postgrest.llama("Hub.tomaConversacion", {"idConversacion": "c1"}, token="tok-123")
    (ll,) = red.llamadas
    assert ll["url"] == "https://api.cleber.test/dev/hub-cleber/rpc/toma_conversacion"
    h = ll["headers"]
    assert h["X-Id-Token"] == "tok-123"
    assert h["x-api-key"] == "clave-gateway"
    # El email y el schema los pone el gateway: el backend no puede suplantar a nadie
    assert "X-User-Email" not in h and "Content-Profile" not in h


def test_modo_usuario_con_header_authorization_usa_bearer(entorno, red, monkeypatch):
    monkeypatch.setenv("API_GATEWAY_TOKEN_HEADER", "Authorization")
    postgrest.llama("Hub.tomaConversacion", {"idConversacion": "c1"}, token="tok-123")
    assert red.llamadas[0]["headers"]["Authorization"] == "Bearer tok-123"


def test_token_vacio_es_sesion_expirada(entorno, red):
    with pytest.raises(ErrorHub) as e:
        postgrest.llama("Hub.tomaConversacion", {}, token="")
    assert e.value.codigo == "SESION_EXPIRADA"
    assert not red.llamadas


def test_respuesta_fallida_se_lanza_con_su_codigo_e_info(entorno, red):
    red.respuesta = {"successful": False, "errorCode": "ESTADO_INVALIDO", "errorMessage": "ya hay otra",
                     "info": {"motivo": "CONVERSACION_ABIERTA", "idConversacion": "c9"}}
    with pytest.raises(ErrorHub) as e:
        postgrest.llama("Hub.abreConversacionExterna", {"fuente": "valuacion"})
    assert e.value.codigo == "ESTADO_INVALIDO"
    assert e.value.motivo == "CONVERSACION_ABIERTA"
    assert e.value.info["idConversacion"] == "c9"
    assert e.value.accion == "Hub.abreConversacionExterna"


def test_respuesta_regresa_el_envelope_sin_lanzar(entorno, red):
    red.respuesta = {"successful": False, "errorCode": "SIN_PERMISO", "errorMessage": "no"}
    assert postgrest.respuesta("Hub.guardaMensaje", {})["errorCode"] == "SIN_PERMISO"


@pytest.mark.parametrize("codigo,esperado", [(401, "SESION_EXPIRADA"), (403, "CONFIGURACION"), (502, "HTTP_502")])
def test_errores_http(entorno, red, codigo, esperado):
    red.error = _http_error(codigo, "detalle")
    with pytest.raises(ErrorHub) as e:
        postgrest.llama("Hub.guardaMensaje", {}, token="tok" if codigo == 401 else None)
    assert e.value.codigo == esperado


def test_sin_conexion(entorno, red):
    red.error = urllib.error.URLError("connection refused")
    with pytest.raises(ErrorHub) as e:
        postgrest.llama("Hub.guardaMensaje", {})
    assert e.value.codigo == "SIN_CONEXION"


def test_respuesta_que_no_es_del_envelope(entorno, red):
    red.respuesta = ["no", "es", "envelope"]
    with pytest.raises(ErrorHub) as e:
        postgrest.llama("Hub.guardaMensaje", {})
    assert e.value.codigo == "RESPUESTA_INVALIDA"


def test_falta_configuracion(red, monkeypatch):
    monkeypatch.delenv("URL_API_DB", raising=False)
    with pytest.raises(ErrorHub) as e:
        postgrest.llama("Hub.guardaMensaje", {})
    assert e.value.codigo == "CONFIGURACION"
    assert e.value.accion == "Hub.guardaMensaje"
    assert not red.llamadas
