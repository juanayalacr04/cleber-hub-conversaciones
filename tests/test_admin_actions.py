import importlib

import pytest

from core import admin_actions, user_actions as ua
from tests.fakes import FakeDB

TOKENS = {"t-admin": "admin1", "t-ana": "ana", "t-olga": "olga", "t-root": "root", "t-vera": "vera"}


def verifier(token):
    return {"uid": TOKENS[token]} if token in TOKENS else None


@pytest.fixture(autouse=True)
def acciones():
    ua.clear()
    importlib.reload(admin_actions)
    yield
    ua.clear()


@pytest.fixture
def db():
    d = FakeDB()
    d.seed("users", "admin1", {"role": "admin", "organizationIds": ["honda"], "organizationId": "honda"})
    d.seed("users", "ana", {"role": "agent", "organizationIds": ["honda"], "organizationId": "honda",
                            "teamId": "ventas", "orgTeams": {"honda": "ventas"}})
    d.seed("users", "beto", {"role": "agent", "organizationIds": ["honda", "kia"], "organizationId": "kia",
                             "orgTeams": {"honda": "ventas", "kia": "kia-t"}, "teamId": "kia-t"})
    d.seed("users", "olga", {"role": "admin", "organizationIds": ["kia"], "organizationId": "kia"})
    d.seed("users", "vera", {"role": "viewer", "organizationIds": ["honda"], "organizationId": "honda"})
    d.seed("users", "root", {"role": "viewer", "isSuperAdmin": True})
    d.seed("users", "kiauser", {"role": "agent", "organizationIds": ["kia"], "organizationId": "kia"})
    d.seed("organizations", "honda", {"name": "Honda", "sfBrandCode": "HO", "plan": "enterprise"})
    d.seed("organizations", "kia", {"name": "Kia", "sfBrandCode": "KI"})
    d.seed("teams", "ventas", {"organizationId": "honda", "vertical": "ventas", "name": "Ventas"})
    d.seed("teams", "servicio", {"organizationId": "honda", "vertical": "servicio", "name": "Servicio"})
    d.seed("teams", "kia-t", {"organizationId": "kia", "vertical": "ventas", "name": "Kia"})
    d.seed("bots", "bot1", {"organizationId": "honda", "name": "Bot", "type": "chatllm", "vertical": "ventas"})
    d.seed("bots", "bot-kia", {"organizationId": "kia", "name": "Bot K", "type": "chatllm", "vertical": "ventas"})
    d.seed("templates", "tpl1", {"organizationId": "honda", "name": "T", "content": "c"})
    d.seed("whatsappNumbers", "n1", {"organizationId": "honda", "phoneNumber": "whatsapp:+521", "teamId": "ventas", "provider": "twilio"})
    d.seed("whatsappNumbers", "n-kia", {"organizationId": "kia", "phoneNumber": "whatsapp:+529", "provider": "twilio"})
    d.seed("conversations", "c-abierta", {"organizationId": "honda", "whatsappNumberId": "n1", "status": "bot", "teamId": "ventas"})
    d.seed("conversations", "c-cerrada", {"organizationId": "honda", "whatsappNumberId": "n1", "status": "closed", "teamId": "ventas"})
    return d


def run(db, token, action, **data):
    return ua.handle({"Authorization": f"Bearer {token}"}, {"action": action, "data": data}, db=db, verifier=verifier)


def doc(db, collection, id):
    return db.data[collection][id]


# --------------------------------------------------------------------------- lista blanca y permisos comunes

def test_solo_admin_de_la_organizacion_crea(db):
    fields = {"name": "Nuevo", "vertical": "ventas"}
    assert run(db, "t-ana", "team.create", organizationId="honda", fields=fields)[1] == 403      # agente
    assert run(db, "t-olga", "team.create", organizationId="honda", fields=fields)[1] == 403     # admin de otra marca
    body, status = run(db, "t-admin", "team.create", organizationId="honda", fields=fields)
    assert status == 200
    team = doc(db, "teams", body["result"]["id"])
    assert team["organizationId"] == "honda" and team["status"] == "active" and team["activeConversations"] == 0
    assert team["createdAt"] is not None


