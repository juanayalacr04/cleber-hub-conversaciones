import importlib

import pytest

from channels import webhooks
from core import admin_actions, campaigns, credentials, numbers, user_actions as ua
from tests.fakes import FakeDB

TOKENS = {"t-admin": "admin1", "t-ana": "ana"}


def verifier(token):
    return {"uid": TOKENS[token]} if token in TOKENS else None


@pytest.fixture(autouse=True)
def acciones():
    ua.clear()
    importlib.reload(admin_actions)
    numbers.clear_bot_cache()
    yield
    ua.clear()


@pytest.fixture
def db():
    d = FakeDB()
    d.seed("users", "admin1", {"role": "admin", "organizationIds": ["honda"]})
    d.seed("users", "ana", {"role": "agent", "organizationIds": ["honda"], "orgTeams": {"honda": "ventas"}})
    d.seed("organizations", "honda", {"name": "Honda"})
    d.seed("teams", "ventas", {"organizationId": "honda", "vertical": "ventas"})
    return d


def run(db, action, token="t-admin", **data):
    return ua.handle({"Authorization": f"Bearer {token}"}, {"action": action, "data": data}, db=db, verifier=verifier)


def secrets_of(db, kind, doc_id):
    return db.data.get("secrets", {}).get(f"{kind}__{doc_id}")


# --------------------------------------------------------------------------- piezas

def test_split_separa_las_credenciales_de_numeros_y_de_bots():
    number = {"phoneNumber": "+52", "twilioAccountSid": "AC1", "twilioAuthToken": " tok ", "metaAccessToken": "", "metaWebhookVerifyToken": "v"}
    public, found = credentials.split("numbers", number)
    assert public == {"phoneNumber": "+52", "twilioAccountSid": "AC1"} and found == {"twilioAuthToken": "tok", "metaWebhookVerifyToken": "v"}
    assert number["twilioAuthToken"] == " tok "          # no muta lo que recibe

    bot = {"name": "B", "twilioConfig": {"accountSid": "AC1", "authToken": "t"}, "abacusConfig": {"deploymentId": "D", "deploymentToken": "dt", "apiKey": "ak"},
           "externalConfig": {"endpoint": "https://x", "apiKey": "ek"}}
    public, found = credentials.split("bots", bot)
    assert public["abacusConfig"] == {"deploymentId": "D"} and public["twilioConfig"] == {"accountSid": "AC1"}
    assert public["externalConfig"] == {"endpoint": "https://x"}
    assert found == {"twilioConfig.authToken": "t", "abacusConfig.deploymentToken": "dt", "abacusConfig.apiKey": "ak", "externalConfig.apiKey": "ek"}


@pytest.mark.parametrize("value", ["", "   ", None, 5, "********", " ** "])
def test_una_credencial_vacia_o_invalida_no_cambia_nada(value):
    assert credentials.split("numbers", {"twilioAuthToken": value})[1] == {}
    assert credentials.split("bots", {"abacusConfig": {"deploymentToken": value}})[1] == {}


def test_guardar_leer_y_revelar_sin_pisar_las_hermanas(db):
    credentials.store(db, "bots", "b1", {"abacusConfig.deploymentToken": "dt"})
    credentials.store(db, "bots", "b1", {"abacusConfig.apiKey": "ak", "twilioConfig.authToken": "t"})
    assert credentials.load(db, "bots", "b1") == {"abacusConfig.deploymentToken": "dt", "abacusConfig.apiKey": "ak", "twilioConfig.authToken": "t"}
    revealed = credentials.reveal(db, "bots", "b1", {"name": "B", "abacusConfig": {"deploymentId": "D"}})
    assert revealed["abacusConfig"] == {"deploymentId": "D", "deploymentToken": "dt", "apiKey": "ak"} and revealed["twilioConfig"] == {"authToken": "t"}
    assert credentials.reveal(db, "bots", "sin-credenciales", {"name": "x"}) == {"name": "x"}
    assert credentials.reveal(db, "bots", None, {"name": "x"}) == {"name": "x"}


