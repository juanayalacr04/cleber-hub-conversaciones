import importlib
import json
from datetime import datetime, timedelta, timezone

import pytest

import main
from channels import valuetext_wa
from core import campaigns, escalation, tools
from crm import salesforce
from jobs import close_inactive, inactivity, inactivity_ladder as ladder, reminders, runner, scheduled_contacts, verify_templates
from modules import ventas
from tests.fakes import FakeDB

NOW = datetime(2026, 10, 20, 18, 0, tzinfo=timezone.utc)      # 12:00 en CDMX
SF = {"instanceUrl": "https://sf.example", "clientId": "c", "clientSecret": "s", "username": "u", "password": "p",
      "marcaRR": "HO", "bdcFallbackOwnerId": "005BDC"}
CFG = {"enabled": True, "reminders": [{"order": 1, "hours": 1, "closeAfter": False}, {"order": 2, "hours": 2, "closeAfter": True}]}
NUMBER = {"followupOpeningTemplateId": "OPEN", "followupReminderTemplateId": "REM", "followupClosingTemplateId": "CLOSE",
          "scheduledContactTemplateId": "SCHED"}


def ago(**kw):
    return NOW - timedelta(**kw)


@pytest.fixture(autouse=True)
def modulos():
    tools.clear()
    importlib.reload(ventas)
    salesforce.clear_token_cache()
    yield
    tools.clear()


@pytest.fixture
def sf_calls(monkeypatch):
    """Registra lo que Ventas hace en Salesforce sin tocar la red."""
    calls = []
    monkeypatch.setattr(salesforce, "patch_lead", lambda cfg, lead, fields: calls.append(("patch", lead, fields)) or True)
    monkeypatch.setattr(salesforce, "call_flow", lambda cfg, flow, inputs: calls.append(("flow", flow, inputs)) or True)
    return calls


def conv(**kw):
    return {"status": "bot", "botId": "bot1", "lastMessageSender": "bot", "lastCustomerMessageAt": ago(hours=3),
            "createdAt": ago(days=2), **kw}


def decide(c, cfg=CFG, number=NUMBER, now=NOW):
    return ladder.decide(c, cfg, number, now)


# --------------------------------------------------------------------------- decide: omisiones

@pytest.mark.parametrize("extra", [
    {"broadcastId": "b1", "vertical": "servicio"}, {"status": "waiting_agent"}, {"escalatedOnLastReminder": True},
    {"handoffBlockedAt": ago(hours=1)}, {"scheduledContactAt": NOW}, {"appointmentStatus": "cita_bot"}, {"appointmentStatus": "cita_agente"},
])
def test_omite_lo_que_no_debe_recibir_recordatorios(extra):
    assert decide(conv(**extra)).action == "skip"


def test_una_campana_de_ventas_si_sigue_la_escalera():
    assert decide(conv(broadcastId="b1", vertical="ventas")).action == "followup"


def test_waiting_agent_escalada_por_este_job_sigue_la_escalera():
    assert decide(conv(status="waiting_agent", inactivityEscalatedAt=ago(hours=1))).action == "followup"


def test_fuera_del_horario_de_envio_se_omite():
    cfg = {**CFG, "sendingHours": {"enabled": True, "from": "09:00", "to": "11:00", "timezone": "America/Mexico_City"}}
    assert decide(conv(), cfg).action == "skip"        # son las 12:00 en CDMX
    cfg["sendingHours"]["to"] = "12:00"
    assert decide(conv(), cfg).action == "followup"    # el límite es inclusivo
    assert ladder.within_sending_hours(None, NOW) and ladder.within_sending_hours({"enabled": False}, NOW)


# --------------------------------------------------------------------------- decide: escalera

def test_ventana_libre_abierta_por_el_cliente_el_bot_redacta_el_recordatorio():
    d = decide(conv(lastCustomerMessageAt=ago(hours=1, minutes=30)))
    assert d == ladder.Decision("followup", {"code": "__ADMIN_FOLLOWUP_1_RECORDATORIO__", "closeAfter": False, "reminderIndex": 1,
                                             "useTemplate": False, "templateId": None})


def test_ventana_libre_todavia_no_toca_el_paso():
    assert decide(conv(lastCustomerMessageAt=ago(minutes=30))).action == "skip"


def test_ventana_vencida_usa_la_plantilla_de_apertura():
    d = decide(conv(lastCustomerMessageAt=ago(hours=30)))
    assert d.payload["useTemplate"] is True and d.payload["templateId"] == "OPEN" and d.payload["reminderIndex"] == 1


def test_con_plantilla_previa_usa_la_de_recordatorio_y_la_de_cierre_en_el_ultimo_paso():
    base = {"lastCustomerMessageAt": ago(hours=40), "lastTemplateMessageAt": ago(hours=30)}
    d = decide(conv(**base))
    assert d.payload["templateId"] == "REM" and d.payload["closeAfter"] is False
    last = decide(conv(**base, inactivityRemindersSent=1))
    assert last.payload["templateId"] == "CLOSE" and last.payload["closeAfter"] is True and last.payload["reminderIndex"] == 2
    assert last.payload["code"] == "__ADMIN_FOLLOWUP_2_RECORDATORIO__"


