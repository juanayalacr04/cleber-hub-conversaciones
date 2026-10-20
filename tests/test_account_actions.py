import importlib

import pytest

from core import account_actions, user_actions as ua
from tests.fakes import FakeDB

CLAIMS = {
    "t-nuevo": {"uid": "u-nuevo", "email": "nuevo@x.com", "email_verified": True, "name": "Nuevo Usuario", "picture": "http://foto"},
    "t-sin-verificar": {"uid": "u-sv", "email": "nuevo@x.com", "email_verified": False},
    "t-sin-email": {"uid": "u-se", "email_verified": True},
    "t-intruso": {"uid": "u-intruso", "email": "intruso@x.com", "email_verified": True},
    "t-ana": {"uid": "ana", "email": "ana@x.com", "email_verified": True},
    "t-mayus": {"uid": "u-m", "email": "mayus@x.com", "email_verified": True},
}


def verifier(token):
    return CLAIMS.get(token)


@pytest.fixture(autouse=True)
def acciones():
    ua.clear()
    importlib.reload(account_actions)
    yield
    ua.clear()


@pytest.fixture
def db():
    d = FakeDB()
    d.seed("users", "pre1", {"id": "pre1", "email": "nuevo@x.com", "name": "", "role": "agent", "organizationId": "honda",
                             "organizationIds": ["honda"], "teamId": "ventas", "orgTeams": {"honda": "ventas"},
                             "status": "offline", "photoURL": None, "invitedBy": "admin1"})
    d.seed("users", "pre2", {"email": "mayus@x.com", "role": "viewer", "organizationId": "kia", "teamId": "kia-t"})  # formato viejo
    d.seed("users", "ana", {"id": "ana", "email": "ana@x.com", "role": "agent", "organizationIds": ["honda"], "status": "offline"})
    return d


def run(db, token, action):
    return ua.handle({"Authorization": f"Bearer {token}"}, {"action": action, "data": {}}, db=db, verifier=verifier)


def test_reclamar_invitacion_crea_el_usuario_con_el_uid_y_borra_el_preregistrado(db):
    body, status = run(db, "t-nuevo", "me.claim_invite")
    assert status == 200 and body["result"] == {"claimed": True}
    user = db.data["users"]["u-nuevo"]
    assert (user["id"], user["role"], user["organizationIds"], user["orgTeams"]) == ("u-nuevo", "agent", ["honda"], {"honda": "ventas"})
    assert user["name"] == "Nuevo Usuario" and user["photoURL"] == "http://foto" and user["status"] == "online"
    assert user["lastLoginAt"] is not None and user["invitedBy"] == "admin1"
    assert "pre1" not in db.data["users"]


def test_el_rol_sale_de_la_invitacion_no_del_cliente(db):
    ua.handle({"Authorization": "Bearer t-nuevo"}, {"action": "me.claim_invite", "data": {"role": "admin", "isSuperAdmin": True,
              "organizationIds": ["kia"]}}, db=db, verifier=verifier)
    user = db.data["users"]["u-nuevo"]
    assert user["role"] == "agent" and not user.get("isSuperAdmin") and user["organizationIds"] == ["honda"]


def test_sin_invitacion_se_rechaza_y_no_se_crea_nada(db):
    body, status = run(db, "t-intruso", "me.claim_invite")
    assert status == 403 and body["error"]["code"] == "no_autorizado"
    assert "u-intruso" not in db.data["users"]


@pytest.mark.parametrize("token", ["t-sin-verificar", "t-sin-email"])
def test_correo_sin_verificar_no_reclama(db, token):
    assert run(db, token, "me.claim_invite")[1] == 403
    assert "pre1" in db.data["users"]


def test_documento_en_formato_viejo_nace_con_campos_multiorganizacion(db):
    db.data["users"]["pre2"]["email"] = "mayus@x.com"
    assert run(db, "t-mayus", "me.claim_invite")[1] == 200
    user = db.data["users"]["u-m"]
    assert user["organizationIds"] == ["kia"] and user["orgTeams"] == {"kia": "kia-t"}


def test_reclamar_dos_veces_es_inofensivo(db):
    run(db, "t-nuevo", "me.claim_invite")
    body, status = run(db, "t-nuevo", "me.claim_invite")
    assert status == 200 and body["result"] == {"claimed": False}


def test_un_usuario_ya_registrado_no_puede_reclamar_otra_invitacion(db):
    db.seed("users", "pre-ana", {"email": "ana@x.com", "role": "admin", "organizationIds": ["kia"]})
    assert run(db, "t-ana", "me.claim_invite")[0]["result"] == {"claimed": False}
    assert db.data["users"]["ana"]["role"] == "agent" and "pre-ana" in db.data["users"]


def test_sign_in_y_sign_out(db):
    assert run(db, "t-ana", "me.sign_in")[1] == 200
    ana = db.data["users"]["ana"]
    assert ana["status"] == "online" and ana["lastLoginAt"] is not None
    assert run(db, "t-ana", "me.sign_out")[1] == 200
    assert db.data["users"]["ana"]["status"] == "offline"


def test_sign_in_exige_usuario_registrado(db):
    for action in ("me.sign_in", "me.sign_out"):
        assert run(db, "t-intruso", action)[1] == 403
    assert "u-intruso" not in db.data["users"]


def test_sin_token_es_401(db):
    assert ua.handle({}, {"action": "me.sign_in", "data": {}}, db=db, verifier=verifier)[1] == 401


def test_declaracion_identity_exige_level_none():
    with pytest.raises(ValueError):
        ua.declare("x", scope="identity")(lambda c, d: None)           # level por defecto "write"
    with pytest.raises(ValueError):
        ua.declare("y", scope="org", level=None)(lambda c, d: None)
