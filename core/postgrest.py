"""Único cliente del backend hacia PostgreSQL (DISENO_BACKEND_AWS.md §4.2, DISENO_MIGRACION_POSTGRES.md §7).

Todas las lecturas y escrituras del hub, Valuación y Clientes pasan por aquí: una acción plpgsql por operación, con el
envelope de la convención `{ action, params }` y la respuesta `{ successful, info }` / `{ successful: false, errorCode,
errorMessage, info }`.

    info = postgrest.llama("Hub.obtieneOAbreConversacion", {"idNumero": ..., "telefonoCliente": ...})
    info = postgrest.llama("Hub.tomaConversacion", {"idConversacion": ...}, token=id_token_del_usuario)

Dos modos:
  - Sistema (sin token): PostgREST por la red interna (`URL_API_DB`), con `X-User-Email` de servicio. Es lo que usan el
    pipeline, los jobs y el contrato ①. Mismo patrón que las Lambdas de Valuación (toma-unidades-en-taller/index.mjs).
  - Usuario (con token): por el API Gateway (`API_GATEWAY_URL`), con el id_token de Google del usuario en
    `X-Id-Token`; el authorizer lo valida e inyecta su email. Lo usan las acciones del dashboard (Q21), para que plpgsql
    decida los permisos con el usuario real. Mismo contrato que `apps/web/src/lib/api.ts`.

Un rechazo de negocio (`successful: false`) y una falla de transporte se lanzan como `ErrorHub` con su código: el
llamador decide qué hacer. No hay reintentos automáticos: no todas las acciones son idempotentes.

Variables de entorno:
    URL_API_DB                  base de PostgREST para el modo sistema (con o sin "/" final)
    CLEBER_API_KEY              x-api-key del modo sistema (opcional si la ruta interna no la pide)
    API_GATEWAY_URL             base del API Gateway para el modo usuario
    API_GATEWAY_KEY             x-api-key del modo usuario
    API_GATEWAY_TOKEN_HEADER    header del id_token (default X-Id-Token; con Authorization va como Bearer)
"""
import json
import logging
import os
import re
from dataclasses import dataclass, field

from core import http

log = logging.getLogger(__name__)

EMAIL_SISTEMA = "sistema@hub-conversaciones.internal"
TIMEOUT = 15


@dataclass(frozen=True)
class Perfil:
    schema: str       # Content-Profile de PostgREST
    recurso: str      # ruta del API Gateway (modo usuario)


# Prefijo de la acción → schema y ruta. Cada ruta del gateway apunta a un schema fijo (GUIA_API_GATEWAY.md).
PERFILES = {
    "Hub": Perfil("hub_cleber", "hub-cleber"),
    "Valuacion": Perfil("valuacion", "toma-unidades"),
    "Clientes": Perfil("clientes", "clientes"),
}


@dataclass
class ErrorHub(Exception):
    """Respuesta fallida de una acción, o falla de transporte (SIN_CONEXION, SESION_EXPIRADA, CONFIGURACION, HTTP_xxx)."""
    codigo: str
    mensaje: str = ""
    info: dict | None = field(default=None)
    accion: str = ""

    def __post_init__(self):
        super().__init__(f"{self.accion}: {self.codigo} {self.mensaje}".strip())

    @property
    def motivo(self) -> str | None:
        """info.motivo de los ESTADO_INVALIDO (p. ej. CONVERSACION_ABIERTA)."""
        return (self.info or {}).get("motivo") if isinstance(self.info, dict) else None


def funcion_de(accion: str) -> str:
    """'Hub.obtieneOAbreConversacion' → 'obtiene_o_abre_conversacion' (nombre de la función en PostgREST)."""
    _, _, nombre = accion.partition(".")
    if not nombre:
        raise ValueError(f"acción sin prefijo: {accion!r}")
    return re.sub(r"([A-Z])", r"_\1", nombre).lower()


def perfil_de(accion: str) -> Perfil:
    prefijo = accion.partition(".")[0]
    try:
        return PERFILES[prefijo]
    except KeyError:
        raise ValueError(f"prefijo de acción desconocido: {prefijo!r}") from None


