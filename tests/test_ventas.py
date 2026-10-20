import importlib
import json
from datetime import datetime, timezone
from io import BytesIO

import pytest

from ai import engine
from core import http, numbers as nb, tools
from core.pipeline import Incoming, process_message
from crm import salesforce
from modules import ventas
from tests.fakes import FakeDB

SF = {"instanceUrl": "https://sf.example", "clientId": "c", "clientSecret": "s", "username": "u", "password": "p",
      "marcaRR": "Honda", "bdcFallbackOwnerId": "005BDC", "ownerId": "005OWN"}
CUSTOMER = "whatsapp:+528186019229"


class SfRouter:
    """Salesforce simulado: responde por (método, fragmento de la URL) y registra cada llamada."""

    def __init__(self, overrides=None):
        self.calls = []
        self.routes = {
            ("POST", "/oauth2/token"): (200, json.dumps({"access_token": "T"})),
            ("POST", "/sobjects/Lead/"): (201, json.dumps({"id": "00QNEW"})),
            ("PATCH", "/sobjects/Lead/"): (204, ""),
            ("POST", "/sobjects/Event/"): (201, json.dumps({"id": "00UNEW"})),
            ("PATCH", "/sobjects/Event/"): (204, ""),
            ("GET", "/query"): (200, json.dumps({"records": []})),
            ("POST", "/actions/custom/flow/"): (200, json.dumps([{"isSuccess": True}])),
            ("GET", "fields="): (200, json.dumps({"GCL_ComentarioLanding__c": "previo"})),
        }
        self.routes.update(overrides or {})

    def __call__(self, url, data=None, headers=None, method="POST", timeout=30):
        try:
            payload = json.loads(data) if data else None
        except ValueError:
            payload = data.decode()
        self.calls.append({"method": method, "url": url, "payload": payload, "headers": headers or {}})
        for (m, fragment), response in self.routes.items():
            if m == method and fragment in url:
                if isinstance(response, Exception):
                    raise response
                return response
        raise AssertionError(f"llamada no prevista: {method} {url}")

    def find(self, method, fragment):
        return [c for c in self.calls if c["method"] == method and fragment in c["url"]]

    def patched_lead(self):
        return [c["payload"] for c in self.find("PATCH", "/sobjects/Lead/")]


def http_error(code):
    return http.HTTPError("u", code, "x", {}, BytesIO(b"{}"))


@pytest.fixture(autouse=True)
def _ventas(monkeypatch):
    salesforce.clear_token_cache()
    nb.clear_bot_cache()
    tools.clear()
    importlib.reload(ventas)  # los handlers se registran al importar; el registro se limpia entre pruebas
    yield
    tools.clear()


@pytest.fixture
def sf(monkeypatch):
    router = SfRouter()
    monkeypatch.setattr(http, "request", router)
    return router


# ---- reglas puras ----

def test_telefono_de_diez_digitos():
    assert ventas.phone_10("whatsapp:+528186019229") == "8186019229"
    assert ventas.phone_10("+5218186019229") == "8186019229"
    assert ventas.phone_10("") == ""


def test_lead_completo_incompleto_y_nombres():
    conv = {"customerPhone": CUSTOMER, "customerName": "Ana López Ruiz"}
    full = ventas.build_lead_record(SF, conv, {"familia_modelo": "a0F1", "concesionaria": "Norte"}, "HO")
    assert (full["FirstName"], full["LastName"], full["Celular__c"], full["GCL_Marca__c"]) == ("Ana", "López Ruiz", "8186019229", "HO")
    assert full["Validacion_Prospecto__c"] == "Con respuesta" and full["Fecha_Deal__c"] and full["OwnerId"] == "005OWN" and full["ReglasAsignacion__c"] is True
    assert full["GCL_ComentarioLanding__c"].startswith("Modelo:a0F1\n")
    partial = ventas.build_lead_record(SF, conv, {}, "HO")
    assert (partial["Validacion_Prospecto__c"], partial["Fecha_Deal__c"]) == ("Sin validar", None)
    # el tool manda nombre y apellido: mandan sobre el nombre del cliente
    assert ventas.build_lead_record(SF, conv, {"nombre": "Luis", "apellido": "Paz"}, "HO")["LastName"] == "Paz"
    # una sola palabra: queda como apellido; sin nada: "Sin Nombre"
    one = ventas.build_lead_record(SF, {"customerName": "Ana"}, {}, "HO")
    assert (one["FirstName"], one["LastName"]) == ("", "Ana")
    assert ventas.build_lead_record(SF, {}, {}, "HO")["LastName"] == "Sin Nombre"


