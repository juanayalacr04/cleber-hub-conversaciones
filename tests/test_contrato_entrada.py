"""Contrato ① (core/contrato_entrada.py) con la fuente de Valuación (modules/valuacion.py), sin red ni base."""
import itertools

import pytest

import modules  # noqa: F401  registra la fuente "valuacion"
from core import contrato_entrada, credentials, outbound, postgrest, tiempo_real
from core.datos import numeros
from core.postgrest import ErrorHub
from modules import valuacion

PLANTILLA = {
    "contentSid": "HX123",
    "templateName": "oferta_compra",
    "variables": ["nombreCliente", "vehiculo", "montoOferta"],
    "texto": "Hola {{1}}, por tu {{2}} te ofrecemos {{3}}.",
}
CONTEXTO = {"nombreCliente": "Juan Pérez", "vehiculo": "HONDA CIVIC 2019", "kilometraje": 64000, "montoOferta": 270000.0,
            "agencia": "Honda Satélite", "fechaCita": "2026-11-12", "horaCita": "09:30"}
PETICION = {"action": "Hub.abreConversacion", "params": {
    "fuente": "valuacion", "idExterno": "123", "idMarca": "HO", "modulo": "valuacion", "telefono": "+525512345678", "alCliente": True,
    "nombreCliente": "Juan Pérez", "contexto": CONTEXTO}}


class BaseFalsa:
    """Las acciones Hub.* que usa el contrato ①, sobre un dict en memoria."""

    def __init__(self, plantillas=None, proveedor="twilio"):
        self.numero = {"idNumero": "n1", "idMarca": "HO", "modulo": "valuacion", "telefono": "+525500000001",
                       "proveedor": proveedor, "configProveedor": {"twilioAccountSid": "AC1"}, "esActivo": True,
                       "plantillas": {"ofertaValuacion": PLANTILLA} if plantillas is None else plantillas}
        self.conversaciones: dict[str, dict] = {}
        self.mensajes: list[dict] = []
        self.bitacora: list[dict] = []
        self.llamadas: list[str] = []
        self._ids = itertools.count(1)
        self.error: dict[str, ErrorHub] = {}

    def llama(self, accion, params=None, *, token=None, timeout=15):
        self.llamadas.append(accion)
        if accion in self.error:
            raise self.error[accion]
        return getattr(self, accion.split(".")[1])(params or {})

    def resuelveNumero(self, p):
        return {"numero": self.numero, "botDefault": None, "equipo": None, "marca": {"idMarca": "HO", "salesforceConfig": {}}}

    def abreConversacionExterna(self, p):
        for c in self.conversaciones.values():
            if (c["fuente"], c["idExterno"]) == (p["fuente"], p["idExterno"]):
                return {"conversacion": c, "numero": self.numero, "creada": False}
        cid = f"c{next(self._ids)}"
        self.conversaciones[cid] = {"idConversacion": cid, "idMarca": "HO", "modulo": "valuacion", "fuente": p["fuente"],
                                    "idExterno": p["idExterno"], "telefonoCliente": p["telefono"], "metadatos": {"contexto": p["contexto"]},
                                    "idAgencia": p.get("idAgencia"), "version": 1}
        return {"conversacion": self.conversaciones[cid], "numero": self.numero, "creada": True}

    def guardaMensaje(self, p):
        self.mensajes.append(p)
        return {"mensaje": {"idMensaje": str(len(self.mensajes))}, "conversacion": self.conversaciones[p["idConversacion"]]}

    def actualizaConversacion(self, p):
        c = self.conversaciones[p["idConversacion"]]
        c["metadatos"] = {**c["metadatos"], **p.get("metadatos", {})}
        c["version"] += 1
        return {"conversacion": c}

    def registraBitacora(self, p):
        self.bitacora.append(p)
        return {"idBitacora": str(len(self.bitacora))}


@pytest.fixture
def base(monkeypatch):
    b = BaseFalsa()
    monkeypatch.setattr(postgrest, "llama", b.llama)
    numeros.clear_cache()
    return b


@pytest.fixture
def envios(monkeypatch):
    """Proveedor falso: guarda lo que se le pidió mandar y regresa un id."""
    class Proveedor:
        enviados = []
        falla = None

    def send_campaign(number, broadcast, recipient, phone, sf_config=None, track=True):
        if Proveedor.falla:
            raise Proveedor.falla
        Proveedor.enviados.append({"number": number, "plantilla": broadcast, "recipient": recipient, "phone": phone})
        return f"SM{len(Proveedor.enviados)}"

    Proveedor.enviados = []
    outbound.configure(send_campaign=send_campaign)
    yield Proveedor
    outbound.configure()