def test_un_paso_con_close_after_usa_la_plantilla_de_cierre():
    cfg = {**CFG, "reminders": [{"order": 1, "hours": 1, "closeAfter": True}, {"order": 2, "hours": 5, "closeAfter": False}]}
    d = decide(conv(lastCustomerMessageAt=ago(hours=40), lastTemplateMessageAt=ago(hours=30)), cfg)
    assert d.payload["templateId"] == "CLOSE" and d.payload["closeAfter"] is True


def test_el_paso_aun_no_toca_si_pasaron_menos_horas_que_las_configuradas():
    cfg = {**CFG, "reminders": [{"order": 1, "hours": 50, "closeAfter": False}]}
    assert decide(conv(lastCustomerMessageAt=ago(hours=40), lastTemplateMessageAt=ago(hours=30)), cfg).action == "skip"


def test_cooldown_de_24h_avanza_el_paso_sin_mandar_mensaje():
    c = conv(lastCustomerMessageAt=ago(hours=40), lastTemplateMessageAt=ago(hours=2), inactivityRemindersSent=1)
    d = decide(c)
    assert d.action == "followup" and d.payload["useTemplate"] is True and d.payload["templateId"] is None
    assert d.payload["closeAfter"] is True       # el cierre no se atora


def test_el_orden_de_los_pasos_es_el_campo_order():
    cfg = {**CFG, "reminders": [{"order": 2, "hours": 9, "closeAfter": True}, {"order": 1, "hours": 1, "closeAfter": False}]}
    d = decide(conv(lastCustomerMessageAt=ago(hours=2)), cfg)
    assert d.payload["closeAfter"] is False and d.payload["reminderIndex"] == 1


def test_sin_configuracion_del_bot_cierra_sin_mensaje_salvo_plantilla_reciente():
    d = ladder.decide(conv(inactivityRemindersSent=2), None, NUMBER, NOW)
    assert d == ladder.Decision("followup", {"code": "__ADMIN_FOLLOWUP_CIERRE__", "closeAfter": True, "reminderIndex": 2,
                                             "useTemplate": False, "templateId": None})
    assert ladder.decide(conv(lastTemplateMessageAt=ago(hours=2)), None, NUMBER, NOW).action == "skip"


def test_escalera_agotada_cierra_con_la_plantilla_de_cierre_o_escala():
    c = conv(inactivityRemindersSent=5)
    d = decide(c)
    assert d.action == "followup" and d.payload["closeAfter"] is True and d.payload["templateId"] == "CLOSE" and d.payload["reminderIndex"] == 5
    assert decide(conv(inactivityRemindersSent=5, lastTemplateMessageAt=ago(hours=2))).action == "skip"
    assert decide(c, {**CFG, "escalateOnLastReminder": True}) == ladder.Decision("escalate", {"escalatedOnLastReminder": True})


def test_ultimo_paso_con_escalate_on_last_reminder_escala_en_vez_de_cerrar():
    cfg = {**CFG, "escalateOnLastReminder": True}
    c = conv(lastCustomerMessageAt=ago(hours=40), lastTemplateMessageAt=ago(hours=30), inactivityRemindersSent=1)
    assert decide(c, cfg) == ladder.Decision("escalate", {"escalatedOnLastReminder": True})
    # también si ya se había escalado antes (fuera de horario, solo se reasignó el Lead)
    assert decide({**c, "inactivityEscalatedAt": ago(hours=5)}, cfg).action == "escalate"


# --------------------------------------------------------------------------- decide: ladders alternativas y escalación independiente

def test_ladder_de_leads_salientes_sin_respuesta_y_de_conversaciones_entrantes():
    cfg = {**CFG, "noResponseOverride": {"reminders": [{"order": 1, "hours": 24, "closeAfter": False}]},
           "inboundOverride": {"reminders": [{"order": 1, "hours": 5, "closeAfter": False}]}}
    outbound = conv(smsBucketId="sms1", lastCustomerMessageAt=None, createdAt=ago(hours=10))
    assert ladder.pick_ladder(outbound, cfg) == cfg["noResponseOverride"]["reminders"]
    assert ladder.pick_ladder(conv(smsBucketId="sms1"), cfg) == CFG["reminders"]            # saliente que ya respondió: la base
    assert ladder.pick_ladder(conv(), cfg) == cfg["inboundOverride"]["reminders"]          # entrante: sin smsBucketId
    assert ladder.pick_ladder(conv(), CFG) == CFG["reminders"]
    # sin respuesta, la referencia es la creación de la conversación
    c = conv(smsBucketId="sms1", lastCustomerMessageAt=None, lastTemplateMessageAt=ago(hours=30), createdAt=ago(hours=10))
    assert decide(c, cfg).action == "skip"                                                  # 10 h < 24 h
    assert decide({**c, "createdAt": ago(hours=30)}, cfg).action == "followup"