def test_campo_fuera_de_la_lista_blanca_o_con_tipo_invalido(db):
    for fields in ({"name": "x", "vertical": "ventas", "activeConversations": 99},
                   {"name": "x", "vertical": "ventas", "createdAt": "ayer"},
                   {"name": 5, "vertical": "ventas"},
                   {"name": "x", "vertical": "marte"},
                   {"name": "x", "vertical": "ventas", "maxConversationsPerAgent": True}):
        assert run(db, "t-admin", "team.create", organizationId="honda", fields=fields)[1] == 400, fields


def test_faltan_campos_obligatorios(db):
    for fields in ({"vertical": "ventas"}, {"name": "  ", "vertical": "ventas"}, {"name": "x"}):
        body, status = run(db, "t-admin", "team.create", organizationId="honda", fields=fields)
        assert status == 400 and "Faltan" in body["error"]["message"]


def test_update_no_toca_recursos_de_otra_organizacion_ni_revela_si_existen(db):
    ajeno, s1 = run(db, "t-admin", "team.update", id="kia-t", set={"name": "x"})
    inexistente, s2 = run(db, "t-admin", "team.update", id="no-hay", set={"name": "x"})
    assert s1 == s2 == 404 and ajeno == inexistente
    assert doc(db, "teams", "kia-t")["name"] == "Kia"


def test_update_set_y_unset(db):
    db.data["teams"]["ventas"]["maxConversationsPerAgent"] = 5
    assert run(db, "t-admin", "team.update", id="ventas", set={"name": "Ventas 2"}, unset=["maxConversationsPerAgent"])[1] == 200
    t = doc(db, "teams", "ventas")
    assert t["name"] == "Ventas 2" and "maxConversationsPerAgent" not in t


@pytest.mark.parametrize("body", [{}, {"set": {}}, {"unset": "name"}, {"set": {"name": "a"}, "unset": ["name"]},
                                  {"set": {"name": ""}}, {"unset": ["createdAt"]}])
def test_update_invalido(db, body):
    assert run(db, "t-admin", "team.update", id="ventas", **body)[1] == 400


def test_mover_de_organizacion_es_solo_del_superadmin(db):
    assert run(db, "t-admin", "team.update", id="ventas", set={"organizationId": "kia"})[1] == 403
    assert run(db, "t-admin", "team.update", id="ventas", unset=["organizationId"])[1] == 403
    assert doc(db, "teams", "ventas")["organizationId"] == "honda"
    assert run(db, "t-root", "team.update", id="ventas", set={"organizationId": "kia"})[1] == 200
    assert run(db, "t-root", "team.update", id="ventas", set={"organizationId": "no-hay"})[1] == 400


# --------------------------------------------------------------------------- equipos

def test_equipo_valida_tope_y_semaforo(db):
    assert run(db, "t-admin", "team.update", id="ventas", set={"maxConversationsPerAgent": 0})[1] == 400
    assert run(db, "t-admin", "team.update", id="ventas", set={"semaphoreThresholds": {"yellowMinutes": 10, "redMinutes": 5}})[1] == 400
    assert run(db, "t-admin", "team.update", id="ventas", set={"semaphoreThresholds": {"yellowMinutes": "a", "redMinutes": 5}})[1] == 400
    assert run(db, "t-admin", "team.update", id="ventas", set={"semaphoreThresholds": {"yellowMinutes": 5, "redMinutes": 10}})[1] == 200


def test_borrar_equipo_libera_agentes_y_numeros_de_esa_organizacion(db):
    assert run(db, "t-admin", "team.delete", id="ventas")[1] == 200
    assert "ventas" not in db.data["teams"]
    ana, beto = doc(db, "users", "ana"), doc(db, "users", "beto")
    assert ana["teamId"] is None and "honda" not in ana["orgTeams"]
    assert "honda" not in beto["orgTeams"] and beto["orgTeams"]["kia"] == "kia-t" and beto["teamId"] == "kia-t"
    assert doc(db, "whatsappNumbers", "n1")["teamId"] is None
    assert doc(db, "whatsappNumbers", "n-kia")["provider"] == "twilio"


