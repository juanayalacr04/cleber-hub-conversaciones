"""Entrada de mensajes sobre hub_cleber (core/entrada_mensajes.py), sin red ni base: las acciones Hub.* en memoria."""
import itertools

import pytest

from ai import engine
from contracts.messages import IncomingMessage
from core import credentials, entrada_mensajes, postgrest, tools
from core.datos import numeros
from core.postgrest import ErrorHub

CLIENTE = "whatsapp:+528186019229"
NUMERO = "whatsapp:+5215500000001"


def ok(response="Hola", tool_results=None):
    return {"success": True, "result": {"response": response, "toolResults": tool_results or []}}


class BaseFalsa:
    """Hub.resuelveNumero, obtieneOAbreConversacion, guardaMensaje y actualizaConversacion sobre dicts."""

    def __init__(self):
        self.numero = {"idNumero": "n1", "idMarca": "TO", "modulo": "valuacion", "telefono": "+5215500000001",
                       "proveedor": "twilio", "idEquipo": "e1", "idBotDefault": "b1", "esActivo": True}
        self.bot = {"idBot": "b1", "idMarca": "TO", "modulo": "valuacion", "nombre": "Bot", "tipo": "workflow",
                    "config": {"abacusConfig": {"deploymentId": "d1"}}, "esActivo": True}
        self.equipo = {"idEquipo": "e1", "modoAsignacion": "manual", "accionOptOut": None}
        self.conversaciones: dict[str, dict] = {}
        self.mensajes: list[dict] = []
        self.bitacora: list[dict] = []
        self._ids = itertools.count(1)

    def llama(self, accion, params=None, *, token=None, timeout=15):
        return getattr(self, accion.split(".")[1])(params or {})

    def resuelveNumero(self, p):
        if p.get("telefono") not in ("+5215500000001", NUMERO):
            raise ErrorHub("RECURSO_NO_ENCONTRADO", "no hay número")
        return {"numero": self.numero, "botDefault": self.bot, "equipo": self.equipo, "marca": {"idMarca": "TO"}}

    def conv(self):
        return next(iter(self.conversaciones.values()))

    def abre(self, **extra):
        cid = f"c{next(self._ids)}"
        self.conversaciones[cid] = {"idConversacion": cid, "idMarca": "TO", "modulo": "valuacion", "idNumero": "n1",
                                    "idEquipo": "e1", "estado": "bot", "telefonoCliente": "+528186019229",
                                    "ultimoMensajeClienteEn": None, "metadatos": {}, "version": 1, **extra}
        return self.conversaciones[cid]

    def obtieneOAbreConversacion(self, p):
        abiertas = [c for c in self.conversaciones.values() if c["estado"] != "closed"]
        if abiertas:
            c, origen = abiertas[0], "abierta"
        else:
            c, origen = self.abre(), "nueva"
        historial = [m for m in self.mensajes if m["idConversacion"] == c["idConversacion"]]
        return {"conversacion": dict(c), "origen": origen, "historial": historial}

    def guardaMensaje(self, p):
        c = self.conversaciones[p["idConversacion"]]
        if p.get("idMensajeProveedor") and any(m.get("idMensajeProveedor") == p["idMensajeProveedor"] for m in self.mensajes):
            return {"mensaje": {}, "conversacion": dict(c), "duplicado": True}
        self.mensajes.append({**p, "remitente": p["remitente"]})
        if p["remitente"] == "customer":
            c["ultimoMensajeClienteEn"] = "ahora"
        c["version"] += 1
        return {"mensaje": {"idMensaje": str(len(self.mensajes))}, "conversacion": dict(c), "duplicado": False}

    def registraBitacora(self, p):
        self.bitacora.append(p)
        return {"idBitacora": str(len(self.bitacora))}

    def actualizaConversacion(self, p):
        c = self.conversaciones[p["idConversacion"]]
        for k, v in p.items():
            if k == "metadatos":
                c["metadatos"] = {**c["metadatos"], **v}
            elif k != "idConversacion":
                c[k] = v
        c["version"] += 1
        return {"conversacion": dict(c)}


