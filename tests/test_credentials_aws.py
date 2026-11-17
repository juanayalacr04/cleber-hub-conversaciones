"""Credenciales en AWS Secrets Manager (core/credentials.py, almacén `aws`) y verificación de Meta con el token del ambiente."""
import json

import pytest

from channels import webhooks
from core import credentials
from core.credentials import AlmacenSecretsManager


class NoExiste(Exception):
    response = {"Error": {"Code": "ResourceNotFoundException"}}


class SecretsManagerFalso:
    """Lo mínimo de boto3.client('secretsmanager') que usa el almacén."""

    def __init__(self):
        self.secretos: dict[str, str] = {}
        self.llamadas: list[str] = []

    def get_secret_value(self, SecretId):
        self.llamadas.append("get")
        if SecretId not in self.secretos:
            raise NoExiste()
        return {"SecretString": self.secretos[SecretId]}

    def create_secret(self, Name, SecretString, Description=""):
        self.llamadas.append("create")
        assert Name not in self.secretos
        self.secretos[Name] = SecretString

    def put_secret_value(self, SecretId, SecretString):
        self.llamadas.append("put")
        assert SecretId in self.secretos
        self.secretos[SecretId] = SecretString

    def delete_secret(self, SecretId, ForceDeleteWithoutRecovery):
        self.llamadas.append("delete")
        assert ForceDeleteWithoutRecovery
        if SecretId not in self.secretos:
            raise NoExiste()
        del self.secretos[SecretId]


@pytest.fixture
def sm():
    cliente = SecretsManagerFalso()
    credentials.configure(AlmacenSecretsManager("hub/dev/", cliente))
    yield cliente
    credentials.configure(None)


def guardado(sm, nombre):
    return json.loads(sm.secretos[nombre])


def test_store_crea_el_secreto_y_luego_lo_actualiza_sin_pisar_las_demas(sm):
    credentials.store(None, "bots", "b1", {"abacusConfig.deploymentToken": "dt"})
    assert guardado(sm, "hub/dev/bots/b1") == {"abacusConfig.deploymentToken": "dt"}
    credentials.store(None, "bots", "b1", {"abacusConfig.apiKey": "ak"})
    assert guardado(sm, "hub/dev/bots/b1") == {"abacusConfig.deploymentToken": "dt", "abacusConfig.apiKey": "ak"}
    assert sm.llamadas.count("create") == 1 and sm.llamadas.count("put") == 1


def test_reveal_pone_las_credenciales_donde_las_espera_el_codigo(sm):
    credentials.store(None, "bots", "b1", {"abacusConfig.deploymentToken": "dt"})
    bot = {"name": "B", "abacusConfig": {"deploymentId": "D"}}
    assert credentials.reveal(None, "bots", "b1", bot) == {"name": "B", "abacusConfig": {"deploymentId": "D", "deploymentToken": "dt"}}
    assert bot == {"name": "B", "abacusConfig": {"deploymentId": "D"}}      # no muta lo que recibe


def test_load_ignora_llaves_que_no_son_credenciales_y_un_secreto_inexistente(sm):
    sm.secretos["hub/dev/numbers/n1"] = json.dumps({"twilioAuthToken": "t", "otra": "x", "metaAccessToken": ""})
    assert credentials.load(None, "numbers", "n1") == {"twilioAuthToken": "t"}
    assert credentials.load(None, "numbers", "no-existe") == {}


def test_load_usa_la_cache_y_store_la_invalida(sm):
    credentials.store(None, "numbers", "n1", {"twilioAuthToken": "v1"})
    credentials.load(None, "numbers", "n1")
    lecturas = sm.llamadas.count("get")
    credentials.load(None, "numbers", "n1")
    assert sm.llamadas.count("get") == lecturas                     # de caché
    credentials.store(None, "numbers", "n1", {"twilioAuthToken": "v2"})
    assert credentials.load(None, "numbers", "n1") == {"twilioAuthToken": "v2"}


def test_clear_quita_solo_las_indicadas(sm):
    credentials.store(None, "numbers", "n1", {"twilioAuthToken": "t", "metaAccessToken": "m"})
    credentials.clear(None, "numbers", "n1", ["metaAccessToken", "noEsCredencial"])
    assert guardado(sm, "hub/dev/numbers/n1") == {"twilioAuthToken": "t"}


def test_delete_borra_el_secreto_y_no_falla_si_no_existe(sm):
    credentials.store(None, "numbers", "n1", {"twilioAuthToken": "t"})
    credentials.delete(None, "numbers", "n1")
    assert "hub/dev/numbers/n1" not in sm.secretos
    credentials.delete(None, "numbers", "n1")
    assert credentials.load(None, "numbers", "n1") == {}


def test_no_busca_numero_por_token(sm):
    assert credentials.find_number_by_verify_token(None, "cualquiera") is None


def test_almacen_segun_el_entorno(monkeypatch):
    credentials.configure(None)
    monkeypatch.setenv("SECRETOS_EN", "aws")
    monkeypatch.setenv("SECRETOS_PREFIJO", "hub/prod")
    a = credentials.almacen()
    assert isinstance(a, AlmacenSecretsManager) and a.nombre("bots", "x") == "hub/prod/bots/x"
    credentials.configure(None)
    monkeypatch.delenv("SECRETOS_PREFIJO")
    with pytest.raises(RuntimeError):
        credentials.almacen()
    credentials.configure(None)
    monkeypatch.delenv("SECRETOS_EN")
    assert isinstance(credentials.almacen(), credentials.AlmacenFirestore)
    credentials.configure(None)


# --------------------------------------------------------------------------- Meta

def test_meta_verifica_con_el_token_del_ambiente(monkeypatch):
    monkeypatch.setenv("META_WEBHOOK_VERIFY_TOKEN", "token-del-ambiente")
    args = {"hub.mode": "subscribe", "hub.verify_token": "token-del-ambiente", "hub.challenge": "123"}
    # Sin base de datos: con el token del ambiente no hace falta buscar el número
    assert webhooks.handle_meta_verification(args, db=object()) == ("123", 200)


def test_meta_con_otro_token_sigue_buscando_por_numero(monkeypatch, sm):
    from tests.fakes import FakeDB
    monkeypatch.setenv("META_WEBHOOK_VERIFY_TOKEN", "token-del-ambiente")
    args = {"hub.mode": "subscribe", "hub.verify_token": "otro", "hub.challenge": "123"}
    assert webhooks.handle_meta_verification(args, db=FakeDB()) == ("Forbidden", 403)
