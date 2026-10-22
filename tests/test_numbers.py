import pytest

from core import numbers as nb
from core.utils import normalize_mx_phone, phone_variants
from tests.fakes import FakeDB


@pytest.fixture(autouse=True)
def _cache():
    nb.clear_bot_cache()


@pytest.fixture
def db():
    d = FakeDB()
    d.seed("organizations", "honda", {"name": "Honda", "sfBrandCode": "HO"})
    d.seed("organizations", "nissan", {"name": "Nissan", "sfBrandCode": "NI"})
    d.seed("teams", "honda-ventas", {"organizationId": "honda", "vertical": "ventas"})
    d.seed("teams", "honda-servicio", {"organizationId": "honda", "vertical": "servicio"})
    d.seed("whatsappNumbers", "n-serv", {"organizationId": "honda", "teamId": "honda-servicio", "status": "active", "phoneNumber": "whatsapp:+5255000001", "defaultBotId": "bot-serv", "provider": "twilio", "twilioAccountSid": "AC1", "twilioAuthToken": "tok"})
    d.seed("whatsappNumbers", "n-vent", {"organizationId": "honda", "teamId": "honda-ventas", "status": "active", "phoneNumber": "whatsapp:+5255000002", "defaultBotId": "bot-vent", "provider": "meta", "metaPhoneNumberId": "123", "metaAccessToken": "t"})
    d.seed("whatsappNumbers", "n-off", {"organizationId": "honda", "teamId": "honda-ventas", "status": "paused"})
    d.seed("bots", "bot-serv", {"organizationId": "honda", "name": "Serv", "type": "workflow"})
    d.seed("bots", "bot-vent", {"organizationId": "honda", "name": "Vent", "type": "chatllm"})
    d.seed("bots", "bot-otro", {"organizationId": "honda", "name": "Otro", "type": "chatllm"})
    return d


def test_marca_con_vertical_elige_el_numero_de_esa_vertical(db):
    assert nb.get_whatsapp_number_by_brand("HO", "ventas", db=db)["id"] == "n-vent"
    assert nb.get_whatsapp_number_by_brand("HO", "servicio", db=db)["id"] == "n-serv"


def test_marca_sin_vertical_es_determinista(db):
    assert nb.get_whatsapp_number_by_brand("HO", db=db)["id"] == "n-serv"  # id menor, no orden de Firestore


def test_marca_desconocida_o_sin_numero(db):
    assert nb.get_whatsapp_number_by_brand("XX", db=db) is None
    assert nb.get_whatsapp_number_by_brand("NI", db=db) is None
    assert nb.get_whatsapp_number_by_brand("", db=db) is None
    assert nb.get_whatsapp_number_by_brand("HO", "valuacion", db=db) is None


def test_codigo_de_marca_duplicado_falla_ruidoso(db):
    db.seed("organizations", "honda2", {"name": "Honda 2", "sfBrandCode": "HO"})
    with pytest.raises(nb.AmbiguousBrandCode):
        nb.get_whatsapp_number_by_brand("HO", "ventas", db=db)


def test_bot_por_telefono_mezcla_la_config_de_canal(db):
    bot = nb.get_bot_by_phone("whatsapp:+5255000001", db=db)
    assert bot["id"] == "bot-serv" and bot["provider"] == "twilio" and bot["teamId"] == "honda-servicio"
    assert bot["twilioConfig"]["accountSid"] == "AC1"
    meta = nb.get_bot_by_phone("whatsapp:+5255000002", db=db)
    assert meta["provider"] == "meta" and meta["metaPhoneNumberId"] == "123"
    assert nb.get_bot_by_phone("whatsapp:+0", db=db) is None


def test_override_de_bot_conserva_la_config_de_canal(db):
    channel_bot = nb.get_bot_by_phone("whatsapp:+5255000002", db=db)
    out = nb.apply_active_bot_override(channel_bot, {"activeBotId": "bot-otro"}, db=db)
    assert out["id"] == "bot-otro" and out["provider"] == "meta" and out["metaPhoneNumberId"] == "123"
    assert out["channelBotId"] == "bot-vent"
    assert nb.apply_active_bot_override(channel_bot, {}, db=db) is channel_bot
    assert nb.apply_active_bot_override(channel_bot, {"activeBotId": "no-existe"}, db=db) is channel_bot


def test_telefonos_mx():
    assert normalize_mx_phone("whatsapp:+5218186019229") == "whatsapp:+528186019229"
    assert normalize_mx_phone("+5218186019229") == "+528186019229"
    assert normalize_mx_phone("whatsapp:+14155551234") == "whatsapp:+14155551234"
    assert phone_variants("whatsapp:+528186019229") == ["whatsapp:+528186019229", "whatsapp:+5218186019229"]
    assert phone_variants("whatsapp:+5218186019229") == ["whatsapp:+5218186019229", "whatsapp:+528186019229"]