def test_lead_de_seminuevo_usa_el_owner_de_la_ruta_o_el_por_defecto():
    conv = {"customerPhone": CUSTOMER}
    rec = ventas.build_lead_record(dict(SF, seminuevoOwnerId="005RUTA"), conv, {"motivo": " presupuesto 300k "}, "HO", seminuevo=True)
    assert (rec["OwnerId"], rec["GCL_ResponsableBDC__c"], rec["GCL_TipoAuto__c"], rec["ReglasAsignacion__c"]) == ("005RUTA", "005RUTA", "Seminuevo", False)
    assert rec["Validacion_Prospecto__c"] == "Llamada urgente" and rec["Fecha_Deal__c"] is None
    assert rec["GCL_ComentarioLanding__c"].endswith("Comentarios:presupuesto 300k")
    default = ventas.build_lead_record({}, conv, {}, "HO", seminuevo=True)
    assert default["OwnerId"] == ventas.DEFAULT_SEMINUEVO_OWNER_ID and default["RecordTypeId"] == ventas.DEFAULT_SEMINUEVO_RECORD_TYPE_ID
    assert ventas.build_lead_record(dict(SF, vehicleType="seminuevo", seminuevoRecordTypeId="012X"), conv, {}, "HO")["RecordTypeId"] == "012X"


def test_la_hora_de_la_cita_se_interpreta_en_la_zona_de_la_organizacion():
    assert ventas.parse_appointment_datetime({"fecha": "2026-10-20", "hora": "11:30"}) == datetime(2026, 10, 20, 17, 30, tzinfo=timezone.utc)
    assert ventas.parse_appointment_datetime({"fecha": "2026-10-20", "hora": "11:30"}, "America/Bogota").hour == 16
    for bad in ({}, {"fecha": "2026-10-20"}, {"hora": "10:00"}, {"fecha": "20/10", "hora": "x"}):
        assert ventas.parse_appointment_datetime(bad) is None


# ---- operaciones en Salesforce ----

def test_crear_lead_real_y_simulado(sf):
    conv = {"customerPhone": CUSTOMER}
    assert ventas.create_salesforce_lead(SF, conv, {}, "HO") == "00QNEW"
    assert sf.find("POST", "/sobjects/Lead/")[0]["payload"]["GCL_Marca__c"] == "HO"
    n = len(sf.calls)
    simulated = ventas.create_salesforce_lead(dict(SF, leadCreationEnabled=False), conv, {}, "HO")
    assert simulated.startswith("QA-SIMULATED-") and len(sf.calls) == n  # no toca Salesforce


def test_actualizar_lead_traduce_los_campos(sf):
    assert ventas.update_salesforce_lead(SF, "00Q1", {
        "status": "En Proceso", "nombre": "Ana López Ruiz", "familia_modelo": "a0F1", "concesionaria": "Norte", "comentarios": "Quiere SUV"}) is True
    patch = sf.patched_lead()[0]
    assert patch["Status"] == "Asignado" and (patch["FirstName"], patch["LastName"]) == ("Ana", "López Ruiz")
    assert patch["Familia_de_modelo__c"] == "a0F1" and patch["GCL_Concesionaria__c"] == "Norte"
    assert patch["GCL_ComentarioLanding__c"].startswith("previo\n[") and patch["GCL_ComentarioLanding__c"].endswith("] Quiere SUV")


def test_actualizar_lead_no_pisa_comentarios_si_no_pudo_leerlos(monkeypatch):
    router = SfRouter({("GET", "fields="): http_error(500)})
    monkeypatch.setattr(http, "request", router)
    assert ventas.update_salesforce_lead(SF, "00Q1", {"comentarios": "x", "concesionaria": "Norte"}) is True
    assert "GCL_ComentarioLanding__c" not in router.patched_lead()[0]
    assert ventas.update_salesforce_lead(SF, "00Q1", {"comentarios": "solo esto"}) is False  # nada más que escribir