def test_escalacion_independiente_exige_lead_completo_y_cliente_que_respondio():
    cfg = {**CFG, "escalateEnabled": True, "escalateHours": 2}
    base = conv(leadId="L1", completedLead=True, lastCustomerMessageAt=ago(hours=3))
    assert decide(base, cfg) == ladder.Decision("escalate")
    assert decide({**base, "completedLead": False}, cfg).action != "escalate"
    assert decide({**base, "completedLead": False, "smsBucketId": "s"}, cfg).action == "escalate"      # saliente por ValueText
    assert decide({**base, "leadId": None}, cfg).action != "escalate"
    assert decide({**base, "lastCustomerMessageAt": ago(hours=1)}, cfg).action != "escalate"
    assert decide({**base, "inactivityEscalatedAt": ago(hours=1)}, cfg).action != "escalate"
    assert decide(base, {**CFG, "escalateEnabled": False}).action != "escalate"


def test_la_escalacion_independiente_no_respeta_el_horario_de_envio():
    cfg = {**CFG, "escalateEnabled": True, "escalateHours": 2, "sendingHours": {"enabled": True, "from": "01:00", "to": "02:00"}}
    assert decide(conv(leadId="L1", completedLead=True), cfg).action == "escalate"
    assert decide(conv(), cfg).action == "skip"


# --------------------------------------------------------------------------- escalación (núcleo + Ventas)

def escalation_db(mode="manual", within=True, lead="L1", bdc=True):
    d = FakeDB()
    d.seed("organizations", "honda", {"salesforceConfig": {**SF, **({} if bdc else {"bdcFallbackOwnerId": None})}})
    d.seed("teams", "t1", {"organizationId": "honda", "assignmentMode": mode})
    schedule = {"enabled": True, "timezone": "America/Mexico_City", "schedule": [{"day": "monday", "startTime": "00:00", "endTime": "23:59"}] if within else []}
    d.seed("bots", "bot1", {"organizationId": "honda", "scheduleConfig": schedule, "name": "Bot"})
    d.seed("users", "ag1", {"role": "agent", "organizationIds": ["honda"], "orgTeams": {"honda": "t1"}, "isAvailable": True})
    d.seed("conversations", "c1", {"status": "bot", "botId": "bot1", "teamId": "t1", "organizationId": "honda", "vertical": "ventas",
                                   "leadId": lead, "lastCustomerMessageAt": ago(hours=3)})
    return d


def escalate(d, extra=None, bot_id="bot1"):
    c = d.data["conversations"]["c1"]
    bot = {**d.data["bots"][bot_id], "id": bot_id} if bot_id else None
    return escalation.escalate_to_advisor("c1", c, bot, d, extra)


def open_hours(monkeypatch, open_=True):
    monkeypatch.setattr("core.handoff.check_business_hours", lambda cfg, now=None: open_)


def test_modo_manual_deja_la_conversacion_esperando_agente_y_sella(sf_calls, monkeypatch):
    open_hours(monkeypatch)
    d = escalation_db("manual")
    assert escalate(d, {"escalatedOnLastReminder": True}) == escalation.ESCALATED
    c = d.data["conversations"]["c1"]
    assert c["status"] == "waiting_agent" and c["inactivityEscalatedAt"] is not None and c["escalatedOnLastReminder"] is True
    assert sf_calls == []     # el cliente sí contestó y el modo manual no pide nada al CRM


def test_round_robin_asigna_un_agente_del_equipo(sf_calls, monkeypatch):
    open_hours(monkeypatch)
    d = escalation_db("round_robin")
    assert escalate(d) == escalation.ESCALATED
    c = d.data["conversations"]["c1"]
    assert (c["status"], c["assignedAgentId"]) == ("with_agent", "ag1") and c["inactivityEscalatedAt"] is not None


def test_round_robin_sin_agentes_disponibles_cae_a_waiting_agent(sf_calls, monkeypatch):
    open_hours(monkeypatch)
    d = escalation_db("least_busy")
    d.data["users"]["ag1"]["isAvailable"] = False
    assert escalate(d) == escalation.ESCALATED and d.data["conversations"]["c1"]["status"] == "waiting_agent"


def test_modo_salesforce_dentro_de_horario_pasa_a_with_agent_sin_agente_y_llama_al_flow(sf_calls, monkeypatch):
    open_hours(monkeypatch)
    d = escalation_db("salesforce")
    assert escalate(d) == escalation.ESCALATED
    c = d.data["conversations"]["c1"]
    assert c["status"] == "with_agent" and c["assignedAgentId"] is None and c["waitingStartedAt"] is not None
    assert ("flow", "RRAgenteIACLEBER", [{"leadId": "L1", "marcaRR": "HO"}]) in sf_calls


def test_modo_salesforce_fuera_de_horario_solo_reasigna_el_lead_y_no_cambia_el_status(sf_calls, monkeypatch):
    open_hours(monkeypatch, False)
    d = escalation_db("salesforce")
    assert escalate(d) == escalation.OWNER_ONLY
    c = d.data["conversations"]["c1"]
    assert c["status"] == "bot" and c["inactivityEscalatedAt"] is not None
    assert ("patch", "L1", {"OwnerId": "005BDC"}) in sf_calls and not any(call[0] == "flow" for call in sf_calls)


