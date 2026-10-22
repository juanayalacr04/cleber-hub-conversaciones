import hashlib
import hmac
import json

import pytest
from werkzeug.datastructures import MultiDict

import main
from channels import event_queue, signatures, webhook_auth
from core import credentials, numbers
from tests.fakes import FakeDB

# Vector del ejemplo de la documentación de Twilio; coincide con `RequestValidator` de la biblioteca oficial (se comparó una por una)
DOC_URL = "https://mycompany.com/myapp.php?foo=1&bar=2"
DOC_PARAMS = {"CallSid": "CA1234567890ABCDE", "Caller": "+12349013030", "Digits": "1234", "From": "+12349013030", "To": "+18005551212"}
DOC_SIGNATURE = "0/KCTR6DLpKmkAf8muzZqo1nDgQ="
HOOK_URL = "https://us-central1-demo.cloudfunctions.net/whatsapp-webhook"


@pytest.fixture(autouse=True)
def entorno(monkeypatch):
    for var in ("ALLOW_UNAUTHENTICATED_WEBHOOKS", "META_APP_SECRET", "VALUETEXT_WEBHOOK_SECRET", "PUBLIC_BASE_URL"):
        monkeypatch.delenv(var, raising=False)
    numbers.clear_bot_cache()


# --------------------------------------------------------------------------- firmas

def test_firma_de_twilio_contra_el_ejemplo_de_su_documentacion():
    assert signatures.twilio_signature("12345", DOC_URL, DOC_PARAMS) == DOC_SIGNATURE
    assert signatures.valid_twilio("12345", DOC_URL, DOC_PARAMS, DOC_SIGNATURE)


def test_la_firma_de_twilio_se_rompe_si_cambia_cualquier_cosa():
    assert not signatures.valid_twilio("otro", DOC_URL, DOC_PARAMS, DOC_SIGNATURE)
    assert not signatures.valid_twilio("12345", DOC_URL + "&x=1", DOC_PARAMS, DOC_SIGNATURE)
    assert not signatures.valid_twilio("12345", DOC_URL, {**DOC_PARAMS, "Digits": "9999"}, DOC_SIGNATURE)
    assert not signatures.valid_twilio("12345", DOC_URL, {**DOC_PARAMS, "Extra": "x"}, DOC_SIGNATURE)
    assert not signatures.valid_twilio("12345", DOC_URL, DOC_PARAMS, "")
    assert not signatures.valid_twilio("", DOC_URL, DOC_PARAMS, DOC_SIGNATURE)


def test_firma_de_twilio_con_el_formulario_de_flask_y_valores_repetidos():
    form = MultiDict([("Body", "Hola ñandú & más"), ("To", "whatsapp:+528100000000"), ("Tag", "b"), ("Tag", "a")])
    signature = signatures.twilio_signature("tok", HOOK_URL, form)
    assert signatures.valid_twilio("tok", HOOK_URL, form, signature)
    reordered = MultiDict([("Tag", "a"), ("Tag", "b"), ("To", "whatsapp:+528100000000"), ("Body", "Hola ñandú & más")])
    assert signatures.valid_twilio("tok", HOOK_URL, reordered, signature)       # el orden de llegada no cuenta


def test_twilio_firma_con_o_sin_el_puerto_por_defecto():
    params = {"a": "1"}
    with_port = signatures.twilio_signature("tok", "https://h.example:443/p", params)
    without_port = signatures.twilio_signature("tok", "https://h.example/p", params)
    assert signatures.valid_twilio("tok", "https://h.example/p", params, with_port)
    assert signatures.valid_twilio("tok", "https://h.example:443/p", params, without_port)
    custom = signatures.twilio_signature("tok", "https://h.example:8443/p", params)
    assert signatures.valid_twilio("tok", "https://h.example:8443/p", params, custom)
    assert not signatures.valid_twilio("tok", "https://h.example/p", params, custom)


