"""Módulo Verificación (modules/verificacion.py): contrato ① y acción del bot, sin red ni base."""
import importlib

import pytest

from core import contrato_entrada, entrada_mensajes, postgrest
from core.postgrest import ErrorHub
from crm import salesforce
from modules import verificacion
from tests.test_contrato_entrada import BaseFalsa, base, envios, sin_credenciales_reales, avisos  # noqa: F401
from tests.test_entrada_mensajes import env, ok  # noqa: F401

PLANTILLA = {"contentSid": "HX999", "templateName": "verificacion_telefono", "texto": "¿Es correcto este número?"}
PETICION = {"action": "Hub.abreConversacion", "params": {
    "fuente": "verificacion", "idExterno": "SF-1", "idMarca": "HO", "modulo": "verificacion", "telefono": "+525512345678",
    "alCliente": True}}


class BaseVerificacion(BaseFalsa):
    def __init__(self, plantillas=None):
        super().__init__()
        self.numero["modulo"] = "verificacion"
        self.numero["plantillas"] = {"verificacionTelefono": PLANTILLA} if plantillas is None else plantillas
        self.verificaciones: dict[str, dict] = {}

    def abreConversacionExterna(self, p):
        info = super().abreConversacionExterna(p)
        info["conversacion"]["modulo"] = "verificacion"
        return info

    def registraVerificacion(self, p):
        previa = self.verificaciones.get(p["idExterno"])
        if previa:
            if previa["valor"] != p["valor"]:
                raise ErrorHub("ESTADO_INVALIDO", "El ID ya está registrado con otro dato",
                               {"motivo": "ID_CON_OTRO_VALOR", "idExterno": p["idExterno"]})
            return {"verificacion": previa, "creada": False}
        self.verificaciones[p["idExterno"]] = {**p, "estado": "pendiente"}
        return {"verificacion": self.verificaciones[p["idExterno"]], "creada": True}


@pytest.fixture
def baseV(monkeypatch):
    from core.datos import numeros
    b = BaseVerificacion()
    monkeypatch.setattr(postgrest, "llama", b.llama)
    numeros.clear_cache()
    return b


def test_envia_la_plantilla_sin_datos_del_cliente_y_registra_la_verificacion(baseV, envios, avisos):
    r = contrato_entrada.maneja(PETICION)
    assert r["successful"] and r["info"]["enviada"] and r["info"]["idMensajeProveedor"] == "SM1"
    (enviado,) = envios.enviados
    assert enviado["phone"] == "+525512345678"
    assert enviado["plantilla"]["contentSid"] == "HX999"
    assert enviado["recipient"]["variables"] == {}
    assert baseV.verificaciones["SF-1"] == {"idExterno": "SF-1", "idMarca": "HO", "tipo": "telefono", "valor": "+525512345678",
                                           "idConversacion": "c1", "estado": "pendiente"}
    contexto, plantilla = baseV.mensajes
    assert contexto["remitente"] == "system" and "Verificar_Telefono" in contexto["texto"]
    assert plantilla["esPlantilla"] and plantilla["texto"] == "¿Es correcto este número?"


def test_mismo_id_no_reenvia_la_plantilla(baseV, envios, avisos):
    contrato_entrada.maneja(PETICION)
    r = contrato_entrada.maneja(PETICION)
    assert r["successful"] and r["info"]["creada"] is False and r["info"]["enviada"] is True
    assert len(envios.enviados) == 1


def test_mismo_id_con_otro_telefono_se_rechaza_aun_despues_del_envio(baseV, envios, avisos):
    contrato_entrada.maneja(PETICION)
    otra = {**PETICION, "params": {**PETICION["params"], "telefono": "+525599998888"}}
    r = contrato_entrada.maneja(otra)
    assert r["successful"] is False and r["errorCode"] == "ESTADO_INVALIDO" and r["info"]["motivo"] == "ID_CON_OTRO_VALOR"
    assert len(envios.enviados) == 1


def test_sin_plantilla_configurada_falla(envios, monkeypatch, avisos):
    from core.datos import numeros
    b = BaseVerificacion(plantillas={})
    monkeypatch.setattr(postgrest, "llama", b.llama)
    numeros.clear_cache()
    r = contrato_entrada.maneja(PETICION)
    assert r["successful"] is False and r["errorCode"] == "PLANTILLA_NO_CONFIGURADA"
    assert envios.enviados == []


