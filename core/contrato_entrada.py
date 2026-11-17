"""Contrato ①: otro sistema abre una conversación con un cliente (DISENO_BACKEND_AWS.md §5).

Lo llama, por ejemplo, la Lambda de Valuación al enviar una oferta (`TomaUnidades.enviaOferta`, acciones-valuacion.md §6.1).
El núcleo no sabe de ofertas: lo propio de cada fuente (qué plantilla, con qué variables, qué contexto para el bot) lo pone el
módulo que la registra (`modules/valuacion.py` registra "valuacion").

    Petición:  { "action": "Hub.abreConversacion", "params": { fuente, idExterno, idMarca, modulo, telefono,
                                                               nombreCliente?, claveCliente?, contexto? } }
    Respuesta: envelope de la convención
               { successful: true,  info: { idConversacion, creada, enviada, idMensajeProveedor } }
               { successful: false, errorCode, errorMessage, info? }

Pasos:
  1. Número del módulo en la marca (Hub.resuelveNumero) y conversación (Hub.abreConversacionExterna, idempotente por
     fuente + idExterno; ESTADO_INVALIDO con motivo CONVERSACION_ABIERTA o SIN_NUMERO pasa tal cual a quien llama).
  2. Si esa conversación ya tiene el envío registrado (metadatos.envio), se regresa sin volver a mandar nada.
  3. El módulo prepara el envío. El <<CONTEXTO>> para el bot se guarda como mensaje de sistema (una vez).
  4. Plantilla por el proveedor del número (outbound.send_campaign: un destinatario). Si el proveedor la rechaza:
     ERROR_PROVEEDOR; la conversación queda abierta sin envío y un reintento la reutiliza.
  5. Mensaje de la plantilla en la conversación, metadatos.envio y aviso de tiempo real.

Pruebas: con TELEFONO_PRUEBAS definida (solo en dev), todas las conversaciones se abren y se envían a ese teléfono en lugar
del del cliente; el original queda en metadatos.contexto.telefonoOriginal. En producción no se define.

Errores propios: CAMPO_REQUERIDO, FUENTE_DESCONOCIDA, PLANTILLA_NO_CONFIGURADA, ERROR_PROVEEDOR, ERROR_INTERNO.
Los de hub_cleber (ErrorHub) pasan con su código e info.
"""
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

from core import outbound, postgrest, tiempo_real
from core.datos import numeros
from core.postgrest import ErrorHub
from crm import salesforce

log = logging.getLogger(__name__)

ACCION = "Hub.abreConversacion"
REQUERIDOS = ("fuente", "idExterno", "idMarca", "modulo", "telefono")


@dataclass
class Envio:
    """Lo que el módulo decide para la primera plantilla.

    plantilla: la definición que entiende outbound.send_campaign (`templateName`, `templateLanguage`, `templateComponents`
               para Meta; `contentSid` para Twilio; `valuetextObjectApi` para ValueText).
    variables: {"1": "...", "2": "..."} de la plantilla.
    texto:     cómo se ve en el chat del dashboard (la plantilla ya con sus variables).
    contexto_bot: <<CONTEXTO>> que el bot recibe con el historial cuando el cliente conteste (None: sin contexto).
    """
    plantilla: dict
    variables: dict = field(default_factory=dict)
    texto: str = ""
    contexto_bot: str | None = None


class SinPlantilla(Exception):
    """El número no tiene configurada la plantilla que la fuente necesita."""


# fuente → preparar(conversacion, numero, contexto) -> Envio
Preparador = Callable[[dict, dict, dict], Envio]
_FUENTES: dict[str, Preparador] = {}


def registra_fuente(fuente: str, preparar: Preparador) -> None:
    _FUENTES[fuente] = preparar


def fuentes() -> list[str]:
    return sorted(_FUENTES)


def _exito(info: dict) -> dict:
    return {"successful": True, "info": info}


def _falla(codigo: str, mensaje: str, info: dict | None = None) -> dict:
    respuesta = {"successful": False, "errorCode": codigo, "errorMessage": mensaje}
    if info:
        respuesta["info"] = info
    return respuesta


def maneja(cuerpo: dict | None) -> dict:
    """Atiende una petición del contrato ①. Nunca lanza: regresa el envelope."""
    if not isinstance(cuerpo, dict) or cuerpo.get("action") != ACCION or not isinstance(cuerpo.get("params"), dict):
        return _falla("PETICION_INVALIDA", f"Se esperaba {{ action: {ACCION}, params }}")
    params = cuerpo["params"]
    for campo in REQUERIDOS:
        if not str(params.get(campo) or "").strip():
            return _falla("CAMPO_REQUERIDO", f"Falta el campo {campo}", {"campo": campo})
    fuente = str(params["fuente"]).strip().lower()
    preparar = _FUENTES.get(fuente)
    if preparar is None:
        return _falla("FUENTE_DESCONOCIDA", f"La fuente {fuente!r} no está registrada", {"fuentes": fuentes()})
    try:
        return _exito(_abre(fuente, preparar, params))
    except ErrorHub as e:
        return _falla(e.codigo, e.mensaje, e.info)
    except SinPlantilla as e:
        return _falla("PLANTILLA_NO_CONFIGURADA", str(e))
    except outbound.TemplateError as e:
        codigo = "PLANTILLA_NO_CONFIGURADA" if e.kind == outbound.NOT_CONFIGURED else "ERROR_PROVEEDOR"
        return _falla(codigo, e.message)
    except Exception:
        log.exception("contrato ①: error inesperado (%s %s)", fuente, params.get("idExterno"))
        return _falla("ERROR_INTERNO", "Error inesperado al abrir la conversación")


