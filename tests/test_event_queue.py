import base64
import json

import pytest

import main
from channels import event_queue, ingest
from contracts import ChannelEvent, ContractError, DeliveryStatus, IncomingMessage, OutboundRecord
from tests.fakes import FakeDB

ENV = {"QUEUE_PUSH_SECRET": "s3"}


def message(**kw):
    return IncomingMessage(**{"message_id": "SM1", "provider": "twilio", "from_number": "whatsapp:+528186019229", "to_number": "whatsapp:+5255000001",
                              "body": "hola", **kw})


def push(event, **extra):
    """El sobre que manda una suscripción push de Pub/Sub."""
    data = base64.b64encode(json.dumps(event.to_dict()).encode()).decode()
    return {"message": {"data": data, "messageId": "1", **extra}, "subscription": "projects/p/subscriptions/s"}


# ---- contrato ----

@pytest.mark.parametrize("payload", [
    message(),
    message(provider="meta", to_number="", phone_number_id="123", message_id="wamid.1"),
    DeliveryStatus("meta", "wamid.1", "delivered", ""),
    OutboundRecord("whatsapp:+528186019229", "whatsapp:+5255000001", "hola", None, True, "a01"),
])
def test_el_evento_ida_y_vuelta(payload):
    event = ChannelEvent.of(payload)
    again = ChannelEvent.from_dict(json.loads(json.dumps(event.to_dict())))
    assert again.to_dict() == event.to_dict() and again.kind == event.kind


@pytest.mark.parametrize("data", [None, {}, {"kind": "otro"}, {"kind": "message"}, {"kind": "message", "message": {"provider": "twilio"}},
                                  {"schemaVersion": 99, "kind": "status", "status": {}}])
def test_un_evento_invalido_no_pasa(data):
    with pytest.raises(ContractError):
        ChannelEvent.from_dict(data)


def test_mensajes_y_ecos_de_una_conversacion_comparten_clave_de_orden():
    inbound = ChannelEvent.of(message(provider="valuetext", from_number="whatsapp:+528186019229", to_number="whatsapp:+5255000001"))
    echo = ChannelEvent.of(OutboundRecord(to_number="whatsapp:+528186019229", from_number="whatsapp:+5255000001", body="x"))
    assert inbound.ordering_key == echo.ordering_key == "5255000001_528186019229"
    other = ChannelEvent.of(message(from_number="whatsapp:+528100000000"))
    assert other.ordering_key != inbound.ordering_key                          # otro cliente, otra clave: no se bloquean entre sí


def test_los_estados_de_un_mensaje_van_en_orden_entre_si():
    sent, read = ChannelEvent.of(DeliveryStatus("twilio", "SM1", "sent")), ChannelEvent.of(DeliveryStatus("twilio", "SM1", "read"))
    assert sent.ordering_key == read.ordering_key and sent.event_id != read.event_id


# ---- publicador de Pub/Sub (con un cliente falso: la biblioteca real no se usa en pruebas) ----

class FakeFuture:
    def __init__(self, error=None):
        self.error = error

    def result(self, timeout=None):
        if self.error:
            raise self.error


class FakeClient:
    def __init__(self, fail=False):
        self.published, self.resumed, self.fail = [], [], fail

    def publish(self, topic, data, ordering_key="", **attrs):
        self.published.append((topic, json.loads(data), ordering_key, attrs))
        return FakeFuture(RuntimeError("deadline") if self.fail else None)

    def resume_publish(self, topic, key):
        self.resumed.append((topic, key))


def test_pubsub_publica_con_la_clave_de_orden():
    pub, client = event_queue.PubSubPublisher("projects/p/topics/t"), FakeClient()
    pub._client = client
    event = ChannelEvent.of(message())
    pub.publish(event)
    topic, body, key, attrs = client.published[0]
    assert topic == "projects/p/topics/t" and key == event.ordering_key and attrs == {"kind": "message"}
    assert ChannelEvent.from_dict(body).message.message_id == "SM1"


def test_pubsub_reanuda_la_clave_tras_un_fallo_y_lanza():
    pub, client = event_queue.PubSubPublisher("projects/p/topics/t"), FakeClient(fail=True)
    pub._client = client
    event = ChannelEvent.of(message())
    with pytest.raises(RuntimeError):
        pub.publish(event)
    assert client.resumed == [("projects/p/topics/t", event.ordering_key)]      # sin esto Pub/Sub bloquea la clave para siempre


def test_publicar_sin_cola_configurada_falla_en_vez_de_perder_el_evento(monkeypatch):
    monkeypatch.setattr(event_queue, "_publisher", None)
    with pytest.raises(RuntimeError):
        event_queue.publish(ChannelEvent.of(message()))


def test_sin_topico_se_procesa_en_proceso_y_con_topico_va_a_pubsub():
    seen = []
    direct = event_queue.DirectPublisher(lambda e: seen.append(("proceso", e.kind)), lambda fn, *a: fn(*a))
    assert event_queue.from_env({}, direct=direct) is direct
    direct.publish(ChannelEvent.of(message()))
    assert seen == [("proceso", "message")]
    pub = event_queue.from_env({"INCOMING_TOPIC": "projects/p/topics/t", "PUBSUB_REGION": "us-east1"}, direct=direct)
    assert isinstance(pub, event_queue.PubSubPublisher) and (pub.topic, pub.region) == ("projects/p/topics/t", "us-east1")