def test_actualizar_lead_vehiculo_seminuevo_ignora_la_familia_y_sin_creacion_no_escribe(sf):
    ventas.update_salesforce_lead(dict(SF, vehicleType="seminuevo"), "00Q1", {"familia_modelo": "a0F1", "concesionaria": "Norte"})
    assert "Familia_de_modelo__c" not in sf.patched_lead()[0]
    n = len(sf.calls)
    assert ventas.update_salesforce_lead(dict(SF, leadCreationEnabled=False), "00Q1", {"concesionaria": "x"}) is True and len(sf.calls) == n


def test_cita_nueva_crea_el_event_y_deja_el_lead_en_cita(sf):
    conv = {"customerName": "Ana López"}
    assert ventas.create_salesforce_appointment(SF, "00Q1", {"fecha": "2026-10-20", "hora": "11:30", "concesionaria": "Norte"}, conv) is True
    event = sf.find("POST", "/sobjects/Event/")[0]["payload"]
    assert event["StartDateTime"] == "2026-10-20T17:30:00+0000" and event["EndDateTime"] == "2026-10-20T18:30:00+0000"
    assert (event["Subject"], event["WhoId"], event["Type"]) == ("Cita presencial - Ana López", "00Q1", "Cita presencial")
    assert sf.patched_lead()[-1] == {"Status": "Cita", "Validacion_Prospecto__c": "Finalizado con cita"}


def test_cita_existente_se_reagenda_sin_crear_otra(monkeypatch):
    router = SfRouter({("GET", "/query"): (200, json.dumps({"records": [{"Id": "00UOLD"}]}))})
    monkeypatch.setattr(http, "request", router)
    assert ventas.create_salesforce_appointment(SF, "00Q1", {"fecha": "2026-10-20", "hora": "11:30"}, {}) is True
    assert not router.find("POST", "/sobjects/Event/")
    patch = router.find("PATCH", "/sobjects/Event/00UOLD")[0]["payload"]
    assert "WhoId" not in patch and patch["StartDateTime"].startswith("2026-10-20")


def test_cita_sin_fecha_no_llama_a_salesforce(sf):
    assert ventas.create_salesforce_appointment(SF, "00Q1", {"hora": "10:00"}, {}) is False and sf.calls == []


def test_asignacion_por_horario(sf):
    open_bot, closed_bot = {}, {"scheduleConfig": {"enabled": True, "schedule": []}}
    ventas.assign_by_schedule(open_bot, dict(SF, rrFlowName="OtroFlow"), "00Q1")
    assert sf.find("POST", "/actions/custom/flow/OtroFlow")[0]["payload"] == {"inputs": [{"leadId": "00Q1", "marcaRR": "Honda"}]}
    ventas.assign_by_schedule(open_bot, SF, "00Q1")
    assert sf.find("POST", "/actions/custom/flow/RRAgenteIACLEBER")  # nombre por defecto
    ventas.assign_by_schedule(closed_bot, SF, "00Q2")
    assert sf.patched_lead()[-1] == {"OwnerId": "005BDC"}  # fuera de horario: owner de BDC, sin tocar la validación
    n = len(sf.calls)
    ventas.assign_by_schedule(closed_bot, {k: v for k, v in SF.items() if k != "marcaRR"}, "00Q3")
    ventas.assign_by_schedule(closed_bot, {k: v for k, v in SF.items() if k != "bdcFallbackOwnerId"}, "00Q3")
    assert len(sf.calls) == n


