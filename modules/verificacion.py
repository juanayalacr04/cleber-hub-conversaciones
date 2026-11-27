"""Módulo Verificación: confirma con el cliente que su número de WhatsApp es el correcto (PLAN_MODULO_VERIFICACION.md).

Salesforce pide la verificación con la acción "Hub.VerificarTelefono" (contrato ①, fuente "verificacion"):

    { "action": "Hub.VerificarTelefono", "params": {
        "idPeticion": "sf1234567890",     Requerido: ID de la solicitud en SF (idempotencia y acuse; idExterno del contrato)
        "idMarca": "HO",                  Requerido
        "idAgencia": 123,                 Requerido, entero
        "telefono": "8111849398",         Requerido
        "idClienteQuiter": "12345",       Opcional: cuenta de SF con la que se hace el PATCH del resultado
        "nombreAgencia": "Honda CLEBER",  Opcional
        "telefonoAsesor": "8112288816",   Opcional
        "nombreAsesor": "IVAN GARCIA"     Opcional
    } }

El traductor (`traduce_peticion_sf`) la convierte al contrato (fuente y modulo "verificacion", idExterno = idPeticion,
claveCliente = idClienteQuiter, destino siempre el teléfono del cliente) y los opcionales quedan en el contexto de la
conversación, visibles en el dashboard.

La plantilla no lleva datos del cliente: solo pide confirmar el número, con el botón "Confirmo". Se configura en el número de
Verificación de la marca, `plantillas.verificacionTelefono` (Hub.guardaNumero):

    {
      "templateName": "verificacion_telefono",   Meta y ValueText
      "templateLanguage": "es_MX",               Meta (default es)
      "templateComponents": [...],               Meta, opcional
      "contentSid": "HX...",                     Twilio
      "valuetextObjectApi": "...",               ValueText, opcional
      "texto": "¿Es correcto este número?..."    cómo se ve en el chat (opcional)
    }

Sin esa configuración el envío falla con PLANTILLA_NO_CONFIGURADA.

El bot de Abacus recibe el botón o el texto libre y devuelve la decisión. Un bot ChatLLM usa `Ejecutar_Accion_Externo`; un IA
Workflow devuelve en el segmento `action` el texto `result_confirmado` (valido true) o `result_declinado` (valido false)
(core/entrada_mensajes.py, DEFAULT_TOOLS). Contrato del tool:

    accion = "Verificar_Telefono", motivo = <valor fijo, no decide nada>, datos = {"valido": true | false}

`valido` debe ser un booleano real. Cualquier otra cosa (texto, falta el dato) se ignora: la verificación sigue pendiente y SF
conserva su estatus. Una decisión válida guarda el resultado (Hub.actualizaVerificacion) y cierra la conversación; la primera
decisión manda.

La entrega del resultado a SF se puede simular por marca (`marcas.simularCallbackSf`, Hub.guardaMarca): la verificación lo trae
en `simularCallback` y, cuando está encendido, no se llama a SF y el intento queda marcado como simulado (`callbackSimulado`),
para no confundirlo con una entrega real.
"""
import logging

from core import postgrest
from core.contrato_entrada import Envio, SinPlantilla, registra_accion, registra_fuente
from core.datos import conversaciones
from core.tools import tool
from crm import salesforce

log = logging.getLogger(__name__)

FUENTE = "verificacion"
MODULO = "verificacion"
LLAVE_PLANTILLA = "verificacionTelefono"
ACCION_BOT = "Verificar_Telefono"
ACCION_SF = "Hub.VerificarTelefono"
EVENTO = "verificar_telefono"
RESULTADOS = {True: "valido", False: "no_valido"}

# Campos opcionales del body de SF que viajan en el contexto de la conversación (visibles en el dashboard)
CAMPOS_CONTEXTO = ("nombreAgencia", "telefonoAsesor", "nombreAsesor")
REQUERIDOS_SF = ("idPeticion", "idMarca", "idAgencia", "telefono")


def traduce_peticion_sf(params: dict) -> dict:
    """Body de Salesforce → params del contrato ①. Puede lanzar ErrorHub (la petición se rechaza con ese código)."""
    faltan = [c for c in REQUERIDOS_SF if not str(params.get(c) or "").strip()]
    if faltan:
        raise postgrest.ErrorHub("CAMPO_REQUERIDO", f"Faltan los campos {', '.join(faltan)}", {"campos": faltan})
    if isinstance(params["idAgencia"], bool) or not isinstance(params["idAgencia"], int):
        raise postgrest.ErrorHub("CAMPO_INVALIDO", "idAgencia debe ser un entero", {"campo": "idAgencia"})
    contexto = {c: str(params[c]) for c in CAMPOS_CONTEXTO if str(params.get(c) or "").strip()}
    return {"fuente": FUENTE, "modulo": MODULO, "idExterno": str(params["idPeticion"]), "idMarca": str(params["idMarca"]),
            "idAgencia": str(params["idAgencia"]), "telefono": str(params["telefono"]), "alCliente": True,
            "claveCliente": str(params["idClienteQuiter"]) if str(params.get("idClienteQuiter") or "").strip() else None,
            "contexto": contexto}