def test_la_credencial_guardada_gana_sobre_la_que_quedo_en_el_documento(db):
    credentials.store(db, "numbers", "n1", {"twilioAuthToken": "nuevo"})
    legacy = {"twilioAuthToken": "viejo", "metaAccessToken": "solo-en-el-doc"}
    revealed = credentials.reveal(db, "numbers", "n1", legacy)
    assert revealed["twilioAuthToken"] == "nuevo" and revealed["metaAccessToken"] == "solo-en-el-doc"
    assert legacy["twilioAuthToken"] == "viejo"


def test_cache_de_un_minuto_y_se_invalida_al_escribir(db, monkeypatch):
    credentials.store(db, "numbers", "n1", {"twilioAuthToken": "a"})
    assert credentials.load(db, "numbers", "n1") == {"twilioAuthToken": "a"}
    db.data["secrets"]["numbers__n1"]["twilioAuthToken"] = "cambio-por-fuera"
    assert credentials.load(db, "numbers", "n1") == {"twilioAuthToken": "a"}          # cacheado
    assert credentials.load(db, "numbers", "n1", use_cache=False) == {"twilioAuthToken": "cambio-por-fuera"}
    credentials.store(db, "numbers", "n1", {"metaAccessToken": "m"})                  # escribir invalida la caché
    assert credentials.load(db, "numbers", "n1")["twilioAuthToken"] == "cambio-por-fuera"
    clock = [1000.0]
    monkeypatch.setattr(credentials.time, "time", lambda: clock[0])
    credentials.clear_cache()
    credentials.load(db, "numbers", "n1")
    db.data["secrets"]["numbers__n1"]["twilioAuthToken"] = "otra"
    clock[0] += credentials.TTL - 1
    assert credentials.load(db, "numbers", "n1")["twilioAuthToken"] == "cambio-por-fuera"
    clock[0] += 2
    assert credentials.load(db, "numbers", "n1")["twilioAuthToken"] == "otra"


def test_borrar_credenciales(db):
    credentials.store(db, "numbers", "n1", {"twilioAuthToken": "a", "metaAccessToken": "m"})
    credentials.clear(db, "numbers", "n1", ["twilioAuthToken", "noexiste"])
    assert credentials.load(db, "numbers", "n1") == {"metaAccessToken": "m"}
    credentials.clear(db, "numbers", "sin-doc", ["twilioAuthToken"])      # no falla si no hay documento
    credentials.delete(db, "numbers", "n1")
    assert credentials.load(db, "numbers", "n1") == {}


def test_mark_configured_deja_en_el_documento_solo_la_lista(db):
    db.seed("whatsappNumbers", "n1", {"phoneNumber": "+52"})
    credentials.store(db, "numbers", "n1", {"metaAccessToken": "valor-meta-xyz", "twilioAuthToken": "valor-twilio-xyz"})
    assert credentials.mark_configured(db, "numbers", "n1") == ["metaAccessToken", "twilioAuthToken"]
    assert db.data["whatsappNumbers"]["n1"]["secretsSet"] == ["metaAccessToken", "twilioAuthToken"]
    assert "xyz" not in str(db.data["whatsappNumbers"]["n1"])


def test_buscar_el_numero_por_su_token_de_verificacion(db):
    credentials.store(db, "numbers", "n-meta", {"metaWebhookVerifyToken": "verif"})
    credentials.store(db, "bots", "b1", {"externalConfig.apiKey": "verif"})
    assert credentials.find_number_by_verify_token(db, "verif") == "n-meta"
    assert credentials.find_number_by_verify_token(db, "otro") is None and credentials.find_number_by_verify_token(db, "") is None


# --------------------------------------------------------------------------- migración

