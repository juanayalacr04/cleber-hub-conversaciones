"""Módulo Valuación: lo propio de las conversaciones de ofertas de compra (DISENO_BACKEND_AWS.md §5).

Registra la fuente "valuacion" del contrato ① (core/contrato_entrada.py). La Lambda de Valuación manda el `contexto` que
regresa `Valuacion.solicitaEnvio` (acciones-valuacion.md §6.2):

    { nombreCliente, vehiculo, kilometraje, montoOferta, agencia, fechaCita, horaCita }

La plantilla se configura en el número de Valuación de la marca, `plantillas.ofertaValuacion` (Hub.guardaNumero):

    {
      "templateName": "oferta_compra",          Meta y ValueText (nombre o id de la plantilla aprobada)
      "templateLanguage": "es_MX",              Meta (default es)
      "templateComponents": [...],              Meta, opcional: sin él se arma el body con las variables
      "contentSid": "HX...",                    Twilio
      "valuetextObjectApi": "...",              ValueText, opcional
      "variables": ["nombreCliente", "vehiculo", "montoOferta"],   orden de {{1}}, {{2}}, ... (llaves del contexto)
      "texto": "Hola {{1}}, por tu {{2}} te ofrecemos {{3}}..."    cómo se ve en el chat (opcional)
    }

Sin esa configuración el envío falla con PLANTILLA_NO_CONFIGURADA (y la oferta queda FALLIDO, reintentable).
"""
import re

from core import contrato_salida as salida
from core.contrato_entrada import Envio, SinPlantilla, registra_fuente
from core.tools import tool

FUENTE = "valuacion"
LLAVE_PLANTILLA = "ofertaValuacion"


def _monto(valor) -> str:
    try:
        numero = float(valor)
    except (TypeError, ValueError):
        return str(valor or "")
    return f"${numero:,.0f}" if numero == int(numero) else f"${numero:,.2f}"


def _kilometraje(valor) -> str:
    try:
        return f"{int(float(valor)):,} km"
    except (TypeError, ValueError):
        return str(valor or "")


def _fecha(valor) -> str:
    """2026-11-12 → 12/11/2026 (las fechas de la cita son locales de México, sin zona)."""
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", str(valor or ""))
    return f"{m.group(3)}/{m.group(2)}/{m.group(1)}" if m else str(valor or "")


# Cómo se escribe cada dato del contexto en la plantilla y en el contexto del bot
FORMATOS = {"montoOferta": _monto, "kilometraje": _kilometraje, "fechaCita": _fecha}


def valor(contexto: dict, llave: str) -> str:
    formato = FORMATOS.get(llave, lambda v: "" if v is None else str(v))
    return formato(contexto.get(llave)).strip()


def contexto_bot(contexto: dict, id_oferta: str) -> str:
    """<<CONTEXTO>> que recibe el bot de Valuación cuando el cliente contesta la oferta."""
    partes = [
        ("Cliente", valor(contexto, "nombreCliente")),
        ("Vehículo", valor(contexto, "vehiculo")),
        ("Kilometraje", valor(contexto, "kilometraje")),
        ("Monto ofrecido", valor(contexto, "montoOferta")),
        ("Agencia", valor(contexto, "agencia")),
        ("Cita de servicio", " ".join(x for x in (valor(contexto, "fechaCita"), valor(contexto, "horaCita")) if x)),
        ("Id de oferta", id_oferta),
    ]
    datos = ". ".join(f"{titulo}: {texto}" for titulo, texto in partes if texto)
    return f"<<CONTEXTO>> Se le envió al cliente una oferta de compra de su vehículo. {datos}."


