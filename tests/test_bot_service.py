import json

import pytest

import main
from ai import engine, service
from contracts.bot import BotRequest, BotResponse, Expediente, HistoryItem, SummaryRequest
from core import numbers
from tests.fakes import FakeDB

ENV = {"BOT_FUNCTION_SECRET": "s3"}
HEADERS = {"X-Service-Secret": "s3"}


@pytest.fixture
def db(monkeypatch):
    d = FakeDB()
    d.seed("bots", "b1", {"organizationId": "honda", "type": "chatllm", "abacusConfig": {"deploymentId": "d", "deploymentToken": "t"}})
    d.seed("bots", "ext", {"organizationId": "honda", "type": "external", "externalConfig": {"endpoint": "http://bot"}})
    monkeypatch.setattr(numbers, "get_db", lambda: d)
    return d


class Engine(list):
    """Registra cada llamada al motor y contesta con `reply`, que cada prueba puede cambiar."""
    reply = {"success": True, "result": {"response": "¡Hola!", "toolResults": []}}

    def __call__(self, bot, messages, conv_id=None, customer_phone=""):
        self.append({"bot": bot["id"], "messages": messages, "conv_id": conv_id, "phone": customer_phone})
        return self.reply


@pytest.fixture
def sent(monkeypatch):
    fake = Engine()
    monkeypatch.setattr(engine, "send_to_bot", fake)
    return fake


def turn(**kw):
    return BotRequest(bot_id=kw.pop("bot_id", "b1"), conversation_id="c1", message="hola", customer_phone="whatsapp:+52", **kw)


def test_un_turno_devuelve_el_texto(db, sent):
    r = service.run_turn(turn(), db)
    assert r.ok and r.text == "¡Hola!" and not r.handoff and r.motivo is None and r.actions == []
    assert sent == [{"bot": "b1", "messages": [{"is_user": True, "text": "hola"}], "conv_id": "c1", "phone": "whatsapp:+52"}]


def test_el_historial_solo_viaja_al_bot_externo(db, sent):
    history = [HistoryItem("customer", "a"), HistoryItem("bot", "b")]
    service.run_turn(turn(history=history), db)
    service.run_turn(turn(bot_id="ext", history=history), db)
    assert len(sent[0]["messages"]) == 1
    assert sent[1]["messages"] == [{"is_user": True, "text": "a"}, {"is_user": False, "text": "b"}, {"is_user": True, "text": "hola"}]


def test_el_expediente_se_antepone_solo_si_trae_algo(db, sent):
    service.run_turn(turn(expediente=Expediente(datos={"nombre": "Ana"}, resumenes=["Pidió cotización"])), db)
    text = sent[0]["messages"][-1]["text"]
    assert text.startswith("[Expediente del cliente]") and "Ana" in text and "Pidió cotización" in text and text.endswith("hola")


def test_handoff_y_motivo_salen_del_resultado(db, sent):
    sent.reply = {"success": True, "result": {"response": "Te paso", "toolResults": [
        {"toolName": "Transferir_a_Asesor", "input": {"motivo": "quiere humano"}},
        {"toolName": "Clasificar_Motivo", "input": {"motivo": "interes_cita"}}]}}
    r = service.run_turn(turn(), db)
    assert r.handoff and r.handoff_motivo == "quiere humano" and r.motivo == "interes_cita"


def test_el_bot_externo_devuelve_sus_acciones_y_los_demas_no(db, sent):
    sent.reply = {"success": True, "result": {"response": "ok", "toolResults": [], "actions": [{"name": "Crear_Lead", "params": {"x": 1}}]}}
    assert [(a.name, a.params) for a in service.run_turn(turn(bot_id="ext"), db).actions] == [("Crear_Lead", {"x": 1})]
    assert service.run_turn(turn(), db).actions == []


@pytest.mark.parametrize("error,code,retryable", [("Error: timed out", "timeout", True), ("Error: connection reset", "bot_error", True),
                                                   ("HTTP 500: boom", "bot_error", False)])
def test_los_errores_del_motor_son_tipados(db, sent, error, code, retryable):
    sent.reply = {"error": error}
    r = service.run_turn(turn(), db)
    assert not r.ok and r.error.code == code and r.error.retryable is retryable


def test_bot_inexistente(db, sent):
    r = service.run_turn(turn(bot_id="nope"), db)
    assert not r.ok and r.error.code == "bot_no_configurado" and sent == []


def test_resumen_en_una_sesion_aparte(db, sent):
    sent.reply = {"success": True, "result": {"response": " Quería una cotización. ", "toolResults": []}}
    r = service.run_summary(SummaryRequest("b1", "c1", [HistoryItem("customer", "quiero cotizar"), HistoryItem("bot", "claro")], ["Antes: cita"]), db)
    assert r.ok and r.summary == "Quería una cotización."
    assert sent[0]["conv_id"] == "c1-resumen"
    prompt = sent[0]["messages"][0]["text"]
    assert "Cliente: quiero cotizar" in prompt and "Asistente: claro" in prompt and "Resumen anterior: Antes: cita" in prompt


def test_resumen_con_error(db, sent):
    sent.reply = {"error": "HTTP 500: x"}
    assert not service.run_summary(SummaryRequest("b1", "c1", []), db).ok


# ---- HTTP ----

def test_autenticacion_falla_cerrado(db, sent):
    body = turn().to_dict()
    assert service.handle("/bot/turn", {}, body, ENV, db)[1] == 401
    assert service.handle("/bot/turn", {"X-Service-Secret": "malo"}, body, ENV, db)[1] == 401
    assert service.handle("/bot/turn", HEADERS, body, {}, db)[1] == 401                          # sin secreto configurado
    assert service.handle("/bot/turn", {}, body, {"ALLOW_UNAUTHENTICATED_BOT": "true"}, db)[1] == 200
    assert sent and len(sent) == 1


def test_rutas_y_contrato(db, sent):
    ok, status = service.handle("/bot/turn", HEADERS, turn().to_dict(), ENV, db)
    assert status == 200 and BotResponse.from_dict(ok).text == "¡Hola!"
    assert service.handle("/otra", HEADERS, {}, ENV, db)[1] == 404
    assert service.handle("/bot/turn", HEADERS, {"botId": "b1"}, ENV, db)[1] == 400              # incumple el contrato
    assert service.handle("/bot/turn", HEADERS, None, ENV, db)[1] == 400


def test_entry_point(db, sent, monkeypatch):
    monkeypatch.setenv("BOT_FUNCTION_SECRET", "s3")
    monkeypatch.setattr(service, "get_db", lambda: db)

    class Req:
        method, path, headers = "POST", "/bot/turn", HEADERS

        def get_json(self, silent=False):
            return turn().to_dict()

    body, status, _ = main.bot(Req())
    assert status == 200 and json.loads(body)["text"] == "¡Hola!"
    Req.method = "GET"
    assert main.bot(Req())[1] == 405