def test_la_migracion_mueve_las_credenciales_y_es_idempotente(db):
    db.seed("whatsappNumbers", "n1", {"phoneNumber": "+52", "twilioAccountSid": "AC1", "twilioAuthToken": "tok", "metaWebhookVerifyToken": "v"})
    db.seed("whatsappNumbers", "n-sin", {"phoneNumber": "+53"})
    db.seed("bots", "b1", {"name": "B", "twilioConfig": {"accountSid": "AC1", "authToken": "bt"}, "abacusConfig": {"deploymentId": "D", "deploymentToken": "dt"}})
    assert credentials.migrate(db) == {"numbers": 1, "bots": 1}
    n, b = db.data["whatsappNumbers"]["n1"], db.data["bots"]["b1"]
    assert "twilioAuthToken" not in n and "metaWebhookVerifyToken" not in n and n["twilioAccountSid"] == "AC1"
    assert n["secretsSet"] == ["metaWebhookVerifyToken", "twilioAuthToken"]
    assert b["twilioConfig"] == {"accountSid": "AC1"} and b["abacusConfig"] == {"deploymentId": "D"} and b["secretsSet"] == ["abacusConfig.deploymentToken", "twilioConfig.authToken"]
    assert secrets_of(db, "numbers", "n1") == {"twilioAuthToken": "tok", "metaWebhookVerifyToken": "v"}
    assert secrets_of(db, "bots", "b1") == {"twilioConfig": {"authToken": "bt"}, "abacusConfig": {"deploymentToken": "dt"}}
    assert "secretsSet" not in db.data["whatsappNumbers"]["n-sin"]
    assert credentials.migrate(db) == {"numbers": 0, "bots": 0}


def test_en_la_migracion_gana_lo_que_ya_estaba_guardado(db):
    credentials.store(db, "numbers", "n1", {"twilioAuthToken": "vigente"})
    db.seed("whatsappNumbers", "n1", {"twilioAuthToken": "viejo", "metaAccessToken": "m"})
    credentials.migrate(db)
    assert credentials.load(db, "numbers", "n1", use_cache=False) == {"twilioAuthToken": "vigente", "metaAccessToken": "m"}
    assert "twilioAuthToken" not in db.data["whatsappNumbers"]["n1"]


# --------------------------------------------------------------------------- acciones de administración

NUMBER = {"phoneNumber": "+528100000000", "provider": "twilio", "twilioAccountSid": "AC1", "twilioAuthToken": "tok-secreto"}


def create_number(db, **extra):
    return run(db, "number.create", organizationId="honda", fields={**NUMBER, **extra})


def test_crear_un_numero_guarda_el_token_aparte_y_no_lo_devuelve(db):
    body, status = create_number(db)
    nid = body["result"]["id"]
    assert status == 200 and body["result"] == {"id": nid} and "tok-secreto" not in str(body)
    doc = db.data["whatsappNumbers"][nid]
    assert "twilioAuthToken" not in doc and doc["twilioAccountSid"] == "AC1" and doc["secretsSet"] == ["twilioAuthToken"]
    assert "tok-secreto" not in str(doc) and secrets_of(db, "numbers", nid) == {"twilioAuthToken": "tok-secreto"}


def test_el_bot_de_un_numero_recibe_el_token_al_enviar(db):
    db.seed("bots", "bot1", {"organizationId": "honda", "name": "Bot"})
    nid = create_number(db, defaultBotId="bot1")[0]["result"]["id"]
    bot, from_number = numbers.get_bot_for_conversation("bot1", nid, db)
    assert bot["twilioConfig"] == {"phoneNumber": "whatsapp:+528100000000", "accountSid": "AC1", "authToken": "tok-secreto"} and from_number == "whatsapp:+528100000000"


