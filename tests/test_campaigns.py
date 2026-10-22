import importlib
from datetime import datetime, timedelta, timezone

import pytest

from ai import engine
from core import broadcast_actions, campaigns, outbound, user_actions as ua
from core.outbound import FAILED, TemplateError
from crm import salesforce
from tests.fakes import FakeDB

NOW = datetime.now(timezone.utc)
TOKENS = {"t-ana": "ana", "t-vera": "vera", "t-olga": "olga", "t-root": "root"}


def verifier(token):
    return {"uid": TOKENS[token]} if token in TOKENS else None


class Provider:
    """El router de canal simulado: guarda lo enviado y falla para los teléfonos indicados."""

    def __init__(self):
        self.sent, self.fail_for, self.ready_error, self.statuses = [], {}, None, {}

    def send(self, number, broadcast, recipient, phone, sf_config=None, track=True):
        if phone in self.fail_for:
            raise TemplateError(FAILED, self.fail_for[phone])
        self.sent.append({"phone": phone, "recipient": recipient, "track": track, "number": number["id"] if "id" in number else None})
        return f"SID{len(self.sent)}"

    def check(self, number, sf_config=None):
        return self.ready_error

    def delivery(self, number, ids, sf_config=None):
        return {i: s for i, s in self.statuses.items() if i in ids}


@pytest.fixture
def provider(monkeypatch):
    p = Provider()
    outbound.configure(send_campaign=p.send, check_campaign=p.check, delivery_statuses=p.delivery)
    monkeypatch.setattr(campaigns, "_sleep", lambda s: None)
    monkeypatch.setattr(campaigns, "_background", lambda fn, *a: fn(*a))
    yield p
    outbound.configure()


@pytest.fixture
def primed(monkeypatch):
    calls = []
    monkeypatch.setattr(engine, "prime_session", lambda bot, conv_id, message: calls.append((bot["id"], conv_id, message)) or True)
    return calls


@pytest.fixture(autouse=True)
def acciones():
    ua.clear()
    importlib.reload(broadcast_actions)
    salesforce.clear_token_cache()
    yield
    ua.clear()


@pytest.fixture
def db():
    d = FakeDB()
    d.seed("users", "ana", {"role": "agent", "organizationIds": ["honda"]})
    d.seed("users", "vera", {"role": "viewer", "organizationIds": ["honda"]})
    d.seed("users", "olga", {"role": "admin", "organizationIds": ["kia"]})
    d.seed("users", "root", {"role": "viewer", "isSuperAdmin": True})
    d.seed("organizations", "honda", {"name": "Honda", "sfBrandCode": "HO", "sfCalendario": "Taller Norte",
                                      "salesforceConfig": {"instanceUrl": "https://sf.example", "clientId": "c", "clientSecret": "s",
                                                           "username": "u", "password": "p"}})
    d.seed("bots", "bot1", {"organizationId": "honda", "name": "Bot Servicio", "category": "Servicio", "type": "workflow"})
    d.seed("whatsappNumbers", "n1", {"organizationId": "honda", "teamId": "servicio", "provider": "twilio", "phoneNumber": "whatsapp:+528100000000"})
    d.seed("teams", "servicio", {"organizationId": "honda", "vertical": "servicio"})
    d.seed("broadcasts", "b1", {"id": "b1", "organizationId": "honda", "name": "Recordatorios", "whatsappNumberId": "n1", "botId": "bot1",
                                "templateName": "recordatorio", "templateBody": "Hola, te recordamos tu cita", "status": "draft",
                                "vertical": "servicio", "botInstructions": "Confirma la cita", "type": "manual",
                                "sentCount": 0, "deliveredCount": 0, "failedCount": 0})
    for rid, phone, name in (("r1", "+528111111111", "Ana"), ("r2", "+528122222222", "Beto"), ("r3", "+528133333333", None)):
        d.seed("broadcasts/b1/recipients", rid, {"id": rid, "phone": phone, "name": name, "variables": {"taller": "Norte", "auto": "CR-V"},
                                                 "salesforceRecordId": f"E{rid}", "status": "pending", "conversationId": None,
                                                 "errorMessage": None, "whatsappMessageId": None})
    return d


def recipients(db, bid="b1"):
    return db.data[f"broadcasts/{bid}/recipients"]


def bc(db, bid="b1"):
    return db.data["broadcasts"][bid]


def broadcast(db, bid="b1"):
    return bc(db, bid)


