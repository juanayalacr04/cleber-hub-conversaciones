"""Bots de hub_cleber en la forma que espera el motor (ai/engine.py) y los canales.

    bot = bots.para_motor(info["botDefault"], numeros.para_canal(info["numero"]))
    engine.send_to_bot(bot, mensajes, conv_id=...)

El motor y los canales nacieron leyendo el documento de Firestore del bot con la configuración de su número mezclada
(core/numbers.py::apply_channel_config). hub_cleber guarda la configuración del bot en `config` con esos mismos nombres
(abacusConfig, handoffConfig, scheduleConfig, tools, outcomeActions, optOutAction...), sin los tokens: esos viven en el
almacén de credenciales (Secrets Manager con SECRETOS_EN=aws) y se ponen aquí con credentials.reveal.

Abacus, en el secreto del ambiente (SECRET_NAME, core/entorno.py):
    ABACUS_DEPLOYMENT_TOKEN_<MODULO>   uno por módulo (VALUACION, VENTAS, SERVICIO); vale para todos sus bots y marcas
    ABACUS_API_KEY                     una por organización de Abacus: la comparten todos los módulos
Lo propio de cada bot es solo su `deploymentId`. Si un bot trae su propio secreto (hub/<ambiente>/bots/<idBot>), ese gana:
sirve para un bot que viva en otro proyecto de Abacus.
"""
import os

from core import credentials


def para_motor(bot: dict, numero: dict) -> dict:
    """Bot de hub_cleber (objeto Bot) + número en forma de canal (numeros.para_canal) → dict del motor."""
    config = dict(bot.get("config") or {})
    plano = {
        **config,
        "id": bot.get("idBot"),
        "name": bot.get("nombre"),
        "type": bot.get("tipo") or "chatllm",
        "organizationId": bot.get("idMarca"),
        "vertical": bot.get("modulo"),
        "status": "active" if bot.get("esActivo", True) else "inactive",
    }
    plano = credentials.reveal(None, "bots", plano["id"], plano)
    _token_del_modulo(plano)
    return {**plano, **canal(numero)}


def _token_del_modulo(bot: dict) -> None:
    """Completa abacusConfig con el token (y la llave) del módulo, salvo lo que el bot ya traiga."""
    modulo = (bot.get("vertical") or "").upper()
    abacus = dict(bot.get("abacusConfig") or {})
    for campo, variable in (("deploymentToken", "ABACUS_DEPLOYMENT_TOKEN_" + modulo), ("apiKey", "ABACUS_API_KEY")):
        valor = (os.environ.get(variable) or "").strip()
        if valor and not abacus.get(campo):
            abacus[campo] = valor
    if abacus:
        bot["abacusConfig"] = abacus


def canal(numero: dict) -> dict:
    """Campos del bot que dependen del número (core/numbers.py::CHANNEL_BOT_FIELDS)."""
    proveedor = numero.get("provider", "twilio")
    campos = {
        "provider": proveedor,
        "whatsappNumberId": numero.get("id"),
        "teamId": numero.get("teamId"),
        "reopenWindowHours": numero.get("reopenWindowHours"),
        "closeWebhookUrl": numero.get("closeWebhookUrl"),
    }
    if proveedor == "twilio":
        campos["twilioConfig"] = {"phoneNumber": numero.get("phoneNumber"), "accountSid": numero.get("twilioAccountSid"),
                                  "authToken": numero.get("twilioAuthToken")}
    elif proveedor == "meta":
        campos["metaPhoneNumberId"] = numero.get("metaPhoneNumberId", "")
        campos["metaAccessToken"] = numero.get("metaAccessToken", "")
    elif proveedor == "valuetext":
        campos["valuetextSenderId"] = numero.get("valuetextSenderId", "")
    return {k: v for k, v in campos.items() if v is not None}