@pytest.fixture
def conversacion(env, monkeypatch):
    importlib.reload(verificacion)
    monkeypatch.setattr(entrada_mensajes.ho, "check_business_hours", lambda *a, **k: True)
    env.base.numero["modulo"] = "verificacion"
    env.base.abre(modulo="verificacion", fuente="verificacion", idExterno="SF-1")
    env.llamadas_hub = []
    env.callbacks = []
    original = env.base.llama
    resultado = {"aplicada": True, "estado": "valido"}

    def llama(accion, params=None, **kw):
        if accion == "Hub.actualizaVerificacion":
            env.llamadas_hub.append(params)
            return {"verificacion": {"idExterno": params["idExterno"], "estado": resultado["estado"],
                                     "callback": {"estado": resultado.get("callback")},
                                     "simularCallback": resultado.get("simularCallback")}, "aplicada": resultado["aplicada"]}
        if accion == "Hub.registraCallbackVerificacion":
            env.callbacks.append(params)
            return {"verificacion": {}, "aplicada": True}
        return original(accion, params, **kw)

    monkeypatch.setattr(postgrest, "llama", llama)
    env.resultado = resultado
    return env


def accion_bot(datos, motivo="verificacion"):
    return ok("Gracias", [{"toolName": "Ejecutar_Accion_Externo",
                           "input": {"accion": "Verificar_Telefono", "motivo": motivo, "datos": datos}}])


@pytest.mark.parametrize("datos,esperado,estado", [('{"valido": true}', True, "valido"), ('{"valido": false}', False, "no_valido")])
def test_decision_del_bot_guarda_el_resultado_y_cierra_la_conversacion(conversacion, datos, esperado, estado):
    conversacion.resultado["estado"] = estado
    conversacion.estado["result"] = accion_bot(datos)
    conversacion.corre("Confirmo")
    assert conversacion.llamadas_hub == [{"idExterno": "SF-1", "valido": esperado}]
    c = conversacion.base.conv()
    assert c["estado"] == "closed" and c["resultado"] == estado
    assert [e["text"] for e in conversacion.enviados] == ["Gracias"]


@pytest.mark.parametrize("datos", ['{"valido": "true"}', '{"valido": 1}', '{}', '', 'no es json', '{"valido": null}'])
def test_respuesta_del_bot_sin_booleano_se_ignora_y_queda_pendiente(conversacion, datos):
    conversacion.estado["result"] = accion_bot(datos)
    conversacion.corre("no sé")
    assert conversacion.llamadas_hub == []
    assert conversacion.base.conv()["estado"] == "bot"


def test_sin_accion_del_bot_no_hace_nada(conversacion):
    conversacion.corre("¿quién eres?")
    assert conversacion.llamadas_hub == []
    assert conversacion.base.conv()["estado"] == "bot"


def test_no_cambia_el_resultado_si_ya_estaba_resuelta(conversacion):
    conversacion.resultado.update(aplicada=False, estado="valido")
    conversacion.estado["result"] = accion_bot('{"valido": false}')
    conversacion.corre("No es mi número")
    c = conversacion.base.conv()
    assert c["estado"] == "closed" and c["resultado"] == "valido"


def test_ignora_conversaciones_de_otra_fuente(conversacion):
    conversacion.base.conv().update(fuente="valuacion")
    conversacion.estado["result"] = accion_bot('{"valido": true}')
    conversacion.corre("Confirmo")
    assert conversacion.llamadas_hub == []
    assert conversacion.base.conv()["estado"] == "bot"


def accion_workflow(accion, texto=""):
    return {"success": True, "result": {"response": {"segments": [
        {"type": "text", "id": "response", "segment": texto},
        {"type": "text", "id": "action", "segment": accion}]}}}


@pytest.mark.parametrize("accion,esperado,estado", [("result_confirmado", True, "valido"), ("result_declinado", False, "no_valido")])
def test_workflow_con_segmento_action_guarda_el_resultado(conversacion, accion, esperado, estado):
    conversacion.resultado["estado"] = estado
    conversacion.estado["result"] = accion_workflow(accion)
    conversacion.corre("Confirmo")
    assert conversacion.llamadas_hub == [{"idExterno": "SF-1", "valido": esperado}]
    c = conversacion.base.conv()
    assert c["estado"] == "closed" and c["resultado"] == estado
    assert conversacion.enviados == []


def test_workflow_con_accion_desconocida_se_ignora(conversacion):
    conversacion.estado["result"] = accion_workflow("otra_cosa")
    conversacion.corre("hola")
    assert conversacion.llamadas_hub == []
    assert conversacion.base.conv()["estado"] == "bot"


@pytest.mark.parametrize("accion,estado,celular", [("result_confirmado", "valido", True), ("result_declinado", "no_valido", False)])
def test_entrega_el_resultado_a_sf_y_lo_asienta(conversacion, monkeypatch, accion, estado, celular):
    enviados = []
    monkeypatch.setattr(salesforce, "actualiza_validacion_cuenta", lambda i, celular=None, **k: enviados.append((i, celular)) or (True, "001X"))
    conversacion.resultado.update(estado=estado, callback="pendiente")
    conversacion.estado["result"] = accion_workflow(accion)
    conversacion.corre("Confirmo")
    assert enviados == [("SF-1", celular)]
    assert conversacion.callbacks == [{"idExterno": "SF-1", "entregado": True}]


