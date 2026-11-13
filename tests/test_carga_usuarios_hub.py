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
        "organizationIds": ["honda", "kia", "honda"], "orgTeams": {"honda": "honda-servicio"},
        "orgAgencies": {"honda": ["fleteros"]}, "invitedBy": "uid0", "lastLoginAt": CREADO, "createdAt": CREADO},
        {"honda", "kia"}, avisos, {"honda-servicio": "servicio"})
    assert avisos == []
    assert u["email"] == "ana@cleber.com" and u["idOrigen"] == "uid1" and u["esDisponible"] is False
    # El rol de Firestore vale para ventas y servicio en cada marca; el equipo va al módulo de su vertical
    assert u["organizaciones"] == [
        {"idOrganizacion": "honda", "agencias": ["fleteros"],
         "modulos": {"ventas": {"rol": "AGENTE"}, "servicio": {"rol": "AGENTE", "idEquipo": "honda-servicio"}}},
        {"idOrganizacion": "kia", "agencias": [], "modulos": {"ventas": {"rol": "AGENTE"}, "servicio": {"rol": "AGENTE"}}}]
    assert "rol" not in u and "rolesModulo" not in u
    assert u["invitadoPor"] == "uid0" and u["ultimoAccesoEn"] == CREADO.isoformat()


@pytest.mark.parametrize("role, esperado", [("admin", "ADMINISTRADOR"), ("agent", "AGENTE"), ("viewer", "CONSULTA")])
def test_rol_de_firestore_al_catalogo(role, esperado):
    u = carga.mapea_usuario("u", {"email": "a@cleber.com", "role": role, "organizationIds": ["honda"]}, {"honda"}, [])
    assert {m: v["rol"] for m, v in u["organizaciones"][0]["modulos"].items()} == {"ventas": esperado, "servicio": esperado}


def test_equipo_de_otra_vertical_o_desconocido_se_omite():
    avisos = []
    u = carga.mapea_usuario("u", {"email": "a@cleber.com", "role": "agent", "organizationIds": ["honda", "kia"],
                                  "orgTeams": {"honda": "honda-valuacion", "kia": "borrado"}},
                            {"honda", "kia"}, avisos, {"honda-valuacion": "valuacion"})
    assert all("idEquipo" not in v for m in u["organizaciones"] for v in m["modulos"].values())
    assert len(avisos) == 2


def test_usuario_legado_con_organization_id():
    u = carga.mapea_usuario("uid2", {"email": "b@cleber.com", "role": "admin", "organizationId": "honda"}, {"honda"}, [])
    assert [m["idOrganizacion"] for m in u["organizaciones"]] == ["honda"]
    assert u["estado"] == "offline" and u["esDisponible"] is True and "ultimoAccesoEn" not in u
    assert u["organizaciones"][0]["modulos"]["ventas"] == {"rol": "ADMINISTRADOR"}


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
    assert u["organizaciones"] == []
    assert len(avisos) == 3   # rol inválido (queda CONSULTA), organización inexistente y moduleRoles sin copiar


def test_carga_omite_emails_repetidos():
    avisos = []
    c = carga.construye_carga(
        [("honda", {"name": "Honda"})],
        [("u1", {"email": "a@cleber.com", "role": "agent"}), ("u2", {"email": "A@cleber.com", "role": "admin"})], avisos,
        [("t1", {"vertical": "ventas"})])
    assert [u["idOrigen"] for u in c["usuarios"]] == ["u1"]
    assert set(c) == {"modulos", "organizaciones", "usuarios"}
    assert c["modulos"] == ["ventas", "servicio"]   # la carga no reemplaza los roles de valuación
    assert len(avisos) == 1


def test_sql_llama_a_la_accion_como_sistema():
    sql = carga.genera_sql({"organizaciones": [], "usuarios": [{"email": "a@cleber.com", "nombre": "O'Hara"}]})
    assert "hub_cleber.importa_usuarios" in sql and carga.EMAIL_SISTEMA in sql and "O'Hara" in sql
    cuerpo = sql.split("$carga$")[1]
    assert json.loads(cuerpo)["usuarios"][0]["nombre"] == "O'Hara"


def test_sql_rechaza_datos_con_la_marca_de_cita():
    with pytest.raises(SystemExit):
        carga.genera_sql({"organizaciones": [], "usuarios": [{"nombre": "$carga$"}]})
