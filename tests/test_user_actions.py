import json

import pytest

import main
from core import authz, user_actions as ua
from tests.fakes import FakeDB

TOKENS = {"tok-admin": "admin1", "tok-ana": "ana", "tok-beto": "beto", "tok-viewer": "vera",
          "tok-otra": "olga", "tok-super": "root", "tok-fantasma": "nadie"}


def verifier(token):
    return {"uid": TOKENS[token]} if token in TOKENS else None


def auth(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def db():
    d = FakeDB()
    d.seed("users", "admin1", {"role": "admin", "organizationIds": ["honda"]})
    d.seed("users", "ana", {"role": "agent", "organizationIds": ["honda"], "orgTeams": {"honda": "ventas"}})
    d.seed("users", "beto", {"role": "agent", "organizationId": "honda", "teamId": "ventas"})  # formato legado
    d.seed("users", "vera", {"role": "viewer", "organizationIds": ["honda"], "orgTeams": {"honda": "ventas"}})
    d.seed("users", "olga", {"role": "admin", "organizationIds": ["kia"]})
    d.seed("users", "root", {"role": "viewer", "isSuperAdmin": True})
    d.seed("conversations", "c-libre", {"organizationId": "honda", "teamId": "ventas", "status": "waiting_agent"})
    d.seed("conversations", "c-ana", {"organizationId": "honda", "teamId": "ventas", "status": "with_agent", "assignedAgentId": "ana"})
    d.seed("conversations", "c-servicio", {"organizationId": "honda", "teamId": "servicio", "status": "waiting_agent"})
    d.seed("conversations", "c-sin-equipo", {"organizationId": "honda", "teamId": None, "status": "bot"})
    return d


@pytest.fixture(autouse=True)
def acciones():
    ua.clear()
    calls = []

    @ua.declare("conversation.note", scope="conversation")
    def note(ctx, data):
        calls.append(("note", ctx.conv_id, ctx.org_id))
        return {"ok": True}

    @ua.declare("conversation.reassign", scope="conversation", level="admin")
    def reassign(ctx, data):
        calls.append(("reassign", ctx.conv_id))

    @ua.declare("org.rename", scope="org", level="admin")
    def rename(ctx, data):
        calls.append(("rename", ctx.org_id))

    @ua.declare("org.label", scope="org")
    def label(ctx, data):
        calls.append(("label", ctx.org_id))

    @ua.declare("org.falla", scope="org")
    def falla(ctx, data):
        raise RuntimeError("detalle interno")

    @ua.declare("org.rechaza", scope="org")
    def rechaza(ctx, data):
        raise ua.UserActionError("precondicion_fallida", "No se puede", retryable=False)

    yield calls
    ua.clear()


def run(db, token, action, data):
    return ua.handle(auth(token), {"action": action, "data": data}, db=db, verifier=verifier)


# --------------------------------------------------------------------------- autenticación

def test_sin_token_o_token_invalido_es_401(db, acciones):
    for headers in ({}, {"Authorization": "Bearer malo"}, {"Authorization": "tok-ana"}, {"Authorization": "Bearer "}):
        body, status = ua.handle(headers, {"action": "org.label", "data": {"organizationId": "honda"}}, db=db, verifier=verifier)
        assert status == 401
    assert acciones == []


def test_token_valido_de_usuario_no_registrado_es_403(db, acciones):
    body, status = run(db, "tok-fantasma", "org.label", {"organizationId": "honda"})
    assert status == 403 and body["error"]["code"] == "no_autorizado"
    assert acciones == []


def test_sin_proyecto_configurado_el_verificador_falla_cerrado(monkeypatch):
    monkeypatch.delenv("FIREBASE_PROJECT_ID", raising=False)
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)
    assert ua._firebase_verifier("cualquiera") is None


# --------------------------------------------------------------------------- cuerpo

@pytest.mark.parametrize("body", [None, [], {}, {"action": ""}, {"action": "x", "data": []}, {"action": 3, "data": {}}])
def test_cuerpo_invalido_es_400(db, body):
    _, status = ua.handle(auth("tok-ana"), body, db=db, verifier=verifier)
    assert status == 400


