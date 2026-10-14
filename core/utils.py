"""Utilidades puras del núcleo: sin Firestore, sin red."""
import re
from datetime import datetime, timezone


def normalize_phone(phone: str) -> str:
    """Normaliza número de teléfono para usar como ID."""
    return "".join(c for c in phone if c.isdigit() or c == "+")


def normalize_mx_phone(phone: str) -> str:
    """Normaliza números mexicanos al formato estándar sin el '1' legacy.

    México eliminó el prefijo '1' para móviles en 2019. WhatsApp/Twilio aún envían
    +521XXXXXXXXXX (13 dígitos), pero ValueText/Salesforce usan +52XXXXXXXXXX (12 dígitos).

        whatsapp:+5218186019229 -> whatsapp:+528186019229
        +5218186019229          -> +528186019229
        whatsapp:+528186019229  -> sin cambio
        whatsapp:+14155551234   -> sin cambio (no es MX)
    """
    normalized = re.sub(r"(whatsapp:\+52)1(\d{10})$", r"\1\2", phone)
    if normalized != phone:
        return normalized
    return re.sub(r"^(\+52)1(\d{10})$", r"\1\2", phone)


def phone_variants(phone: str) -> list[str]:
    """Formas del mismo teléfono a buscar: el recibido, y su par legacy +521 / moderno +52."""
    variants = [phone]
    legacy = re.sub(r"(whatsapp:\+52)(\d{10})$", r"\g<1>1\2", phone)
    if legacy != phone:
        variants.append(legacy)
    modern = normalize_mx_phone(phone)
    if modern != phone and modern not in variants:
        variants.append(modern)
    return variants


def as_utc(value) -> datetime | None:
    """Convierte un timestamp de Firestore (o datetime) a datetime con zona UTC."""
    if value is None:
        return None
    if hasattr(value, "timestamp"):
        return datetime.fromtimestamp(value.timestamp(), tz=timezone.utc)
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def hours_since(value, now: datetime | None = None) -> float | None:
    when = as_utc(value)
    if when is None:
        return None
    return ((now or datetime.now(timezone.utc)) - when).total_seconds() / 3600