def contexto_bot(id_externo: str) -> str:
    """<<CONTEXTO>> que recibe el bot cuando el cliente contesta la verificación."""
    return ("<<CONTEXTO>> Se le envió al cliente un mensaje para verificar que este número de WhatsApp es el correcto, con el botón "
            f"\"Confirmo\". Cuando quede claro si el número es o no el correcto, llama a {ACCION_BOT} con datos "
            "{\"valido\": true} o {\"valido\": false}." + (f" Id de verificación: {id_externo}." if id_externo else ""))


def prepara_verificacion(conversacion: dict, numero: dict, contexto: dict) -> Envio:
    config = (numero.get("plantillas") or {}).get(LLAVE_PLANTILLA)
    if not isinstance(config, dict) or not (config.get("templateName") or config.get("contentSid")):
        raise SinPlantilla(f"El número {numero.get('telefono')} no tiene configurada la plantilla {LLAVE_PLANTILLA}")
    plantilla = {k: config[k] for k in ("templateName", "templateLanguage", "templateComponents", "contentSid", "valuetextObjectApi")
                 if config.get(k)}
    return Envio(plantilla=plantilla, texto=config.get("texto") or "",
                 contexto_bot=contexto_bot(str(conversacion.get("idExterno") or "")))


def registra_solicitud(conversacion: dict, params: dict) -> None:
    """Deja la verificación registrada (idempotente por el ID de SF). El mismo ID con otro teléfono se rechaza (ErrorHub
    ESTADO_INVALIDO, motivo ID_CON_OTRO_VALOR). El dato verificado es el teléfono del cliente, aun si en pruebas se envía a otro."""
    postgrest.llama("Hub.registraVerificacion", {
        "idExterno": str(params["idExterno"]), "idMarca": params["idMarca"], "tipo": "telefono", "valor": params["telefono"],
        "idConversacion": conversacion["idConversacion"],
    })


registra_fuente(FUENTE, prepara_verificacion, registra_solicitud)
registra_accion(ACCION_SF, traduce_peticion_sf)


@tool(EVENTO, vertical=MODULO)
def _verificar_telefono(conv_data: dict, params: dict) -> None:
    turn = params["turn"]
    if conv_data.get("source") != FUENTE or not conv_data.get("externalId"):
        log.warning("%s en una conversación que no abrió la fuente %s: se ignora (conv=%s)", ACCION_BOT, FUENTE, turn.conv_id)
        return
    valido = (params.get("input") or {}).get("valido")
    if not isinstance(valido, bool):
        log.warning("%s sin un booleano en datos.valido (conv=%s, recibido=%r): se ignora, la verificación sigue pendiente",
                    ACCION_BOT, turn.conv_id, valido)
        return
    info = postgrest.llama("Hub.actualizaVerificacion", {"idExterno": str(conv_data["externalId"]), "valido": valido})
    verificacion = info["verificacion"]
    log.info("verificacion.resultado conv=%s id=%r estado=%r aplicada=%r", turn.conv_id, verificacion.get("idExterno"),
             verificacion.get("estado"), info.get("aplicada"))
    # El PATCH a SF va sobre la cuenta del cliente (idClienteQuiter, claveCliente de la conversación); si SF no lo mandó,
    # el ID de la petición conserva el comportamiento anterior
    id_cuenta = str(conv_data.get("claveCliente") or verificacion["idExterno"])
    if not conv_data.get("claveCliente"):
        log.warning("verificacion.sin_id_cliente conv=%s id=%r: el PATCH a SF usa el ID de la petición", turn.conv_id,
                    verificacion.get("idExterno"))
    _entrega_callback(verificacion, id_cuenta)
    if turn.conv.get("estado") != "closed":
        turn.refresca(conversaciones.actualiza(turn.conv_id, estado="closed", resultado=verificacion["estado"]))


def _entrega_callback(verificacion: dict, id_cuenta: str) -> None:
    """Avisa a SF el resultado y deja asentado el intento. Sin avisar si ya se entregó; si falló, se reintenta cuando el bot
    repite la acción. Nunca lanza: el turno del cliente no depende de SF."""
    if (verificacion.get("callback") or {}).get("estado") not in ("pendiente", "fallido"):
        return
    id_externo = str(verificacion["idExterno"])
    simular = bool(verificacion.get("simularCallback"))
    try:
        entregado, detalle = salesforce.actualiza_validacion_cuenta(id_cuenta, celular=verificacion["estado"] == RESULTADOS[True],
                                                                   simular=simular)
    except Exception as e:
        entregado, detalle = False, str(e)[:300]
    if not entregado:
        log.error("verificacion.callback_fallido id=%r detalle=%r", id_externo, detalle)
    try:
        postgrest.llama("Hub.registraCallbackVerificacion", {"idExterno": id_externo, "entregado": entregado,
                                                             **({} if entregado else {"error": detalle}),
                                                             **({"simulado": True} if simular else {})})
    except Exception:
        log.exception("no se pudo registrar el callback de la verificación %s", id_externo)