# --------------------------------------------------------------------------- piezas puras

def test_mensaje_de_contexto_para_el_bot():
    assert campaigns.context_message("Ana", {"taller": "Norte", "vin": "V1", "horaCita": "10:00", "otro": "x"}) == \
        "<<CONTEXTO>> CONTACTO: Ana, TALLER: Norte, VIN: V1, HORA CITA: 10:00"
    assert campaigns.context_message(None, None) == "<<CONTEXTO>> "


def test_contexto_del_destinatario_une_instrucciones_nombre_y_datos():
    assert campaigns.recipient_context("Confirma", {"name": "Ana", "variables": {"auto": "CR-V", "taller": "Norte"}}) == \
        "Confirma. Nombre del cliente: Ana. Datos adicionales: auto: CR-V, taller: Norte"
    assert campaigns.recipient_context(None, {"name": None, "variables": None}) is None


def test_ventana_de_24_horas():
    sent = NOW - timedelta(hours=2)
    assert campaigns.blocked_until({"lastTemplateSentAt": sent}, NOW) == sent + campaigns.WINDOW
    assert campaigns.blocked_until({"lastTemplateSentAt": sent, "lastCustomerMessageAt": NOW - timedelta(hours=1)}, NOW) is None  # contestó
    assert campaigns.blocked_until({"lastTemplateSentAt": sent, "lastCustomerMessageAt": NOW - timedelta(hours=3)}, NOW) is not None
    assert campaigns.blocked_until({"lastTemplateSentAt": NOW - timedelta(hours=25)}, NOW) is None
    assert campaigns.blocked_until({}, NOW) is None


def test_hora_en_que_podra_recibir_otra_plantilla():
    when = datetime.now(campaigns.TZ).replace(hour=18, minute=30)
    assert campaigns.format_available_at(when) == "hoy a las 18:30 (CDMX)"
    assert campaigns.format_available_at(when + timedelta(days=1)) == "mañana a las 18:30 (CDMX)"
    assert campaigns.format_available_at(when + timedelta(days=5)).endswith("a las 18:30 (CDMX)")


# --------------------------------------------------------------------------- envío

def test_envia_a_todos_crea_conversaciones_y_actualiza_los_contadores(db, provider, primed):
    result = campaigns.send(db, "b1", broadcast(db))
    assert result == {"done": True, "sentCount": 3, "failedCount": 0, "skippedCount": 0}
    assert sorted(s["phone"] for s in provider.sent) == ["+528111111111", "+528122222222", "+528133333333"]
    assert all(r["status"] == "sent" and r["whatsappMessageId"].startswith("SID") and r["sentAt"] for r in recipients(db).values())
    b = bc(db)
    assert (b["status"], b["sentCount"], b["failedCount"], b["skippedCount"]) == ("completed", 3, 0, 0)
    assert b["sendingStartedAt"] is not None and b["completedAt"] is not None
    assert len(db.data["conversations"]) == 3 and len(primed) == 3


def test_la_conversacion_nueva_lleva_el_contexto_y_la_campana(db, provider, primed):
    campaigns.send(db, "b1", broadcast(db))
    r1 = recipients(db)["r1"]
    conv = db.data["conversations"][r1["conversationId"]]
    assert (conv["customerPhone"], conv["organizationId"], conv["direction"], conv["status"], conv["vertical"]) == \
        ("whatsapp:+528111111111", "honda", "outbound", "bot", "servicio")
    assert (conv["botId"], conv["whatsappNumberId"], conv["teamId"], conv["customerName"], conv["tags"]) == \
        ("bot1", "n1", "servicio", "Ana", ["broadcast"])
    assert (conv["broadcastId"], conv["broadcastName"], conv["lastBroadcastRecipientId"], conv["source"]) == ("b1", "Recordatorios", "r1", "broadcast")
    assert conv["broadcastContext"] == "Confirma la cita. Nombre del cliente: Ana. Datos adicionales: taller: Norte, auto: CR-V"
    assert conv["lastTemplateSentAt"] is not None and conv["lastMessagePreview"] == "<<PLANTILLA>> Hola, te recordamos tu cita"
    texts = sorted(m["text"] for m in db.data[f"conversations/{r1['conversationId']}/messages"].values())
    assert texts == ["<<CONTEXTO>> CONTACTO: Ana, TALLER: Norte, AUTO: CR-V", "<<PLANTILLA>> Hola, te recordamos tu cita"]
    assert any(c[1] == r1["conversationId"] and c[2].startswith("<<PLANTILLA>>") for c in primed)