def test_entrega_simulada_no_llama_a_sf_y_lo_asienta(conversacion, monkeypatch):
    monkeypatch.setattr(salesforce.http, "request", lambda *a, **k: pytest.fail("no debía salir a la red"))
    conversacion.resultado.update(estado="valido", callback="pendiente", simularCallback=True)
    conversacion.estado["result"] = accion_workflow("result_confirmado")
    conversacion.corre("Confirmo")
    assert conversacion.callbacks == [{"idExterno": "SF-1", "entregado": True, "simulado": True}]


def test_si_sf_falla_se_asienta_el_error_y_el_turno_sigue(conversacion, monkeypatch):
    monkeypatch.setattr(salesforce, "actualiza_validacion_cuenta", lambda *a, **k: (False, "HTTP 401"))
    conversacion.resultado.update(estado="valido", callback="pendiente")
    conversacion.estado["result"] = accion_workflow("result_confirmado")
    conversacion.corre("Confirmo")
    assert conversacion.callbacks == [{"idExterno": "SF-1", "entregado": False, "error": "HTTP 401"}]
    assert conversacion.base.conv()["estado"] == "closed"


@pytest.mark.parametrize("callback", ["enviado", None])
def test_no_vuelve_a_avisar_a_sf_si_ya_se_entrego_o_no_hay_resultado(conversacion, monkeypatch, callback):
    monkeypatch.setattr(salesforce, "actualiza_validacion_cuenta", lambda *a, **k: pytest.fail("no debía llamar a SF"))
    conversacion.resultado.update(estado="valido", callback=callback)
    conversacion.estado["result"] = accion_workflow("result_confirmado")
    conversacion.corre("Confirmo")
    assert conversacion.callbacks == []


def test_reintenta_el_callback_fallido_cuando_el_bot_repite_la_accion(conversacion, monkeypatch):
    monkeypatch.setattr(salesforce, "actualiza_validacion_cuenta", lambda *a, **k: (True, "001X"))
    conversacion.resultado.update(aplicada=False, estado="valido", callback="fallido")
    conversacion.estado["result"] = accion_workflow("result_confirmado")
    conversacion.corre("Confirmo")
    assert conversacion.callbacks == [{"idExterno": "SF-1", "entregado": True}]


class TestClienteSF:
    def _http(self, monkeypatch, respuesta):
        llamadas = []

        def request(url, data=None, headers=None, method="POST", timeout=30):
            llamadas.append((url, data, headers, method))
            if isinstance(respuesta, Exception):
                raise respuesta
            return 200, respuesta
        monkeypatch.setattr(salesforce.http, "request", request)
        return llamadas

    def test_arma_el_patch_con_apikey_y_cuerpo(self, monkeypatch):
        monkeypatch.setenv("SF_VALIDACION_URL", "https://sf.test/apexrest/accounts/validacion/")
        monkeypatch.setenv("SF_VALIDACION_API_KEY", "k")
        llamadas = self._http(monkeypatch, '{"success": true, "message": "ok", "recordId": "001A"}')
        assert salesforce.actualiza_validacion_cuenta("123456", celular=True) == (True, "001A")
        url, data, headers, metodo = llamadas[0]
        assert (url, metodo, headers["ApiKey"]) == ("https://sf.test/apexrest/accounts/validacion/123456", "PATCH", "k")
        import json
        assert json.loads(data) == {"validacionCelular": True, "validacionCelularJson": "{}",
                                    "validacionCorreo": False, "validacionCorreoJson": "{}"}

    def test_sin_configuracion_o_con_success_falso_o_error_http_no_es_ok(self, monkeypatch):
        monkeypatch.delenv("SF_VALIDACION_URL", raising=False)
        assert salesforce.actualiza_validacion_cuenta("1", celular=True)[0] is False
        monkeypatch.setenv("SF_VALIDACION_URL", "https://sf.test/v")
        monkeypatch.setenv("SF_VALIDACION_API_KEY", "k")
        self._http(monkeypatch, '{"success": false}')
        assert salesforce.actualiza_validacion_cuenta("1", celular=True)[0] is False
        self._http(monkeypatch, OSError("sin red"))
        assert salesforce.actualiza_validacion_cuenta("1", celular=True) == (False, "sin red")

    def test_simulacion_no_toca_la_red_ni_pide_configuracion(self, monkeypatch):
        monkeypatch.delenv("SF_VALIDACION_URL", raising=False)
        monkeypatch.delenv("SF_VALIDACION_API_KEY", raising=False)
        llamadas = self._http(monkeypatch, "{}")
        assert salesforce.actualiza_validacion_cuenta("123", celular=True, simular=True) == (True, "QA-SIMULATED-123")
        assert llamadas == []
