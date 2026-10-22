"""Broadcasts, outcomes, outbound de Salesforce y handoff fuera de horario."""
import pytest

from channels.meta_wa import process_meta_status
from channels.twilio_wa import process_twilio_status
from core import broadcasts, conversations as cv, handoff as ho, numbers as nb, tools
from core.outcomes import set_conversation_outcome
from tests.fakes import FakeDB


@pytest.fixture
def db():
    d = FakeDB()
    d.seed("broadcasts", "b1", {"deliveredCount": 0, "failedCount": 0, "confirmedCount": 0, "botInstructions": "Sé breve"})
    d.seed("broadcasts/b1/recipients", "r1", {"whatsappMessageId": "SM1", "status": "sent"})
    return d


# ---- estado de entrega (Twilio y Meta comparten la lógica) ----

def test_entrega_avanza_y_cuenta_una_sola_vez(db):
    process_twilio_status("SM1", "delivered", db=db)
    process_twilio_status("SM1", "delivered", db=db)  # repetido: no cuenta doble
    assert db.data["broadcasts/b1/recipients"]["r1"]["status"] == "delivered"
    assert db.data["broadcasts"]["b1"]["deliveredCount"] == 1


def test_estado_no_retrocede(db):
    db.data["broadcasts/b1/recipients"]["r1"]["status"] = "read"
    process_meta_status({"id": "SM1", "status": "delivered"}, db=db)
    assert db.data["broadcasts/b1/recipients"]["r1"]["status"] == "read"


def test_undelivered_es_failed_y_guarda_el_error(db):
    process_twilio_status("SM1", "undelivered", "30008 desconocido", db=db)
    r = db.data["broadcasts/b1/recipients"]["r1"]
    assert (r["status"], r["errorMessage"]) == ("failed", "30008 desconocido")
    assert db.data["broadcasts"]["b1"]["failedCount"] == 1


def test_entrega_ignora_finalizados_manualmente_y_mensajes_desconocidos(db):
    db.data["broadcasts/b1/recipients"]["r1"]["deliveryStatus"] = "delivered"
    process_twilio_status("SM1", "read", db=db)
    assert db.data["broadcasts/b1/recipients"]["r1"]["status"] == "sent"
    assert broadcasts.update_recipient_delivery("NOEXISTE", "delivered", db=db) is False
    assert broadcasts.update_recipient_delivery("SM1", "queued", db=db) is False


# ---- respuesta a campañas ----

def test_respuesta_a_campana_solo_guarda_la_primera(db):
    conv = {"lastBroadcastRecipientId": "r1", "broadcastId": "b1"}
    assert broadcasts.record_broadcast_response(conv, "confirmar_cita", db=db) is True
    assert broadcasts.record_broadcast_response(conv, "cancelar_cita", db=db) is False
    assert db.data["broadcasts/b1/recipients"]["r1"]["response"] == "confirmar_cita"
    assert db.data["broadcasts"]["b1"]["confirmedCount"] == 1


def test_respuesta_a_campana_con_vocabulario_configurable(db):
    conv = {"lastBroadcastRecipientId": "r1", "broadcastId": "b1"}
    assert broadcasts.record_broadcast_response(conv, "oferta_aceptada", counters={"oferta_aceptada": "acceptedCount"}, db=db)
    assert db.data["broadcasts"]["b1"]["acceptedCount"] == 1
    assert broadcasts.record_broadcast_response({}, "confirmar_cita", db=db) is False
    assert broadcasts.record_broadcast_response(conv, "inventada", db=db) is False


def test_instrucciones_de_campana_con_cache(db):
    assert broadcasts.get_broadcast_instructions("b1", db=db) == "Sé breve"
    db.data["broadcasts"]["b1"]["botInstructions"] = "otra"
    assert broadcasts.get_broadcast_instructions("b1", db=db) == "Sé breve"  # cache de 5 min


# ---- outcomes ----

def test_outcome_auto_no_pisa_uno_terminal_pero_manual_si(db):
    db.seed("conversations", "c1", {"conversationOutcome": "cita_bot"})
    set_conversation_outcome("c1", "inactividad", db=db)
    assert db.data["conversations"]["c1"]["conversationOutcome"] == "cita_bot"
    set_conversation_outcome("c1", "otro", source="manual", ai_outcome="otro_motivo", db=db)
    conv = db.data["conversations"]["c1"]
    assert (conv["conversationOutcome"], conv["aiOutcome"]) == ("otro", "otro_motivo")
    assert [h["outcome"] for h in conv["conversationOutcomeHistory"]] == ["otro"]