def test_borrar_equipo_ajeno_es_404(db):
    assert run(db, "t-admin", "team.delete", id="kia-t")[1] == 404
    assert "kia-t" in db.data["teams"]


# --------------------------------------------------------------------------- números

def test_numero_se_normaliza_y_referencias_deben_ser_de_la_organizacion(db):
    body, status = run(db, "t-admin", "number.create", organizationId="honda",
                       fields={"phoneNumber": " +5218100000000 ", "provider": "twilio", "teamId": "ventas", "defaultBotId": "bot1"})
    assert status == 200
    n = doc(db, "whatsappNumbers", body["result"]["id"])
    assert n["phoneNumber"] == "whatsapp:+5218100000000" and n["displayName"] == n["phoneNumber"] and n["status"] == "active"
    base = {"phoneNumber": "+5218111111111", "provider": "meta"}
    assert run(db, "t-admin", "number.create", organizationId="honda", fields={**base, "teamId": "kia-t"})[1] == 400
    assert run(db, "t-admin", "number.create", organizationId="honda", fields={**base, "defaultBotId": "bot-kia"})[1] == 400
    assert run(db, "t-admin", "number.create", organizationId="honda", fields={**base, "leadTemplateId": "no-hay"})[1] == 400
    assert run(db, "t-admin", "number.create", organizationId="honda", fields={**base, "leadTemplateId": "tpl1"})[1] == 200


def test_numero_duplicado_se_rechaza_pero_se_puede_editar_a_si_mismo(db):
    body, status = run(db, "t-admin", "number.create", organizationId="honda", fields={"phoneNumber": "whatsapp:+529", "provider": "twilio"})
    assert status == 400 and "ya está dado de alta" in body["error"]["message"]
    assert run(db, "t-admin", "number.update", id="n1", set={"phoneNumber": "+521", "displayName": "Sucursal"})[1] == 200
    assert doc(db, "whatsappNumbers", "n1")["displayName"] == "Sucursal"


def test_cambiar_el_equipo_de_un_numero_mueve_sus_conversaciones_abiertas(db):
    assert run(db, "t-admin", "number.update", id="n1", set={"teamId": "servicio"})[1] == 200
    abierta, cerrada = doc(db, "conversations", "c-abierta"), doc(db, "conversations", "c-cerrada")
    assert (abierta["teamId"], abierta["vertical"]) == ("servicio", "servicio")
    assert cerrada["teamId"] == "ventas" and "vertical" not in cerrada


def test_editar_el_numero_sin_cambiar_equipo_no_toca_conversaciones(db):
    run(db, "t-admin", "number.update", id="n1", set={"displayName": "X"})
    assert doc(db, "conversations", "c-abierta")["teamId"] == "ventas"


def test_numero_horas_deben_ser_positivas_y_se_puede_quitar_un_equipo(db):
    assert run(db, "t-admin", "number.update", id="n1", set={"reopenWindowHours": 0})[1] == 400
    assert run(db, "t-admin", "number.update", id="n1", set={"teamId": None})[1] == 200
    assert doc(db, "whatsappNumbers", "n1")["teamId"] is None


def test_borrar_numero(db):
    assert run(db, "t-admin", "number.delete", id="n1")[1] == 200 and "n1" not in db.data["whatsappNumbers"]


# --------------------------------------------------------------------------- bots, plantillas, etiquetas

def test_bot_crear_editar_y_sin_borrado(db):
    body, status = run(db, "t-admin", "bot.create", organizationId="honda", fields={"name": "B", "type": "workflow", "vertical": "servicio"})
    assert status == 200 and doc(db, "bots", body["result"]["id"])["status"] == "active"
    assert run(db, "t-admin", "bot.create", organizationId="honda", fields={"name": "B", "type": "otro", "vertical": "servicio"})[1] == 400
    assert run(db, "t-admin", "bot.update", id="bot1", set={"status": "paused", "handoffConfig": {"enabled": True}}, unset=["tools"])[1] == 200
    assert doc(db, "bots", "bot1")["status"] == "paused"
    assert run(db, "t-admin", "bot.update", id="bot1", set={"status": "roto"})[1] == 400
    assert run(db, "t-admin", "bot.delete", id="bot1")[1] == 404 and "bot1" in db.data["bots"]  # no hay acción de borrado