def test_editar_un_numero_sin_token_conserva_el_token_y_con_token_lo_reemplaza(db):
    nid = create_number(db)[0]["result"]["id"]
    assert run(db, "number.update", id=nid, set={"displayName": "Sucursal", "twilioAuthToken": ""})[1] == 200     # la pantalla manda vacío si no lo tocó
    assert secrets_of(db, "numbers", nid) == {"twilioAuthToken": "tok-secreto"}
    assert run(db, "number.update", id=nid, set={"twilioAuthToken": "nuevo", "metaAccessToken": "meta-tk"})[1] == 200
    assert secrets_of(db, "numbers", nid) == {"twilioAuthToken": "nuevo", "metaAccessToken": "meta-tk"}
    doc = db.data["whatsappNumbers"][nid]
    assert doc["secretsSet"] == ["metaAccessToken", "twilioAuthToken"] and doc["displayName"] == "Sucursal" and "nuevo" not in str(doc)


def test_solo_credenciales_vacias_no_es_un_cambio_pero_tampoco_falla(db):
    nid = create_number(db)[0]["result"]["id"]
    before = dict(db.data["whatsappNumbers"][nid])
    assert run(db, "number.update", id=nid, set={"twilioAuthToken": ""})[1] == 200
    assert db.data["whatsappNumbers"][nid] == before


def test_se_puede_borrar_una_credencial_con_unset(db):
    nid = create_number(db, metaAccessToken="m")[0]["result"]["id"]
    assert run(db, "number.update", id=nid, unset=["metaAccessToken"])[1] == 200
    assert secrets_of(db, "numbers", nid) == {"twilioAuthToken": "tok-secreto"} and db.data["whatsappNumbers"][nid]["secretsSet"] == ["twilioAuthToken"]


def test_un_campo_de_credencial_no_se_puede_escribir_por_otro_camino(db):
    nid = create_number(db)[0]["result"]["id"]
    assert run(db, "number.update", id=nid, set={"secretsSet": []})[1] == 400          # la lista la pone el servidor
    assert run(db, "number.update", id=nid, set={"secrets": {}})[1] == 400


def test_borrar_un_numero_borra_sus_credenciales(db):
    nid = create_number(db)[0]["result"]["id"]
    assert run(db, "number.delete", id=nid)[1] == 200
    assert secrets_of(db, "numbers", nid) is None and credentials.load(db, "numbers", nid, use_cache=False) == {}


BOT = {"name": "Bot", "type": "workflow", "vertical": "servicio", "twilioConfig": {"phoneNumber": "", "accountSid": "AC1", "authToken": "bot-tok"},
       "abacusConfig": {"deploymentId": "D1", "deploymentToken": "dep-tok", "apiKey": "abacus-key"}}


def test_crear_un_bot_deja_los_tokens_fuera_del_documento(db):
    body, _ = run(db, "bot.create", organizationId="honda", fields=BOT)
    bid = body["result"]["id"]
    doc = db.data["bots"][bid]
    assert doc["abacusConfig"] == {"deploymentId": "D1"} and doc["twilioConfig"] == {"phoneNumber": "", "accountSid": "AC1"}
    assert doc["secretsSet"] == ["abacusConfig.apiKey", "abacusConfig.deploymentToken", "twilioConfig.authToken"]
    assert not any(token in str(doc) for token in ("bot-tok", "dep-tok", "abacus-key"))
    bot = numbers.get_bot_by_id(bid, db)
    assert bot["abacusConfig"] == {"deploymentId": "D1", "deploymentToken": "dep-tok", "apiKey": "abacus-key"}
    assert bot["twilioConfig"]["authToken"] == "bot-tok"


def test_guardar_el_bot_sin_reescribir_los_tokens_los_conserva(db):
    bid = run(db, "bot.create", organizationId="honda", fields=BOT)[0]["result"]["id"]
    # la pantalla manda el mapa completo, con los tokens en blanco si no se tocaron
    assert run(db, "bot.update", id=bid, set={"abacusConfig": {"deploymentId": "D2", "deploymentToken": "", "apiKey": ""},
                                              "twilioConfig": {"phoneNumber": "+52", "accountSid": "AC1", "authToken": ""}})[1] == 200
    bot = numbers.get_bot_by_id(bid, db)
    assert bot["abacusConfig"] == {"deploymentId": "D2", "deploymentToken": "dep-tok", "apiKey": "abacus-key"} and bot["twilioConfig"]["authToken"] == "bot-tok"
    assert run(db, "bot.update", id=bid, set={"abacusConfig": {"deploymentId": "D2", "deploymentToken": "rotado"}})[1] == 200
    assert numbers.get_bot_by_id(bid, db)["abacusConfig"]["deploymentToken"] == "rotado"
    assert db.data["bots"][bid]["secretsSet"] == ["abacusConfig.apiKey", "abacusConfig.deploymentToken", "twilioConfig.authToken"]