@pytest.fixture(autouse=True)
def sin_credenciales_reales(monkeypatch):
    """Twilio: la cuenta del ambiente. Un secreto propio del número (el almacén) se ignora."""
    monkeypatch.setenv("TWILIO_ACCOUNT_SID", "AC-ambiente")
    monkeypatch.setenv("TWILIO_AUTH_TOKEN", "tok")

    class Almacen:
        def lee(self, db, kind, doc_id):
            return {"twilioAuthToken": "del-numero", "metaAccessToken": "meta-tok"} if kind == "numbers" else {}
    credentials.configure(Almacen())
    yield
    credentials.configure(None)


@pytest.fixture
def avisos():
    publicados = []
    tiempo_real.configure(lambda canal, eventos: publicados.append((canal, eventos)))
    yield publicados
    tiempo_real.configure(None)


def test_envia_la_oferta_de_punta_a_punta(base, envios, avisos):
    r = contrato_entrada.maneja(PETICION)
    assert r == {"successful": True, "info": {"idConversacion": "c1", "creada": True, "enviada": True, "idMensajeProveedor": "SM1"}}

    (enviado,) = envios.enviados
    assert enviado["phone"] == "+525512345678"
    assert enviado["number"]["phoneNumber"] == "whatsapp:+525500000001"      # forma que esperan los canales
    assert enviado["number"]["twilioAuthToken"] == "tok"                       # la cuenta de Twilio del ambiente...
    assert enviado["number"]["twilioAccountSid"] == "AC-ambiente"              # ...no la que traiga el número
    assert enviado["plantilla"]["contentSid"] == "HX123"
    assert enviado["recipient"]["variables"] == {"1": "Juan Pérez", "2": "HONDA CIVIC 2019", "3": "$270,000"}

    contexto, plantilla = base.mensajes
    assert contexto["remitente"] == "system" and contexto["texto"].startswith("<<CONTEXTO>> Se le envió al cliente una oferta")
    assert "Monto ofrecido: $270,000" in contexto["texto"] and "Cita de servicio: 12/11/2026 09:30" in contexto["texto"]
    assert "Id de oferta: 123" in contexto["texto"]
    assert plantilla == {"idConversacion": "c1", "remitente": "bot", "esPlantilla": True,
                         "texto": "Hola Juan Pérez, por tu HONDA CIVIC 2019 te ofrecemos $270,000.", "idMensajeProveedor": "SM1"}

    assert base.conversaciones["c1"]["metadatos"]["envio"]["idMensajeProveedor"] == "SM1"
    assert base.bitacora[0]["accion"] == "envio_plantilla"
    assert [canal for canal, _ in avisos] == ["/hub/HO/valuacion", "/hub/HO/valuacion/c1"]


def _con(**extra):
    params = {k: v for k, v in PETICION["params"].items() if k != "alCliente"}
    return {"action": "Hub.abreConversacion", "params": {**params, **extra}}


@pytest.mark.parametrize("escrito", ["5599999999", "55 9999 9999", "+52 55 9999 9999", "525599999999", "+525599999999"])
def test_telefono_destino_redirige_el_envio_y_agrega_el_codigo_de_pais(base, envios, escrito):
    r = contrato_entrada.maneja(_con(telefonoDestino=escrito))
    assert r["successful"], r
    assert envios.enviados[0]["phone"] == "+525599999999"                     # nunca al cliente
    conv = base.conversaciones["c1"]
    assert conv["telefonoCliente"] == "+525599999999"                          # la respuesta caerá en esta conversación
    assert conv["metadatos"]["contexto"]["telefonoOriginal"] == "+525512345678"


def test_al_cliente_envia_al_telefono_del_cliente(base, envios):
    r = contrato_entrada.maneja(_con(alCliente=True))
    assert r["successful"] and envios.enviados[0]["phone"] == "+525512345678"
    assert "telefonoOriginal" not in base.conversaciones["c1"]["metadatos"]["contexto"]


def test_la_agencia_de_la_oferta_queda_en_la_conversacion(base, envios):
    assert contrato_entrada.maneja(_con(alCliente=True, idAgencia=107))["successful"]
    assert base.conversaciones["c1"]["idAgencia"] == "107"


def test_sin_agencia_la_conversacion_no_lleva(base, envios):
    assert contrato_entrada.maneja(_con(alCliente=True))["successful"]
    assert base.conversaciones["c1"]["idAgencia"] is None


