"""`firestore.rules` es solo de lectura (tarea 1.40): toda escritura pasa por la función de reglas de negocio.

Sin emulador (la prueba de las reglas con datos reales sigue diferida, 0.11): se lee el archivo y se verifica su forma, para
que nadie reabra una escritura desde el navegador sin darse cuenta.
"""
import re
from pathlib import Path

RULES = (Path(__file__).resolve().parent.parent / "firestore.rules").read_text(encoding="utf-8")
BODY = re.sub(r"//[^\n]*", "", RULES)    # sin comentarios: el encabezado menciona las palabras prohibidas
ALLOW = re.compile(r"allow\s+([a-z, ]+?)\s*:\s*if\b([^;]*);", re.S)

# Colecciones con reglas y el campo que las liga a una organización (None: la regla usa otra cosa)
COLLECTIONS = ["users", "bots", "teams", "whatsappNumbers", "conversations", "templates", "organizations", "labels", "webChannels",
               "broadcasts"]


def test_solo_se_permite_leer():
    operations = [op.strip() for ops, _ in ALLOW.findall(BODY) for op in ops.split(",")]
    assert operations, "no se encontró ninguna regla allow"
    assert set(operations) <= {"read", "get", "list"}, f"hay escrituras en las reglas: {sorted(set(operations) - {'read', 'get', 'list'})}"


def test_ninguna_regla_menciona_escrituras():
    for word in ("create", "update", "delete", "write"):
        assert not re.search(rf"\b{word}\b", BODY), f"firestore.rules no debe mencionar {word!r}"


def test_cada_coleccion_sigue_con_su_regla_de_lectura():
    for name in COLLECTIONS:
        assert re.search(rf"match /{name}/\{{", BODY), f"falta la regla de {name}"
    for sub in ("messages", "notes", "recipients"):
        assert re.search(rf"match /{sub}/\{{", BODY), f"falta la regla de {sub}"


def test_toda_lectura_exige_sesion_y_pertenencia():
    for ops, condition in ALLOW.findall(BODY):
        assert "isAuthenticated()" in condition or "isSuperAdmin()" in condition or "belongsToOrg(" in condition, condition
        assert any(token in condition for token in ("belongsToOrg(", "canAccessTeam(", "sharesOrgWithUser(", "request.auth.uid == userId")), \
            f"la lectura {ops!r} no limita por organización, equipo o dueño: {condition.strip()}"


def test_el_agente_solo_lee_las_conversaciones_de_su_equipo():
    conversation = re.search(r"match /conversations/\{convId\} \{(.*?)\n    \}\n", BODY, re.S).group(1)
    assert conversation.count("canAccessTeam(") == 3     # conversación, mensajes y notas


def test_el_usuario_ya_no_se_busca_por_correo_ni_se_crea_a_si_mismo():
    assert "request.auth.token.email" not in BODY    # el reclamo de la invitación lo hace la función (me.claim_invite)
    users = re.search(r"match /users/\{userId\} \{(.*?)\n    \}\n", BODY, re.S).group(1)
    assert set(op.strip() for ops, _ in ALLOW.findall(users) for op in ops.split(",")) == {"get", "list"}
