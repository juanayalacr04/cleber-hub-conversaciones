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

from core.contrato_entrada import Envio, SinPlantilla, registra_fuente

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