# ---- consumidor ----

@pytest.fixture
def applied(monkeypatch):
    calls = []
    monkeypatch.setattr(ingest.inbound, "process_incoming", lambda m, db=None: calls.append(("message", m.message_id)))
    monkeypatch.setattr(ingest, "process_twilio_status", lambda sid, status, error, db=None: calls.append(("twilio_status", sid, status, error)))
    monkeypatch.setattr(ingest, "process_meta_status", lambda update, db=None: calls.append(("meta_status", update)))
    monkeypatch.setattr(ingest, "save_agent_outbound", lambda *a, db=None: calls.append(("agent", a)))
    monkeypatch.setattr(ingest, "save_template_outbound", lambda *a, db=None: calls.append(("template", a)))
    return calls


def test_el_consumidor_aplica_cada_tipo_de_evento(applied):
    db = FakeDB()
    for payload in (message(), DeliveryStatus("twilio", "SM1", "delivered", "e"), DeliveryStatus("meta", "w1", "read"),
                    OutboundRecord("c", "b", "hola", "http://f", False, "a1"), OutboundRecord("c", "b", "plantilla", None, True, "a2")):
        assert ingest.process_event(ChannelEvent.of(payload), db) is True
    assert applied == [("message", "SM1"), ("twilio_status", "SM1", "delivered", "e"), ("meta_status", {"id": "w1", "status": "read"}),
                       ("agent", ("c", "b", "hola", "http://f")), ("template", ("c", "b", "plantilla"))]


def test_la_cola_entrega_al_menos_una_vez_el_consumidor_no_repite(applied):
    db, event = FakeDB(), ChannelEvent.of(message())
    assert ingest.process_event(event, db) is True and ingest.process_event(event, db) is False
    assert applied == [("message", "SM1")]


def test_la_marca_del_consumidor_no_choca_con_la_del_router(applied):
    from core import idempotency
    db = FakeDB()
    assert not idempotency.is_duplicate("twilio", "SM1", db=db)                   # el router ya marcó este mensaje
    assert ingest.process_event(ChannelEvent.of(message()), db) is True           # y aun así el consumidor lo procesa


def test_si_aplicar_falla_se_suelta_la_marca_para_que_el_reintento_funcione(monkeypatch):
    db, event, calls = FakeDB(), ChannelEvent.of(message()), []

    def flaky(m, db=None):
        calls.append(m.message_id)
        if len(calls) == 1:
            raise RuntimeError("firestore")
    monkeypatch.setattr(ingest.inbound, "process_incoming", flaky)
    with pytest.raises(RuntimeError):
        ingest.process_event(event, db)
    assert ingest.process_event(event, db) is True and calls == ["SM1", "SM1"]


def test_push_http_autenticacion_falla_cerrado(applied):
    db, body = FakeDB(), push(ChannelEvent.of(message()))
    assert ingest.handle({}, {}, body, ENV, db)[1] == 401
    assert ingest.handle({"secret": "malo"}, {}, body, ENV, db)[1] == 401
    assert ingest.handle({"secret": "s3"}, {}, body, {}, db)[1] == 401           # sin secreto configurado
    assert ingest.handle({"secret": "s3"}, {}, body, ENV, db) == ({"ok": True, "duplicate": False}, 200)
    assert ingest.handle({}, {"X-Queue-Secret": "s3"}, push(ChannelEvent.of(message(message_id="SM2"))), ENV, db)[1] == 200
    assert ingest.handle({}, {}, push(ChannelEvent.of(message(message_id="SM3"))), {"ALLOW_UNAUTHENTICATED_QUEUE": "true"}, db)[1] == 200
    assert applied == [("message", "SM1"), ("message", "SM2"), ("message", "SM3")]


def test_un_evento_invalido_se_descarta_con_200_para_no_bloquear_la_clave(applied):
    for body in (None, {}, {"message": {}}, {"message": {"data": "%%%no-base64"}}, {"message": {"data": base64.b64encode(b"{}").decode()}}):
        response, status = ingest.handle({"secret": "s3"}, {}, body, ENV, FakeDB())
        assert status == 200 and "discarded" in response
    assert applied == []


def test_un_fallo_transitorio_responde_500_y_se_reintenta(monkeypatch):
    monkeypatch.setattr(ingest.inbound, "process_incoming", lambda m, db=None: (_ for _ in ()).throw(RuntimeError("x")))
    db = FakeDB()
    assert ingest.handle({"secret": "s3"}, {}, push(ChannelEvent.of(message())), ENV, db)[1] == 500


def test_entry_point_del_consumidor(applied, monkeypatch):
    monkeypatch.setenv("QUEUE_PUSH_SECRET", "s3")
    monkeypatch.setattr(ingest, "idempotency", type("I", (), {"is_duplicate": staticmethod(lambda *a, **k: False), "release": staticmethod(lambda *a, **k: None)}))

    class Req:
        method, args, headers = "POST", {"secret": "s3"}, {}

        def get_json(self, silent=False):
            return push(ChannelEvent.of(message()))

    body, status, _ = main.queue_incoming(Req())
    assert status == 200 and json.loads(body)["ok"] is True and applied == [("message", "SM1")]
    Req.method = "GET"
    assert main.queue_incoming(Req())[1] == 405
