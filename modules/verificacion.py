"""Módulo Verificación: confirma con el cliente que su número de WhatsApp es el correcto (PLAN_MODULO_VERIFICACION.md).

Salesforce pide la verificación por el contrato ① (core/contrato_entrada.py, fuente "verificacion"):

    { fuente: "verificacion", idExterno: <ID opaco de SF>, idMarca, modulo: "verificacion", telefono, alCliente | telefonoDestino }

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
"""
import logging

from core import postgrest
from core.contrato_entrada import Envio, SinPlantilla, registra_fuente
from core.datos import conversaciones
from core.tools import tool

log = logging.getLogger(__name__)

FUENTE = "verificacion"
MODULO = "verificacion"
LLAVE_PLANTILLA = "verificacionTelefono"
ACCION_BOT = "Verificar_Telefono"
EVENTO = "verificar_telefono"
RESULTADOS = {True: "valido", False: "no_valido"}


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
    if turn.conv.get("estado") != "closed":
        turn.refresca(conversaciones.actualiza(turn.conv_id, estado="closed", resultado=verificacion["estado"]))
