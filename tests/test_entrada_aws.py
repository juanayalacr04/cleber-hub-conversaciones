"""Entrada en AWS: router (handlers.router), publicador SQS, consumidor de la cola (channels/cola_sqs.py) y firma de Twilio
con el token del ambiente. Sin red: la cola y Twilio son falsos."""
import json
from urllib.parse import urlencode

import pytest

import handlers
from channels import cola_sqs, event_queue, signatures, webhook_auth, webhooks
from contracts.messages import ChannelEvent, IncomingMessage

BASE = "https://api.example.com/dev"
FORM = {"From": "whatsapp:+5218186019229", "To": "whatsapp:+5215500000001", "Body": "Me interesa", "MessageSid": "SM1",
        "ProfileName": "Juan"}


def _firma(token, url, form):
    import base64
    import hashlib
    import hmac
    datos = url + "".join(k + form[k] for k in sorted(form))
    return base64.b64encode(hmac.new(token.encode(), datos.encode(), hashlib.sha1).digest()).decode()


class SqsFalso:
    def __init__(self):
        self.enviados = []

    def send_message(self, **kw):
        self.enviados.append(kw)


def _evento_api(form, firma, path="/webhook/twilio"):
    return {"httpMethod": "POST", "path": path, "requestContext": {"stage": "dev"},
            "headers": {"Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": firma},
            "queryStringParameters": None, "body": urlencode(form), "isBase64Encoded": False}


@pytest.fixture
def router(monkeypatch):
    sqs = SqsFalso()
    monkeypatch.setattr(handlers, "_prepara", lambda: None)
    monkeypatch.setenv("TWILIO_AUTH_TOKEN", "tok")
    monkeypatch.setenv("PUBLIC_BASE_URL", BASE)
    monkeypatch.setenv("COLA_ENTRANTES_URL", "https://sqs/cola.fifo")
    monkeypatch.setattr(event_queue, "_publisher", None)
    monkeypatch.setattr(webhooks, "DEDUPLICA_EN_FIRESTORE", True)
    handlers._prepara_router()
    event_queue._publisher._client = sqs
    return sqs


def test_router_valida_firma_y_publica_en_sqs_fifo(router):
    resp = handlers.router(_evento_api(FORM, _firma("tok", BASE + "/webhook/twilio", FORM)))
    assert resp["statusCode"] == 200
    enviado = router.enviados[0]
    assert enviado["QueueUrl"] == "https://sqs/cola.fifo"
    assert enviado["MessageGroupId"] == "5215500000001_528186019229"     # número + cliente (ya sin el 1 de México)
    assert enviado["MessageDeduplicationId"] == "message-twilio__SM1"
    msg = ChannelEvent.from_dict(json.loads(enviado["MessageBody"])).message
    assert (msg.body, msg.from_number, msg.contact_name) == ("Me interesa", "whatsapp:+528186019229", "Juan")
    assert webhooks.DEDUPLICA_EN_FIRESTORE is False


def test_router_rechaza_firma_invalida(router):
    resp = handlers.router(_evento_api(FORM, "firma-falsa"))
    assert resp["statusCode"] == 403 and router.enviados == []


def test_router_responde_500_si_la_cola_falla(router):
    def falla(**kw):
        raise RuntimeError("SQS caído")
    router.send_message = falla
    resp = handlers.router(_evento_api(FORM, _firma("tok", BASE + "/webhook/twilio", FORM)))
    assert resp["statusCode"] == 500


def test_firma_de_twilio_con_token_del_ambiente_no_busca_el_numero():
    url = BASE + "/webhook/twilio"
    env = {"TWILIO_AUTH_TOKEN": "tok"}
    assert webhook_auth.twilio_authorized(url, FORM, {"X-Twilio-Signature": _firma("tok", url, FORM)}, env=env)
    assert not webhook_auth.twilio_authorized(url, FORM, {"X-Twilio-Signature": _firma("otro", url, FORM)}, env=env)
    assert signatures.valid_twilio("tok", url, FORM, _firma("tok", url, FORM))


def _registro(evento: ChannelEvent | None, id_mensaje="r1", cuerpo=None):
    return {"messageId": id_mensaje, "body": cuerpo if cuerpo is not None else json.dumps(evento.to_dict())}


def _mensaje(mid="SM1"):
    return ChannelEvent.of(IncomingMessage(message_id=mid, provider="twilio", from_number="whatsapp:+528186019229",
                                           to_number="whatsapp:+5215500000001", body="hola"))


def test_consumidor_reporta_solo_los_fallidos():
    aplicados = []

    def aplica(ev):
        if ev.message.message_id == "SM2":
            raise RuntimeError("PostgREST no responde")
        aplicados.append(ev.message.message_id)

    resp = cola_sqs.consume({"Records": [_registro(_mensaje("SM1"), "r1"), _registro(_mensaje("SM2"), "r2")]}, aplica)
    assert aplicados == ["SM1"]
    assert resp == {"batchItemFailures": [{"itemIdentifier": "r2"}]}


def test_consumidor_descarta_lo_que_no_cumple_el_contrato():
    resp = cola_sqs.consume({"Records": [_registro(None, "r1", cuerpo="{no es json"), _registro(None, "r2", cuerpo='{"kind": "x"}')]},
                            lambda ev: pytest.fail("no debe aplicarse"))
    assert resp == {"batchItemFailures": []}


def test_entrantes_manda_los_mensajes_al_pipeline(monkeypatch):
    procesados = []
    monkeypatch.setattr(handlers, "_prepara", lambda: None)
    monkeypatch.setattr(handlers.entrada_mensajes, "procesa", lambda msg, send: procesados.append(msg.message_id))
    resp = handlers.entrantes({"Records": [_registro(_mensaje("SM9"))]})
    assert procesados == ["SM9"] and resp == {"batchItemFailures": []}


def test_entrantes_devuelve_todo_el_lote_si_no_se_puede_preparar(monkeypatch):
    def falla():
        raise RuntimeError("sin secreto")
    monkeypatch.setattr(handlers, "_prepara", falla)
    resp = handlers.entrantes({"Records": [_registro(_mensaje(), "r1"), _registro(_mensaje("SM2"), "r2")]})
    assert resp == {"batchItemFailures": [{"itemIdentifier": "r1"}, {"itemIdentifier": "r2"}]}