def test_sin_destino_explicito_no_se_envia_a_nadie(base, envios):
    r = contrato_entrada.maneja(_con())
    assert (r["successful"], r["errorCode"]) == (False, "DESTINO_REQUERIDO")
    assert envios.enviados == [] and base.conversaciones == {}


def test_al_cliente_en_falso_tampoco_cuenta_como_destino(base, envios):
    assert contrato_entrada.maneja(_con(alCliente=False))["errorCode"] == "DESTINO_REQUERIDO"
    assert contrato_entrada.maneja(_con(alCliente="true"))["errorCode"] == "DESTINO_REQUERIDO"   # solo el booleano true


@pytest.mark.parametrize("malo", ["123", "55999", "abcdefghij", "+12"])
def test_telefono_destino_invalido_se_rechaza(base, envios, malo):
    r = contrato_entrada.maneja(_con(telefonoDestino=malo))
    assert (r["errorCode"], r["info"]) == ("CAMPO_INVALIDO", {"campo": "telefonoDestino"})
    assert envios.enviados == []


def test_en_produccion_se_envia_al_cliente_en_automatico(base, envios, monkeypatch):
    monkeypatch.setenv("AMBIENTE", "prd")
    r = contrato_entrada.maneja(_con())                    # sin destino: no hace falta
    assert r["successful"] and envios.enviados[0]["phone"] == "+525512345678"
    assert "telefonoOriginal" not in base.conversaciones["c1"]["metadatos"]["contexto"]


def test_en_produccion_no_se_puede_desviar_el_envio(base, envios, monkeypatch):
    monkeypatch.setenv("AMBIENTE", "prd")
    r = contrato_entrada.maneja(_con(telefonoDestino="5599999999"))
    assert r["successful"] and envios.enviados[0]["phone"] == "+525512345678"          # el desvío se ignora


@pytest.mark.parametrize("valor", [None, "dev", "qa", ""])
def test_fuera_de_produccion_sigue_exigiendo_destino(base, envios, monkeypatch, valor):
    if valor is None:
        monkeypatch.delenv("AMBIENTE", raising=False)
    else:
        monkeypatch.setenv("AMBIENTE", valor)
    assert contrato_entrada.maneja(_con())["errorCode"] == "DESTINO_REQUERIDO"


def test_telefono_destino_gana_sobre_al_cliente(base, envios):
    contrato_entrada.maneja(_con(telefonoDestino="5599999999", alCliente=True))
    assert envios.enviados[0]["phone"] == "+525599999999"


def test_la_misma_oferta_otra_vez_no_reenvia(base, envios):
    contrato_entrada.maneja(PETICION)
    r = contrato_entrada.maneja(PETICION)
    assert r["info"] == {"idConversacion": "c1", "creada": False, "enviada": True, "idMensajeProveedor": "SM1"}
    assert len(envios.enviados) == 1


def test_si_el_proveedor_falla_se_puede_reintentar_sin_duplicar_el_contexto(base, envios):
    envios.falla = outbound.TemplateError(outbound.FAILED, "Twilio API error 400")
    r = contrato_entrada.maneja(PETICION)
    assert r == {"successful": False, "errorCode": "ERROR_PROVEEDOR", "errorMessage": "Twilio API error 400"}
    assert "envio" not in base.conversaciones["c1"]["metadatos"]

    envios.falla = None
    r = contrato_entrada.maneja(PETICION)
    assert r["successful"] and r["info"]["idConversacion"] == "c1" and r["info"]["creada"] is False
    assert [m["remitente"] for m in base.mensajes] == ["system", "bot"]        # el contexto se guardó una sola vez


def test_conversacion_abierta_pasa_con_su_motivo(base, envios):
    base.error["Hub.abreConversacionExterna"] = ErrorHub("ESTADO_INVALIDO", "ya hay otra",
                                                         {"motivo": "CONVERSACION_ABIERTA", "idConversacion": "c9"})
    r = contrato_entrada.maneja(PETICION)
    assert r == {"successful": False, "errorCode": "ESTADO_INVALIDO", "errorMessage": "ya hay otra",
                 "info": {"motivo": "CONVERSACION_ABIERTA", "idConversacion": "c9"}}
    assert not envios.enviados