def test_descarte_del_lead_por_situacion(sf):
    ventas.patch_lead_situacion(SF, "00Q1", "servicio_postventa")
    ventas.patch_lead_situacion(SF, "00Q1", "fuera_de_alcance")
    ventas.patch_lead_situacion(SF, "00Q1", "finalizado_por_cliente")
    ventas.patch_lead_situacion(SF, "00Q1", "otra")
    ventas.patch_lead_situacion(dict(SF, situationMap={"servicio_postventa": {"status": "Perdido", "razon": "Taller"}}), "00Q1", "servicio_postventa")
    servicio, descarte, finalizado, otra, custom = sf.patched_lead()
    assert servicio == {"Status": "Cerrado/Perdido", "Validacion_Prospecto__c": "Sin validar", "Fecha_Deal__c": None, "GCL_RazonNoCompra__c": "Servicio"}
    assert (descarte["Status"], descarte["GCL_RazonNoCompra__c"]) == ("Descartado", "No Lead")
    assert finalizado["Validacion_Prospecto__c"] == "Finalizado por cliente" and "GCL_RazonNoCompra__c" not in finalizado
    assert otra["GCL_RazonNoCompra__c"] == "otra"
    assert (custom["Status"], custom["GCL_RazonNoCompra__c"]) == ("Perdido", "Taller")


def test_opt_out_y_cierre_sin_respuesta(sf):
    ventas.update_lead_on_stop(SF, "00Q1")
    ventas.reset_lead_sin_respuesta(SF, "00Q1")
    assert sf.patched_lead() == [
        {"Validacion_Prospecto__c": "Finalizado por cliente", "Status": "Nuevo", "Fecha_Deal__c": None},
        {"Validacion_Prospecto__c": "Sin validar", "Status": "Nuevo", "Fecha_Deal__c": None},
    ]


# ---- en el pipeline (proveedor ValueText con Salesforce) ----

@pytest.fixture
def env(monkeypatch):
    db = FakeDB()
    db.seed("organizations", "honda", {"sfBrandCode": "HO", "salesforceConfig": {"marcaRR": "Honda"}, "settings": {"timezone": "America/Mexico_City"}})
    db.seed("teams", "tv", {"vertical": "ventas", "assignmentMode": "manual"})
    for k, v in {"SF_INSTANCE_URL": "https://sf.example", "SF_CLIENT_ID": "c", "SF_CLIENT_SECRET": "s", "SF_USERNAME": "u", "SF_PASSWORD": "p"}.items():
        monkeypatch.setenv(k, v)

    class Env:
        pass

    e = Env()
    e.db, e.sent, e.bot_calls = db, [], []
    e.state = {"results": [], "default": {"success": True, "result": {"response": "Hola", "toolResults": []}}}
    e.sf = SfRouter()
    monkeypatch.setattr(http, "request", e.sf)

    def fake_engine(bot, messages, conv_id=None, customer_phone=""):
        e.bot_calls.append(messages[-1]["text"])
        return e.state["results"].pop(0) if e.state["results"] else e.state["default"]

    monkeypatch.setattr(engine, "send_to_bot", fake_engine)
    e.bot = {"id": "bot1", "organizationId": "honda", "teamId": "tv", "type": "chatllm", "provider": "valuetext", "name": "Ventas",
             "salesforceConfig": dict(SF), "handoffConfig": {"enabled": True, "triggerKeywords": ["asesor"]}}

    def run(body="hola", bot=None, **inc):
        msg = Incoming(provider="valuetext", from_number=CUSTOMER, to_number="whatsapp:+5255000002", body=body, **inc)
        process_message(msg, bot or e.bot, lambda b, to, frm, text, media_url=None: e.sent.append(text), db=db)

    e.run = run
    e.conv = lambda: next(iter(db.data["conversations"].values()))
    e.tool = lambda name, **inp: {"success": True, "result": {"response": "ok", "toolResults": [{"toolName": name, "input": inp}]}}
    return e


def test_crear_lead_guarda_el_id_y_avisa_al_bot(env):
    env.state["default"] = env.tool("Crear_Lead", nombre="Ana", familia_modelo="a0F1")
    env.run("quiero cotizar")
    conv = env.conv()
    assert (conv["leadId"], conv["completedLead"]) == ("00QNEW", True)
    assert env.sf.find("POST", "/sobjects/Lead/")[0]["payload"]["GCL_Marca__c"] == "HO"
    msgs = [m["text"] for m in env.db.data[f"conversations/{conv['id']}/messages"].values()]
    assert '<<CONTEXTO>> LeadID: "00QNEW" | Lead creado exitosamente' in msgs