def test_firma_de_meta():
    body = '{"object":"whatsapp_business_account","entry":[]}'.encode()
    signature = "sha256=" + hmac.new(b"app-secret", body, hashlib.sha256).hexdigest()
    assert signatures.meta_signature("app-secret", body) == signature
    assert signatures.valid_meta(["app-secret"], body, signature)
    assert signatures.valid_meta(["otra-app", "app-secret"], body, signature)     # varias apps de Meta
    assert not signatures.valid_meta(["otra-app"], body, signature)
    assert not signatures.valid_meta(["app-secret"], body + b" ", signature)      # un byte distinto
    assert not signatures.valid_meta(["app-secret"], body, signature.removeprefix("sha256="))
    assert not signatures.valid_meta(["app-secret"], body, "") and not signatures.valid_meta([], body, signature)
    assert not signatures.valid_meta([""], body, signature)


def test_secreto_compartido():
    assert signatures.same_secret("abc", "abc") and not signatures.same_secret("abc", "abd")
    assert not signatures.same_secret("", "") and not signatures.same_secret("abc", "")


# --------------------------------------------------------------------------- URL pública

class Req:
    def __init__(self, path="/", method="POST", headers=None, form=None, args=None, query="", body=b"", scheme="http", host="internal:8080"):
        self.path, self.method, self.headers, self.form, self.args = path, method, headers or {}, form or {}, args or {}
        self.query_string, self._body, self.scheme, self.host = query.encode(), body, scheme, host

    def get_data(self, as_text=False):
        return self._body.decode() if as_text else self._body

    def get_json(self, silent=False):
        return json.loads(self._body) if self._body else None


def test_url_publica_con_balanceador_sin_base_configurada():
    req = Req("/webhook/twilio", headers={"X-Forwarded-Proto": "https, http", "X-Forwarded-Host": "hub.example.com"}, query="a=1&b=2")
    assert webhook_auth.public_url(req, {}) == "https://hub.example.com/webhook/twilio?a=1&b=2"
    assert webhook_auth.public_url(Req("/"), {}) == "http://internal:8080/"


def test_url_publica_con_el_prefijo_de_la_funcion():
    env = {"PUBLIC_BASE_URL": f"{HOOK_URL}/"}
    assert webhook_auth.public_url(Req("/"), env) == HOOK_URL             # la raíz no suma barra
    assert webhook_auth.public_url(Req("/", query="x=1"), env) == f"{HOOK_URL}?x=1"
    assert webhook_auth.public_url(Req("/webhook/twilio"), {"PUBLIC_BASE_URL": "https://hub.example.com"}) == "https://hub.example.com/webhook/twilio"


# --------------------------------------------------------------------------- Twilio: el token sale del número

@pytest.fixture
def db(monkeypatch):
    d = FakeDB()
    d.seed("bots", "bot1", {"organizationId": "honda", "name": "Bot"})
    d.seed("whatsappNumbers", "n1", {"organizationId": "honda", "status": "active", "provider": "twilio", "phoneNumber": "whatsapp:+528100000000",
                                     "twilioAccountSid": "AC1", "defaultBotId": "bot1"})
    d.seed("whatsappNumbers", "n-meta", {"organizationId": "honda", "status": "active", "provider": "meta", "phoneNumber": "whatsapp:+528100000009",
                                         "metaPhoneNumberId": "9", "defaultBotId": "bot1"})
    credentials.store(d, "numbers", "n1", {"twilioAuthToken": "token-del-numero"})
    monkeypatch.setattr(numbers, "get_db", lambda: d)
    return d


INBOUND = {"From": "whatsapp:+5218186019229", "To": "whatsapp:+528100000000", "Body": "Hola"}


def signed(form, token="token-del-numero", url=HOOK_URL):
    return {"X-Twilio-Signature": signatures.twilio_signature(token, url, form)}


def test_twilio_acepta_un_mensaje_firmado_con_el_token_del_numero(db):
    assert webhook_auth.twilio_authorized(HOOK_URL, INBOUND, signed(INBOUND), db)