def test_modo_salesforce_fuera_de_horario_sin_lo_necesario_no_sella_para_reintentar(sf_calls, monkeypatch):
    open_hours(monkeypatch, False)
    for d in (escalation_db("salesforce", lead=None), escalation_db("salesforce", bdc=False)):
        assert escalate(d) == escalation.NOT_READY
        assert "inactivityEscalatedAt" not in d.data["conversations"]["c1"]
    d = escalation_db("salesforce")
    assert escalate(d, bot_id="bot1") == escalation.OWNER_ONLY


@pytest.mark.parametrize("mode", ["manual", "round_robin", None])
def test_fuera_de_horario_en_los_demas_modos_no_toca_nada(sf_calls, monkeypatch, mode):
    open_hours(monkeypatch, False)
    d = escalation_db(mode or "manual")
    if mode is None:
        d.data["teams"]["t1"].pop("assignmentMode")
    assert escalate(d) == escalation.OUT_OF_HOURS
    c = d.data["conversations"]["c1"]
    assert c["status"] == "bot" and "inactivityEscalatedAt" not in c


def test_un_cliente_que_nunca_contesto_deja_el_lead_en_sin_validar(sf_calls, monkeypatch):
    open_hours(monkeypatch)
    d = escalation_db("manual")
    d.data["conversations"]["c1"].pop("lastCustomerMessageAt")
    escalate(d)
    assert sf_calls[0] == ("patch", "L1", {"Validacion_Prospecto__c": "Sin validar", "Status": "Nuevo", "Fecha_Deal__c": None})


def test_sin_bot_se_escala_como_dentro_de_horario(sf_calls):
    d = escalation_db("manual")
    assert escalate(d, bot_id=None) == escalation.ESCALATED and d.data["conversations"]["c1"]["status"] == "waiting_agent"


def test_el_modulo_de_servicio_no_toca_salesforce(sf_calls, monkeypatch):
    open_hours(monkeypatch)
    d = escalation_db("salesforce")
    d.data["conversations"]["c1"]["vertical"] = "servicio"
    assert escalate(d) == escalation.ESCALATED and sf_calls == []


# --------------------------------------------------------------------------- escalera: el tick completo

@pytest.fixture
def followups(monkeypatch):
    calls = []
    monkeypatch.setattr(inactivity, "run_followup", lambda body, db=None, send=None: calls.append(body) or ({"success": True}, 200))
    return calls


def tick_db():
    d = FakeDB()
    d.seed("bots", "bot1", {"status": "active", "organizationId": "honda", "inactivityConfig": CFG})
    d.seed("bots", "bot-off", {"status": "active", "inactivityConfig": {"enabled": False, "reminders": [{"order": 1, "hours": 1}]}})
    d.seed("bots", "bot-pausado", {"status": "paused", "inactivityConfig": CFG})
    d.seed("whatsappNumbers", "n1", NUMBER)
    return d


def seed_conv(d, cid, **kw):
    d.seed("conversations", cid, {"whatsappNumberId": "n1", "teamId": "t1", "vertical": "ventas", **conv(**kw)})


def test_el_tick_decide_y_ejecuta_cada_conversacion(followups):
    d = tick_db()
    seed_conv(d, "c-toca", lastCustomerMessageAt=ago(hours=1, minutes=30))
    seed_conv(d, "c-aun-no", lastCustomerMessageAt=ago(minutes=40))      # no entra por el corte de las horas del paso más corto
    seed_conv(d, "c-cita", lastCustomerMessageAt=ago(hours=5), appointmentStatus="cita_bot")
    seed_conv(d, "c-bot-apagado", botId="bot-off", lastCustomerMessageAt=ago(hours=5))
    seed_conv(d, "c-otro-sender", lastMessageSender="customer", lastCustomerMessageAt=ago(hours=5))
    result = ladder.run(d, NOW)
    assert result == {"processed": 2, "skipped": 1, "errors": 0}
    by_conv = {c["convId"]: c for c in followups}
    assert set(by_conv) == {"c-toca", "c-bot-apagado"}
    assert by_conv["c-toca"] == {"convId": "c-toca", "botId": "bot1", "code": "__ADMIN_FOLLOWUP_1_RECORDATORIO__", "closeAfter": False,
                                 "reminderIndex": 1, "useTemplate": False, "templateId": None}
    assert by_conv["c-bot-apagado"]["code"] == "__ADMIN_FOLLOWUP_CIERRE__"      # su bot ya no tiene escalera: cierra sin mensaje


def test_la_consulta_b_trae_las_conversaciones_con_plantilla_sin_respuesta(followups):
    d = tick_db()
    seed_conv(d, "c-plantilla", lastCustomerMessageAt=None, lastTemplateMessageAt=ago(hours=30), createdAt=ago(hours=30))
    assert ladder.run(d, NOW)["processed"] == 1 and followups[0]["templateId"] == "REM"


def test_sin_bots_con_escalera_no_hay_nada_que_hacer(followups):
    d = FakeDB()
    d.seed("bots", "b", {"status": "active", "inactivityConfig": {"enabled": True, "reminders": []}})
    assert ladder.run(d, NOW) == {"processed": 0, "skipped": 0, "errors": 0, "message": "No bots with inactivity config"}