def test_si_la_creacion_falla_se_libera_el_claim_para_reintentar(env):
    env.sf.routes[("POST", "/sobjects/Lead/")] = http_error(400)
    env.state["default"] = env.tool("Crear_Lead", nombre="Ana")
    env.run("quiero cotizar")
    conv = env.conv()
    assert "leadId" not in conv and "leadCreationClaimedAt" not in conv
    msgs = [m["text"] for m in env.db.data[f"conversations/{conv['id']}/messages"].values()]
    assert "<<CONTEXTO>> No se pudo crear el Lead en Salesforce" in msgs


def test_otra_invocacion_ya_creo_el_lead_no_se_crea_un_segundo(env):
    env.run("hola")
    cid = env.conv()["id"]
    env.db.data["conversations"][cid]["leadCreationClaimedAt"] = datetime.now(timezone.utc)  # otra invocación lo está creando
    env.state["default"] = env.tool("Crear_Lead", nombre="Ana")
    env.run("quiero cotizar")
    assert not env.sf.find("POST", "/sobjects/Lead/")


def test_crear_lead_y_transferir_en_el_mismo_turno_escala_con_el_lead_recien_creado(env):
    env.state["default"] = {"success": True, "result": {"response": "Te conecto", "toolResults": [
        {"toolName": "Transferir_a_Asesor", "input": {"motivo": "cotización"}}, {"toolName": "Crear_Lead", "input": {"nombre": "Ana"}}]}}
    env.run("hola")
    conv = env.conv()
    assert (conv["leadId"], conv["status"], conv["handoffReason"]) == ("00QNEW", "waiting_agent", "cotización")
    assert env.sent[-1] == "Te conecto" and len(env.bot_calls) == 1  # sin re-preguntar al bot
    patches = env.sf.patched_lead()
    assert {"Validacion_Prospecto__c": "Llamada urgente", "Status": "Contactado"} in patches
    assert env.sf.find("POST", "/actions/custom/flow/RRAgenteIACLEBER")


def test_handoff_sin_lead_no_escala_y_le_pide_los_datos_al_bot(env):
    env.state["results"] = [
        {"success": True, "result": {"response": "¿Me das tu nombre completo?", "toolResults": []}},  # follow-up tras el contexto
    ]
    env.run("quiero un asesor")
    conv = env.conv()
    assert conv["status"] == "bot" and "leadId" not in conv
    assert env.bot_calls == [ventas.HANDOFF_NO_LEAD_CONTEXT] and env.sent == ["¿Me das tu nombre completo?"]
    msgs = env.db.data[f"conversations/{conv['id']}/messages"].values()
    assert any(m["sender"] == "system" and m["text"] == ventas.HANDOFF_NO_LEAD_CONTEXT for m in msgs)


def test_handoff_sin_lead_si_el_bot_resuelve_en_el_follow_up_escala(env):
    env.state["results"] = [{"success": True, "result": {"response": "Listo, te conecto", "toolResults": [
        {"toolName": "Transferir_a_Asesor", "input": {"motivo": "tras crear lead"}}]}}]
    env.run("quiero un asesor")
    conv = env.conv()
    assert (conv["status"], conv["handoffReason"]) == ("waiting_agent", "tras crear lead") and env.sent == ["Listo, te conecto"]


def test_handoff_sin_lead_fuera_de_horario_avisa_y_marca(env):
    closed = dict(env.bot, scheduleConfig={"enabled": True, "outOfHoursMessage": "Cerrado.", "schedule": []})
    env.state["results"] = [{"success": True, "result": {"response": "ok", "toolResults": [{"toolName": "Transferir_a_Asesor", "input": {}}]}}]
    env.run("quiero un asesor", bot=closed)
    conv = env.conv()
    assert conv["status"] == "bot" and conv["handoffBlockedAt"] is not None and env.sent[-1].startswith("Cerrado.")


def test_handoff_con_lead_por_palabra_clave_y_fuera_de_horario_deja_el_lead_con_bdc(env):
    env.run("hola")
    cid = env.conv()["id"]
    env.db.data["conversations"][cid]["leadId"] = "00Q1"
    closed = dict(env.bot, scheduleConfig={"enabled": True, "outOfHoursMessage": "Cerrado.", "schedule": []})
    env.run("quiero un asesor", bot=closed)
    assert env.sf.patched_lead()[-1] == {"OwnerId": "005BDC", "Validacion_Prospecto__c": "Llamada urgente"}
    assert env.db.data["conversations"][cid]["status"] == "bot"


