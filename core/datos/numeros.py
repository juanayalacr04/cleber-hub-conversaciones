"""Números de WhatsApp en hub_cleber (Hub.resuelveNumero) y su forma para los canales.

    info = numeros.resuelve(id_marca="TO", modulo="valuacion")      # { numero, botDefault, equipo, marca }; caché 60 s
    numero = numeros.para_canal(info["numero"])                      # dict con la forma que esperan channels/ y las credenciales

Los canales (channels/twilio_wa.py, meta_wa.py, valuetext_wa.py, campaign_templates.py) nacieron leyendo el documento de
Firestore (`phoneNumber`, `provider`, `twilioAccountSid`, `metaPhoneNumberId`...). `para_canal` traduce la fila de hub_cleber
a esa forma para no tocarlos; las credenciales se agregan desde el almacén (core/credentials.py, tipo "numbers").
"""
import time

from core import credentials, postgrest

TTL = 60
_cache: dict[tuple, dict] = {}


def clear_cache() -> None:
    _cache.clear()


def resuelve(*, telefono: str | None = None, meta_phone_number_id: str | None = None,
             id_marca: str | None = None, modulo: str | None = None, use_cache: bool = True) -> dict:
    """Hub.resuelveNumero con caché por criterio. Lanza ErrorHub (RECURSO_NO_ENCONTRADO si no hay número activo)."""
    if telefono:
        params = {"telefono": telefono}
    elif meta_phone_number_id:
        params = {"metaPhoneNumberId": meta_phone_number_id}
    else:
        params = {"idMarca": id_marca, "modulo": modulo}
    clave = tuple(sorted(params.items()))
    guardado = _cache.get(clave)
    if use_cache and guardado and time.time() < guardado["expira"]:
        return guardado["info"]
    info = postgrest.llama("Hub.resuelveNumero", params)
    _cache[clave] = {"info": info, "expira": time.time() + TTL}
    return info


def para_canal(numero: dict) -> dict:
    """Número de hub_cleber (objeto Numero) con la forma del documento de Firestore que usan los canales."""
    config = numero.get("configProveedor") or {}
    proveedor = numero.get("proveedor") or "twilio"
    telefono = numero.get("telefono") or ""
    plano = {
        "id": numero.get("idNumero"),
        "organizationId": numero.get("idMarca"),
        "vertical": numero.get("modulo"),
        "provider": proveedor,
        # Twilio manda desde "whatsapp:+52..."; Meta y ValueText usan sus propios ids
        "phoneNumber": f"whatsapp:{telefono}" if proveedor == "twilio" and telefono else telefono,
        "teamId": numero.get("idEquipo"),
        "defaultBotId": numero.get("idBotDefault"),
        "reopenWindowHours": numero.get("ventanaReaperturaHoras"),
        "closeWebhookUrl": numero.get("webhookCierreUrl"),
        "status": "active" if numero.get("esActivo", True) else "inactive",
        "twilioAccountSid": config.get("twilioAccountSid"),
        "metaPhoneNumberId": config.get("metaPhoneNumberId"),
        "valuetextSenderId": config.get("valuetextSenderId"),
        "plantillas": numero.get("plantillas") or {},
    }
    plano = {k: v for k, v in plano.items() if v is not None}
    return credentials.reveal(None, "numbers", plano.get("id"), plano)
