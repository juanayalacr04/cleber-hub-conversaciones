"""Genera el SQL que carga organizaciones y usuarios de Firestore al schema `hub_cleber` de PostgreSQL (Fase 3, adelanto).

    python dev/carga_usuarios_hub.py --salida C:/ruta/fuera/del/repo/carga_hub.sql

El script NO se conecta a PostgreSQL: solo lee Firestore y escribe un archivo .sql que llama a `Hub.importaUsuarios`
como el usuario de sistema del hub. El archivo se revisa y se corre a mano con psql:

    psql -h <host> -p <puerto> -U <usuario> -d <database> -f carga_hub.sql

La carga es idempotente (se puede correr de nuevo) y es todo o nada: si un elemento falla, no se escribe nada y el
error dice qué lista e índice lo causó.

Solo lee el proyecto y la base de desarrollo del hub (igual que dev/seed.py):

    GOOGLE_CLOUD_PROJECT=ambiente-desarrollo-ti    FIRESTORE_DATABASE=dev-hub-conversaciones

Roles (decisión Q36): en Firestore el rol (`role`) es uno por usuario y vale para ventas y servicio. Aquí se convierte
en un rol de ventas y otro de servicio en cada marca del usuario (admin → ADMINISTRADOR, agent → AGENTE,
viewer → CONSULTA). El equipo de la marca (`orgTeams`) va al módulo de su vertical (`teams/{id}.vertical`).
La carga maneja solo ventas y servicio (`modulos`): los roles de valuación que se asignen en el editor no se tocan.
`moduleRoles` de Firestore no se copia (se avisa si existe): los roles de valuación se asignan en el editor.

El catálogo de agencias no vive en el hub (viene de un API externo). Del usuario solo se copian los ids que tenga en
`orgAgencies`, por valor; hoy ese campo no existe en Firestore, así que los usuarios quedan sin agencias.

El .sql contiene emails de usuarios: guárdalo fuera del repo y bórralo al terminar.
"""
import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

PROJECT = "ambiente-desarrollo-ti"
DATABASE = "dev-hub-conversaciones"
EMAIL_SISTEMA = "sistema@hub-conversaciones.internal"
# Rol de Firestore → rol del catálogo hub_cleber.roles_modulo, igual en ventas y en servicio
ROL_MODULO = {"admin": "ADMINISTRADOR", "agent": "AGENTE", "viewer": "CONSULTA"}
ESTADOS = {"online", "away", "offline"}
PLANES = {"free", "pro", "enterprise"}
MODULOS_CARGA = ["ventas", "servicio"]   # los únicos módulos cuyos roles reemplaza esta carga
# Las credenciales de Salesforce son globales (variables de entorno / Secret Manager); nunca pasan a PostgreSQL.
LLAVES_SECRETAS = {"clientid", "clientsecret", "username", "password", "securitytoken"}


def check_target(env) -> None:
    """Falla si el entorno no apunta al proyecto y la base de desarrollo del hub."""
    problems = []
    if env.get("GOOGLE_CLOUD_PROJECT") != PROJECT:
        problems.append(f"GOOGLE_CLOUD_PROJECT debe ser {PROJECT!r} (es {env.get('GOOGLE_CLOUD_PROJECT')!r})")
    if env.get("FIRESTORE_DATABASE") != DATABASE:
        problems.append(f"FIRESTORE_DATABASE debe ser {DATABASE!r} (es {env.get('FIRESTORE_DATABASE')!r})")
    if problems:
        raise SystemExit("No se genera nada:\n  - " + "\n  - ".join(problems))


def _fecha(valor):
    """Timestamp de Firestore (datetime) a ISO 8601; cualquier otra cosa → None."""
    return valor.isoformat() if isinstance(valor, datetime) else None


def _texto(valor):
    return valor.strip() or None if isinstance(valor, str) else None


def es_secreta(llave: str) -> bool:
    llave = llave.lower()
    return llave in LLAVES_SECRETAS or "secret" in llave or "password" in llave or "token" in llave


def mapea_organizacion(doc_id: str, data: dict) -> dict:
    settings = dict(data.get("settings") or {})
    zona = _texto(settings.pop("timezone", None))
    salesforce = {k: v for k, v in (data.get("salesforceConfig") or {}).items() if not es_secreta(k)}
    org = {"idOrganizacion": doc_id, "nombre": _texto(data.get("name")) or doc_id, "horario": settings,
           "salesforceConfig": salesforce, "sfCodigoMarca": _texto(data.get("sfBrandCode")),
           "sfCalendario": _texto(data.get("sfCalendario")), "plan": data.get("plan") if data.get("plan") in PLANES else "free",
           "creadoEn": _fecha(data.get("createdAt"))}
    if zona:
        org["zonaHoraria"] = zona
    return {k: v for k, v in org.items() if v is not None}


