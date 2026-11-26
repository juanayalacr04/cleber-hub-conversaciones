"""Módulo Verificación (modules/verificacion.py): contrato ① y acción del bot, sin red ni base."""
import importlib

import pytest

from core import contrato_entrada, entrada_mensajes, postgrest
from core.postgrest import ErrorHub
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
    original = env.base.llama
    resultado = {"aplicada": True, "estado": "valido"}

    def llama(accion, params=None, **kw):
        if accion == "Hub.actualizaVerificacion":
            env.llamadas_hub.append(params)
            return {"verificacion": {"idExterno": params["idExterno"], "estado": resultado["estado"]}, "aplicada": resultado["aplicada"]}
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