def test_sin_cuerpo_de_plantilla_usa_el_nombre(db, provider, primed):
    db.data["broadcasts"]["b1"].pop("templateBody")
    campaigns.send(db, "b1", broadcast(db))
    conv = db.data["conversations"][recipients(db)["r1"]["conversationId"]]
    assert conv["lastMessagePreview"] == "<<PLANTILLA>> recordatorio"


def test_un_fallo_no_detiene_a_los_demas(db, provider, primed):
    provider.fail_for["+528122222222"] = "Meta API error 400: plantilla no aprobada"
    result = campaigns.send(db, "b1", broadcast(db))
    assert (result["sentCount"], result["failedCount"]) == (2, 1)
    r2 = recipients(db)["r2"]
    assert r2["status"] == "failed" and r2["errorMessage"] == "Meta API error 400: plantilla no aprobada"
    assert (bc(db)["status"], bc(db)["sentCount"], bc(db)["failedCount"]) == ("completed", 2, 1)


def test_si_todos_fallan_la_campana_queda_failed(db, provider, primed):
    for r in recipients(db).values():
        provider.fail_for[r["phone"]] = "x"
    campaigns.send(db, "b1", broadcast(db))
    assert bc(db)["status"] == "failed" and bc(db)["failedCount"] == 3


def test_si_el_proveedor_rechaza_la_ventana_de_24h_no_queda_marcada(db, provider, primed):
    provider.fail_for["+528111111111"] = "x"
    campaigns.send(db, "b1", broadcast(db))
    conv = db.data["conversations"][next(c for c in db.data["conversations"])]
    failed = next(c for c in db.data["conversations"].values() if c["customerPhone"] == "whatsapp:+528111111111")
    assert "lastTemplateSentAt" not in failed or failed["lastTemplateSentAt"] is None
    ok = next(c for c in db.data["conversations"].values() if c["customerPhone"] == "whatsapp:+528122222222")
    assert ok["lastTemplateSentAt"] is not None


def test_omite_a_quien_recibio_una_plantilla_sin_responder_en_24h(db, provider, primed):
    db.seed("conversations", "c-ana", {"customerPhone": "whatsapp:+528111111111", "organizationId": "honda", "status": "bot",
                                       "lastMessageAt": NOW, "lastTemplateSentAt": NOW - timedelta(hours=3)})
    result = campaigns.send(db, "b1", broadcast(db))
    assert (result["sentCount"], result["skippedCount"]) == (2, 1)
    r1 = recipients(db)["r1"]
    assert r1["status"] == "skipped" and r1["errorMessage"].startswith("Plantilla sin respuesta en las últimas 24h — puedes enviar ")
    assert "+528111111111" not in [s["phone"] for s in provider.sent] and "conversations/c-ana/messages" not in db.data
    assert bc(db)["skippedCount"] == 1


@pytest.mark.parametrize("extra", [{"lastCustomerMessageAt": NOW - timedelta(minutes=30)}, {"lastTemplateSentAt": NOW - timedelta(hours=30)}])
def test_si_contesto_o_ya_pasaron_24h_se_envia(db, provider, primed, extra):
    db.seed("conversations", "c-ana", {"customerPhone": "whatsapp:+528111111111", "organizationId": "honda", "status": "with_agent",
                                       "lastMessageAt": NOW, "lastTemplateSentAt": NOW - timedelta(hours=3), **extra})
    assert campaigns.send(db, "b1", broadcast(db))["sentCount"] == 3


def test_reusa_la_conversacion_abierta_y_le_agrega_el_contexto(db, provider, primed):
    db.seed("conversations", "c-ana", {"customerPhone": "whatsapp:+528111111111", "organizationId": "honda", "status": "with_agent",
                                       "lastMessageAt": NOW, "tags": ["vip"]})
    db.seed("conversations", "c-otra", {"customerPhone": "whatsapp:+528111111111", "organizationId": "kia", "status": "bot", "lastMessageAt": NOW})
    campaigns.send(db, "b1", broadcast(db))
    assert recipients(db)["r1"]["conversationId"] == "c-ana" and len(db.data["conversations"]) == 4
    c = db.data["conversations"]["c-ana"]
    assert c["status"] == "with_agent" and c["tags"] == ["vip"] and c["broadcastId"] == "b1" and c["lastBroadcastRecipientId"] == "r1"
    assert len(db.data["conversations/c-ana/messages"]) == 2 and c["lastTemplateSentAt"] is not None


