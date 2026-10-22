from datetime import datetime, timezone

import pytest

from ai.parsing import detect_handoff
from core import claims, handoff as ho, idempotency
from tests.fakes import FakeDB

SCHEDULE = {
    "enabled": True, "timezone": "America/Mexico_City", "outOfHoursMessage": "Fuera de horario.",
    "schedule": [{"day": "monday", "startTime": "09:00", "endTime": "18:00"}],
}
# 2026-10-12 es lunes. México: UTC-6.
MON_10AM = datetime(2026, 10, 12, 16, 0, tzinfo=timezone.utc)
MON_8PM = datetime(2026, 10, 13, 2, 0, tzinfo=timezone.utc)
TUE_10AM = datetime(2026, 10, 13, 16, 0, tzinfo=timezone.utc)


def _agent(db, id, team="t1", org="honda", **kw):
    db.seed("users", id, dict({"role": "agent", "orgTeams": {org: team}, "teamId": team}, **kw))


@pytest.fixture
def db():
    d = FakeDB()
    d.seed("teams", "t1", {"organizationId": "honda", "assignmentMode": "round_robin"})
    d.seed("conversations", "c1", {"status": "bot", "organizationId": "honda"})
    return d


# ---- horarios ----

def test_horario():
    assert ho.check_business_hours(SCHEDULE, MON_10AM) is True
    assert ho.check_business_hours(SCHEDULE, MON_8PM) is False
    assert ho.check_business_hours(SCHEDULE, TUE_10AM) is False  # el martes no está en el horario
    assert ho.check_business_hours(None) is True
    assert ho.check_business_hours({"enabled": False}) is True


def test_mensaje_fuera_de_horario_lista_los_dias():
    msg = ho.build_out_of_hours_message(SCHEDULE)
    assert msg.startswith("Fuera de horario.")
    assert "Lunes: 09:00 - 18:00" in msg and "Martes: Cerrado" in msg and msg.endswith(ho.FIXED_CLOSING)


def test_contexto_fuera_de_horario_solo_si_el_handoff_sigue_bloqueado():
    msgs = [{"is_user": True, "text": "hola"}]
    out = ho.apply_out_of_hours_context(msgs, {"handoffBlockedAt": True}, SCHEDULE, MON_8PM)
    assert out[-1]["text"].startswith("<<CONTEXTO>>") and out[-1]["text"].endswith("hola")
    assert msgs[-1]["text"] == "hola"  # no muta la entrada
    assert ho.apply_out_of_hours_context(msgs, {"handoffBlockedAt": True}, SCHEDULE, MON_10AM) is msgs
    assert ho.apply_out_of_hours_context(msgs, {}, SCHEDULE, MON_8PM) is msgs


# ---- asignación ----

def test_round_robin_rota_y_continua_si_un_agente_sale(db):
    for a in ("a1", "a2", "a3"):
        _agent(db, a)
    order = []
    for i in range(4):
        db.seed("conversations", f"c{i}", {"status": "bot"})
        order.append(ho.auto_assign_agent("honda", f"c{i}", "t1", db=db))
    assert order == ["a1", "a2", "a3", "a1"]
    db.data["users"]["a2"]["isAvailable"] = False
    db.seed("conversations", "cx", {"status": "bot"})
    assert ho.auto_assign_agent("honda", "cx", "t1", db=db) == "a3"  # el puntero estaba en a1


def test_asignar_actualiza_conversacion_y_carga_del_agente(db):
    _agent(db, "a1")
    assert ho.auto_assign_agent("honda", "c1", "t1", handoff_reason="motivo x", db=db) == "a1"
    conv = db.data["conversations"]["c1"]
    assert (conv["status"], conv["assignedAgentId"], conv["handoffReason"], conv["assignedAgentType"]) == ("with_agent", "a1", "motivo x", "human")
    assert db.data["users"]["a1"]["activeConversations"] == 1


def test_menos_ocupado_y_limite_por_agente(db):
    db.data["teams"]["t1"].update(assignmentMode="least_busy", maxConversationsPerAgent=3)
    _agent(db, "a1", activeConversations=3)
    _agent(db, "a2", activeConversations=2)
    _agent(db, "a3", activeConversations=1, isAvailable=False)
    assert ho.auto_assign_agent("honda", "c1", "t1", db=db) == "a2"
    db.data["users"]["a2"]["activeConversations"] = 3
    assert ho.auto_assign_agent("honda", "c1", "t1", db=db) is None  # todos al tope o no disponibles


def test_sin_limite_si_el_equipo_no_lo_define(db):
    db.data["teams"]["t1"]["assignmentMode"] = "least_busy"
    _agent(db, "a1", activeConversations=99)
    assert ho.auto_assign_agent("honda", "c1", "t1", db=db) == "a1"


