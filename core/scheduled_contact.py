"""Contacto programado: el cliente pide que lo recontacten a cierta hora (tarea 1.19).

Es genérico, no de Ventas: cualquier módulo puede agendar un recordatorio, así que vive en el
núcleo. El job que lo ejecuta (`jobs/`) lee `scheduledContactAt`. La zona horaria sale de la
organización (`settings.timezone`), no de un offset fijo.
"""
import logging
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from google.cloud import firestore

from contracts.actions import DATOS_INVALIDOS, ActionResponse
from core.db import get_db

log = logging.getLogger(__name__)
DEFAULT_TIMEZONE = "America/Mexico_City"


def org_timezone(org_id: str | None, db=None) -> str:
    """Zona horaria de la organización (`settings.timezone`), o la de México por defecto."""
    if org_id:
        doc = (db or get_db()).collection("organizations").document(org_id).get()
        if doc.exists:
            name = (doc.to_dict().get("settings") or {}).get("timezone")
            if name:
                return name
    return DEFAULT_TIMEZONE


def local_to_utc(naive_or_aware: datetime, timezone_name: str) -> datetime:
    """Interpreta una fecha sin zona en la zona de la organización y la devuelve en UTC."""
    dt = naive_or_aware if naive_or_aware.tzinfo else naive_or_aware.replace(tzinfo=ZoneInfo(timezone_name))
    return dt.astimezone(timezone.utc)


def parse_scheduled_contact_time(value: str, timezone_name: str = DEFAULT_TIMEZONE) -> datetime | None:
    """Fecha y hora ISO que manda el bot (en la zona de la organización) -> datetime UTC para Firestore."""
    try:
        return local_to_utc(datetime.fromisoformat(value), timezone_name)
    except Exception as e:
        log.warning("hora de contacto programado inválida %r: %s", value, e)
        return None


def clear_scheduled_contact(conv_id: str, db=None) -> None:
    """Quita el recontacto programado (el cliente respondió o el bot lo canceló)."""
    try:
        (db or get_db()).collection("conversations").document(conv_id).update({
            "scheduledContactAt": firestore.DELETE_FIELD, "scheduledContactSavedAt": firestore.DELETE_FIELD,
        })
    except Exception as e:
        log.error("Error quitando el contacto programado de %s: %s", conv_id, e)


def _agendar(conv_data: dict, params: dict) -> ActionResponse:
    turn = params["turn"]
    when = parse_scheduled_contact_time((params.get("input") or {}).get("fecha_hora", "").strip(), org_timezone(turn.org_id, turn.db))
    if not when:
        return ActionResponse.failure(DATOS_INVALIDOS, "No se entendió la fecha y hora del recordatorio: pide al cliente que la repita")
    turn.fire(turn.db.collection("conversations").document(turn.conv_id).update,
              {"scheduledContactAt": when, "scheduledContactSavedAt": firestore.SERVER_TIMESTAMP})
    return ActionResponse.success({"programado_para": when.isoformat()})


def _cancelar(conv_data: dict, params: dict) -> None:
    turn = params["turn"]
    turn.fire(clear_scheduled_contact, turn.conv_id, turn.db)


def _cliente_respondio(conv_data: dict, params: dict) -> None:
    """El cliente escribió: un recontacto programado ya no tiene sentido."""
    if conv_data.get("scheduledContactAt"):
        turn = params["turn"]
        turn.fire(clear_scheduled_contact, turn.conv_id, turn.db)


DEFAULT_HANDLERS = {
    "agendar_recordatorio": _agendar,
    "cancelar_recordatorio": _cancelar,
    "customer_replied": _cliente_respondio,
}