def test_el_tick_cuenta_los_errores_y_sigue_con_las_demas(monkeypatch):
    d = tick_db()
    seed_conv(d, "c1", lastCustomerMessageAt=ago(hours=5))
    seed_conv(d, "c2", lastCustomerMessageAt=ago(hours=5))

    def run_followup(body, db=None, send=None):
        if body["convId"] == "c1":
            raise RuntimeError("Abacus caído")
        return {"success": True}, 200
    monkeypatch.setattr(inactivity, "run_followup", run_followup)
    assert ladder.run(d, NOW) == {"processed": 1, "skipped": 0, "errors": 1}


def test_el_tick_escala_las_conversaciones_que_lo_piden(sf_calls, followups, monkeypatch):
    open_hours(monkeypatch)
    d = escalation_db("manual")
    d.data["bots"]["bot1"].update({"status": "active", "inactivityConfig": {**CFG, "escalateEnabled": True, "escalateHours": 2}})
    d.data["conversations"]["c1"].update({"completedAssignment": 1, "completedLead": True, "lastMessageSender": "bot",
                                          "lastCustomerMessageAt": ago(hours=3)})
    d.data["conversations"]["c1"].pop("vertical")                          # conversación anterior al hub: se deduce del equipo
    d.data["teams"]["t1"]["vertical"] = "ventas"
    assert ladder.run(d, NOW) == {"processed": 1, "skipped": 0, "errors": 0}
    c = d.data["conversations"]["c1"]
    assert c["status"] == "waiting_agent" and c["inactivityEscalatedAt"] is not None and followups == []


# --------------------------------------------------------------------------- cierre por inactividad

def closing_db():
    d = FakeDB()
    d.seed("whatsappNumbers", "n-rapido", {"status": "active", "inactivityCloseHours": 1})
    d.seed("whatsappNumbers", "n-lento", {"status": "active", "inactivityCloseHours": 10})
    d.seed("whatsappNumbers", "n-defecto", {"status": "active"})
    d.seed("whatsappNumbers", "n-inactivo", {"status": "inactive", "inactivityCloseHours": 0.5})
    return d


def test_cierra_por_las_horas_de_su_numero_y_por_defecto_dos(sf_calls):
    d = closing_db()
    for cid, number, hours, status in (("c1", "n-rapido", 2, "with_agent"), ("c2", "n-lento", 2, "with_agent"),
                                       ("c3", "n-defecto", 3, "waiting_agent"), ("c4", "n-defecto", 1, "with_agent"),
                                       ("c5", None, 3, "with_agent"), ("c6", "n-inactivo", 0.75, "with_agent")):
        d.seed("conversations", cid, {"status": status, "whatsappNumberId": number, "assignedAgentId": "ag1", "lastMessageAt": ago(hours=hours)})
    result = close_inactive.run(d, NOW)
    assert sorted(result["conversationIds"]) == ["c1", "c3", "c5"] and result["closed"] == 3
    c = d.data["conversations"]["c1"]
    assert (c["status"], c["statusBeforeClose"], c["agentBeforeClose"], c["assignedAgentId"], c["closedReason"]) == \
        ("closed", "with_agent", "ag1", None, "inactivity")
    assert c["closedAt"] is not None and c["conversationOutcome"] == "inactividad"
    assert c["conversationOutcomeHistory"] == [{"outcome": "inactividad", "at": NOW}]
    assert d.data["conversations"]["c2"]["status"] == "with_agent"


def test_las_de_bot_solo_se_cierran_si_ya_tienen_cita_y_el_outcome_terminal_no_se_pisa():
    d = closing_db()
    d.seed("conversations", "c-bot", {"status": "bot", "whatsappNumberId": "n-defecto", "lastMessageAt": ago(hours=9)})
    d.seed("conversations", "c-cita", {"status": "bot", "whatsappNumberId": "n-defecto", "lastMessageAt": ago(hours=9),
                                       "appointmentStatus": "cita_bot", "conversationOutcome": "cita_bot"})
    d.seed("conversations", "c-sin-fecha", {"status": "with_agent", "whatsappNumberId": "n-defecto"})
    assert close_inactive.run(d, NOW)["conversationIds"] == ["c-cita"]
    c = d.data["conversations"]["c-cita"]
    assert c["conversationOutcome"] == "cita_bot" and "conversationOutcomeHistory" not in c and c["statusBeforeClose"] == "bot"


def test_el_cierre_se_hace_en_lotes(monkeypatch):
    d = closing_db()
    monkeypatch.setattr(close_inactive, "BATCH", 2)
    for i in range(5):
        d.seed("conversations", f"c{i}", {"status": "with_agent", "whatsappNumberId": "n-defecto", "lastMessageAt": ago(hours=5)})
    assert close_inactive.run(d, NOW)["closed"] == 5 and all(c["status"] == "closed" for c in d.data["conversations"].values())
    assert close_inactive.run(d, NOW)["closed"] == 0


# --------------------------------------------------------------------------- contacto programado