def test_un_destinatario_de_la_campana_solo_se_envia_una_vez_con_su_telefono_en_e164(db, provider, primed):
    campaigns.send(db, "b1", broadcast(db))
    assert provider.sent[0]["track"] is True
    assert all(s["phone"].startswith("+52") for s in provider.sent)


@pytest.mark.parametrize("status", ["completed", "failed"])
def test_una_campana_ya_terminada_no_se_envia(db, provider, primed, status):
    db.data["broadcasts"]["b1"]["status"] = status
    with pytest.raises(ua.UserActionError) as e:
        campaigns.send(db, "b1", broadcast(db))
    assert e.value.code == "precondicion_fallida" and provider.sent == []


def test_una_campana_sending_se_reanuda_sin_pisar_el_inicio(db, provider, primed):
    started = NOW - timedelta(minutes=3)
    db.data["broadcasts"]["b1"].update({"status": "sending", "sendingStartedAt": started})
    db.data["broadcasts/b1/recipients"]["r1"]["status"] = "sent"
    assert campaigns.send(db, "b1", broadcast(db))["sentCount"] == 2
    assert bc(db)["sendingStartedAt"] == started


def test_no_envia_nada_si_el_numero_no_esta_listo_y_la_campana_sigue_en_borrador(db, provider, primed):
    provider.ready_error = "Twilio credentials not configured"
    with pytest.raises(ua.UserActionError) as e:
        campaigns.send(db, "b1", broadcast(db))
    assert e.value.message == "Twilio credentials not configured" and bc(db)["status"] == "draft" and provider.sent == []


def test_numero_inexistente(db, provider):
    db.data["broadcasts"]["b1"]["whatsappNumberId"] = "no-hay"
    with pytest.raises(ua.UserActionError) as e:
        campaigns.send(db, "b1", broadcast(db))
    assert e.value.code == "recurso_no_encontrado"


def test_sin_pendientes_se_completa_sin_enviar(db, provider, primed):
    for r in recipients(db).values():
        r["status"] = "sent"
    assert campaigns.send(db, "b1", broadcast(db)) == {"done": True, "sentCount": 0, "failedCount": 0, "skippedCount": 0}
    assert bc(db)["status"] == "completed"


# --------------------------------------------------------------------------- reintento

def prepared(db, failed=("r1",), skipped=("r2",), sent=("r3",)):
    for rid in failed:
        recipients(db)[rid].update({"status": "failed", "errorMessage": "boom"})
    for rid in skipped:
        recipients(db)[rid].update({"status": "skipped", "errorMessage": "ventana"})
    for rid in sent:
        recipients(db)[rid].update({"status": "sent", "whatsappMessageId": "SID0"})
    db.data["broadcasts"]["b1"].update({"status": "completed", "sentCount": 1, "failedCount": 1, "skippedCount": 1})


def test_reintenta_fallidos_y_omitidos_y_ajusta_los_contadores(db, provider, primed):
    prepared(db)
    result = campaigns.retry(db, "b1", broadcast(db))
    assert result == {"retriedCount": 2, "failedCount": 0, "skippedCount": 0, "total": 2}
    assert all(recipients(db)[r]["status"] == "sent" and recipients(db)[r]["errorMessage"] is None for r in ("r1", "r2"))
    b = bc(db)
    assert (b["status"], b["sentCount"], b["failedCount"], b["skippedCount"]) == ("completed", 3, 0, 0)


def test_reintento_que_vuelve_a_fallar_deja_los_contadores_netos(db, provider, primed):
    prepared(db)
    provider.fail_for["+528111111111"] = "otra vez"
    result = campaigns.retry(db, "b1", broadcast(db))
    assert (result["retriedCount"], result["failedCount"]) == (1, 1)
    b = bc(db)
    assert (b["sentCount"], b["failedCount"], b["skippedCount"]) == (2, 1, 0) and b["status"] == "completed"
    assert recipients(db)["r1"]["errorMessage"] == "otra vez"
    provider.fail_for["+528122222222"] = "x"
    db.data["conversations"].clear()                      # sin ventana de 24 h de la primera ronda
    recipients(db)["r2"]["conversationId"] = None
    prepared(db, failed=(), skipped=("r2",), sent=("r1", "r3"))
    db.data["broadcasts"]["b1"].update({"sentCount": 2, "failedCount": 0, "skippedCount": 1})
    campaigns.retry(db, "b1", broadcast(db))
    assert bc(db)["status"] == "failed" and bc(db)["failedCount"] == 1 and bc(db)["skippedCount"] == 0