@pytest.fixture
def env(monkeypatch):
    base = BaseFalsa()
    monkeypatch.setattr(postgrest, "llama", base.llama)
    monkeypatch.setattr(credentials, "reveal", lambda db, kind, doc_id, data: data)
    monkeypatch.setenv("TWILIO_ACCOUNT_SID", "AC1")
    monkeypatch.setenv("TWILIO_AUTH_TOKEN", "tok")
    numeros.clear_cache()
    tools.clear()
    estado = {"result": ok("¡Hola! ¿En qué te ayudo?")}
    llamadas, enviados = [], []

    def motor(bot, mensajes, conv_id=None, customer_phone=""):
        llamadas.append({"bot": bot, "texto": mensajes[-1]["text"], "conv_id": conv_id})
        return estado["result"]

    monkeypatch.setattr(engine, "send_to_bot", motor)

    def send(bot, to, from_, text, media_url=None):
        enviados.append({"to": to, "from": from_, "text": text, "bot": bot})
        return f"SM{len(enviados)}"

    def corre(body="hola", message_id=None, **extra):
        msg = IncomingMessage(message_id=message_id or f"in{len(base.mensajes)}", provider="twilio", from_number=CLIENTE,
                              to_number=NUMERO, body=body, **extra)
        entrada_mensajes.procesa(msg, send)

    class E:
        pass

    e = E()
    e.base, e.estado, e.llamadas, e.enviados, e.corre = base, estado, llamadas, enviados, corre
    yield e
    tools.clear()


def _remitentes(base):
    return [m["remitente"] for m in base.mensajes]


def test_camino_normal_guarda_contesta_y_guarda_respuesta(env):
    env.corre("hola")
    assert _remitentes(env.base) == ["customer", "system", "bot"]          # system = teléfono del cliente (Twilio)
    assert env.enviados[0]["text"] == "¡Hola! ¿En qué te ayudo?"
    assert env.enviados[0]["to"] == CLIENTE
    assert env.enviados[0]["from"] == "whatsapp:+5215500000001"
    assert env.enviados[0]["bot"]["twilioConfig"] == {"phoneNumber": "whatsapp:+5215500000001", "accountSid": "AC1", "authToken": "tok"}
    assert env.base.mensajes[-1]["idMensajeProveedor"] == "SM1"
    assert env.llamadas[0]["conv_id"] == "c1"
    assert env.llamadas[0]["bot"]["vertical"] == "valuacion"


def test_primer_mensaje_lleva_plantilla_y_contexto_de_la_oferta(env):
    conv = env.base.abre(fuente="valuacion", idExterno="9")
    env.base.mensajes += [
        {"idConversacion": conv["idConversacion"], "remitente": "system", "texto": "<<CONTEXTO>> Oferta 9: $270,000"},
        {"idConversacion": conv["idConversacion"], "remitente": "bot", "esPlantilla": True, "texto": "Hola Juan, te ofrecemos..."},
    ]
    env.corre("Me interesa")
    texto = env.llamadas[0]["texto"]
    assert texto.startswith("<<CONTEXTO>> Oferta 9: $270,000")
    assert '<<PLANTILLA>> Mensaje que se le envió al cliente: "Hola Juan, te ofrecemos..."' in texto
    assert texto.endswith("Me interesa")


def test_segundo_mensaje_va_sin_preambulo(env):
    env.corre("hola")
    env.corre("¿y cuánto?")
    assert env.llamadas[1]["texto"] == "¿y cuánto?"


def test_reintento_del_proveedor_no_se_procesa_dos_veces(env):
    env.corre("hola", message_id="SMx")
    env.corre("hola", message_id="SMx")
    assert len(env.llamadas) == 1
    assert _remitentes(env.base).count("customer") == 1


def test_numero_desconocido_no_hace_nada(env):
    msg = IncomingMessage(message_id="1", provider="twilio", from_number=CLIENTE, to_number="whatsapp:+529999999999", body="hola")
    entrada_mensajes.procesa(msg, lambda *a, **k: None)
    assert env.base.conversaciones == {}


