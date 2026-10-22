import importlib

import pytest

from core import broadcast_actions, user_actions as ua
from tests.fakes import FakeDB

TOKENS = {"t-ana": "ana", "t-vera": "vera", "t-olga": "olga"}


def verifier(token):
    return {"uid": TOKENS[token]} if token in TOKENS else None


@pytest.fixture(autouse=True)
def acciones():
    ua.clear()
    importlib.reload(broadcast_actions)
    yield
    ua.clear()


@pytest.fixture
def db():
    d = FakeDB()
    d.seed("users", "ana", {"role": "agent", "organizationIds": ["honda"]})
    d.seed("users", "vera", {"role": "viewer", "organizationIds": ["honda"]})
    d.seed("users", "olga", {"role": "admin", "organizationIds": ["kia"]})
    d.seed("teams", "servicio", {"organizationId": "honda", "vertical": "servicio"})
    d.seed("whatsappNumbers", "n1", {"organizationId": "honda", "teamId": "servicio"})
    d.seed("whatsappNumbers", "n-sin-equipo", {"organizationId": "honda"})
    d.seed("whatsappNumbers", "n-kia", {"organizationId": "kia"})
    d.seed("bots", "bot1", {"organizationId": "honda", "category": "Ventas"})
    d.seed("bots", "bot-kia", {"organizationId": "kia"})
    return d


BASE = {"name": "Promo", "whatsappNumberId": "n1", "botId": "bot1", "templateName": "promo_marzo", "templateBody": "Hola"}
PEOPLE = [{"phone": "5218111111111", "name": "Ana", "variables": {"1": "x"}, "salesforceRecordId": "001"},
          {"phone": "+5218122222222"}]


def create(db, token="t-ana", fields=None, recipients=PEOPLE, **extra):
    return ua.handle({"Authorization": f"Bearer {token}"},
                     {"action": "broadcast.create", "data": {"organizationId": "honda", "fields": fields or BASE,
                                                              "recipients": recipients, **extra}}, db=db, verifier=verifier)


def test_crea_la_campana_en_borrador_con_destinatarios_pendientes(db):
    body, status = create(db)
    assert status == 200
    b = db.data["broadcasts"][body["result"]["id"]]
    assert (b["id"], b["organizationId"], b["status"], b["totalRecipients"]) == (body["result"]["id"], "honda", "draft", 2)
    assert (b["sentCount"], b["deliveredCount"], b["failedCount"], b["createdBy"], b["type"]) == (0, 0, 0, "ana", "manual")
    assert b["createdAt"] is not None and b["completedAt"] is None and b["templateLanguage"] == "es"
    recipients = db.data[f"broadcasts/{b['id']}/recipients"]
    assert sorted(r["phone"] for r in recipients.values()) == ["+5218111111111", "+5218122222222"]
    first = next(r for r in recipients.values() if r["name"] == "Ana")
    assert (first["status"], first["variables"], first["salesforceRecordId"], first["whatsappMessageId"]) == ("pending", {"1": "x"}, "001", None)


def test_el_cliente_no_decide_estado_contadores_ni_autor(db):
    for field in ("status", "createdBy", "sentCount", "totalRecipients", "organizationId", "id"):
        assert create(db, fields={**BASE, field: "x"})[1] == 400, field


def vertical_of(db, **kwargs):
    body, status = create(db, **kwargs)
    assert status == 200, body
    return db.data["broadcasts"][body["result"]["id"]]["vertical"]


def test_la_vertical_sale_del_equipo_del_numero_luego_del_bot_y_luego_de_la_pantalla(db):
    assert vertical_of(db) == "servicio"                                  # equipo del número
    sin_equipo = {**BASE, "whatsappNumberId": "n-sin-equipo", "vertical": "valuacion"}
    assert vertical_of(db, fields=sin_equipo) == "ventas"                 # categoría del bot
    db.data["bots"]["bot1"].pop("category")
    assert vertical_of(db, fields=sin_equipo) == "valuacion"              # lo que manda la pantalla
    assert vertical_of(db, fields={**sin_equipo, "vertical": None}) is None


def test_numero_y_bot_deben_ser_de_la_organizacion(db):
    assert create(db, fields={**BASE, "whatsappNumberId": "n-kia"})[1] == 400
    assert create(db, fields={**BASE, "botId": "bot-kia"})[1] == 400
    assert create(db, fields={**BASE, "botId": "no-hay"})[1] == 400
    assert "broadcasts" not in db.data


def test_viewer_y_otra_organizacion_no_crean(db):
    assert create(db, token="t-vera")[1] == 403
    assert create(db, token="t-olga")[1] == 403
    assert "broadcasts" not in db.data


@pytest.mark.parametrize("recipients", [[], None, [{"phone": "abc"}], [{"phone": "+123"}], [{}], ["5218111111111"],
                                        [{"phone": "5218111111111", "variables": "x"}], [{"phone": "5218111111111", "name": 5}]])
def test_destinatarios_invalidos_en_campana_manual(db, recipients):
    assert create(db, recipients=recipients)[1] == 400
    assert "broadcasts" not in db.data


def test_un_telefono_invalido_no_deja_nada_a_medias(db):
    body, status = create(db, recipients=[*PEOPLE, {"phone": "mal"}])
    assert status == 400 and "destinatario 3" in body["error"]["message"]
    assert "broadcasts" not in db.data and not any("recipients" in k for k in db.data)


def test_limite_de_destinatarios(db, monkeypatch):
    monkeypatch.setattr(broadcast_actions, "MAX_RECIPIENTS", 2)
    assert create(db, recipients=[{"phone": f"+52181000000{i}"} for i in range(3)])[1] == 400
    assert create(db, recipients=PEOPLE)[1] == 200


def test_campanas_de_recordatorio_no_llevan_destinatarios_y_normalizan_el_mapeo(db):
    fields = {**BASE, "type": "appointment_reminder", "reminderConfig": {"daysBefore": 1, "eventType": "Cita"},
              "variableMapping": ["fechaCita", "", "horaCita"], "templateComponents": [{"type": "body", "parameters": []}]}
    assert create(db, fields=fields, recipients=PEOPLE)[1] == 400
    body, status = create(db, fields=fields, recipients=[])
    assert status == 200
    b = db.data["broadcasts"][body["result"]["id"]]
    assert b["variableMapping"] == ["fechaCita", "horaCita"] and b["totalRecipients"] == 0 and b["reminderConfig"]["daysBefore"] == 1
    manual = db.data["broadcasts"][create(db)[0]["result"]["id"]]
    assert manual["variableMapping"] is None


@pytest.mark.parametrize("fields", [{**BASE, "name": " "}, {k: v for k, v in BASE.items() if k != "templateName"}, {**BASE, "type": "otro"},
                                    {**BASE, "templateComponents": "x"}])
def test_campos_invalidos(db, fields):
    assert create(db, fields=fields)[1] == 400


def test_lotes_de_500(db, monkeypatch):
    monkeypatch.setattr(broadcast_actions, "BATCH_SIZE", 2)
    body, _ = create(db, recipients=[{"phone": f"+52181000000{i}"} for i in range(5)])
    assert len(db.data[f"broadcasts/{body['result']['id']}/recipients"]) == 5
