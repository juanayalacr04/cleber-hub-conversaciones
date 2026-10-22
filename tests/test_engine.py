import json
from io import BytesIO

import pytest

from ai import engine
from ai.parsing import detect, detect_handoff
from core import http

MSGS = [{"is_user": True, "text": "hola"}, {"is_user": False, "text": "buenas"}, {"is_user": True, "text": "quiero cotizar"}]


class Script:
    def __init__(self, *responses):
        self.calls, self._r = [], list(responses)

    def __call__(self, url, data=None, headers=None, method="POST", timeout=30):
        self.calls.append({"url": url, "payload": json.loads(data) if data else None, "headers": headers or {}, "method": method})
        r = self._r.pop(0)
        if isinstance(r, Exception):
            raise r
        return 200, json.dumps(r)


@pytest.fixture(autouse=True)
def _limpio():
    engine.clear_caches()


def _patch(monkeypatch, *responses):
    s = Script(*responses)
    monkeypatch.setattr(http, "request", s)
    return s


def test_chatllm_usa_el_host_dedicado_y_manda_el_ultimo_mensaje(monkeypatch):
    s = _patch(monkeypatch, {"success": True, "result": {"response": "ok"}})
    bot = {"type": "chatllm", "abacusConfig": {"deploymentId": "D", "deploymentToken": "T"}}
    assert engine.send_to_bot(bot, MSGS, conv_id="c1")["success"] is True
    call = s.calls[0]
    assert call["url"] == "https://cleber.abacus.ai/api/v0/getConversationResponse"
    assert call["payload"] == {"deploymentToken": "T", "deploymentId": "D", "message": "quiero cotizar", "executeUsercodeTools": True, "externalSessionId": "c1"}
    assert call["headers"]["User-Agent"] == "WhatsAppProxy/2.0"


def test_chatllm_host_por_bot(monkeypatch):
    s = _patch(monkeypatch, {"success": True})
    engine.send_to_bot({"abacusConfig": {"apiHost": "https://api.abacus.ai"}}, MSGS)
    assert s.calls[0]["url"].startswith("https://api.abacus.ai/api/v0/getConversationResponse")


def test_workflow_resuelve_el_proxy_y_manda_apikey_y_telefono(monkeypatch):
    s = _patch(monkeypatch, {"result": {"proxyEndpoint": "https://proxy.example"}}, {"success": True, "result": {"response": "ok"}})
    bot = {"type": "workflow", "abacusConfig": {"deploymentId": "D", "deploymentToken": "T", "apiKey": "K", "workflowInputName": "texto"}}
    engine.send_to_bot(bot, MSGS, conv_id="c1", customer_phone="+52")
    lookup, call = s.calls
    assert lookup["method"] == "GET" and "deploymentId=D" in lookup["url"]
    assert call["url"].startswith("https://proxy.example/api/executeSyncConversationAgent?")
    assert call["headers"]["APIKEY"] == "K"
    assert call["payload"] == {"keywordArguments": {"texto": "quiero cotizar", "telefono_cliente": "+52"}, "externalSessionId": "c1"}
    engine.send_to_bot(bot, MSGS)  # el proxy se cachea: solo una llamada más
    assert len(s.calls) == 3


def test_workflow_sin_proxy_devuelve_error(monkeypatch):
    _patch(monkeypatch, {"result": {}})
    assert "error" in engine.send_to_bot({"type": "workflow", "abacusConfig": {}}, MSGS)


def test_externo_normaliza_el_contrato_nuevo_y_el_legado(monkeypatch):
    s = _patch(monkeypatch,
               {"response": "Oferta lista", "actions": [{"name": "oferta_aceptada", "params": {"vin": "X1"}}]},
               {"response": "Te paso", "action": "handoff", "metadata": {"motivo": "pidió asesor"}},
               {"response": "Gracias", "action": "guardar_nombre", "metadata": {"nombre": "Ana"}})
    bot = {"type": "external", "externalConfig": {"endpoint": "https://bot.example/chat", "apiKey": "K"}}
    r1 = engine.send_to_bot(bot, MSGS, conv_id="c1", customer_phone="+52")
    assert s.calls[0]["headers"]["Authorization"] == "Bearer K"
    assert s.calls[0]["payload"]["history"][0] == {"role": "customer", "text": "hola"}
    assert detect(r1, "external", "oferta_aceptada") == {"triggered": True, "input": {"vin": "X1"}}
    r2 = engine.send_to_bot({"type": "vertex_ai", "vertexAiConfig": {"endpoint": "https://v"}}, MSGS)
    assert detect_handoff(r2, "vertex_ai") == {"triggered": True, "motivo": "pidió asesor"}
    r3 = engine.send_to_bot(bot, MSGS)
    assert detect(r3, "external", "Guardar_Nombre_Cliente")["input"] == {"nombre": "Ana"}


def test_externo_sin_endpoint(monkeypatch):
    assert engine.send_to_bot({"type": "external"}, MSGS) == {"error": "externalConfig.endpoint not configured"}


def test_errores_http_y_de_red_se_devuelven_como_error(monkeypatch):
    _patch(monkeypatch, http.HTTPError("u", 429, "x", {}, BytesIO(b"rate limit")))
    assert engine.send_to_bot({"abacusConfig": {}}, MSGS) == {"error": "HTTP 429: rate limit"}
    _patch(monkeypatch, OSError("sin red"))
    assert engine.send_to_bot({"abacusConfig": {}}, MSGS)["error"].startswith("Error:")