def test_sin_bot_activo_guarda_el_mensaje_y_no_contesta(env):
    env.base.bot["esActivo"] = False
    env.corre("hola")
    assert _remitentes(env.base) == ["customer"]
    assert env.enviados == [] and env.llamadas == []


def test_opt_out_cierra(env):
    env.corre("hola")
    env.corre("stop")
    assert env.base.conv()["estado"] == "closed"
    assert len(env.llamadas) == 1


def test_handoff_pedido_por_el_bot_pasa_a_esperar_asesor(env, monkeypatch):
    monkeypatch.setattr(entrada_mensajes.ho, "check_business_hours", lambda *a, **k: True)
    env.estado["result"] = ok("Te comunico con un asesor.", [{"toolName": "Transferir_a_Asesor", "input": {"motivo": "precio"}}])
    env.corre("quiero hablar con alguien")
    c = env.base.conv()
    assert c["estado"] == "waiting_agent" and c["motivoHandoff"] == "precio"
    assert env.enviados[-1]["text"] == "Te comunico con un asesor."


def test_handoff_por_el_tool_generico_externo(env, monkeypatch):
    monkeypatch.setattr(entrada_mensajes.ho, "check_business_hours", lambda *a, **k: True)
    env.estado["result"] = ok("Te comunico con un asesor.", [
        {"toolName": "Ejecutar_Accion_Externo", "input": {"accion": "Transferir_a_Asesor", "motivo": "precio"}}])
    env.corre("quiero hablar con alguien")
    c = env.base.conv()
    assert c["estado"] == "waiting_agent" and c["motivoHandoff"] == "precio"
    assert env.enviados[-1]["text"] == "Te comunico con un asesor."


def test_handoff_fuera_de_horario_avisa_y_no_escala(env, monkeypatch):
    monkeypatch.setattr(entrada_mensajes.ho, "check_business_hours", lambda *a, **k: False)
    monkeypatch.setattr(entrada_mensajes.ho, "build_out_of_hours_message", lambda *a, **k: "Fuera de horario")
    env.estado["result"] = ok("Te comunico.", [{"toolName": "Transferir_a_Asesor", "input": {"motivo": "x"}}])
    env.corre("asesor")
    c = env.base.conv()
    assert c["estado"] == "bot" and c["metadatos"].get("handoffBloqueadoEn")
    assert env.enviados[-1]["text"] == "Fuera de horario"


def test_esperando_asesor_contesta_aviso_sin_bot(env):
    env.base.abre(estado="waiting_agent")
    env.corre("¿hola?")
    assert env.llamadas == []
    assert env.enviados[-1]["text"] == entrada_mensajes.DEFAULT_WAITING_MESSAGE


def test_con_asesor_no_contesta_nadie(env):
    env.base.abre(estado="with_agent")
    env.corre("gracias")
    assert env.llamadas == [] and env.enviados == []
    assert _remitentes(env.base) == ["customer"]


def test_reset_cierra_de_forma_manual(env):
    env.corre("hola")
    env.corre("/reset")
    c = env.base.conv()
    assert c["estado"] == "closed" and c["cierreManual"] is True
    assert env.enviados[-1]["text"] == entrada_mensajes.RESET_MESSAGE


def test_handlers_del_modulo_reciben_la_conversacion_con_llaves_de_firestore(env):
    vistos = []
    tools.tool("customer_replied", vertical="valuacion")(lambda conv, params: vistos.append(conv))
    env.corre("hola")
    assert vistos[0]["vertical"] == "valuacion" and vistos[0]["id"] == "c1" and vistos[0]["hub"]["idNumero"] == "n1"


def test_token_de_abacus_sale_del_ambiente_por_modulo(env, monkeypatch):
    monkeypatch.setenv("ABACUS_DEPLOYMENT_TOKEN_VALUACION", "tok-val")
    monkeypatch.setenv("ABACUS_DEPLOYMENT_TOKEN_VENTAS", "tok-ven")
    env.corre("hola")
    assert env.llamadas[0]["bot"]["abacusConfig"] == {"deploymentId": "d1", "deploymentToken": "tok-val"}