def test_twilio_acepta_el_callback_de_estado_donde_el_numero_es_el_remitente(db):
    status = {"From": "whatsapp:+528100000000", "To": "whatsapp:+5218186019229", "MessageSid": "SM1", "MessageStatus": "delivered"}
    assert webhook_auth.twilio_authorized(HOOK_URL, status, signed(status), db)


@pytest.mark.parametrize("case", ["sin firma", "token ajeno", "cuerpo alterado", "url distinta", "numero desconocido", "numero de otro proveedor"])
def test_twilio_rechaza(db, case):
    form, headers, url = dict(INBOUND), signed(INBOUND), HOOK_URL
    if case == "sin firma":
        headers = {}
    elif case == "token ajeno":
        headers = signed(INBOUND, token="el-token-de-otro")
    elif case == "cuerpo alterado":
        form["Body"] = "Otro mensaje"
    elif case == "url distinta":
        url = "https://otro.example/whatsapp-webhook"
    elif case == "numero desconocido":
        form = {**INBOUND, "To": "whatsapp:+520000000000"}
        headers = signed(form)
    elif case == "numero de otro proveedor":       # el número existe pero es de Meta: no tiene token de Twilio con que firmar
        form = {**INBOUND, "To": "whatsapp:+528100000009"}
        headers = signed(form)
    assert not webhook_auth.twilio_authorized(url, form, headers, db)


def test_twilio_con_un_bot_del_modelo_antiguo(db):
    db.seed("bots", "viejo", {"status": "active", "organizationId": "honda", "twilioConfig": {"phoneNumber": "whatsapp:+528100000077", "accountSid": "AC9"}})
    credentials.store(db, "bots", "viejo", {"twilioConfig.authToken": "token-del-bot"})
    form = {"From": "whatsapp:+5218186019229", "To": "whatsapp:+528100000077", "Body": "Hola"}
    assert webhook_auth.twilio_authorized(HOOK_URL, form, signed(form, token="token-del-bot"), db)


# --------------------------------------------------------------------------- Meta y ValueText

def test_meta_exige_la_firma_con_el_secreto_de_la_app(monkeypatch):
    body = b'{"entry": []}'
    good = {"X-Hub-Signature-256": signatures.meta_signature("app-secret", body)}
    assert not webhook_auth.meta_authorized(body, good, {})                                  # sin META_APP_SECRET: falla cerrado
    assert webhook_auth.meta_authorized(body, good, {"META_APP_SECRET": "app-secret"})
    assert webhook_auth.meta_authorized(body, good, {"META_APP_SECRET": "otra, app-secret"})
    assert not webhook_auth.meta_authorized(body, good, {"META_APP_SECRET": "otra"})
    assert not webhook_auth.meta_authorized(body, {}, {"META_APP_SECRET": "app-secret"})
    assert not webhook_auth.meta_authorized(body + b"x", good, {"META_APP_SECRET": "app-secret"})


def test_valuetext_exige_el_secreto_compartido():
    env = {"VALUETEXT_WEBHOOK_SECRET": "s3"}
    assert webhook_auth.valuetext_authorized({"secret": "s3"}, {}, env) and webhook_auth.valuetext_authorized({}, {"X-Api-Secret": "s3"}, env)
    assert not webhook_auth.valuetext_authorized({"secret": "otro"}, {}, env) and not webhook_auth.valuetext_authorized({}, {}, env)
    assert not webhook_auth.valuetext_authorized({"secret": "s3"}, {}, {})                  # sin secreto configurado: falla cerrado
    assert not webhook_auth.valuetext_authorized({}, {}, {})


def test_la_salida_de_desarrollo_abre_los_tres(db):
    env = {"ALLOW_UNAUTHENTICATED_WEBHOOKS": "true"}
    assert webhook_auth.twilio_authorized(HOOK_URL, INBOUND, {}, db, env) and webhook_auth.meta_authorized(b"x", {}, env)
    assert webhook_auth.valuetext_authorized({}, {}, env)
    assert not webhook_auth.meta_authorized(b"x", {}, {"ALLOW_UNAUTHENTICATED_WEBHOOKS": "false"})


