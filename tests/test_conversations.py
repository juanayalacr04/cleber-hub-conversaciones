from datetime import datetime, timedelta, timezone

import pytest

from core import conversations as cv
from tests.fakes import FakeDB

NOW = datetime.now(timezone.utc)
PHONE = "whatsapp:+528186019229"


@pytest.fixture
def db():
    d = FakeDB()
    d.seed("organizations", "honda", {"name": "Honda", "sfBrandCode": "HO"})
    d.seed("teams", "honda-ventas", {"organizationId": "honda", "vertical": "ventas"})
    d.seed("teams", "honda-servicio", {"organizationId": "honda", "vertical": "servicio"})
    return d


def _new(db, **kw):
    args = dict(bot_id="b1", org_id="honda", customer_phone=PHONE, team_id="honda-ventas", db=db)
    args.update(kw)
    return cv.get_or_create_conversation(**args)


def test_crea_conversacion_con_los_ganchos_del_hub(db):
    conv_id, data, msgs = _new(db, bot_config={"name": "Asistente", "category": "Ventas"}, source="lead_webhook", external_id="L-1")
    assert msgs == []
    assert data["status"] == "bot" and data["direction"] == "inbound"
    assert data["vertical"] == "ventas"
    assert data["customerId"] == "honda_528186019229"
    assert (data["source"], data["externalId"]) == ("lead_webhook", "L-1")
    assert db.data["customers"]["honda_528186019229"]["organizationId"] == "honda"
    assert conv_id in db.data["conversations"]


def test_vertical_sale_del_equipo_si_el_bot_no_la_declara(db):
    _, data, _ = _new(db, team_id="honda-servicio", bot_config={"name": "x"})
    assert data["vertical"] == "servicio"


def test_vertical_declarada_por_el_bot_gana(db):
    _, data, _ = _new(db, team_id="honda-servicio", bot_config={"vertical": "ventas"})
    assert data["vertical"] == "ventas"


def test_reusa_la_conversacion_abierta_y_ligera_historial(db):
    conv_id, _, _ = _new(db)
    cv.add_message(conv_id, "customer", "hola", db=db)
    cv.add_message(conv_id, "bot", "buenas", db=db)
    again_id, _, msgs = _new(db)
    assert again_id == conv_id
    assert msgs == [{"is_user": True, "text": "hola"}, {"is_user": False, "text": "buenas"}]


def test_encuentra_la_conversacion_con_el_telefono_legacy_521(db):
    conv_id, _, _ = _new(db, customer_phone="whatsapp:+5218186019229")
    again_id, data, _ = _new(db, customer_phone=PHONE)
    assert again_id == conv_id
    assert data["customerPhone"] == PHONE  # se normaliza al formato recibido


def test_otra_organizacion_no_comparte_conversacion(db):
    db.seed("organizations", "nissan", {"name": "Nissan"})
    a, _, _ = _new(db)
    b, _, _ = _new(db, org_id="nissan", team_id=None)
    assert a != b


def test_sesion_expirada_cierra_con_closedAt_y_crea_otra(db):
    conv_id, _, _ = _new(db)
    db.data["conversations"][conv_id]["lastMessageAt"] = NOW - timedelta(hours=30)
    new_id, _, _ = _new(db, bot_config={"reopenWindowHours": 0})
    assert new_id != conv_id
    assert db.data["conversations"][conv_id]["status"] == "closed"
    assert db.data["conversations"][conv_id]["closedAt"] is not None


def test_reabre_cerrada_reciente_y_limpia_inactividad(db):
    conv_id, _, _ = _new(db)
    db.data["conversations"][conv_id].update(
        status="closed", closedAt=NOW - timedelta(hours=5), conversationOutcome="inactividad", conversationOutcomeAt=NOW)
    again_id, data, _ = _new(db)
    assert again_id == conv_id and data["status"] == "bot" and data["closedAt"] is None
    assert data["conversationOutcome"] is None


def test_reabre_con_el_asesor_que_la_traia(db):
    conv_id, _, _ = _new(db)
    db.data["conversations"][conv_id].update(
        status="closed", closedAt=NOW - timedelta(hours=2), statusBeforeClose="with_agent", agentBeforeClose="ag1")
    _, data, _ = _new(db)
    assert (data["status"], data["assignedAgentId"], data["assignedAgentType"]) == ("with_agent", "ag1", "human")


def test_no_reabre_fuera_de_ventana_ni_si_fue_cierre_manual(db):
    conv_id, _, _ = _new(db)
    db.data["conversations"][conv_id].update(status="closed", closedAt=NOW - timedelta(hours=200))
    assert _new(db)[0] != conv_id
    conv2, _, _ = _new(db, customer_phone="whatsapp:+528112345678")
    db.data["conversations"][conv2].update(status="closed", closedAt=NOW - timedelta(hours=1), manualClose=True)
    assert _new(db, customer_phone="whatsapp:+528112345678")[0] != conv2


def test_cerrar_re_estampa_closedAt(db):
    conv_id, _, _ = _new(db)
    cv.update_conversation_status(conv_id, "closed", db=db)
    assert db.data["conversations"][conv_id]["status"] == "closed"
    assert db.data["conversations"][conv_id]["closedAt"] is not None


def test_add_message_actualiza_el_resumen(db):
    conv_id, _, _ = _new(db)
    cv.add_message(conv_id, "customer", "x" * 150, db=db)
    conv = db.data["conversations"][conv_id]
    assert conv["lastMessagePreview"] == "x" * 100 and conv["lastMessageSender"] == "customer"
    cv.add_message(conv_id, "agent", "", agent_id="a1", media_url="http://f", db=db)
    assert db.data["conversations"][conv_id]["lastMessagePreview"].startswith("📎")


@pytest.mark.parametrize("text,expected", [("STOP", True), ("por favor stop ya", True), ("stopping", False), ("nonstop", False), ("hola", False), ("", False)])
def test_opt_out_solo_palabra_completa(text, expected):
    assert cv.is_stop_message(text) is expected


def test_conversaciones_anteriores_al_hub_reciben_su_vertical_al_volver_a_escribir(db):
    conv_id, _, _ = _new(db)
    del db.data["conversations"][conv_id]["vertical"]
    _, data, _ = _new(db)
    assert data["vertical"] == "ventas" and db.data["conversations"][conv_id]["vertical"] == "ventas"