def test_manual_o_sin_equipo_no_asigna(db):
    _agent(db, "a1")
    assert ho.auto_assign_agent("honda", "c1", None, db=db) is None
    db.data["teams"]["t1"]["assignmentMode"] = "manual"
    assert ho.auto_assign_agent("honda", "c1", "t1", db=db) is None


def test_orgTeams_manda_sobre_el_teamId_plano_viejo(db):
    _agent(db, "a1")
    db.seed("users", "viejo", {"role": "agent", "teamId": "t1", "orgTeams": {"honda": "otro-equipo"}})
    db.seed("users", "legado", {"role": "agent", "teamId": "t1"})  # sin orgTeams: cuenta
    assert set(ho._team_agents(db, "honda", "t1")) == {"a1", "legado"}


def test_agentes_de_otra_organizacion_no_entran(db):
    _agent(db, "a1", org="nissan")  # orgTeams solo de nissan, pero teamId plano coincide
    assert "a1" in ho._team_agents(db, "honda", "t1")  # sin entrada para honda en su mapa, el plano cuenta
    db.data["users"]["a1"]["teamId"] = "otro"
    assert "a1" not in ho._team_agents(db, "honda", "t1")


# ---- status del handoff ----

def test_status_manual_deja_en_espera(db):
    db.data["teams"]["t1"]["assignmentMode"] = "manual"
    ho.apply_handoff_status("c1", "t1", "honda", db=db)
    assert db.data["conversations"]["c1"]["status"] == "waiting_agent"


def test_status_round_robin_sin_agentes_cae_a_espera(db):
    ho.apply_handoff_status("c1", "t1", "honda", db=db)
    assert db.data["conversations"]["c1"]["status"] == "waiting_agent"


def test_status_modo_salesforce_pasa_a_con_agente_sin_asignar(db):
    db.data["teams"]["t1"]["assignmentMode"] = "salesforce"
    ho.apply_handoff_status("c1", "t1", "honda", db=db)
    conv = db.data["conversations"]["c1"]
    assert conv["status"] == "with_agent" and conv["assignedAgentId"] is None


# ---- claims e idempotencia ----

def test_claim_solo_lo_gana_una_invocacion_y_se_libera(db):
    assert claims.claim("c1", "leadId", "leadCreationClaimedAt", db=db) == (True, "")
    assert claims.claim("c1", "leadId", "leadCreationClaimedAt", db=db) == (False, "")  # otra lo está creando
    claims.release_claim("c1", "leadCreationClaimedAt", db=db)
    assert claims.claim("c1", "leadId", "leadCreationClaimedAt", db=db) == (True, "")


def test_claim_devuelve_el_recurso_existente(db):
    db.data["conversations"]["c1"]["leadId"] = "L1"
    assert claims.claim("c1", "leadId", "leadCreationClaimedAt", db=db) == (False, "L1")


def test_claim_vencido_se_puede_retomar(db):
    from datetime import timedelta
    db.data["conversations"]["c1"]["leadCreationClaimedAt"] = datetime.now(timezone.utc) - timedelta(seconds=300)
    assert claims.claim("c1", "leadId", "leadCreationClaimedAt", ttl_secs=120, db=db)[0] is True


def test_idempotencia_por_source_y_external_id(db):
    assert idempotency.is_duplicate("lead_webhook", "L-1", db=db) is False
    assert idempotency.is_duplicate("lead_webhook", "L-1", db=db) is True
    assert idempotency.is_duplicate("valuetext", "L-1", db=db) is False  # otro source
    assert idempotency.is_duplicate("lead_webhook", "", db=db) is False


# ---- detección del handoff en la respuesta del bot ----

def _ok(result):
    return {"success": True, "result": result}


def test_handoff_por_tool_con_motivo():
    r = _ok({"toolResults": [{"toolName": "Transferir_a_Asesor", "input": {"motivo": "quiere cotización"}}]})
    assert detect_handoff(r, "chatllm") == {"triggered": True, "motivo": "quiere cotización"}


def test_handoff_por_segments_de_chatllm():
    seg = {"title": "Executing Transferir_a_Asesor", "segment": {"segment": "params = {\"motivo\": \"reclamo\"}"}}
    assert detect_handoff(_ok({"segments": [seg]}), "chatllm") == {"triggered": True, "motivo": "reclamo"}


def test_handoff_por_accion_de_workflow():
    r = _ok({"response": {"segments": [{"id": "action", "segment": " Pre_Registro "}]}})
    assert detect_handoff(r, "workflow") == {"triggered": True, "motivo": "pre-registro completado"}


def test_handoff_por_marcador_en_texto_y_sin_handoff():
    assert detect_handoff(_ok({"response": 'ok {"action": "HANDOFF"}'}), "chatllm")["triggered"] is True
    assert detect_handoff(_ok({"response": "Hola"}), "chatllm") == {"triggered": False}
    assert detect_handoff({"error": "x"}, "chatllm") == {"triggered": False}
