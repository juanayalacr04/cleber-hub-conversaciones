import importlib

import pytest

from core import conversation_actions, user_actions as ua
from tests.fakes import FakeDB

TOKENS = {"t-admin": "admin1", "t-ana": "ana", "t-beto": "beto", "t-olga": "olga", "t-vera": "vera"}


def verifier(token):
    return {"uid": TOKENS[token]} if token in TOKENS else None


@pytest.fixture(autouse=True)
def acciones():
    ua.clear()
    importlib.reload(conversation_actions)
    yield
    ua.clear()


@pytest.fixture
def db():
    d = FakeDB()
    d.seed("users", "admin1", {"role": "admin", "organizationIds": ["honda"], "name": "Alicia"})
    d.seed("users", "ana", {"role": "agent", "organizationIds": ["honda"], "orgTeams": {"honda": "ventas"}, "name": "Ana"})
    d.seed("users", "beto", {"role": "agent", "organizationIds": ["honda"], "orgTeams": {"honda": "ventas"}, "email": "beto@x.com"})
    d.seed("users", "olga", {"role": "admin", "organizationIds": ["kia"]})
    d.seed("users", "vera", {"role": "viewer", "organizationIds": ["honda"], "orgTeams": {"honda": "ventas"}})
    d.seed("teams", "ventas", {"organizationId": "honda", "vertical": "ventas"})
    d.seed("teams", "servicio", {"organizationId": "honda", "vertical": "servicio"})
    d.seed("teams", "kia-t", {"organizationId": "kia", "vertical": "ventas"})
    d.seed("labels", "l1", {"organizationId": "honda", "teamId": "ventas"})
    d.seed("labels", "l-kia", {"organizationId": "kia", "teamId": "kia-t"})
    d.seed("conversations", "espera", {"organizationId": "honda", "teamId": "ventas", "status": "waiting_agent",
                                       "lastMessageAt": "T0", "vertical": "ventas"})
    d.seed("conversations", "ana", {"organizationId": "honda", "teamId": "ventas", "status": "with_agent",
                                    "assignedAgentId": "ana", "assignedAt": "x", "waitingStartedAt": "y",
                                    "firstAgentResponseAt": "z", "responseTimeSecs": 9, "responseTimes": [1, 2]})
    d.seed("conversations", "cerrada", {"organizationId": "honda", "teamId": "ventas", "status": "closed", "closedAt": "x"})
    return d


def run(db, token, action, **data):
    return ua.handle({"Authorization": f"Bearer {token}"}, {"action": action, "data": data}, db=db, verifier=verifier)


def conv(db, id):
    return db.data["conversations"][id]


# --------------------------------------------------------------------------- tomar y asignar

def test_admin_toma_una_conversacion_que_espera(db):
    body, status = run(db, "t-admin", "conversation.take", conversationId="espera")
    assert status == 200 and body["result"]["assignedAgentId"] == "admin1"
    c = conv(db, "espera")
    assert c["status"] == "with_agent" and c["assignedAgentId"] == "admin1" and c["waitingStartedAt"] == "T0"


def test_agente_no_puede_tomar(db):
    assert run(db, "t-ana", "conversation.take", conversationId="espera")[1] == 403
    assert conv(db, "espera")["status"] == "waiting_agent"


def test_tomar_exige_que_espere_agente(db):
    body, status = run(db, "t-admin", "conversation.take", conversationId="ana")
    assert status == 200 and body["error"]["code"] == "precondicion_fallida"
    assert conv(db, "ana")["assignedAgentId"] == "ana"


def test_asignar_a_un_agente_de_la_organizacion(db):
    body, status = run(db, "t-admin", "conversation.assign", conversationId="espera", agentId="beto")
    assert status == 200 and conv(db, "espera")["assignedAgentId"] == "beto" and conv(db, "espera")["status"] == "with_agent"