def test_accion_desconocida_es_404(db):
    body, status = run(db, "tok-ana", "no.existe", {})
    assert status == 404 and body["error"]["code"] == "accion_desconocida"


def test_scope_sin_su_identificador_es_400(db):
    assert run(db, "tok-ana", "org.label", {})[1] == 400
    assert run(db, "tok-ana", "conversation.note", {})[1] == 400


# --------------------------------------------------------------------------- organización

def test_miembro_escribe_en_su_organizacion(db, acciones):
    body, status = run(db, "tok-ana", "org.label", {"organizationId": "honda"})
    assert status == 200 and body["ok"] and body["status"] == "done"
    assert acciones == [("label", "honda")]


def test_otra_organizacion_es_403(db, acciones):
    body, status = run(db, "tok-otra", "org.label", {"organizationId": "honda"})
    assert status == 403 and body["error"]["code"] == "no_autorizado"
    assert acciones == []


def test_viewer_no_escribe(db, acciones):
    assert run(db, "tok-viewer", "org.label", {"organizationId": "honda"})[1] == 403
    assert acciones == []


def test_accion_de_admin_exige_admin_de_esa_organizacion(db, acciones):
    assert run(db, "tok-ana", "org.rename", {"organizationId": "honda"})[1] == 403
    assert run(db, "tok-otra", "org.rename", {"organizationId": "honda"})[1] == 403   # admin, pero de otra marca
    assert run(db, "tok-admin", "org.rename", {"organizationId": "honda"})[1] == 200
    assert acciones == [("rename", "honda")]


def test_superadmin_actua_en_cualquier_organizacion_aunque_su_rol_sea_viewer(db, acciones):
    assert run(db, "tok-super", "org.rename", {"organizationId": "kia"})[1] == 200


# --------------------------------------------------------------------------- conversación: equipo

def test_agente_actua_en_conversacion_de_su_equipo_y_el_contexto_sale_del_documento(db, acciones):
    # `organizationId` en `data` no cuenta: la organización sale de la conversación
    body, status = run(db, "tok-ana", "conversation.note", {"conversationId": "c-libre", "organizationId": "kia"})
    assert status == 200
    assert acciones == [("note", "c-libre", "honda")]


def test_agente_con_equipo_en_formato_legado(db, acciones):
    assert run(db, "tok-beto", "conversation.note", {"conversationId": "c-libre"})[1] == 200


def test_agente_no_ve_conversacion_de_otro_equipo_y_no_sabe_si_existe(db, acciones):
    otro_equipo, st1 = run(db, "tok-ana", "conversation.note", {"conversationId": "c-servicio"})
    inexistente, st2 = run(db, "tok-ana", "conversation.note", {"conversationId": "no-hay"})
    assert st1 == st2 == 404
    assert otro_equipo == inexistente
    assert acciones == []


def test_conversacion_sin_equipo_solo_para_admins(db, acciones):
    assert run(db, "tok-ana", "conversation.note", {"conversationId": "c-sin-equipo"})[1] == 404
    assert run(db, "tok-admin", "conversation.note", {"conversationId": "c-sin-equipo"})[1] == 200


def test_otra_organizacion_no_ve_la_conversacion(db):
    assert run(db, "tok-otra", "conversation.note", {"conversationId": "c-libre"})[1] == 404


def test_admin_ve_conversaciones_de_todos_los_equipos(db):
    assert run(db, "tok-admin", "conversation.note", {"conversationId": "c-servicio"})[1] == 200


def test_viewer_ve_la_conversacion_pero_no_actua(db, acciones):
    assert run(db, "tok-viewer", "conversation.note", {"conversationId": "c-libre"})[1] == 403
    assert acciones == []


# --------------------------------------------------------------------------- conversación: agente asignado