def test_token_propio_del_bot_gana_sobre_el_del_modulo(env, monkeypatch):
    monkeypatch.setenv("ABACUS_DEPLOYMENT_TOKEN_VALUACION", "tok-val")
    env.base.bot["config"]["abacusConfig"]["deploymentToken"] = "tok-propio"
    env.corre("hola")
    assert env.llamadas[0]["bot"]["abacusConfig"]["deploymentToken"] == "tok-propio"


def test_llave_de_abacus_es_una_para_todos_los_modulos(env, monkeypatch):
    monkeypatch.setenv("ABACUS_DEPLOYMENT_TOKEN_VALUACION", "tok-val")
    monkeypatch.setenv("ABACUS_API_KEY", "llave-org")
    env.corre("hola")
    assert env.llamadas[0]["bot"]["abacusConfig"] == {"deploymentId": "d1", "deploymentToken": "tok-val", "apiKey": "llave-org"}


def test_el_turno_deja_registro_de_sus_decisiones(env, monkeypatch, caplog):
    import logging
    monkeypatch.setattr(entrada_mensajes.ho, "check_business_hours", lambda *a, **k: True)
    env.estado["result"] = ok("Te comunico.", [{"toolName": "Transferir_a_Asesor", "input": {"motivo": "precio"}}])
    with caplog.at_level(logging.INFO, logger="core.entrada_mensajes"):
        env.corre("quiero un asesor")
    texto = "\n".join(r.getMessage() for r in caplog.records)
    assert "turno.inicio" in texto and "cliente=****9229" in texto
    assert "turno.bot_respuesta" in texto and "'Transferir_a_Asesor'" in texto
    assert "turno.handoff_revisado conv=c1 detectado=True motivo='precio'" in texto
    assert "turno.handoff_aplicado" in texto and "estado_destino='waiting_agent'" in texto
    assert "Te comunico." not in texto and "quiero un asesor" not in texto        # el contenido solo con LOG_CONTENIDO=true


def test_con_log_contenido_se_registra_el_texto(env, monkeypatch, caplog):
    import logging
    monkeypatch.setenv("LOG_CONTENIDO", "true")
    with caplog.at_level(logging.INFO, logger="core.entrada_mensajes"):
        env.corre("hola")
    texto = "\n".join(r.getMessage() for r in caplog.records)
    assert "¡Hola! ¿En qué te ayudo?" in texto and "texto='hola'" in texto


def test_boton_de_la_plantilla_llega_al_modulo_con_su_payload(env):
    vistos = []
    tools.tool("customer_button", vertical="valuacion")(lambda conv, params: vistos.append((params["payload"], params["text"])))
    env.corre("Me interesa", button_payload="oferta_interesa", button_text="Me interesa")
    assert vistos == [("oferta_interesa", "Me interesa")]
    assert env.llamadas[0]["texto"].endswith("Me interesa")          # el bot lo lee como un mensaje más


def test_mensaje_normal_no_dispara_el_evento_de_boton(env):
    vistos = []
    tools.tool("customer_button", vertical="valuacion")(lambda conv, params: vistos.append(params))
    env.corre("hola")
    assert vistos == []


# ---- contrato 3: eventos hacia Valuación ----

@pytest.fixture
def salida(env, monkeypatch):
    import importlib
    from core import contrato_salida
    from modules import valuacion
    importlib.reload(valuacion)               # los handlers se registran al importar; el registro se limpia entre pruebas
    monkeypatch.setattr(entrada_mensajes.ho, "check_business_hours", lambda *a, **k: True)
    env.base.abre(fuente="valuacion", idExterno="77")
    env.eventos, env.orden, env.responde = [], [], {"resultado": "IGNORADO"}

    def entrega(accion, params):
        env.orden.append(("evento", len(env.enviados)))        # cuántas respuestas ya habían salido al cliente
        env.eventos.append((accion, params))
        if isinstance(env.responde, Exception):
            raise env.responde
        return env.responde

    contrato_salida.configure(entrega)
    yield env
    contrato_salida.configure(None)


def _tipos(env):
    return [(p["tipo"], p.get("accion")) for _, p in env.eventos]