@pytest.mark.parametrize("agent", ["olga", "vera", "nadie"])   # otra marca, solo lectura, inexistente
def test_asignar_rechaza_agentes_invalidos(db, agent):
    body, status = run(db, "t-admin", "conversation.assign", conversationId="espera", agentId=agent)
    assert status == 400 and body["error"]["code"] == "datos_invalidos"
    assert conv(db, "espera")["status"] == "waiting_agent"


def test_asignar_exige_agentid(db):
    assert run(db, "t-admin", "conversation.assign", conversationId="espera")[1] == 400


# --------------------------------------------------------------------------- transferir equipo

def test_transferir_equipo_reinicia_asignacion_y_sigue_la_vertical(db):
    body, status = run(db, "t-admin", "conversation.transfer_team", conversationId="ana", teamId="servicio")
    assert status == 200
    c = conv(db, "ana")
    assert (c["teamId"], c["status"], c["assignedAgentId"], c["vertical"]) == ("servicio", "waiting_agent", None, "servicio")


def test_transferir_a_equipo_de_otra_organizacion_se_rechaza(db):
    assert run(db, "t-admin", "conversation.transfer_team", conversationId="ana", teamId="kia-t")[1] == 400
    assert conv(db, "ana")["teamId"] == "ventas"


def test_agente_no_transfiere(db):
    assert run(db, "t-ana", "conversation.transfer_team", conversationId="ana", teamId="servicio")[1] == 403


# --------------------------------------------------------------------------- devolver, cerrar, reabrir

def test_devolver_a_bot_limpia_la_asignacion_y_conserva_el_historial_de_tiempos(db):
    assert run(db, "t-ana", "conversation.return_to_bot", conversationId="ana")[1] == 200
    c = conv(db, "ana")
    assert c["status"] == "bot" and c["assignedAgentId"] is None and c["responseTimeSecs"] is None
    assert c["responseTimes"] == [1, 2]


def test_otro_agente_no_devuelve_la_conversacion_ajena(db):
    assert run(db, "t-beto", "conversation.return_to_bot", conversationId="ana")[1] == 403
    assert conv(db, "ana")["status"] == "with_agent"


def test_cerrar_guarda_motivo_y_marca_manual(db):
    body, status = run(db, "t-ana", "conversation.close", conversationId="ana", reason="  Resuelto  ")
    assert status == 200
    c = conv(db, "ana")
    assert c["status"] == "closed" and c["closedReason"] == "Resuelto" and c["manualClose"] is True
    assert c["assignedAgentId"] is None and c["closedAt"] is not None


def test_cerrar_exige_motivo_y_no_cierra_una_cerrada(db):
    assert run(db, "t-ana", "conversation.close", conversationId="ana")[1] == 400
    assert run(db, "t-ana", "conversation.close", conversationId="ana", reason="  ")[1] == 400
    body, _ = run(db, "t-admin", "conversation.close", conversationId="cerrada", reason="x")
    assert body["error"]["code"] == "precondicion_fallida"
    assert conv(db, "ana")["status"] == "with_agent"


def test_reabrir_solo_una_cerrada(db):
    assert run(db, "t-ana", "conversation.reopen", conversationId="cerrada")[1] == 200
    c = conv(db, "cerrada")
    assert c["status"] == "bot" and c["closedAt"] is None
    body, _ = run(db, "t-ana", "conversation.reopen", conversationId="ana")
    assert body["error"]["code"] == "precondicion_fallida"


def test_viewer_no_modifica_nada(db):
    for action, data in [("conversation.close", {"reason": "x"}), ("conversation.reopen", {}), ("conversation.add_note", {"text": "x"})]:
        assert run(db, "t-vera", action, conversationId="cerrada", **data)[1] == 403


# --------------------------------------------------------------------------- etiquetas

def test_etiqueta_se_pone_y_se_quita(db):
    assert run(db, "t-ana", "conversation.toggle_label", conversationId="espera", labelId="l1")[0]["result"]["applied"] is True
    assert conv(db, "espera")["labelIds"] == ["l1"]
    assert run(db, "t-ana", "conversation.toggle_label", conversationId="espera", labelId="l1")[0]["result"]["applied"] is False
    assert conv(db, "espera")["labelIds"] == []