def test_outcome_terminal_es_configurable(db):
    db.seed("conversations", "c2", {"conversationOutcome": "oferta_aceptada"})
    set_conversation_outcome("c2", "inactividad", terminal_outcomes={"oferta_aceptada"}, db=db)
    assert db.data["conversations"]["c2"]["conversationOutcome"] == "oferta_aceptada"


# ---- outbound de Salesforce y lookup de Meta ----

@pytest.fixture
def numbers_db(db):
    nb.clear_bot_cache()
    db.seed("organizations", "honda", {"name": "Honda"})
    db.seed("whatsappNumbers", "n1", {"organizationId": "honda", "teamId": "t1", "status": "active", "phoneNumber": "whatsapp:+52BOT", "defaultBotId": "bot1", "provider": "valuetext", "metaPhoneNumberId": "999", "metaAccessToken": "tk"})
    db.seed("bots", "bot1", {"organizationId": "honda", "name": "Bot"})
    return db


def test_outbound_de_agente_pasa_la_conversacion_a_with_agent(numbers_db):
    cv.save_agent_outbound("whatsapp:+528186019229", "whatsapp:+52BOT", "Hola, soy tu asesor", media_url="http://f", db=numbers_db)
    conv = next(iter(numbers_db.data["conversations"].values()))
    msg = next(iter(numbers_db.data[f"conversations/{conv['id']}/messages"].values()))
    assert conv["status"] == "with_agent" and (msg["sender"], msg["mediaUrl"]) == ("agent", "http://f")


def test_outbound_de_template_siempre_deja_with_agent(numbers_db):
    cv.save_template_outbound("whatsapp:+528186019229", "whatsapp:+52BOT", "Recordatorio de cita", db=numbers_db)
    conv = next(iter(numbers_db.data["conversations"].values()))
    assert conv["status"] == "with_agent"


def test_outbound_sin_bot_no_crea_nada(numbers_db):
    cv.save_agent_outbound("whatsapp:+52X", "whatsapp:+52NOEXISTE", "hola", db=numbers_db)
    assert "conversations" not in numbers_db.data


def test_bot_por_meta_phone_number_id(numbers_db):
    bot = nb.get_bot_by_meta_phone_number_id("999", db=numbers_db)
    assert (bot["id"], bot["provider"], bot["metaAccessToken"], bot["teamId"]) == ("bot1", "meta", "tk", "t1")
    assert nb.get_bot_by_meta_phone_number_id("000", db=numbers_db) is None


def test_reset_de_inactividad(db):
    db.seed("conversations", "c1", {"inactivityRemindersSent": 2, "lastTemplateMessageAt": "x"})
    cv.reset_inactivity("c1", 2, db=db)
    conv = db.data["conversations"]["c1"]
    assert conv["inactivityRemindersSent"] == 0 and conv["lastTemplateMessageAt"] is None and conv["lastCustomerMessageAt"] is not None


# ---- handoff fuera de horario ----

def test_handoff_fuera_de_horario_avisa_marca_y_despacha_al_modulo(db):
    tools.clear()
    db.seed("conversations", "c1", {"status": "bot", "vertical": "ventas"})
    sent, events = [], []
    tools.tool("handoff_blocked_out_of_hours", vertical="ventas")(lambda conv, p: events.append((conv["vertical"], p["trigger"])))
    schedule = {"enabled": True, "outOfHoursMessage": "Cerrado.", "schedule": []}
    conv_data = {"vertical": "ventas"}
    ho.block_handoff_out_of_hours("c1", conv_data, {"id": "bot"}, "from", "to", schedule, "keyword",
                                  send=lambda bot, a, b, text: sent.append(text), db=db)
    assert sent[0].startswith("Cerrado.")
    assert db.data["conversations"]["c1"]["handoffBlockedAt"] is not None and conv_data["handoffBlockedAt"] is True
    assert events == [("ventas", "keyword")]
    tools.clear()
