import pytest

from core import numbers as nb
from crm import salesforce
from tests.fakes import FakeDB

ENV = {
    "SF_INSTANCE_URL": "https://global.sf", "SF_CLIENT_ID": "gid", "SF_CLIENT_SECRET": "gsecret",
    "SF_USERNAME": "global@x.com", "SF_PASSWORD": "gpass",
}
ORG = {"marcaRR": "Honda", "bdcFallbackOwnerId": "005X", "RecordTypeId": "012Y"}


@pytest.fixture(autouse=True)
def _env_limpio(monkeypatch):
    for var in list(ENV) + ["SF_VENTAS_USERNAME", "SF_VENTAS_PASSWORD", "SF_SERVICIO_USERNAME"]:
        monkeypatch.delenv(var, raising=False)
    nb.clear_bot_cache()


def _set(monkeypatch, **extra):
    for k, v in {**ENV, **extra}.items():
        monkeypatch.setenv(k, v)


def test_las_credenciales_vienen_del_entorno_y_la_config_de_marca_se_conserva(monkeypatch):
    _set(monkeypatch)
    cfg = salesforce.resolve_config(ORG, "ventas")
    assert cfg["instanceUrl"] == "https://global.sf" and cfg["password"] == "gpass"
    assert (cfg["marcaRR"], cfg["bdcFallbackOwnerId"], cfg["RecordTypeId"]) == ("Honda", "005X", "012Y")


def test_el_entorno_gana_sobre_credenciales_viejas_en_firestore(monkeypatch):
    _set(monkeypatch)
    cfg = salesforce.resolve_config(dict(ORG, username="viejo@x.com", password="vieja", clientSecret="vieja"), "ventas")
    assert (cfg["username"], cfg["password"], cfg["clientSecret"]) == ("global@x.com", "gpass", "gsecret")


def test_un_modulo_puede_tener_su_propio_usuario(monkeypatch):
    _set(monkeypatch, SF_VENTAS_USERNAME="ventas@x.com", SF_VENTAS_PASSWORD="vpass")
    ventas, servicio, general = (salesforce.resolve_config(ORG, v) for v in ("ventas", "servicio", None))
    assert (ventas["username"], ventas["password"], ventas["instanceUrl"]) == ("ventas@x.com", "vpass", "https://global.sf")
    assert servicio["username"] == "global@x.com" and general["username"] == "global@x.com"


def test_sin_entorno_se_usan_las_credenciales_de_firestore_durante_la_migracion(monkeypatch, caplog):
    legacy = dict(ORG, instanceUrl="https://org.sf", clientId="c", clientSecret="s", username="u", password="p")
    with caplog.at_level("WARNING"):
        cfg = salesforce.resolve_config(legacy, "ventas")
    assert cfg == legacy and "variables de entorno" in caplog.text


def test_sin_ninguna_credencial_no_hay_conexion(monkeypatch):
    cfg = salesforce.resolve_config(ORG, "ventas")
    assert not salesforce.has_credentials(cfg) and cfg["marcaRR"] == "Honda"
    assert salesforce.resolve_config(None) == {}


def test_el_bot_de_valuetext_recibe_la_config_resuelta_por_modulo(monkeypatch):
    _set(monkeypatch, SF_VENTAS_USERNAME="ventas@x.com")
    db = FakeDB()
    db.seed("organizations", "honda", {"salesforceConfig": ORG})
    db.seed("teams", "tv", {"vertical": "ventas"})
    db.seed("whatsappNumbers", "n1", {"organizationId": "honda", "teamId": "tv", "status": "active", "phoneNumber": "whatsapp:+52V",
                                      "defaultBotId": "b1", "provider": "valuetext", "valuetextSenderId": "S"})
    db.seed("bots", "b1", {"organizationId": "honda", "name": "Ventas"})
    cfg = nb.get_bot_by_phone("whatsapp:+52V", db=db)["salesforceConfig"]
    assert cfg["username"] == "ventas@x.com" and cfg["instanceUrl"] == "https://global.sf" and cfg["marcaRR"] == "Honda"
