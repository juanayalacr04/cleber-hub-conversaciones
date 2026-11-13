"""Mapeo de Firestore → Hub.importaUsuarios (dev/carga_usuarios_hub.py). No toca Firestore ni PostgreSQL."""
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("carga_usuarios_hub", Path(__file__).resolve().parent.parent / "dev" / "carga_usuarios_hub.py")
carga = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(carga)

CREADO = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)


def test_organizacion_sin_secretos_y_con_zona_horaria():
    org = carga.mapea_organizacion("honda", {
        "name": "Honda", "plan": "enterprise", "sfBrandCode": "HO", "createdAt": CREADO,
        "settings": {"timezone": "America/Tijuana", "businessHours": {"start": "09:00", "end": "18:00"}},
        "salesforceConfig": {"marcaRR": "HO", "clientSecret": "x", "password": "y", "clientId": "z", "accessToken": "t"}})
    assert org == {"idOrganizacion": "honda", "nombre": "Honda", "zonaHoraria": "America/Tijuana",
                   "horario": {"businessHours": {"start": "09:00", "end": "18:00"}}, "salesforceConfig": {"marcaRR": "HO"},
                   "sfCodigoMarca": "HO", "plan": "enterprise", "creadoEn": CREADO.isoformat()}


def test_organizacion_con_plan_desconocido_queda_en_free():
    assert carga.mapea_organizacion("x", {"plan": "gold"})["plan"] == "free"


def test_usuario_completo():
    avisos = []
    u = carga.mapea_usuario("uid1", {
        "email": " Ana@Cleber.com ", "name": "Ana", "role": "agent", "isAvailable": False, "status": "online",
        "organizationIds": ["honda", "kia", "honda"], "orgTeams": {"honda": "honda-ventas"},
        "orgAgencies": {"honda": ["fleteros"]}, "moduleRoles": {"valuacion": "valuador"},
        "invitedBy": "uid0", "lastLoginAt": CREADO, "createdAt": CREADO}, {"honda", "kia"}, avisos)
    assert avisos == []
    assert u["email"] == "ana@cleber.com" and u["idOrigen"] == "uid1" and u["esDisponible"] is False
    assert u["organizaciones"] == [{"idOrganizacion": "honda", "agencias": ["fleteros"], "idEquipo": "honda-ventas"},
                                   {"idOrganizacion": "kia", "agencias": []}]
    assert u["rolesModulo"] == {"valuacion": "VALUADOR"}
    assert u["invitadoPor"] == "uid0" and u["ultimoAccesoEn"] == CREADO.isoformat()


def test_usuario_legado_con_organization_id():
    u = carga.mapea_usuario("uid2", {"email": "b@cleber.com", "role": "admin", "organizationId": "honda"}, {"honda"}, [])
    assert [m["idOrganizacion"] for m in u["organizaciones"]] == ["honda"]
    assert u["estado"] == "offline" and u["esDisponible"] is True and "ultimoAccesoEn" not in u


@pytest.mark.parametrize("data, motivo", [
    ({"role": "agent"}, "sin email"),
    ({"email": "sistema@hub-conversaciones.internal", "role": "agent"}, "email de sistema"),
])
def test_usuarios_que_no_se_cargan(data, motivo):
    avisos = []
    assert carga.mapea_usuario("u", data, set(), avisos) is None
    assert motivo in avisos[0]


def test_avisos_de_rol_organizacion_y_modulo():
    avisos = []
    u = carga.mapea_usuario("u", {"email": "c@cleber.com", "role": "jefe", "organizationIds": ["borrada"],
                                  "moduleRoles": {"marketing": "X", "valuacion": "SISTEMA"}}, {"honda"}, avisos)
    assert u["rol"] == "viewer" and u["organizaciones"] == [] and u["rolesModulo"] == {}
    assert len(avisos) == 4


def test_carga_omite_emails_repetidos():
    avisos = []
    c = carga.construye_carga(
        [("honda", {"name": "Honda"})],
        [("u1", {"email": "a@cleber.com", "role": "agent"}), ("u2", {"email": "A@cleber.com", "role": "admin"})], avisos)
    assert [u["idOrigen"] for u in c["usuarios"]] == ["u1"]
    assert set(c) == {"organizaciones", "usuarios"}
    assert len(avisos) == 1


def test_sql_llama_a_la_accion_como_sistema():
    sql = carga.genera_sql({"organizaciones": [], "usuarios": [{"email": "a@cleber.com", "nombre": "O'Hara"}]})
    assert "hub_cleber.importa_usuarios" in sql and carga.EMAIL_SISTEMA in sql and "O'Hara" in sql
    cuerpo = sql.split("$carga$")[1]
    assert json.loads(cuerpo)["usuarios"][0]["nombre"] == "O'Hara"


def test_sql_rechaza_datos_con_la_marca_de_cita():
    with pytest.raises(SystemExit):
        carga.genera_sql({"organizaciones": [], "usuarios": [{"nombre": "$carga$"}]})