def test_conversacion_tomada_solo_la_toca_su_agente_o_un_admin(db, acciones):
    assert run(db, "tok-ana", "conversation.note", {"conversationId": "c-ana"})[1] == 200       # la asignada
    assert run(db, "tok-beto", "conversation.note", {"conversationId": "c-ana"})[1] == 403      # mismo equipo, otro agente
    assert run(db, "tok-admin", "conversation.note", {"conversationId": "c-ana"})[1] == 200
    assert [c[1] for c in acciones] == ["c-ana", "c-ana"]


def test_reasignar_es_solo_de_admin(db, acciones):
    assert run(db, "tok-ana", "conversation.reassign", {"conversationId": "c-ana"})[1] == 403   # ni siquiera su agente
    assert run(db, "tok-admin", "conversation.reassign", {"conversationId": "c-ana"})[1] == 200
    assert acciones == [("reassign", "c-ana")]


# --------------------------------------------------------------------------- errores del handler

def test_rechazo_de_negocio_llega_tipado(db):
    body, status = run(db, "tok-ana", "org.rechaza", {"organizationId": "honda"})
    assert status == 200 and not body["ok"]
    assert body["error"] == {"code": "precondicion_fallida", "message": "No se puede", "retryable": False}


def test_error_inesperado_no_filtra_el_detalle(db):
    body, status = run(db, "tok-ana", "org.falla", {"organizationId": "honda"})
    assert status == 500 and body["error"]["code"] == "error_interno" and body["error"]["retryable"]
    assert "detalle interno" not in json.dumps(body)


def test_handler_duplicado_o_declaracion_invalida_fallan():
    with pytest.raises(ValueError):
        ua.declare("org.label", scope="org")(lambda c, d: None)
    with pytest.raises(ValueError):
        ua.declare("otra", scope="equipo")(lambda c, d: None)
    with pytest.raises(ValueError):
        ua.declare("otra", scope="org", level="read")(lambda c, d: None)


# --------------------------------------------------------------------------- permisos puros

def test_load_requester_acepta_formato_nuevo_y_legado(db):
    assert authz.load_requester(db, "ana").org_ids == ["honda"]
    assert authz.load_requester(db, "beto").org_ids == ["honda"]
    assert authz.team_in(authz.load_requester(db, "beto"), "honda") == "ventas"
    assert authz.load_requester(db, "nadie") is None


def test_orgteams_manda_sobre_teamid_legado():
    r = authz.Requester("u", "agent", org_ids=["honda"], org_teams={"honda": "servicio"}, team_id="ventas")
    assert authz.team_in(r, "honda") == "servicio"
    assert authz.can_access_conversation(r, {"organizationId": "honda", "teamId": "servicio"})
    assert not authz.can_access_conversation(r, {"organizationId": "honda", "teamId": "ventas"})


# --------------------------------------------------------------------------- CORS y entry point

def test_cors_solo_para_origenes_permitidos():
    env = {"ALLOWED_ORIGINS": "https://hub.example.com, http://localhost:3000"}
    assert ua.cors_headers("https://hub.example.com", env)["Access-Control-Allow-Origin"] == "https://hub.example.com"
    assert ua.cors_headers("https://malo.example.com", env) == {}
    assert ua.cors_headers(None, env) == {}
    assert ua.cors_headers("https://hub.example.com", {}) == {}


def test_entry_point_preflight_metodo_y_sin_token(monkeypatch):
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://hub.example.com")

    class Req:
        def __init__(self, method, headers=None, body=None):
            self.method, self.headers, self._body = method, headers or {}, body

        def get_json(self, silent=False):
            return self._body

    body, status, headers = main.user_actions_execute(Req("OPTIONS", {"Origin": "https://hub.example.com"}))
    assert status == 204 and headers["Access-Control-Allow-Origin"] == "https://hub.example.com"
    assert main.user_actions_execute(Req("GET"))[1] == 405
    body, status, headers = main.user_actions_execute(Req("POST", {"Origin": "https://malo.example.com"}, {"action": "x", "data": {}}))
    assert status == 401 and "Access-Control-Allow-Origin" not in headers