def _base(nombre: str) -> str:
    valor = (os.environ.get(nombre) or "").strip()
    if not valor:
        raise ErrorHub("CONFIGURACION", f"Falta la variable {nombre}")
    return valor.rstrip("/")


def _peticion(accion: str, token: str | None) -> tuple[str, dict]:
    """URL y headers de la llamada según el modo."""
    perfil, funcion = perfil_de(accion), funcion_de(accion)
    headers = {"Content-Type": "application/json", "Prefer": "params=single-object"}
    if token is None:
        url = f"{_base('URL_API_DB')}/rpc/{funcion}"
        headers["Content-Profile"] = perfil.schema
        headers["X-User-Email"] = EMAIL_SISTEMA
        if os.environ.get("CLEBER_API_KEY"):
            headers["x-api-key"] = os.environ["CLEBER_API_KEY"]
        return url, headers

    if not token:
        raise ErrorHub("SESION_EXPIRADA", "Falta el token del usuario", accion=accion)
    clave = (os.environ.get("API_GATEWAY_KEY") or "").strip()
    if not clave:
        raise ErrorHub("CONFIGURACION", "Falta la variable API_GATEWAY_KEY", accion=accion)
    url = f"{_base('API_GATEWAY_URL')}/{perfil.recurso}/rpc/{funcion}"
    header_token = os.environ.get("API_GATEWAY_TOKEN_HEADER") or "X-Id-Token"
    headers["x-api-key"] = clave
    # El schema lo fija la ruta del gateway; el email lo inyecta el authorizer desde el token
    headers[header_token] = f"Bearer {token}" if header_token.lower() == "authorization" else token
    return url, headers


def respuesta(accion: str, params: dict | None = None, *, token: str | None = None, timeout: int = TIMEOUT) -> dict:
    """Respuesta completa de la acción (`successful`, `info`, `errorCode`...). Lanza ErrorHub solo por transporte."""
    try:
        url, headers = _peticion(accion, token)
    except ErrorHub as e:
        e.accion = e.accion or accion
        raise
    cuerpo = json.dumps({"action": accion, "params": params or {}}, ensure_ascii=False, default=str).encode("utf-8")
    try:
        _, texto = http.request(url, data=cuerpo, headers=headers, method="POST", timeout=timeout)
    except http.HTTPError as e:
        detalle = ""
        try:
            detalle = e.read().decode("utf-8")[:500]
        except Exception:
            pass
        if e.code == 401:
            raise ErrorHub("SESION_EXPIRADA", "El token del usuario no es válido o expiró", accion=accion) from None
        if e.code == 403:
            log.error("postgrest %s: 403 (API key o ruta) %s", accion, detalle)
            raise ErrorHub("CONFIGURACION", "El gateway rechazó la llamada (API key o ruta)", accion=accion) from None
        log.error("postgrest %s: HTTP %s %s", accion, e.code, detalle)
        raise ErrorHub(f"HTTP_{e.code}", detalle or f"Error HTTP {e.code}", accion=accion) from None
    except OSError as e:  # URLError, timeout, conexión rechazada
        log.error("postgrest %s: sin respuesta (%s)", accion, e)
        raise ErrorHub("SIN_CONEXION", str(e), accion=accion) from None
    try:
        datos = json.loads(texto)
    except ValueError:
        raise ErrorHub("RESPUESTA_INVALIDA", texto[:500], accion=accion) from None
    if not isinstance(datos, dict) or "successful" not in datos:
        raise ErrorHub("RESPUESTA_INVALIDA", texto[:500], accion=accion)
    return datos


def llama(accion: str, params: dict | None = None, *, token: str | None = None, timeout: int = TIMEOUT) -> dict:
    """`info` de la acción. Una respuesta fallida se lanza como ErrorHub con su errorCode, errorMessage e info."""
    datos = respuesta(accion, params, token=token, timeout=timeout)
    if not datos.get("successful"):
        raise ErrorHub(datos.get("errorCode") or "ERROR_DESCONOCIDO", datos.get("errorMessage") or "",
                       datos.get("info") if isinstance(datos.get("info"), dict) else None, accion)
    return datos.get("info") or {}