def mapea_usuario(doc_id: str, data: dict, orgs: set[str], avisos: list[str], verticales: dict | None = None):
    """Usuario de Firestore al formato de Hub.importaUsuarios, o None si no se puede cargar (con el motivo en `avisos`).

    `verticales`: {id de equipo: vertical} de la colección `teams`, para saber a qué módulo va el equipo de cada marca.
    """
    verticales = verticales or {}
    email = (_texto(data.get("email")) or "").lower()
    if "@" not in email:
        avisos.append(f"users/{doc_id}: sin email válido, no se carga")
        return None
    if email.endswith(".internal"):
        avisos.append(f"users/{doc_id}: email de sistema ({email}), no se carga")
        return None
    rol = ROL_MODULO.get(data.get("role"))
    if rol is None:
        avisos.append(f"users/{doc_id} ({email}): rol {data.get('role')!r} no válido, se carga como CONSULTA")
        rol = "CONSULTA"

    org_ids = list(data.get("organizationIds") or ([data["organizationId"]] if data.get("organizationId") else []))
    equipos = data.get("orgTeams") or {}
    agencias = data.get("orgAgencies") or {}
    membresias = []
    for org in dict.fromkeys(org_ids):
        if org not in orgs:
            avisos.append(f"users/{doc_id} ({email}): la organización {org!r} no existe, se omite esa membresía")
            continue
        modulos = {modulo: {"rol": rol} for modulo in MODULOS_CARGA}
        equipo = equipos.get(org)
        if equipo:
            vertical = verticales.get(equipo)
            if vertical in modulos:
                modulos[vertical]["idEquipo"] = equipo
            else:
                avisos.append(f"users/{doc_id} ({email}): el equipo {equipo!r} de {org!r} no es de ventas ni de servicio "
                              f"(vertical {vertical!r}), se omite")
        membresias.append({"idOrganizacion": org, "agencias": list(agencias.get(org) or []), "modulos": modulos})

    if data.get("moduleRoles"):
        avisos.append(f"users/{doc_id} ({email}): moduleRoles no se copia; asigna esos roles en el editor de usuarios")

    usuario = {"idOrigen": doc_id, "email": email, "nombre": _texto(data.get("name")) or "", "fotoUrl": _texto(data.get("photoURL")),
               "esSuperAdmin": bool(data.get("isSuperAdmin")), "esDisponible": data.get("isAvailable", True) is not False,
               "estado": data.get("status") if data.get("status") in ESTADOS else "offline", "invitadoPor": _texto(data.get("invitedBy")),
               "ultimoAccesoEn": _fecha(data.get("lastLoginAt")), "creadoEn": _fecha(data.get("createdAt")),
               "organizaciones": membresias}
    return {k: v for k, v in usuario.items() if v is not None}


def construye_carga(organizaciones, usuarios, avisos: list[str], equipos=()) -> dict:
    """`organizaciones`, `usuarios` y `equipos` son pares (id, datos) de Firestore."""
    orgs = [mapea_organizacion(i, d) for i, d in organizaciones]
    ids = {o["idOrganizacion"] for o in orgs}
    verticales = {i: d.get("vertical") for i, d in equipos}
    vistos, lista = set(), []
    for i, d in usuarios:
        u = mapea_usuario(i, d, ids, avisos, verticales)
        if u is None:
            continue
        if u["email"] in vistos:
            avisos.append(f"users/{i}: email {u['email']} repetido en Firestore, se omite este documento")
            continue
        vistos.add(u["email"])
        lista.append(u)
    return {"modulos": MODULOS_CARGA, "organizaciones": orgs, "usuarios": lista}


def genera_sql(carga: dict) -> str:
    cuerpo = json.dumps(carga, ensure_ascii=False, indent=1)
    if "$carga$" in cuerpo or "$importa$" in cuerpo:
        raise SystemExit("Los datos contienen una marca de cita ($carga$ o $importa$); no se puede generar el SQL.")
    headers = json.dumps({"x-user-email": EMAIL_SISTEMA})
    return f"""-- Generado por dev/carga_usuarios_hub.py el {datetime.now().isoformat(timespec='seconds')}
-- {len(carga['organizaciones'])} organizaciones, {len(carga['usuarios'])} usuarios.
-- Contiene emails: no lo subas al repo y bórralo al terminar.
\\encoding UTF8
\\set ON_ERROR_STOP on

DO $importa$
DECLARE
  r jsonb;
BEGIN
  PERFORM set_config('request.headers', '{headers}', true);
  r := hub_cleber.importa_usuarios(jsonb_build_object('action', 'Hub.importaUsuarios', 'params', $carga${cuerpo}$carga$::jsonb));
  IF NOT coalesce((r->>'successful')::boolean, false) THEN
    RAISE EXCEPTION 'La carga falló, no se escribió nada: %', r;
  END IF;
  RAISE NOTICE 'Carga completa: %', r->'info';
END;
$importa$;
"""


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--salida", required=True, help="archivo .sql a generar (de preferencia fuera del repo)")
    args = parser.parse_args(argv)

    check_target(os.environ)
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from core.db import get_db   # después de verificar el entorno: lee FIRESTORE_DATABASE al importarse

    db = get_db()
    organizaciones = [(s.id, s.to_dict() or {}) for s in db.collection("organizations").stream()]
    usuarios = [(s.id, s.to_dict() or {}) for s in db.collection("users").stream()]
    equipos = [(s.id, s.to_dict() or {}) for s in db.collection("teams").stream()]
    avisos: list[str] = []
    carga = construye_carga(organizaciones, usuarios, avisos, equipos)

    Path(args.salida).write_text(genera_sql(carga), encoding="utf-8")
    print(f"Escrito {args.salida}: {len(carga['organizaciones'])} organizaciones, "
          f"{len(carga['usuarios'])} usuarios (de {len(usuarios)} en Firestore).")
    for aviso in avisos:
        print(f"  aviso: {aviso}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