def test_plantilla_crud(db):
    body, _ = run(db, "t-admin", "template.create", organizationId="honda", fields={"name": "N", "content": "Hola", "category": "x", "vertical": "ventas"})
    tid = body["result"]["id"]
    assert run(db, "t-admin", "template.update", id=tid, set={"content": "Hola 2"})[1] == 200
    assert run(db, "t-admin", "template.update", id=tid, set={"content": ""})[1] == 400
    assert run(db, "t-admin", "template.delete", id=tid)[1] == 200 and tid not in db.data["templates"]


def test_etiqueta_equipo_solo_al_crear_y_de_la_organizacion(db):
    assert run(db, "t-admin", "label.create", organizationId="honda", fields={"name": "L", "color": "red", "teamId": "kia-t"})[1] == 400
    assert run(db, "t-admin", "label.create", organizationId="honda", fields={"name": "L", "color": "fucsia", "teamId": "ventas"})[1] == 400
    body, status = run(db, "t-admin", "label.create", organizationId="honda", fields={"name": "L", "color": "red", "teamId": "ventas"})
    lid = body["result"]["id"]
    assert status == 200 and run(db, "t-admin", "label.update", id=lid, set={"color": "blue"})[1] == 200
    assert run(db, "t-admin", "label.update", id=lid, set={"teamId": "servicio"})[1] == 400
    assert run(db, "t-admin", "label.delete", id=lid)[1] == 200


# --------------------------------------------------------------------------- organizaciones

def test_admin_edita_nombre_zona_y_salesforce_pero_no_los_campos_de_plataforma(db):
    assert run(db, "t-admin", "organization.update", id="honda", set={"name": "Honda MX", "settings.timezone": "America/Monterrey",
                                                                     "salesforceConfig": {"ownerId": "x"}})[1] == 200
    o = doc(db, "organizations", "honda")
    assert o["name"] == "Honda MX" and o["settings"]["timezone"] == "America/Monterrey" and o["salesforceConfig"] == {"ownerId": "x"}
    for field in ("sfBrandCode", "sfCalendario", "plan", "salesforceConfig.vehicleType", "settings"):
        assert run(db, "t-admin", "organization.update", id="honda", set={field: "x" if field != "settings" else {}})[1] == 403, field
    assert doc(db, "organizations", "honda")["sfBrandCode"] == "HO"


def test_admin_de_otra_marca_no_edita_la_organizacion(db):
    assert run(db, "t-olga", "organization.update", id="honda", set={"name": "x"})[1] == 404


def test_superadmin_cambia_codigo_de_marca_con_unicidad(db):
    assert run(db, "t-root", "organization.update", id="honda", set={"sfBrandCode": "KI"})[1] == 400
    assert run(db, "t-root", "organization.update", id="honda", set={"sfBrandCode": "HO"})[1] == 200   # el suyo
    assert run(db, "t-root", "organization.update", id="honda", set={"sfBrandCode": "HN", "salesforceConfig.vehicleType": "seminuevo"})[1] == 200
    assert doc(db, "organizations", "honda")["salesforceConfig"] == {"vehicleType": "seminuevo"}
    assert run(db, "t-root", "organization.update", id="honda", set={"salesforceConfig": {}, "salesforceConfig.vehicleType": "x"})[1] == 400


def test_alta_de_organizacion_solo_superadmin(db):
    fields = {"name": "Nissan", "sfBrandCode": "NI", "salesforceConfig": {"vehicleType": "nuevo"}}
    assert run(db, "t-admin", "organization.create", fields=fields)[1] == 403
    body, status = run(db, "t-root", "organization.create", fields=fields)
    assert status == 200
    o = doc(db, "organizations", body["result"]["id"])
    assert o["plan"] == "enterprise" and o["settings"] == {"timezone": "America/Mexico_City"} and o["createdAt"] is not None
    assert run(db, "t-root", "organization.create", fields={"name": "Otra", "sfBrandCode": "NI"})[1] == 400
    assert run(db, "t-root", "organization.create", fields={"name": " "})[1] == 400