def test_sin_numero_del_modulo(base, envios):
    base.error["Hub.resuelveNumero"] = ErrorHub("RECURSO_NO_ENCONTRADO", "No hay número activo con ese criterio")
    r = contrato_entrada.maneja(PETICION)
    assert r["errorCode"] == "ESTADO_INVALIDO" and r["info"]["motivo"] == "SIN_NUMERO"
    assert "Hub.abreConversacionExterna" not in base.llamadas and not envios.enviados


def test_sin_plantilla_configurada(monkeypatch, envios):
    b = BaseFalsa(plantillas={})
    monkeypatch.setattr(postgrest, "llama", b.llama)
    numeros.clear_cache()
    r = contrato_entrada.maneja(PETICION)
    assert r["errorCode"] == "PLANTILLA_NO_CONFIGURADA"
    assert not envios.enviados


@pytest.mark.parametrize("cuerpo,codigo", [
    (None, "PETICION_INVALIDA"),
    ({"action": "Otra", "params": {}}, "PETICION_INVALIDA"),
    ({"action": "Hub.abreConversacion", "params": {**PETICION["params"], "telefono": " "}}, "CAMPO_REQUERIDO"),
    ({"action": "Hub.abreConversacion", "params": {**PETICION["params"], "fuente": "otra"}}, "FUENTE_DESCONOCIDA"),
])
def test_peticiones_invalidas(base, envios, cuerpo, codigo):
    assert contrato_entrada.maneja(cuerpo)["errorCode"] == codigo
    assert not envios.enviados


def test_error_inesperado_no_se_escapa(base, envios, monkeypatch):
    monkeypatch.setattr(valuacion, "contexto_bot", lambda *a: 1 / 0)
    contrato_entrada.registra_fuente("valuacion", valuacion.prepara_oferta)
    assert contrato_entrada.maneja(PETICION)["errorCode"] == "ERROR_INTERNO"


# --------------------------------------------------------------------------- piezas de Valuación

def test_formatos_de_valuacion():
    assert valuacion.valor({"montoOferta": 270000}, "montoOferta") == "$270,000"
    assert valuacion.valor({"montoOferta": "270000.5"}, "montoOferta") == "$270,000.50"
    assert valuacion.valor({"kilometraje": 64000}, "kilometraje") == "64,000 km"
    assert valuacion.valor({"fechaCita": "2026-11-12"}, "fechaCita") == "12/11/2026"
    assert valuacion.valor({}, "agencia") == ""


def test_meta_sin_componentes_arma_el_body_con_las_variables():
    numero = {"plantillas": {"ofertaValuacion": {"templateName": "oferta", "variables": ["nombreCliente", "montoOferta"]}}}
    envio = valuacion.prepara_oferta({"idExterno": "1"}, numero, CONTEXTO)
    assert envio.plantilla["templateComponents"] == [{"type": "body", "parameters": [
        {"type": "text", "text": "Juan Pérez"}, {"type": "text", "text": "$270,000"}]}]


def test_para_canal_de_meta_y_valuetext():
    credentials.configure(type("A", (), {"lee": lambda self, db, k, i: {"metaAccessToken": "m"}})())
    meta = numeros.para_canal({"idNumero": "n2", "proveedor": "meta", "telefono": "+525511111111",
                               "configProveedor": {"metaPhoneNumberId": "PN1"}})
    assert meta["phoneNumber"] == "+525511111111" and meta["metaPhoneNumberId"] == "PN1" and meta["metaAccessToken"] == "m"
    vt = numeros.para_canal({"idNumero": "n3", "proveedor": "valuetext", "telefono": "+525522222222",
                             "configProveedor": {"valuetextSenderId": "S1"}})
    assert vt["valuetextSenderId"] == "S1" and vt["provider"] == "valuetext"


def test_para_canal_de_twilio_usa_solo_la_cuenta_del_ambiente(monkeypatch):
    fila = {"idNumero": "n1", "proveedor": "twilio", "telefono": "+5215500000001",
            "configProveedor": {"twilioAccountSid": "AC-del-numero"}}
    tw = numeros.para_canal(fila)
    assert tw["twilioAccountSid"] == "AC-ambiente" and tw["twilioAuthToken"] == "tok"       # nada del número ni de su secreto
    assert tw["phoneNumber"] == "whatsapp:+5215500000001"

    monkeypatch.delenv("TWILIO_ACCOUNT_SID")
    monkeypatch.setenv("TWILIO_AUTH_TOKEN", " ")
    tw = numeros.para_canal(fila)
    assert "twilioAccountSid" not in tw and "twilioAuthToken" not in tw                    # sin respaldo: queda sin configurar
