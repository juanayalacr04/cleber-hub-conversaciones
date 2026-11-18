"""Acciones del dashboard que atiende el backend del hub en AWS (DISENO_BACKEND_AWS.md §3, hub-acciones-usuario).

Son las que no pueden ser solo plpgsql porque tocan algo externo (el proveedor de WhatsApp, Secrets Manager...). Llegan por
API Gateway con el authorizer de Google: el email del usuario viene en el contexto del authorizer (confiable) y los permisos
se deciden en hub_cleber (Hub.consultaPermisosUsuario), con las mismas reglas que las acciones Hub.*.

    Petición:  { "action": "Hub.consultaPlantillaProveedor", "params": { ... } }
    Respuesta: envelope de la convención ({ successful, info } / { successful: false, errorCode, errorMessage, info? })

Acciones:
    Hub.consultaPlantillaProveedor   administrador del módulo en la marca del número
        params: idMarca, modulo, idPlantilla (Content SID en Twilio)
        info:   { nombre, idioma, tipo, cuerpo, botones: [{ titulo, id }], variables: ["1", "2", ...] }
        Lee la plantilla de Twilio con la cuenta del ambiente (todos los números están en ella), para configurarla y ver
        su vista previa; no necesita que el número ya esté guardado. idMarca y modulo solo deciden el permiso.
"""
import logging
from typing import Callable

from core import outbound, postgrest
from core.datos import numeros
from core.postgrest import ErrorHub

log = logging.getLogger(__name__)


class Rechazo(Exception):
    def __init__(self, codigo: str, mensaje: str, info: dict | None = None):
        super().__init__(mensaje)
        self.codigo, self.mensaje, self.info = codigo, mensaje, info


def _exito(info: dict) -> dict:
    return {"successful": True, "info": info}


def _falla(codigo: str, mensaje: str, info: dict | None = None) -> dict:
    respuesta = {"successful": False, "errorCode": codigo, "errorMessage": mensaje}
    if info:
        respuesta["info"] = info
    return respuesta


def _texto(params: dict, campo: str) -> str:
    valor = str(params.get(campo) or "").strip()
    if not valor:
        raise Rechazo("CAMPO_REQUERIDO", f"Falta el campo {campo}", {"campo": campo})
    return valor


def _exige_administrador(email: str, id_marca: str, modulo: str) -> None:
    permisos = postgrest.llama("Hub.consultaPermisosUsuario", {"email": email, "idMarca": id_marca, "modulo": modulo})
    if not permisos.get("existe"):
        raise Rechazo("SIN_PERMISO", "El usuario no está registrado en el hub o está inactivo")
    if not permisos.get("esAdministrador"):
        raise Rechazo("SIN_PERMISO", f"No administras el módulo {modulo} en la marca {id_marca}")


def consulta_plantilla_proveedor(email: str, params: dict) -> dict:
    id_marca, modulo = _texto(params, "idMarca").upper(), _texto(params, "modulo").lower()
    id_plantilla = _texto(params, "idPlantilla")
    _exige_administrador(email, id_marca, modulo)
    try:
        return outbound.describe_template({"provider": "twilio", **numeros.cuenta_twilio()}, id_plantilla)
    except outbound.TemplateError as e:
        # PROVEEDOR_NO_CONFIGURADO y no PLANTILLA_NO_CONFIGURADA: ese es del envío ("falta la plantilla en el número")
        raise Rechazo("PROVEEDOR_NO_CONFIGURADO" if e.kind == outbound.NOT_CONFIGURED else "ERROR_PROVEEDOR", e.message) from None


ACCIONES: dict[str, Callable[[str, dict], dict]] = {
    "Hub.consultaPlantillaProveedor": consulta_plantilla_proveedor,
}


def maneja(cuerpo: dict | None, email: str | None) -> dict:
    """Atiende una acción del dashboard. Nunca lanza: regresa el envelope."""
    if not email:
        return _falla("SIN_PERMISO", "La acción debe pedirla un usuario con sesión (API Gateway con el authorizer de Google)")
    if not isinstance(cuerpo, dict) or not isinstance(cuerpo.get("params", {}), dict):
        return _falla("PETICION_INVALIDA", "Se esperaba { action, params }")
    accion = ACCIONES.get(cuerpo.get("action"))
    if accion is None:
        return _falla("ACCION_INVALIDA", f"No se reconoce la acción {cuerpo.get('action')!r}", {"acciones": sorted(ACCIONES)})
    try:
        return _exito(accion(email.strip().lower(), cuerpo.get("params") or {}))
    except Rechazo as e:
        return _falla(e.codigo, e.mensaje, e.info)
    except ErrorHub as e:
        return _falla(e.codigo, e.mensaje, e.info)
    except Exception:
        log.exception("acciones de usuario: error inesperado en %s", cuerpo.get("action"))
        return _falla("ERROR_INTERNO", "Error inesperado")
