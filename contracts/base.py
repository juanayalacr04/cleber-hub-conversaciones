"""Base común de los contratos entre las tres funciones (tarea 1.33).

Sin dependencias del resto del repo: el router, las reglas y el bot importan este paquete y
ninguno importa del otro. Cada contrato es un dataclass con `to_dict` / `from_dict`; `from_dict`
valida y lanza `ContractError` ante un mensaje mal formado.

`schemaVersion` viaja en todo mensaje que cruza una cola o una llamada HTTP: con un redeploy de dos
funciones, hay mensajes en vuelo escritos con la versión anterior.
"""
from typing import Any

SCHEMA_VERSION = 1


class ContractError(ValueError):
    """El mensaje no cumple el contrato (campo faltante, tipo incorrecto o versión no soportada)."""


def check_version(data: dict) -> None:
    version = data.get("schemaVersion", SCHEMA_VERSION)
    if version != SCHEMA_VERSION:
        raise ContractError(f"schemaVersion {version!r} no soportada (se esperaba {SCHEMA_VERSION})")


def as_dict(data: Any, name: str) -> dict:
    if not isinstance(data, dict):
        raise ContractError(f"{name}: se esperaba un objeto, llegó {type(data).__name__}")
    return data


def required(data: dict, key: str, kind: type | tuple = str, name: str = "") -> Any:
    value = data.get(key)
    if value is None or (kind is str and value == ""):
        raise ContractError(f"{name or 'mensaje'}: falta {key!r}")
    if not isinstance(value, kind):
        raise ContractError(f"{name or 'mensaje'}: {key!r} debe ser {kind}")
    return value


def optional(data: dict, key: str, kind: type | tuple, default: Any, name: str = "") -> Any:
    value = data.get(key)
    if value is None:
        return default
    if not isinstance(value, kind):
        raise ContractError(f"{name or 'mensaje'}: {key!r} debe ser {kind}")
    return value


def one_of(value: str, options: tuple, key: str, name: str) -> str:
    if value not in options:
        raise ContractError(f"{name}: {key!r} desconocido: {value!r}")
    return value


def digits(value: str) -> str:
    return "".join(c for c in (value or "") if c.isdigit())