def test_etiqueta_de_otra_organizacion_no_se_pone(db):
    assert run(db, "t-ana", "conversation.toggle_label", conversationId="espera", labelId="l-kia")[1] == 400
    assert run(db, "t-ana", "conversation.toggle_label", conversationId="espera", labelId="no-hay")[1] == 400
    assert "labelIds" not in conv(db, "espera")


# --------------------------------------------------------------------------- cita con agente

def test_marcar_cita_fija_outcome_terminal_e_historial(db):
    assert run(db, "t-ana", "conversation.mark_appointment", conversationId="ana", marked=True)[1] == 200
    c = conv(db, "ana")
    assert c["appointmentStatus"] == "cita_agente" and c["conversationOutcome"] == "cita_agente_bdc"
    assert [h["outcome"] for h in c["conversationOutcomeHistory"]] == ["cita_agente_bdc"]


def test_desmarcar_cita_vuelve_a_la_clasificacion_del_bot(db):
    db.data["conversations"]["ana"]["aiOutcome"] = "interes_cita"
    run(db, "t-ana", "conversation.mark_appointment", conversationId="ana", marked=True)
    run(db, "t-ana", "conversation.mark_appointment", conversationId="ana", marked=False)
    c = conv(db, "ana")
    assert c["appointmentStatus"] == "sin_cita" and "appointmentDate" not in c
    assert c["conversationOutcome"] == "interes_cita"
    assert [h["outcome"] for h in c["conversationOutcomeHistory"]] == ["cita_agente_bdc", "interes_cita"]


def test_desmarcar_sin_clasificacion_previa_deja_el_outcome_vacio(db):
    run(db, "t-ana", "conversation.mark_appointment", conversationId="ana", marked=True)
    run(db, "t-ana", "conversation.mark_appointment", conversationId="ana", marked=False)
    c = conv(db, "ana")
    assert c["conversationOutcome"] is None
    assert len(c["conversationOutcomeHistory"]) == 1


def test_marcar_cita_exige_booleano_y_conversacion_con_agente(db):
    assert run(db, "t-ana", "conversation.mark_appointment", conversationId="ana", marked="si")[1] == 400
    body, _ = run(db, "t-admin", "conversation.mark_appointment", conversationId="espera", marked=True)
    assert body["error"]["code"] == "precondicion_fallida"


# --------------------------------------------------------------------------- nombre y notas

def test_renombrar_cliente_y_borrar_el_nombre(db):
    run(db, "t-ana", "conversation.rename_customer", conversationId="espera", name="  Laura  ")
    assert conv(db, "espera")["customerName"] == "Laura"
    run(db, "t-ana", "conversation.rename_customer", conversationId="espera", name="")
    assert conv(db, "espera")["customerName"] is None
    assert run(db, "t-ana", "conversation.rename_customer", conversationId="espera", name=5)[1] == 400


def test_nota_toma_el_autor_del_token_no_del_cuerpo(db):
    body, status = run(db, "t-beto", "conversation.add_note", conversationId="espera", text=" hola ", authorId="ana", authorName="Ana")
    assert status == 200
    notes = db.data["conversations/espera/notes"]
    assert list(notes.values()) == [{"authorId": "beto", "authorName": "beto@x.com", "text": "hola", "createdAt": notes[body["result"]["noteId"]]["createdAt"]}]


def test_nota_vacia_se_rechaza(db):
    assert run(db, "t-ana", "conversation.add_note", conversationId="espera", text="  ")[1] == 400


def test_otra_organizacion_no_puede_nada(db):
    for action, data in [("conversation.close", {"reason": "x"}), ("conversation.add_note", {"text": "x"}), ("conversation.take", {})]:
        assert run(db, "t-olga", action, conversationId="espera", **data)[1] == 404