def test_reintento_vuelve_a_omitir_si_sigue_la_ventana(db, provider, primed):
    prepared(db, failed=(), skipped=("r2",), sent=("r1", "r3"))
    db.seed("conversations", "c-beto", {"customerPhone": "whatsapp:+528122222222", "organizationId": "honda", "status": "bot",
                                        "lastMessageAt": NOW, "lastTemplateSentAt": NOW - timedelta(hours=1)})
    result = campaigns.retry(db, "b1", broadcast(db))
    assert (result["retriedCount"], result["skippedCount"]) == (0, 1) and recipients(db)["r2"]["status"] == "skipped"
    assert bc(db)["skippedCount"] == 1


def test_reintento_con_conversacion_existente_no_repite_el_contexto(db, provider, primed):
    prepared(db, failed=("r1",), skipped=(), sent=("r2", "r3"))
    db.seed("conversations", "c-ana", {"customerPhone": "whatsapp:+528111111111", "organizationId": "honda", "status": "bot", "lastMessageAt": NOW})
    recipients(db)["r1"]["conversationId"] = "c-ana"
    campaigns.retry(db, "b1", broadcast(db))
    assert "conversations/c-ana/messages" not in db.data and primed == []
    assert db.data["conversations"]["c-ana"]["lastTemplateSentAt"] is not None and recipients(db)["r1"]["conversationId"] == "c-ana"


def test_reintento_sin_conversacion_la_crea_con_su_contexto(db, provider, primed):
    prepared(db, failed=("r1",), skipped=(), sent=("r2", "r3"))
    campaigns.retry(db, "b1", broadcast(db))
    conv = db.data["conversations"][recipients(db)["r1"]["conversationId"]]
    assert conv["lastBroadcastRecipientId"] == "r1" and conv["tags"] == ["broadcast"] and len(primed) == 1


def test_no_se_reintenta_mientras_se_envia_pero_si_se_recupera_la_interrumpida(db, provider, primed):
    prepared(db)
    db.data["broadcasts"]["b1"].update({"status": "sending", "sendingStartedAt": NOW - timedelta(minutes=2)})
    with pytest.raises(ua.UserActionError):
        campaigns.retry(db, "b1", broadcast(db))
    db.data["broadcasts"]["b1"]["sendingStartedAt"] = NOW - timedelta(minutes=20)
    assert campaigns.retry(db, "b1", broadcast(db))["retriedCount"] == 2
    db.data["broadcasts"]["b1"].update({"status": "sending"})
    db.data["broadcasts"]["b1"].pop("sendingStartedAt")
    prepared(db)
    assert campaigns.retry(db, "b1", broadcast(db))["total"] == 2   # sin fecha de inicio también se da por interrumpida


def test_sin_fallidos_ni_omitidos_no_hay_nada_que_reintentar(db, provider, primed):
    prepared(db, failed=(), skipped=(), sent=("r1", "r2", "r3"))
    assert campaigns.retry(db, "b1", broadcast(db)) == {"message": "No failed or skipped recipients to retry", "retriedCount": 0, "failedCount": 0}
    assert bc(db)["status"] == "completed"


# --------------------------------------------------------------------------- prueba

def test_envio_de_prueba_no_toca_al_destinatario_y_crea_una_conversacion_de_prueba(db, provider, primed):
    result = campaigns.send_test(db, "b1", broadcast(db), "8186019229", "r1")
    assert result["sent"] == 1 and result["failed"] == 0 and result["results"][0]["success"]
    assert provider.sent[0]["phone"] == "+528186019229" and provider.sent[0]["track"] is False
    assert provider.sent[0]["recipient"]["name"] == "Ana"            # las variables son las del destinatario elegido
    assert recipients(db)["r1"]["status"] == "pending"
    conv = db.data["conversations"][result["conversationId"]]
    assert conv["tags"] == ["broadcast", "test"] and conv["customerPhone"] == "whatsapp:+528186019229" and conv["customerName"] is None
    assert len(db.data[f"conversations/{result['conversationId']}/messages"]) == 2 and len(primed) == 1


def test_envio_de_prueba_sin_destinatario_usa_el_primero_y_normaliza_el_telefono(db, provider, primed):
    campaigns.send_test(db, "b1", broadcast(db), "+52 1 818 601 9229")
    assert provider.sent[0]["phone"] == "+528186019229"


