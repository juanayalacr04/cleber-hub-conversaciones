from datetime import datetime, timedelta, timezone

import pytest

from ai import engine
from contracts.bot import BotError, SummaryRequest, SummaryResponse
from core import bot_client, expediente, http, pipeline
from jobs import runner, summaries
from tests.fakes import FakeDB

NOW = datetime(2026, 10, 20, 12, tzinfo=timezone.utc)
CARD = "honda_528186019229"
PHONE = "whatsapp:+528186019229"


class Summarizer(list):
    """Sustituto de la función 3: registra las peticiones y contesta `text` (vacío = falla)."""

    def __init__(self, text="Quería cotizar una HR-V."):
        super().__init__()
        self.text = text

    def __call__(self, request):
        self.append(request)
        return SummaryResponse(ok=True, summary=self.text) if self.text else SummaryResponse(ok=False, error=BotError("bot_error", "x"))


def seed_conv(db, cid="c1", closed_ago=timedelta(hours=1), messages=(("customer", "hola"), ("bot", "¿en qué te ayudo?")), **extra):
    db.seed("conversations", cid, {"organizationId": "honda", "customerPhone": PHONE, "botId": "b1", "status": "closed",
                                   "closedAt": NOW - closed_ago, **extra})
    for i, (sender, text) in enumerate(messages):
        db.seed(f"conversations/{cid}/messages", f"m{i}", {"sender": sender, "text": text, "createdAt": NOW - timedelta(hours=5) + timedelta(minutes=i)})


@pytest.fixture
def db():
    d = FakeDB()
    d.seed("customers", CARD, {"name": "Ana", "organizationId": "honda"})
    return d


def test_sin_resumenes_el_expediente_solo_trae_el_nombre(db):
    e = expediente.load(db, "honda", "whatsapp:+5218186019229")      # la clave normaliza el teléfono
    assert e.datos == {"nombre": "Ana"} and e.resumenes == []


def test_cliente_nuevo_o_sin_organizacion_es_un_expediente_vacio(db):
    assert expediente.load(db, "kia", PHONE).to_dict() == {"datos": {}, "resumenes": []}
    assert expediente.load(db, None, PHONE).to_dict() == {"datos": {}, "resumenes": []}


def test_un_fallo_al_leer_no_tumba_al_bot():
    class Roto:
        def collection(self, name):
            raise RuntimeError("firestore caído")
    assert expediente.load(Roto(), "honda", PHONE).resumenes == []


def test_resumir_guarda_en_la_ficha_y_marca_la_conversacion(db):
    seed_conv(db)
    s = Summarizer()
    assert expediente.summarize(db, "c1", db.data["conversations"]["c1"], s) == "saved"
    assert s[0].conversation_id == "c1" and [(h.role, h.text) for h in s[0].history] == [("customer", "hola"), ("bot", "¿en qué te ayudo?")]
    assert db.data[f"customers/{CARD}/summaries"]["c1"]["summary"] == "Quería cotizar una HR-V."
    assert db.data["conversations"]["c1"]["summaryAt"]
    assert expediente.load(db, "honda", PHONE).resumenes == ["Quería cotizar una HR-V."]


def test_los_ultimos_resumenes_van_del_mas_viejo_al_mas_reciente_y_son_tres(db):
    for i in range(5):
        db.seed(f"customers/{CARD}/summaries", f"c{i}", {"summary": f"s{i}", "closedAt": NOW - timedelta(days=5 - i)})
    assert expediente.load(db, "honda", PHONE).resumenes == ["s2", "s3", "s4"]


def test_el_resumen_nuevo_recibe_los_anteriores_de_contexto(db):
    db.seed(f"customers/{CARD}/summaries", "viejo", {"summary": "Antes pidió cita", "closedAt": NOW - timedelta(days=9)})
    seed_conv(db)
    s = Summarizer()
    expediente.summarize(db, "c1", db.data["conversations"]["c1"], s)
    assert s[0].previous_summaries == ["Antes pidió cita"]


def test_sin_mensajes_del_cliente_no_se_resume_ni_se_reintenta(db):
    seed_conv(db, messages=(("bot", "plantilla de campaña"), ("agent", "hola")))
    s = Summarizer()
    assert expediente.summarize(db, "c1", db.data["conversations"]["c1"], s) == "skipped"
    assert s == [] and db.data["conversations"]["c1"]["summaryAt"]


def test_notas_y_mensajes_de_sistema_no_van_al_resumen(db):
    seed_conv(db, messages=(("system", "<<CONTEXTO>>"), ("customer", "hola"), ("note", "nota interna"), ("agent", "te atiendo")))
    s = Summarizer()
    expediente.summarize(db, "c1", db.data["conversations"]["c1"], s)
    assert [(h.role, h.text) for h in s[0].history] == [("customer", "hola"), ("bot", "te atiendo")]