def test_primera_respuesta_avisa_a_valuacion_despues_de_contestar(salida):
    salida.corre("Me interesa", message_id="SMa")
    accion, p = salida.eventos[0]
    assert accion == "Valuacion.registraResultadoConversacion"
    assert (p["tipo"], p["externalId"], p["idConversacion"], p["idEvento"]) == ("conversation.replied", "77", "c1", "replied-c1-SMa")
    assert p["carga"]["texto"] == "Me interesa" and p["carga"]["idMarca"] == "TO"
    assert salida.orden[0] == ("evento", 1)          # el cliente ya tenía su respuesta cuando se avisó


def test_boton_manda_un_solo_evento_con_el_payload_como_accion(salida):
    salida.corre("Me interesa", message_id="SMb", button_payload="oferta_interesa", button_text="Me interesa")
    assert _tipos(salida) == [("conversation.replied", "oferta_interesa")]
    assert salida.eventos[0][1]["carga"]["boton"] == {"payload": "oferta_interesa", "texto": "Me interesa"}
    assert salida.eventos[0][1]["idEvento"] == "button-c1-SMb"


def test_la_segunda_respuesta_no_repite_el_evento_de_primera_respuesta(salida):
    salida.corre("hola", message_id="SM1")
    salida.corre("¿y cuánto?", message_id="SM2")
    assert _tipos(salida) == [("conversation.replied", None)]


def test_handoff_y_resultado_salen_con_su_vocabulario(salida):
    salida.estado["result"] = ok("Te comunico.", [{"toolName": "Transferir_a_Asesor", "input": {"motivo": "precio"}}])
    salida.corre("asesor", message_id="SM3")
    assert ("conversation.handoff", None) in _tipos(salida)
    handoff = next(p for _, p in salida.eventos if p["tipo"] == "conversation.handoff")
    assert handoff["carga"]["motivo"] == "precio" and handoff["carga"]["estado"] == "waiting_agent"


def test_resultado_por_el_tool_generico_externo_llega_a_valuacion(salida):
    salida.base.bot["config"].update(outcomeActions=["oferta_aceptada_venta"], outcomeTool="Clasificar_Motivo")
    salida.estado["result"] = ok("Perfecto, registro tu decisión.", [
        {"toolName": "Ejecutar_Accion_Externo", "input": {"accion": "Clasificar_Motivo", "motivo": "oferta_aceptada_venta"}}])
    salida.corre("sí acepto la venta", message_id="SM4")
    assert ("conversation.outcome", "oferta_aceptada_venta") in _tipos(salida)


def test_opt_out_avisa_el_cierre(salida):
    salida.corre("hola", message_id="SM4")
    salida.eventos.clear()
    salida.corre("stop", message_id="SM5")
    assert _tipos(salida) == [("conversation.closed", None)]


def test_conversacion_que_no_abrio_valuacion_no_manda_eventos(env, monkeypatch):
    import importlib
    from modules import valuacion
    importlib.reload(valuacion)
    from core import contrato_salida
    llamadas = []
    contrato_salida.configure(lambda accion, params: llamadas.append(params) or {})
    try:
        env.corre("hola")
    finally:
        contrato_salida.configure(None)
    assert llamadas == []


def test_destino_caido_no_deshace_el_turno_y_queda_en_bitacora(salida, caplog):
    import logging
    salida.responde = RuntimeError("timeout")
    with caplog.at_level(logging.INFO):
        salida.corre("hola", message_id="SM6")
    assert salida.enviados                                                # el cliente sí recibió su respuesta
    assert "turno.evento_error" in "\n".join(r.getMessage() for r in caplog.records)
    fallo = salida.base.bitacora[-1]
    assert fallo["accion"] == "evento_salida_fallido" and fallo["datos"]["evento"]["idEvento"] == "replied-c1-SM6"


def test_destino_que_rechaza_queda_en_bitacora(salida):
    salida.responde = ErrorHub("ERROR_INTERNO", "falló")
    salida.corre("hola", message_id="SM7")
    assert salida.base.bitacora[-1]["datos"]["codigo"] == "ERROR_INTERNO"