def test_contacto_programado_con_ventana_abierta_o_con_plantilla(followups):
    d = FakeDB()
    d.seed("whatsappNumbers", "n1", NUMBER)
    d.seed("whatsappNumbers", "n-sin", {})
    base = {"status": "bot", "botId": "bot1", "whatsappNumberId": "n1", "scheduledContactAt": ago(minutes=1)}
    d.seed("conversations", "c-ventana", {**base, "lastCustomerMessageAt": ago(hours=2)})
    d.seed("conversations", "c-plantilla", {**base, "lastCustomerMessageAt": ago(hours=30)})
    d.seed("conversations", "c-sin-plantilla", {**base, "whatsappNumberId": "n-sin", "lastCustomerMessageAt": ago(hours=30)})
    d.seed("conversations", "c-futuro", {**base, "scheduledContactAt": NOW + timedelta(hours=1)})
    d.seed("conversations", "c-con-asesor", {**base, "status": "with_agent"})
    assert scheduled_contacts.run(d, NOW) == {"processed": 2, "skipped": 1, "errors": 0}
    by_conv = {c["convId"]: c for c in followups}
    assert by_conv["c-ventana"] == {"type": "scheduled_contact", "convId": "c-ventana", "botId": "bot1", "useTemplate": False, "templateId": None}
    assert by_conv["c-plantilla"]["useTemplate"] is True and by_conv["c-plantilla"]["templateId"] == "SCHED"
    assert "c-sin-plantilla" not in by_conv and "scheduledContactAt" in d.data["conversations"]["c-sin-plantilla"]


def test_contacto_programado_cuenta_errores(monkeypatch):
    d = FakeDB()
    d.seed("conversations", "c1", {"status": "bot", "botId": "bot1", "scheduledContactAt": ago(minutes=1), "lastCustomerMessageAt": ago(hours=1)})
    monkeypatch.setattr(inactivity, "run_followup", lambda body, db=None, send=None: ({"error": "x"}, 400))
    assert scheduled_contacts.run(d, NOW) == {"processed": 0, "skipped": 0, "errors": 1}


# --------------------------------------------------------------------------- verificación de plantillas de Lead

def verify_db(statuses):
    d = FakeDB()
    d.seed("organizations", "honda", {"salesforceConfig": SF})
    d.seed("bots", "bot1", {"organizationId": "honda", "scheduleConfig": {"enabled": True, "schedule": []}})
    for cid, bucket in (("c-ok", "B1"), ("c-falla", "B2"), ("c-pendiente", "B3"), ("c-reciente", "B4"), ("c-servicio", "B5")):
        d.seed("conversations", cid, {"templateVerified": False, "smsBucketId": bucket, "organizationId": "honda", "leadId": f"L-{cid}",
                                      "botId": "bot1", "vertical": "servicio" if cid == "c-servicio" else "ventas",
                                      "lastTemplateMessageAt": ago(minutes=1) if cid == "c-reciente" else ago(minutes=10)})
    d.seed("conversations", "c-sin-bucket", {"templateVerified": False, "organizationId": "honda", "lastTemplateMessageAt": ago(hours=1)})
    d.seed("conversations", "c-ya", {"templateVerified": True, "smsBucketId": "B9", "organizationId": "honda", "lastTemplateMessageAt": ago(hours=1)})
    return d


def test_plantilla_verificada_o_fallida(sf_calls, monkeypatch):
    d = verify_db(None)
    monkeypatch.setattr(verify_templates, "bucket_statuses", lambda cfg, ids: {
        "B1": {"processed": True, "status": "Delivered"}, "B2": {"processed": True, "status": "FAIL"},
        "B3": {"processed": False, "status": None}} if sorted(ids) == ["B1", "B2", "B3"] else pytest.fail(f"consulta inesperada {ids}"))
    monkeypatch.setattr("core.handoff.check_business_hours", lambda cfg, now=None: True)
    assert verify_templates.run(d, NOW) == {"verified": 1, "escalated": 1}
    convs = d.data["conversations"]
    assert convs["c-ok"]["templateVerified"] is True and "status" not in convs["c-ok"]
    f = convs["c-falla"]
    assert (f["status"], f["templateVerified"], f["templateFailed"]) == ("with_agent", True, True) and f["templateFailedAt"] is not None
    assert convs["c-pendiente"]["templateVerified"] is False and convs["c-reciente"]["templateVerified"] is False
    assert convs["c-servicio"]["templateVerified"] is False
    # dentro de horario: Lead "Error plantilla" sin owner, y Flow de round robin
    assert sf_calls == [("patch", "L-c-falla", {"Validacion_Prospecto__c": "Error plantilla", "Status": "Nuevo", "Fecha_Deal__c": None}),
                        ("flow", "RRAgenteIACLEBER", [{"leadId": "L-c-falla", "marcaRR": "HO"}])]


def test_plantilla_fallida_fuera_de_horario_pasa_el_lead_al_owner_de_bdc(sf_calls, monkeypatch):
    d = verify_db(None)
    monkeypatch.setattr(verify_templates, "bucket_statuses", lambda cfg, ids: {"B2": {"processed": True, "status": "FAIL"}})
    monkeypatch.setattr("core.handoff.check_business_hours", lambda cfg, now=None: False)
    verify_templates.run(d, NOW)
    assert sf_calls == [("patch", "L-c-falla", {"Validacion_Prospecto__c": "Error plantilla", "Status": "Nuevo", "Fecha_Deal__c": None,
                                                "OwnerId": "005BDC"})]