def prepara_oferta(conversacion: dict, numero: dict, contexto: dict) -> Envio:
    config = (numero.get("plantillas") or {}).get(LLAVE_PLANTILLA)
    if not isinstance(config, dict) or not (config.get("templateName") or config.get("contentSid")):
        raise SinPlantilla(f"El número {numero.get('telefono')} no tiene configurada la plantilla {LLAVE_PLANTILLA}")

    variables = {str(i): valor(contexto, llave) for i, llave in enumerate(config.get("variables") or [], start=1)}
    plantilla = {k: config[k] for k in ("templateName", "templateLanguage", "templateComponents", "contentSid", "valuetextObjectApi")
                 if config.get(k)}
    if variables and not plantilla.get("templateComponents"):
        plantilla["templateComponents"] = [{"type": "body", "parameters": [{"type": "text", "text": v} for v in variables.values()]}]

    texto = config.get("texto") or ""
    for indice, contenido in variables.items():
        texto = texto.replace("{{" + indice + "}}", contenido)

    return Envio(plantilla=plantilla, variables=variables, texto=texto,
                 contexto_bot=contexto_bot(contexto, str(conversacion.get("idExterno") or "")))


registra_fuente(FUENTE, prepara_oferta)


# --------------------------------------------------------------------------- contrato 3: eventos hacia Valuacion
# Los emite el pipeline de entrada (core/entrada_mensajes.py) y salen al terminar el turno, ya contestado el cliente. Valuacion
# decide que hace con cada uno (Valuacion.registraResultadoConversacion, acciones-valuacion.md 7.2):
#   conversation.replied  el cliente contesto la oferta (la primera vez) o pulso un boton (accion = ButtonPayload)
#   conversation.handoff  la conversacion paso a un asesor
#   conversation.outcome  el bot clasifico el resultado (accion = su vocabulario)
#   conversation.closed   se cerro (hoy: el cliente pidio no recibir mas mensajes)
# Solo de conversaciones abiertas por la fuente "valuacion". Se entregan llamando a la funcion de la base `valuacion` con la
# identidad del hub (sistema@hub-conversaciones.internal), que Valuacion debe autorizar en valuacion.exige_permiso(..., 'sistema').

V = FUENTE

salida.registra_destino(FUENTE, salida.Destino(accion="Valuacion.registraResultadoConversacion"))


def _encola(turn, conv_data: dict, tipo: str, sufijo: str, accion: str | None = None, **extra) -> None:
    """Agrega el evento a la salida del turno. No hace nada si la conversacion no es de la fuente, o no es el pipeline de AWS."""
    conv = getattr(turn, "conv", None)
    salidas = getattr(turn, "salida", None)
    if salidas is None or salida.fuente_de(conv) != FUENTE:
        return
    mensaje = turn.incoming
    carga = {"idConversacion": conv.get("idConversacion"), "idMarca": conv.get("idMarca"), "estado": conv.get("estado"),
             "idMensajeProveedor": mensaje.message_id, "recibidoEn": mensaje.received_at or None, **extra}
    salidas.append(salida.Evento(id_evento=f"{sufijo}-{conv.get('idConversacion')}-{mensaje.message_id}", tipo=tipo,
                                 accion=accion, carga={k: v for k, v in carga.items() if v is not None}))


@tool("first_customer_reply", vertical=V)
def _primera_respuesta(conv_data: dict, params: dict) -> None:
    turn = params["turn"]
    if turn.incoming.button_payload:
        return                                   # lo cubre customer_button: un solo evento por mensaje
    _encola(turn, conv_data, salida.RESPONDIO, "replied", texto=turn.incoming.body)


@tool("customer_button", vertical=V)
def _boton(conv_data: dict, params: dict) -> None:
    _encola(params["turn"], conv_data, salida.RESPONDIO, "button", accion=params.get("payload"),
            boton={"payload": params.get("payload"), "texto": params.get("text")})


@tool("handoff_applied", vertical=V)
def _handoff(conv_data: dict, params: dict) -> None:
    _encola(params["turn"], conv_data, salida.HANDOFF, "handoff", motivo=params.get("motivo"), disparador=params.get("trigger"))


@tool("outcome_classified", vertical=V)
def _resultado(conv_data: dict, params: dict) -> None:
    _encola(params["turn"], conv_data, salida.RESULTADO, "outcome", accion=params.get("motivo"))


@tool("opt_out", vertical=V)
def _opt_out(conv_data: dict, params: dict) -> None:
    if params.get("action") == "close":
        _encola(params["turn"], conv_data, salida.CERRADA, "closed", motivo="opt_out")