def test_envio_de_prueba_respeta_la_ventana_y_reusa_la_conversacion(db, provider, primed):
    db.seed("conversations", "c-test", {"customerPhone": "whatsapp:+528186019229", "organizationId": "honda", "status": "bot",
                                        "lastMessageAt": NOW, "lastTemplateSentAt": NOW - timedelta(hours=1)})
    result = campaigns.send_test(db, "b1", broadcast(db), "8186019229", "r1")
    assert result["sent"] == 0 and "Plantilla sin respuesta" in result["results"][0]["error"] and provider.sent == []
    db.data["conversations"]["c-test"]["lastTemplateSentAt"] = NOW - timedelta(hours=30)
    result = campaigns.send_test(db, "b1", broadcast(db), "8186019229", "r1")
    assert result["conversationId"] == "c-test" and len(db.data["conversations"]) == 1
    assert len(db.data["conversations/c-test/messages"]) == 2


def test_envio_de_prueba_con_fallo_y_destinatario_inexistente(db, provider, primed):
    provider.fail_for["+528186019229"] = "rechazado"
    result = campaigns.send_test(db, "b1", broadcast(db), "8186019229", "r1")
    assert result["failed"] == 1 and result["results"][0]["error"] == "rechazado" and result["conversationId"] is None
    with pytest.raises(ua.UserActionError) as e:
        campaigns.send_test(db, "b1", broadcast(db), "8186019229", "no-hay")
    assert e.value.code == "recurso_no_encontrado"


# --------------------------------------------------------------------------- refresco

def event(i, phone="8111111111", hora="2026-10-21T16:00:00.000+0000", desc=None, **extra):
    return {"Id": f"E{i}", "Description": desc if desc is not None else f"CONTACTO: Cliente {i}\nTALLER: Norte\nAUTO: CR-V\nOPERACION: Servicio",
            "Location": None, "ActivityDate": "2026-10-21", "ActivityDateTime": hora, "Tel_fono_Prospecto__c": phone,
            "Celular_Prospecto__c": None, "VIN__c": f"VIN{i}", "IdQuiter__c": f"Q{i}", **extra}


@pytest.fixture
def reminder(db):
    db.data["broadcasts"]["b1"].update({"type": "appointment_reminder", "reminderConfig": {"daysBefore": 1, "eventType": "Cita"},
                                        "variableMapping": ["name", "fechaCita"], "totalRecipients": 3})
    return db


def test_refresca_destinatarios_desde_las_citas_y_conserva_los_ya_enviados(reminder, monkeypatch):
    db, queries = reminder, []
    events = [event(1, "8111111111"), event(2, "+52 1 812 222 2222"), event(3, None), event(4, "123")]
    monkeypatch.setattr(salesforce, "query_all", lambda cfg, soql, timeout=30: queries.append(soql) or events)
    recipients(db)["r1"].update({"status": "delivered", "salesforceRecordId": "E1"})
    recipients(db)["r2"].update({"status": "failed", "salesforceRecordId": "OLD"})
    result = campaigns.refresh(db, "b1", broadcast(db))
    assert (result["recipients"], result["preserved"], result["skipped"]) == (1, 1, 2)
    assert result["skippedDetails"] == [{"id": "E3", "reason": "no_phone_field", "rawPhone": None, "name": "Cliente 3"},
                                        {"id": "E4", "reason": "invalid_phone_format", "rawPhone": "123", "name": "Cliente 4"}]
    rows = list(recipients(db).values())
    assert len(rows) == 2 and {r["salesforceRecordId"] for r in rows} == {"E1", "E2"}      # E1 se conservó; r2 y r3 se reemplazaron
    new = next(r for r in rows if r["salesforceRecordId"] == "E2")
    assert (new["phone"], new["status"], new["name"]) == ("+528122222222", "pending", "Cliente 2")
    assert new["variables"]["1"] == "Cliente 2" and new["variables"]["2"] == "2026-10-21" and new["variables"]["horaCita"] == "10:00"
    assert new["variables"]["vin"] == "VIN2" and new["variables"]["idQuiter"] == "Q2" and new["variables"]["taller"] == "Norte"
    b = bc(db)
    assert (b["status"], b["totalRecipients"], b["sentCount"], b["deliveredCount"], b["failedCount"]) == ("draft", 2, 1, 0, 0)
    assert b["completedAt"] is None and b["lastRefreshedAt"] is not None
    assert "Type = 'Cita'" in queries[0] and "Calendario__c = 'Taller Norte'" in queries[0] and "GCL_SeRealizo__c = null" in queries[0]