def test_sin_credenciales_de_salesforce_no_verifica_nada(sf_calls, monkeypatch):
    d = verify_db(None)
    d.data["organizations"]["honda"]["salesforceConfig"] = {}
    for var in ("SF_INSTANCE_URL", "SF_CLIENT_ID", "SF_CLIENT_SECRET", "SF_USERNAME", "SF_PASSWORD", "SF_VENTAS_USERNAME"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(verify_templates, "bucket_statuses", lambda *a: pytest.fail("no debía consultar"))
    assert verify_templates.run(d, NOW) == {"verified": 0, "escalated": 0}


def test_estados_de_los_buckets_de_valuetext_en_lotes(monkeypatch):
    queries = []
    monkeypatch.setattr(salesforce, "query", lambda cfg, soql, timeout=30: queries.append(soql) or [
        {"Id": "A", "rsplus__Processed__c": True, "rsplus__Status__c": "FAIL"}, {"Id": "B", "rsplus__Processed__c": None}])
    states = valuetext_wa.bucket_statuses(SF, ["A", "B", "C"], batch=2)
    assert len(queries) == 2 and "IN ('A','B')" in queries[0] and "IN ('C')" in queries[1]
    assert states["A"] == {"processed": True, "status": "FAIL"} and states["B"] == {"processed": False, "status": None}
    monkeypatch.setattr(salesforce, "query", lambda *a, **k: None)
    assert valuetext_wa.bucket_statuses(SF, ["A"]) == {}


# --------------------------------------------------------------------------- recordatorios de cita y no-show

def reminder_db(**broadcast):
    d = FakeDB()
    d.seed("organizations", "honda", {"salesforceConfig": SF, "sfBrandCode": "HO"})
    d.seed("broadcasts", "b-rem", {"organizationId": "honda", "type": "appointment_reminder", "status": "completed", "vertical": None,
                                   "reminderConfig": {"daysBefore": 1, "eventType": "Cita"}, "sentCount": 7, "deliveredCount": 5,
                                   "completedAt": ago(days=1), **broadcast})
    d.seed("broadcasts", "b-no-show", {"organizationId": "honda", "type": "no_show", "status": "draft", "reminderConfig": {"eventType": "Cita"}})
    d.seed("broadcasts", "b-manual", {"organizationId": "honda", "type": "manual", "status": "draft"})
    return d


def events(*ids):
    return [{"Id": i, "Description": f"CONTACTO: Cliente {i}", "ActivityDate": "2026-10-21", "ActivityDateTime": "2026-10-21T16:00:00.000+0000",
             "Tel_fono_Prospecto__c": "8111111111", "Location": "Norte", "VIN__c": None, "IdQuiter__c": None, "Celular_Prospecto__c": None}
            for i in ids]


def test_el_job_actualiza_las_campanas_de_cada_tipo(monkeypatch):
    d, queries = reminder_db(), []
    monkeypatch.setattr(salesforce, "query_all", lambda cfg, soql, timeout=30: queries.append(soql) or events("E1", "E2"))
    result = reminders.run("appointment_reminder", d)
    assert result == {"processed": 1, "results": [{"broadcastId": "b-rem", "recipients": 2, "skipped": 0}]}
    b = d.data["broadcasts"]["b-rem"]
    assert b["status"] == "draft" and b["totalRecipients"] == 2 and b["completedAt"] is None and b["lastRefreshedAt"] is not None
    assert (b["sentCount"], b["deliveredCount"]) == (7, 5)             # el job programado no reinicia los contadores
    assert len(d.data["broadcasts/b-rem/recipients"]) == 2 and "GCL_SeRealizo__c = null" in queries[0]
    assert d.data["broadcasts"]["b-no-show"]["status"] == "draft"


def test_el_job_conserva_lo_enviado_en_90_dias_y_olvida_lo_anterior(monkeypatch):
    d = reminder_db()
    monkeypatch.setattr(salesforce, "query_all", lambda *a, **k: events("E1", "E2", "E3"))
    for rid, sf_id, sent in (("r1", "E1", ago(days=10)), ("r2", "E2", ago(days=100)), ("r3", "OLD", ago(days=1))):
        d.seed("broadcasts/b-rem/recipients", rid, {"status": "sent", "salesforceRecordId": sf_id, "sentAt": sent})
    reminders.run("appointment_reminder", d)
    statuses = {r["salesforceRecordId"]: r["status"] for r in d.data["broadcasts/b-rem/recipients"].values()}
    # E1 y OLD se enviaron hace menos de 90 días: se conservan. E2 se envió hace 100: vuelve a avisarse.
    assert statuses == {"E1": "sent", "OLD": "sent", "E2": "pending", "E3": "pending"}
    assert d.data["broadcasts"]["b-rem"]["totalRecipients"] == 4


def test_el_job_sin_nuevos_destinatarios_no_cambia_el_estado(monkeypatch):
    d = reminder_db()
    monkeypatch.setattr(salesforce, "query_all", lambda *a, **k: [])
    reminders.run("appointment_reminder", d)
    b = d.data["broadcasts"]["b-rem"]
    assert b["status"] == "completed" and b["completedAt"] is not None and b["totalRecipients"] == 0


def test_no_show_usa_la_consulta_de_hoy(monkeypatch):
    d, queries = reminder_db(), []
    monkeypatch.setattr(salesforce, "query_all", lambda cfg, soql, timeout=30: queries.append(soql) or [])
    assert reminders.run("no_show", d)["results"][0]["broadcastId"] == "b-no-show"
    assert "ActivityDate = TODAY" in queries[0] and "GCL_SeRealizo__c = 'No'" in queries[0]


def test_una_campana_enviandose_se_omite_y_una_interrumpida_se_destraba(monkeypatch):
    d = reminder_db(status="sending", sendingStartedAt=datetime.now(timezone.utc))
    monkeypatch.setattr(salesforce, "query_all", lambda *a, **k: events("E1"))
    result = reminders.run("appointment_reminder", d)
    assert result["results"] == [{"broadcastId": "b-rem", "error": "No se puede refrescar mientras se está enviando"}]
    d.data["broadcasts"]["b-rem"]["sendingStartedAt"] = datetime.now(timezone.utc) - timedelta(minutes=30)
    assert reminders.run("appointment_reminder", d)["results"][0]["recipients"] == 1
    assert d.data["broadcasts"]["b-rem"]["status"] == "draft"


def test_cada_campana_falla_por_separado(monkeypatch):
    d = reminder_db()
    d.seed("broadcasts", "b-roto", {"organizationId": "honda", "type": "appointment_reminder", "status": "draft", "reminderConfig": {}})
    d.seed("broadcasts", "b-explota", {"organizationId": "honda", "type": "appointment_reminder", "status": "draft",
                                       "reminderConfig": {"daysBefore": 1, "eventType": "Otro"}})

    def query_all(cfg, soql, timeout=30):
        if "'Otro'" in soql:
            raise RuntimeError("boom")
        return events("E1")
    monkeypatch.setattr(salesforce, "query_all", query_all)
    errors = {r["broadcastId"]: r.get("error") for r in reminders.run("appointment_reminder", d)["results"]}
    assert errors["b-rem"] is None and "eventType" in errors["b-roto"] and errors["b-explota"] == "boom"


def test_sin_campanas_de_ese_tipo():
    assert reminders.run("no_show", FakeDB()) == {"processed": 0, "message": "No no_show broadcasts found"}


def test_el_job_usa_las_credenciales_de_servicio_si_la_campana_no_declara_modulo(monkeypatch):
    seen = []
    real = salesforce.resolve_config
    monkeypatch.setattr(salesforce, "resolve_config", lambda org, vertical=None: seen.append(vertical) or real(org, vertical))
    monkeypatch.setattr(salesforce, "query_all", lambda *a, **k: [])
    reminders.run("appointment_reminder", reminder_db())
    assert seen == ["servicio"]
    seen.clear()
    campaigns.refresh(reminder_db(), "b-rem", reminder_db().data["broadcasts"]["b-rem"])
    assert seen == [None]


# --------------------------------------------------------------------------- despacho y entry point

class Req:
    def __init__(self, method="POST", headers=None, args=None, body=None):
        self.method, self.headers, self.args, self._body = method, headers or {}, args or {}, body

    def get_json(self, silent=False):
        return self._body


def test_el_runner_conoce_los_siete_jobs():
    assert sorted(runner.JOBS) == ["appointment-reminders", "close-inactive", "conversation-summaries", "inactivity-followup", "no-show",
                                   "scheduled-contact", "verify-lead-templates"]
    assert runner.run("no-existe") is None
    assert runner.run("no-show", FakeDB()) == {"processed": 0, "message": "No no_show broadcasts found"}


def test_entry_point_de_los_jobs(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "s3")
    assert main.jobs_run(Req("GET"))[1] == 405
    assert main.jobs_run(Req(args={"job": "close-inactive"}))[1] == 401
    assert main.jobs_run(Req(headers={"X-Cron-Secret": "otro"}, args={"job": "close-inactive"}))[1] == 401
    body, status, _ = main.jobs_run(Req(headers={"X-Cron-Secret": "s3"}, args={"job": "nope"}))
    assert status == 400 and "close-inactive" in json.loads(body)["jobs"]

    monkeypatch.setitem(runner.JOBS, "close-inactive", lambda db=None: {"closed": 3, "at": NOW})
    body, status, _ = main.jobs_run(Req(headers={"X-Cron-Secret": "s3"}, body={"job": "close-inactive"}))
    assert status == 200 and json.loads(body)["closed"] == 3

    def explota(db=None):
        raise RuntimeError("detalle")
    monkeypatch.setitem(runner.JOBS, "close-inactive", explota)
    body, status, _ = main.jobs_run(Req(headers={"X-Cron-Secret": "s3"}, args={"job": "close-inactive"}))
    assert status == 500 and json.loads(body)["success"] is False