def test_sin_salesforce_los_handlers_se_auto_excluyen(env):
    twilio_bot = {k: v for k, v in env.bot.items() if k != "salesforceConfig"}
    twilio_bot["provider"] = "twilio"
    env.state["default"] = env.tool("Crear_Lead", nombre="Ana")
    env.run("quiero cotizar", bot=twilio_bot)
    assert "leadId" not in env.conv() and env.sf.calls == []
    env.state["default"] = {"success": True, "result": {"response": "ok", "toolResults": []}}
    env.run("quiero un asesor", bot=twilio_bot)  # el handoff no exige Lead sin Salesforce
    assert env.conv()["status"] == "waiting_agent"


def test_opt_out_con_lead_actualiza_salesforce(env):
    env.run("hola")
    env.db.data["conversations"][env.conv()["id"]]["leadId"] = "00Q1"
    env.run("STOP")
    assert env.conv()["status"] == "closed"
    assert {"Validacion_Prospecto__c": "Finalizado por cliente", "Status": "Nuevo", "Fecha_Deal__c": None} in env.sf.patched_lead()


def test_primera_respuesta_del_cliente_actualiza_el_lead(env):
    env.run("hola")
    cid = env.conv()["id"]
    env.db.data["conversations"][cid].update(leadId="00Q1")
    env.db.data["conversations"][cid].pop("lastCustomerMessageAt", None)
    env.run("sí, me interesa")
    patch = next(p for p in env.sf.patched_lead() if p.get("Validacion_Prospecto__c") == "Con respuesta")
    assert patch["Status"] == "Contactado" and patch["Fecha_Deal__c"]


def test_actualizar_lead_en_el_turno(env):
    env.run("hola")
    env.db.data["conversations"][env.conv()["id"]]["leadId"] = "00Q1"
    env.state["default"] = env.tool("Actualizar_Lead", concesionaria="Norte", familia_modelo="a0F1")
    env.run("la de Norte")
    assert env.conv()["completedLead"] is True
    assert any(p.get("GCL_Concesionaria__c") == "Norte" for p in env.sf.patched_lead())


def test_cita_valida_crea_el_event_y_asigna(env):
    env.run("hola")
    env.db.data["conversations"][env.conv()["id"]]["leadId"] = "00Q1"
    env.state["default"] = env.tool("Crear_Cita_Ventas_Salesforce", fecha="2026-10-20", hora="11:30", concesionaria="Norte")
    env.run("el martes 11:30")
    conv = env.conv()
    assert (conv["appointmentStatus"], conv["conversationOutcome"]) == ("cita_bot", "cita_bot")
    assert env.sf.find("POST", "/sobjects/Event/") and env.sf.find("POST", "/actions/custom/flow/RRAgenteIACLEBER")
    assert env.sent[-1] == "ok"


def test_cita_sin_fecha_reemplaza_la_confirmacion_del_bot(env):
    env.run("hola")
    env.db.data["conversations"][env.conv()["id"]]["leadId"] = "00Q1"
    env.state["default"] = env.tool("Crear_Cita_Ventas_Salesforce")
    env.run("agéndame")
    assert env.sent[-1] == ventas.CITA_INPUT_INVALIDO_MESSAGE
    assert "appointmentStatus" not in env.conv() and not env.sf.find("POST", "/sobjects/Event/")


# ---- situaciones ----

def test_situacion_seminuevo_inbound_crea_el_lead_del_equipo_de_seminuevos_y_saca_la_conversacion_del_bot(env):
    bot = dict(env.bot, situationRouting=[{"situacion": "seminuevo", "destino": "lead", "seminuevoOwnerId": "005SEMI"}])
    env.state["default"] = env.tool("Detectar_Situacion", situacion="seminuevo", motivo="presupuesto 300k")
    env.run("busco un seminuevo", bot=bot)
    conv = env.conv()
    assert (conv["leadId"], conv["status"]) == ("00QNEW", "with_agent")
    lead = env.sf.find("POST", "/sobjects/Lead/")[0]["payload"]
    assert (lead["OwnerId"], lead["GCL_TipoAuto__c"]) == ("005SEMI", "Seminuevo") and "presupuesto 300k" in lead["GCL_ComentarioLanding__c"]
    assert "lastCustomerMessageAt" not in conv  # se resetea para que su respuesta cuente como la primera