# --------------------------------------------------------------------------- agentes

def test_cambiar_rol_y_disponibilidad(db):
    assert run(db, "t-admin", "member.set_role", organizationId="honda", userId="ana", role="viewer")[1] == 200
    assert doc(db, "users", "ana")["role"] == "viewer"
    assert run(db, "t-admin", "member.set_role", organizationId="honda", userId="ana", role="dios")[1] == 400
    assert run(db, "t-admin", "member.set_availability", organizationId="honda", userId="ana", available=True)[1] == 200
    assert doc(db, "users", "ana")["isAvailable"] is True
    assert run(db, "t-admin", "member.set_availability", organizationId="honda", userId="ana", available="si")[1] == 400


def test_no_se_toca_a_usuarios_de_otra_organizacion_ni_a_un_superadmin(db):
    assert run(db, "t-admin", "member.set_role", organizationId="honda", userId="kiauser", role="admin")[1] == 400
    assert doc(db, "users", "kiauser")["role"] == "agent"
    assert run(db, "t-admin", "member.set_role", organizationId="honda", userId="nadie", role="admin")[1] == 400
    db.data["users"]["root"]["organizationIds"] = ["honda"]
    assert run(db, "t-admin", "member.set_role", organizationId="honda", userId="root", role="viewer")[1] == 403
    assert run(db, "t-ana", "member.set_role", organizationId="honda", userId="vera", role="admin")[1] == 403   # agente


def test_equipo_del_agente_en_formato_nuevo_y_legado(db):
    assert run(db, "t-admin", "member.set_team", organizationId="honda", userId="ana", teamId="servicio")[1] == 200
    ana = doc(db, "users", "ana")
    assert ana["orgTeams"]["honda"] == "servicio" and ana["teamId"] == "servicio"
    # beto tiene a kia como principal: en honda solo cambia orgTeams
    assert run(db, "t-admin", "member.set_team", organizationId="honda", userId="beto", teamId="servicio")[1] == 200
    beto = doc(db, "users", "beto")
    assert beto["orgTeams"] == {"honda": "servicio", "kia": "kia-t"} and beto["teamId"] == "kia-t"
    assert run(db, "t-admin", "member.set_team", organizationId="honda", userId="ana", teamId=None)[1] == 200
    assert "honda" not in doc(db, "users", "ana")["orgTeams"] and doc(db, "users", "ana")["teamId"] is None
    assert run(db, "t-admin", "member.set_team", organizationId="honda", userId="ana", teamId="kia-t")[1] == 400


def test_quitar_agente_de_la_organizacion_reasigna_la_principal(db):
    assert run(db, "t-admin", "member.remove", organizationId="honda", userId="beto")[1] == 200
    beto = doc(db, "users", "beto")
    assert beto["organizationIds"] == ["kia"] and beto["organizationId"] == "kia" and "honda" not in beto["orgTeams"]
    assert run(db, "t-admin", "member.remove", organizationId="honda", userId="ana")[1] == 200
    ana = doc(db, "users", "ana")
    assert ana["organizationIds"] == [] and ana["organizationId"] is None and ana["teamId"] is None


def test_organizacion_principal_solo_superadmin(db):
    assert run(db, "t-admin", "member.set_primary_org", organizationId="honda", userId="kiauser")[1] == 403
    assert run(db, "t-root", "member.set_primary_org", organizationId="honda", userId="kiauser")[1] == 200
    u = doc(db, "users", "kiauser")
    assert u["organizationId"] == "honda" and u["organizationIds"] == ["kia", "honda"]
    body, _ = run(db, "t-root", "member.set_primary_org", organizationId="no-hay", userId="kiauser")
    assert body["error"]["code"] == "precondicion_fallida"