def test_el_bot_externo_y_su_clave(db):
    fields = {"name": "Ext", "type": "external", "vertical": "ventas", "externalConfig": {"endpoint": "https://bot.example", "apiKey": "ext-key"}}
    bid = run(db, "bot.create", organizationId="honda", fields=fields)[0]["result"]["id"]
    assert db.data["bots"][bid]["externalConfig"] == {"endpoint": "https://bot.example"}
    assert numbers.get_bot_by_id(bid, db)["externalConfig"] == {"endpoint": "https://bot.example", "apiKey": "ext-key"}


def test_las_credenciales_viejas_en_el_documento_siguen_funcionando_hasta_migrar(db):
    db.seed("bots", "viejo", {"name": "B", "abacusConfig": {"deploymentId": "D", "deploymentToken": "en-el-doc"}})
    assert numbers.get_bot_by_id("viejo", db)["abacusConfig"]["deploymentToken"] == "en-el-doc"


def test_los_numeros_de_meta_y_de_campana_reciben_su_token(db):
    db.seed("bots", "bot1", {"organizationId": "honda"})
    nid = run(db, "number.create", organizationId="honda", fields={"phoneNumber": "+528111111111", "provider": "meta", "metaPhoneNumberId": "123",
                                                                   "metaAccessToken": "meta-tk", "defaultBotId": "bot1"})[0]["result"]["id"]
    bot = numbers.get_bot_by_meta_phone_number_id("123", db)
    assert bot["metaAccessToken"] == "meta-tk" and bot["metaPhoneNumberId"] == "123"
    db.seed("broadcasts", "b1", {"organizationId": "honda", "whatsappNumberId": nid, "botId": "bot1", "templateName": "t"})
    assert campaigns.Campaign(db, "b1", db.data["broadcasts"]["b1"]).number["metaAccessToken"] == "meta-tk"


# --------------------------------------------------------------------------- verificación del webhook de Meta

def test_la_verificacion_de_meta_usa_el_token_guardado_aparte(db):
    nid = run(db, "number.create", organizationId="honda", fields={"phoneNumber": "+528122222222", "provider": "meta", "metaPhoneNumberId": "9",
                                                                   "metaWebhookVerifyToken": "mi-token"})[0]["result"]["id"]
    args = {"hub.mode": "subscribe", "hub.verify_token": "mi-token", "hub.challenge": "ok123"}
    assert webhooks.handle_meta_verification(args, db) == ("ok123", 200)
    assert webhooks.handle_meta_verification({**args, "hub.verify_token": "otro"}, db) == ("Forbidden", 403)
    assert webhooks.handle_meta_verification({**args, "hub.mode": "otro"}, db) == ("Bad Request", 400)
    db.data["whatsappNumbers"][nid]["status"] = "inactive"
    assert webhooks.handle_meta_verification(args, db) == ("Forbidden", 403)
    db.data["whatsappNumbers"][nid].update({"status": "active", "provider": "twilio"})
    assert webhooks.handle_meta_verification(args, db) == ("Forbidden", 403)


def test_la_verificacion_de_meta_acepta_el_token_que_aun_esta_en_el_documento(db):
    db.seed("whatsappNumbers", "n-viejo", {"provider": "meta", "status": "active", "metaWebhookVerifyToken": "legado"})
    args = {"hub.mode": "subscribe", "hub.verify_token": "legado", "hub.challenge": "c"}
    assert webhooks.handle_meta_verification(args, db) == ("c", 200)