def test_situacion_seminuevo_outbound_solo_deriva_al_round_robin(env):
    env.run("hola")
    env.db.data["conversations"][env.conv()["id"]]["leadId"] = "00QOLD"
    bot = dict(env.bot, situationRouting=[{"situacion": "seminuevo", "destino": "lead"}])
    env.state["default"] = env.tool("Detectar_Situacion", situacion="seminuevo")
    env.run("quiero un seminuevo", bot=bot)
    assert not env.sf.find("POST", "/sobjects/Lead/") and env.sf.find("POST", "/actions/custom/flow/RRAgenteIACLEBER")
    assert env.conv()["status"] == "with_agent"


def test_situacion_servicio_descarta_el_lead_y_cierra(env):
    env.run("hola")
    env.db.data["conversations"][env.conv()["id"]]["leadId"] = "00Q1"
    bot = dict(env.bot, situationRouting=[{"situacion": "servicio_postventa", "destino": "ninguno"}])
    env.state["default"] = env.tool("Detectar_Situacion", situacion="servicio_postventa")
    env.run("necesito servicio", bot=bot)
    assert env.conv()["status"] == "closed"
    assert env.sf.patched_lead()[-1]["GCL_RazonNoCompra__c"] == "Servicio"


# ---- transferir por el endpoint (1.46) ----

def _bot_pide(env, monkeypatch, *pedidos):
    """El bot llama al endpoint de acciones, en orden, mientras el pipeline espera su respuesta."""
    from contracts.actions import ActionRequest
    from core import actions
    env.db.seed("bots", "bot1", env.bot)
    env.responses = []

    def fake_engine(bot, messages, conv_id=None, customer_phone=""):
        env.bot_calls.append(messages[-1]["text"])
        for i, (action, data) in enumerate(pedidos):
            env.responses.append(actions.execute_action(ActionRequest(action, conv_id, f"k{i}", data), "bot1", env.db))
        return env.state["default"]

    monkeypatch.setattr(engine, "send_to_bot", fake_engine)


def test_transferir_sin_lead_por_el_endpoint_no_le_habla_al_cliente_y_le_dice_al_bot_que_falta(env, monkeypatch):
    _bot_pide(env, monkeypatch, ("transferir_a_asesor", {"motivo": "cotización"}))
    env.state["default"] = {"success": True, "result": {"response": "¿Me das tu nombre completo?", "toolResults": []}}
    env.run("necesito una cotización")   # sin la palabra clave "asesor": solo transfiere el bot, por el endpoint
    r = env.responses[0]
    assert not r.ok and r.error.code == "precondicion_fallida" and "Crear_Lead" in r.error.message
    assert env.conv()["status"] == "bot"
    assert env.bot_calls == ["necesito una cotización"] and env.sent == ["¿Me das tu nombre completo?"]   # sin re-invocar al bot ni mensaje del gate


def test_crear_lead_y_transferir_por_el_endpoint_escala_con_el_lead(env, monkeypatch):
    _bot_pide(env, monkeypatch, ("crear_lead", {"nombre": "Ana"}), ("transferir_a_asesor", {"motivo": "cotización"}))
    env.state["default"] = {"success": True, "result": {"response": "Te conecto", "toolResults": []}}
    env.run("hola")
    conv = env.conv()
    assert [r.ok for r in env.responses] == [True, True] and env.responses[1].result == {"estado": "escalado"}
    assert (conv["leadId"], conv["status"], conv["handoffReason"]) == ("00QNEW", "waiting_agent", "cotización")
    assert env.sent == ["Te conecto"] and len(env.sf.find("POST", "/sobjects/Lead/")) == 1
    assert {"Validacion_Prospecto__c": "Llamada urgente", "Status": "Contactado"} in env.sf.patched_lead()