def test_no_show_consulta_las_citas_de_hoy_vencidas_sin_asistir(reminder, monkeypatch):
    queries = []
    monkeypatch.setattr(salesforce, "query_all", lambda cfg, soql, timeout=30: queries.append(soql) or [])
    db = reminder
    db.data["broadcasts"]["b1"].update({"type": "no_show", "reminderConfig": {"eventType": "Cita"}, "status": "completed"})
    result = campaigns.refresh(db, "b1", broadcast(db))
    assert result["recipients"] == 0 and "ActivityDate = TODAY" in queries[0] and "GCL_SeRealizo__c = 'No'" in queries[0]
    assert bc(db)["status"] == "completed"   # sin destinatarios nuevos conserva su estado


def test_el_tipo_de_evento_y_el_calendario_se_escapan_en_la_consulta(reminder, monkeypatch):
    queries = []
    monkeypatch.setattr(salesforce, "query_all", lambda cfg, soql, timeout=30: queries.append(soql) or [])
    reminder.data["broadcasts"]["b1"]["reminderConfig"]["eventType"] = "x' OR Name != '"
    reminder.data["organizations"]["honda"]["sfCalendario"] = "a'b"
    campaigns.refresh(reminder, "b1", broadcast(reminder))
    assert "Type = 'x\\' OR Name != \\''" in queries[0] and "Calendario__c = 'a\\'b'" in queries[0]


def test_refresco_valida_tipo_estado_y_configuracion(reminder, monkeypatch):
    db = reminder
    monkeypatch.setattr(salesforce, "query_all", lambda *a, **k: [])
    db.data["broadcasts"]["b1"]["type"] = "manual"
    with pytest.raises(ua.UserActionError) as e:
        campaigns.refresh(db, "b1", broadcast(db))
    assert e.value.code == "datos_invalidos"
    db.data["broadcasts"]["b1"].update({"type": "appointment_reminder", "status": "sending", "sendingStartedAt": NOW})
    with pytest.raises(ua.UserActionError) as e:
        campaigns.refresh(db, "b1", broadcast(db))
    assert e.value.code == "precondicion_fallida"
    db.data["broadcasts"]["b1"]["sendingStartedAt"] = NOW - timedelta(minutes=30)        # interrumpida: se destraba
    campaigns.refresh(db, "b1", broadcast(db))
    assert bc(db)["status"] == "failed"
    db.data["broadcasts"]["b1"]["reminderConfig"] = {"eventType": "Cita"}
    with pytest.raises(ua.UserActionError) as e:
        campaigns.refresh(db, "b1", broadcast(db))
    assert "daysBefore" in e.value.message
    db.data["broadcasts"]["b1"]["reminderConfig"] = {"daysBefore": 1}
    with pytest.raises(ua.UserActionError) as e:
        campaigns.refresh(db, "b1", broadcast(db))
    assert "eventType" in e.value.message


def test_refresco_sin_credenciales_o_si_salesforce_falla(reminder, monkeypatch):
    monkeypatch.setattr(salesforce, "query_all", lambda *a, **k: None)
    with pytest.raises(ua.UserActionError) as e:
        campaigns.refresh(reminder, "b1", broadcast(reminder))
    assert e.value.code == "error_externo" and e.value.retryable
    reminder.data["organizations"]["honda"]["salesforceConfig"] = {}
    for var in ("SF_INSTANCE_URL", "SF_CLIENT_ID", "SF_CLIENT_SECRET", "SF_USERNAME", "SF_PASSWORD"):
        monkeypatch.delenv(var, raising=False)
    with pytest.raises(ua.UserActionError) as e:
        campaigns.refresh(reminder, "b1", broadcast(reminder))
    assert e.value.code == "precondicion_fallida" and "SF_*" in e.value.message


# --------------------------------------------------------------------------- verificación de entregas

def sent_recipients(db):
    for rid, sid in (("r1", "SID1"), ("r2", "SID2"), ("r3", "SID3")):
        recipients(db)[rid].update({"status": "sent", "whatsappMessageId": sid})
    recipients(db)["r3"]["deliveryStatus"] = "delivered"            # ya final: no se vuelve a consultar