def _telefono_destino(params: dict) -> tuple[str, dict]:
    """Teléfono al que se abre y se envía, y el contexto (con el teléfono original si se redirigió a TELEFONO_PRUEBAS)."""
    contexto = dict(params.get("contexto") or {})
    pruebas = (os.environ.get("TELEFONO_PRUEBAS") or "").strip()
    if not pruebas:
        return params["telefono"], contexto
    log.warning("contrato ①: TELEFONO_PRUEBAS activo; %s %s se envía a %s en lugar de %s",
                params.get("fuente"), params.get("idExterno"), pruebas, params["telefono"])
    return pruebas, {**contexto, "telefonoOriginal": params["telefono"]}


def _abre(fuente: str, preparar: Preparador, params: dict) -> dict:
    telefono, contexto = _telefono_destino(params)
    try:
        resuelto = numeros.resuelve(id_marca=params["idMarca"], modulo=params["modulo"])
    except ErrorHub as e:
        if e.codigo != "RECURSO_NO_ENCONTRADO":
            raise
        # Mismo código que daría Hub.abreConversacionExterna: el módulo no tiene número activo en la marca
        raise ErrorHub("ESTADO_INVALIDO", f"El módulo {params['modulo']} no tiene número activo en la marca {params['idMarca']}",
                       {"motivo": "SIN_NUMERO", "idMarca": params["idMarca"], "modulo": params["modulo"]}) from None
    abierta = postgrest.llama("Hub.abreConversacionExterna", {
        "fuente": fuente, "idExterno": str(params["idExterno"]), "idMarca": params["idMarca"], "modulo": params["modulo"],
        "telefono": telefono, "nombreCliente": params.get("nombreCliente"), "claveCliente": params.get("claveCliente"),
        "contexto": contexto,
    })
    conv, creada = abierta["conversacion"], abierta["creada"]
    envio_previo = (conv.get("metadatos") or {}).get("envio")
    if envio_previo:
        return {"idConversacion": conv["idConversacion"], "creada": False, "enviada": True,
                "idMensajeProveedor": envio_previo.get("idMensajeProveedor")}

    numero_hub = abierta.get("numero") or resuelto["numero"]
    envio = preparar(conv, numero_hub, contexto)

    if envio.contexto_bot and not (conv.get("metadatos") or {}).get("contextoGuardado"):
        postgrest.llama("Hub.guardaMensaje", {"idConversacion": conv["idConversacion"], "remitente": "system", "texto": envio.contexto_bot})
        conv = postgrest.llama("Hub.actualizaConversacion", {"idConversacion": conv["idConversacion"],
                                                            "metadatos": {"contextoGuardado": True}})["conversacion"]

    numero = numeros.para_canal(numero_hub)
    sf_config = salesforce.resolve_config((resuelto.get("marca") or {}).get("salesforceConfig"), numero_hub.get("modulo")) \
        if numero.get("provider") == "valuetext" else None
    id_proveedor = outbound.send_campaign(numero, envio.plantilla, {"variables": envio.variables}, conv["telefonoCliente"],
                                          sf_config=sf_config, track=True)

    # Lo que se ve en el chat: el texto capturado en el número; si no hay, el de la plantilla del proveedor (lo que le llegó
    # al cliente, con sus variables y botones); si tampoco se puede leer, un marcador
    texto = (envio.texto or outbound.render_template(numero, envio.plantilla, envio.variables)
             or f"[Plantilla: {envio.plantilla.get('templateName') or envio.plantilla.get('contentSid')}]")
    guardado = postgrest.llama("Hub.guardaMensaje", {
        "idConversacion": conv["idConversacion"], "remitente": "bot", "esPlantilla": True,
        "texto": texto,
        "idMensajeProveedor": id_proveedor,
    })
    conv = postgrest.llama("Hub.actualizaConversacion", {
        "idConversacion": conv["idConversacion"],
        "metadatos": {"envio": {"idMensajeProveedor": id_proveedor, "idMensaje": guardado["mensaje"]["idMensaje"],
                                "enviadoEn": datetime.now(timezone.utc).isoformat()}},
    })["conversacion"]
    postgrest.llama("Hub.registraBitacora", {"idConversacion": conv["idConversacion"], "accion": "envio_plantilla",
                                             "origen": "sistema", "datos": {"fuente": fuente, "idExterno": str(params["idExterno"]),
                                                                            "idMensajeProveedor": id_proveedor}})
    tiempo_real.conversacion(conv)
    return {"idConversacion": conv["idConversacion"], "creada": creada, "enviada": True, "idMensajeProveedor": id_proveedor}