# --------------------------------------------------------------------------- los puntos de entrada

@pytest.fixture
def handled(monkeypatch):
    """Cuenta los eventos que el router publica en la cola, sin Pub/Sub."""
    calls = []
    monkeypatch.setattr(event_queue, "_publisher", type("Cola", (), {"publish": lambda self, event: calls.append((event.kind, event))})())
    return calls


def test_entry_point_de_twilio(db, handled, monkeypatch):
    monkeypatch.setenv("PUBLIC_BASE_URL", HOOK_URL)
    form, url = MultiDict(INBOUND), HOOK_URL + "/webhook/twilio"
    assert main.router(Req("/webhook/twilio", form=form, headers=signed(form, url=url))) == ("", 200)
    assert [name for name, _ in handled] == ["message"]
    assert main.router(Req("/webhook/twilio", form=form)) == ("Forbidden", 403)
    assert main.router(Req("/webhook/twilio", form=form, headers=signed(form, token="falso", url=url))) == ("Forbidden", 403)
    assert len(handled) == 1                                                       # lo rechazado no se procesa
    assert main.router(Req("/webhook/twilio", method="GET")) == ("OK", 200)


def test_entry_point_de_meta(handled, monkeypatch):
    monkeypatch.setenv("META_APP_SECRET", "app-secret")
    body = json.dumps({"entry": [{"changes": [{"value": {"metadata": {"phone_number_id": "9"}, "contacts": [{"profile": {"name": "L"}}],
                                                         "messages": [{"type": "text", "from": "528186019229", "text": {"body": "Hola"}}]}}]}]}).encode()
    signed_headers = {"X-Hub-Signature-256": signatures.meta_signature("app-secret", body)}
    assert main.router(Req("/webhook/meta", body=body, headers=signed_headers)) == ("OK", 200)
    assert [name for name, _ in handled] == ["message"]
    assert main.router(Req("/webhook/meta", body=body)) == ("Forbidden", 403)
    assert main.router(Req("/webhook/meta", body=body + b" ", headers=signed_headers)) == ("Forbidden", 403)
    assert len(handled) == 1


def test_el_get_de_verificacion_de_meta_no_pide_firma(db, monkeypatch):
    credentials.store(db, "numbers", "n-meta", {"metaWebhookVerifyToken": "mi-token"})
    monkeypatch.setattr("channels.webhooks.get_db", lambda: db)
    args = {"hub.mode": "subscribe", "hub.verify_token": "mi-token", "hub.challenge": "42"}
    assert main.router(Req("/webhook/meta", method="GET", args=args)) == ("42", 200)


def test_entry_point_de_valuetext(handled, monkeypatch):
    monkeypatch.setenv("VALUETEXT_WEBHOOK_SECRET", "s3")
    soap = "<soapenv:Envelope/>"
    assert main.router(Req("/webhook/valuetext", args={"secret": "s3"}, body=soap.encode()))[1] == 200
    assert main.router(Req("/webhook/valuetext", args={"secret": "malo"}, body=soap.encode())) == ("Forbidden", 403)
    assert main.router(Req("/webhook/valuetext", body=soap.encode())) == ("Forbidden", 403)
    assert main.router(Req("/webhook/valuetext", method="GET")) == ("OK", 200)


def test_sin_configuracion_los_tres_webhooks_rechazan_todo(db, handled):
    form = MultiDict(INBOUND)
    # el token del número sí está, pero sin PUBLIC_BASE_URL la URL que ve la función no es la que Twilio firmó
    assert main.router(Req("/webhook/twilio", form=form, headers=signed(form)))[1] == 403
    assert main.router(Req("/webhook/meta", body=b"{}"))[1] == 403
    assert main.router(Req("/webhook/valuetext", body=b"<a/>"))[1] == 403
