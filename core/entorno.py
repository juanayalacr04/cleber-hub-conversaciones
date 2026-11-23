"""Secretos del ambiente al arrancar una Lambda (mismo patrón que toma-unidades-en-taller/index.mjs, `cargaSecrets`).

`SECRET_NAME` es un secreto de Secrets Manager con un JSON plano `{ "CLEBER_API_KEY": "...", "META_APP_SECRET": "...", ... }`;
cada llave se copia a os.environ si no está ya definida (lo que se pone en la configuración de la Lambda gana). Se carga una vez
por instancia. Sin `SECRET_NAME` no hace nada (pruebas y desarrollo local).

Las credenciales de cada número y bot NO van aquí: van una por secreto (core/credentials.py, SECRETOS_EN=aws).
"""
import json
import logging
import os

log = logging.getLogger(__name__)

_cargado = False


def carga_secretos(cliente=None) -> None:
    global _cargado
    nombre = (os.environ.get("SECRET_NAME") or "").strip()
    if _cargado or not nombre:
        return
    if cliente is None:
        import boto3
        cliente = boto3.client("secretsmanager")
    try:
        valores = json.loads(cliente.get_secret_value(SecretId=nombre).get("SecretString") or "{}")
    except Exception as e:
        raise RuntimeError(f"No se pudieron cargar los secretos ({nombre}): {e}") from e
    for llave, valor in (valores or {}).items():
        if valor not in (None, "") and not os.environ.get(llave):
            os.environ[llave] = str(valor)
    _cargado = True


def reinicia() -> None:
    """Para pruebas."""
    global _cargado
    _cargado = False