def test_si_la_funcion_3_falla_no_se_guarda_nada(db):
    seed_conv(db)
    assert expediente.summarize(db, "c1", db.data["conversations"]["c1"], Summarizer(text="")) == "failed"
    assert f"customers/{CARD}/summaries" not in db.data and "summaryAt" not in db.data["conversations"]["c1"]


# ---- el job ----

def test_el_job_resume_lo_pendiente_una_sola_vez(db):
    seed_conv(db, "c1")
    seed_conv(db, "c2", closed_ago=timedelta(days=10))                      # fuera de la ventana: el expediente arranca vacío
    s = Summarizer()
    assert summaries.run(db, NOW, s) == {"saved": 1, "skipped": 0, "failed": 0}
    assert summaries.run(db, NOW, s) == {"saved": 0, "skipped": 0, "failed": 0} and len(s) == 1


def test_una_reapertura_y_nuevo_cierre_vuelve_a_resumir(db):
    seed_conv(db, "c1", summaryAt=NOW - timedelta(minutes=30))
    s = Summarizer()
    assert summaries.run(db, NOW, s)["saved"] == 0                           # resumen posterior al cierre: nada que hacer
    db.data["conversations"]["c1"]["closedAt"] = NOW - timedelta(minutes=5)  # se cerró otra vez
    assert summaries.run(db, NOW, s)["saved"] == 1


def test_los_fallos_se_reintentan_y_un_tick_tiene_tope(db, monkeypatch):
    seed_conv(db, "c1")
    assert summaries.run(db, NOW, Summarizer(text="")) == {"saved": 0, "skipped": 0, "failed": 1}
    assert summaries.run(db, NOW, Summarizer())["saved"] == 1
    monkeypatch.setattr(summaries, "MAX_PER_TICK", 2)
    for i in range(5):
        seed_conv(db, f"x{i}")
    assert sum(summaries.run(db, NOW, Summarizer()).values()) == 2


def test_el_job_esta_registrado():
    assert "conversation-summaries" in runner.JOBS


# ---- cliente de la función 3 ----

def test_cliente_sin_configuracion_no_llama_a_nadie(monkeypatch):
    monkeypatch.setattr(http, "request", lambda *a, **k: pytest.fail("no debía haber red"))
    r = bot_client.summarize(SummaryRequest("b1", "c1", []), env={})
    assert not r.ok and r.error.code == "bot_function_no_configurada"


def test_cliente_manda_el_secreto_y_lee_la_respuesta(monkeypatch):
    seen = {}

    def fake(url, data=None, headers=None, method="POST", timeout=30):
        seen.update(url=url, headers=headers)
        return 200, '{"schemaVersion": 1, "ok": true, "summary": "Listo"}'
    monkeypatch.setattr(http, "request", fake)
    r = bot_client.summarize(SummaryRequest("b1", "c1", []), env={"BOT_FUNCTION_URL": "https://f3.example/", "BOT_FUNCTION_SECRET": "s3"})
    assert r.ok and r.summary == "Listo"
    assert seen["url"] == "https://f3.example/bot/summary" and seen["headers"]["X-Service-Secret"] == "s3"


def test_cliente_tipa_los_fallos_de_red(monkeypatch):
    def boom(*a, **k):
        raise OSError("sin ruta")
    monkeypatch.setattr(http, "request", boom)
    r = bot_client.summarize(SummaryRequest("b1", "c1", []), env={"BOT_FUNCTION_URL": "https://f3", "BOT_FUNCTION_SECRET": "s"})
    assert not r.ok and r.error.code == "red" and r.error.retryable


# ---- al bot ----

def test_el_pipeline_le_da_el_expediente_al_bot_en_una_conversacion_nueva(db, monkeypatch):
    db.seed(f"customers/{CARD}/summaries", "viejo", {"summary": "Pidió cotización de HR-V", "closedAt": NOW - timedelta(days=2)})
    seen = []
    monkeypatch.setattr(engine, "send_to_bot", lambda bot, msgs, conv_id=None, customer_phone="": seen.append(msgs) or {"success": True, "result": {"response": "Hola Ana", "toolResults": []}})
    bot = {"id": "b1", "organizationId": "honda", "type": "chatllm", "name": "Bot"}
    inc = pipeline.Incoming(provider="valuetext", from_number=PHONE, to_number="whatsapp:+5255", body="hola")
    pipeline.process_message(inc, bot, lambda *a, **k: None, db=db)
    text = seen[0][-1]["text"]
    assert "[Expediente del cliente]" in text and "Pidió cotización de HR-V" in text and "Ana" in text and text.endswith("hola")