def test_verifica_entregas_y_actualiza_los_contadores(db, provider):
    sent_recipients(db)
    provider.statuses = {"SID1": {"state": "delivered", "message": None}, "SID2": {"state": "failed", "message": "Número inválido"},
                         "SID3": {"state": "failed", "message": "no debe leerse"}}
    result = campaigns.check_status(db, "b1", broadcast(db))
    assert result == {"checked": 2, "delivered": 1, "failed": 1}
    assert recipients(db)["r1"]["deliveryStatus"] == "delivered" and recipients(db)["r2"]["deliveryStatusMessage"] == "Número inválido"
    assert recipients(db)["r3"]["deliveryStatus"] == "delivered"
    assert (bc(db)["deliveredCount"], bc(db)["failedCount"]) == (1, 1)


def test_lo_que_sigue_en_transito_no_se_toca(db, provider):
    sent_recipients(db)
    provider.statuses = {"SID1": {"state": "read", "message": None}}
    assert campaigns.check_status(db, "b1", broadcast(db)) == {"checked": 2, "delivered": 1, "failed": 0}
    assert "deliveryStatus" not in recipients(db)["r2"] and bc(db)["deliveredCount"] == 1 and bc(db)["failedCount"] == 0


def test_verificacion_solo_para_twilio_y_valuetext_y_sin_pendientes(db, provider):
    db.data["whatsappNumbers"]["n1"]["provider"] = "meta"
    with pytest.raises(ua.UserActionError) as e:
        campaigns.check_status(db, "b1", broadcast(db))
    assert e.value.code == "datos_invalidos"
    db.data["whatsappNumbers"]["n1"]["provider"] = "twilio"
    assert campaigns.check_status(db, "b1", broadcast(db)) == {"checked": 0, "delivered": 0, "failed": 0}   # nada enviado todavía
    sent_recipients(db)
    provider.ready_error = "Twilio credentials not configured"
    with pytest.raises(ua.UserActionError):
        campaigns.check_status(db, "b1", broadcast(db))


# --------------------------------------------------------------------------- acciones: permisos

def act(db, token, action, **data):
    return ua.handle({"Authorization": f"Bearer {token}"}, {"action": action, "data": data}, db=db, verifier=verifier)


def test_un_agente_envia_y_el_resultado_llega_en_la_respuesta(db, provider, primed):
    body, status = act(db, "t-ana", "broadcast.send", id="b1")
    assert status == 200 and body["result"] == {"done": True, "sentCount": 3, "failedCount": 0, "skippedCount": 0}


def test_el_viewer_y_otra_organizacion_no_envian(db, provider, primed):
    assert act(db, "t-vera", "broadcast.send", id="b1")[1] == 403
    assert act(db, "t-olga", "broadcast.send", id="b1")[1] == 404
    assert provider.sent == [] and bc(db)["status"] == "draft"


def test_errores_de_negocio_llegan_tipados(db, provider, primed):
    provider.ready_error = "Meta credentials not configured"
    body, status = act(db, "t-ana", "broadcast.send", id="b1")
    assert status == 200 and body["error"] == {"code": "precondicion_fallida", "message": "Meta credentials not configured", "retryable": False}


def test_el_envio_de_prueba_es_solo_del_superadmin(db, provider, primed):
    assert act(db, "t-ana", "broadcast.test_send", id="b1", testPhone="8186019229")[1] == 403
    body, status = act(db, "t-root", "broadcast.test_send", id="b1", testPhone="8186019229", recipientId="r1")
    assert status == 200 and body["result"]["sent"] == 1
    assert act(db, "t-root", "broadcast.test_send", id="b1")[1] == 400
    assert act(db, "t-root", "broadcast.test_send", id="b1", testPhone="abc")[1] == 400
    assert act(db, "t-root", "broadcast.test_send", id="b1", testPhone="8186019229", recipientId=5)[1] == 400


def test_retry_refresh_y_check_status_exigen_permiso_de_escritura(db, provider, primed):
    for action in ("broadcast.retry", "broadcast.refresh", "broadcast.check_status"):
        assert act(db, "t-vera", action, id="b1")[1] == 403
        assert act(db, "t-olga", action, id="b1")[1] == 404
    assert act(db, "t-ana", "broadcast.check_status", id="b1")[0]["result"] == {"checked": 0, "delivered": 0, "failed": 0}
    assert act(db, "t-ana", "broadcast.retry", id="b1")[0]["result"]["retriedCount"] == 0
