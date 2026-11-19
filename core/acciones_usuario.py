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
    Hub.enviaInvitacion              administrador del módulo en la marca (el mismo que dio el rol con Hub.invitaUsuario)
        params: email, idMarca, modulo, nombreMarca? (para el texto del correo; por defecto idMarca),
                 origen (origen web del ambiente desde el que se invita, p. ej. https://dev.miweb.com; es el enlace del correo)
        info:   { enviado: true }
        Manda el correo de invitación por la API de correo (Cleber.enviarEmail en INVITE_EMAIL_WEBHOOK_URL, con
        INVITE_EMAIL_API_KEY en x-api-key, si el ambiente la tiene). El enlace es el origen que manda la web, así cada ambiente apunta a su propia URL.
        Solo a quien ya tiene rol en ese módulo y marca. Un fallo del envío es ERROR_CORREO: el alta ya quedó hecha y se
        puede reenviar.
"""
import html
import json
import logging
import os
from typing import Callable
from urllib.parse import urlsplit

from core import http, outbound, postgrest
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


NOMBRE_REMITENTE = "CLEBER - HUB Conversaciones"
NOMBRE_MODULO = {"ventas": "Ventas", "servicio": "Servicio", "valuacion": "Valuación"}
ENVIADOS = {"sent", "queued", "scheduled"}     # status de Cleber.enviarEmail por destinatario


def _etiqueta_rol(modulo: str, rol: str) -> str:
    try:
        roles = postgrest.llama("Hub.consultaRolesModulo", {"modulo": modulo}).get("roles") or []
    except ErrorHub:
        return rol
    return next((r.get("nombre") for r in roles if r.get("rol") == rol and r.get("nombre")), rol)


def _origen(valor) -> str:
    """`https://host[:puerto]` o "" si no lo es (sin ruta, consulta ni credenciales): va como enlace en el correo."""
    try:
        partes = urlsplit(str(valor or "").strip())
        valido = partes.scheme in ("http", "https") and partes.hostname and not partes.username and partes.path in ("", "/")             and not partes.query and not partes.fragment
    except ValueError:
        return ""
    return f"{partes.scheme}://{partes.netloc}" if valido else ""


def envia_invitacion(email: str, params: dict) -> dict:
    destino = _texto(params, "email").lower()
    id_marca, modulo = _texto(params, "idMarca").upper(), _texto(params, "modulo").lower()
    _exige_administrador(email, id_marca, modulo)
    permisos = postgrest.llama("Hub.consultaPermisosUsuario", {"email": destino, "idMarca": id_marca, "modulo": modulo})
    if not permisos.get("existe") or not permisos.get("rol"):
        raise Rechazo("ESTADO_INVALIDO", f"{destino} no tiene rol en {modulo} en la marca {id_marca}: dalo de alta primero")
    app_url = _origen(params.get("origen"))
    url = (os.environ.get("INVITE_EMAIL_WEBHOOK_URL") or "").strip()
    clave = (os.environ.get("INVITE_EMAIL_API_KEY") or "").strip()
    if not url:
        raise Rechazo("CONFIGURACION", "Falta INVITE_EMAIL_WEBHOOK_URL en el ambiente")
    if not app_url:
        raise Rechazo("CAMPO_REQUERIDO", "Falta el origen de la web (origen)", {"campo": "origen"})
    marca = html.escape(str(params.get("nombreMarca") or "").strip()[:100] or id_marca)
    rol = html.escape(_etiqueta_rol(modulo, permisos["rol"]))
    nombre_modulo = html.escape(NOMBRE_MODULO.get(modulo, modulo))
    contenido = "\n".join([
        "<!DOCTYPE html>", '<html lang="es">', "<head>", '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f"<title>Invitación al módulo de {nombre_modulo} — {marca}</title>", "</head>",
        '<body style="margin: 0; padding: 16px;">',
        '<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">',
        f"<h2>Invitación al módulo de {nombre_modulo}</h2>",
        f"<p>Un administrador te ha invitado a unirte al equipo de <strong>{marca}</strong> como <strong>{rol}</strong> en el módulo de <strong>{nombre_modulo}</strong>.</p>",
        "<p>Haz clic en el siguiente enlace para acceder:</p>",
        f'<a href="{html.escape(app_url)}" style="display: inline-block; padding: 12px 24px; background-color: #000; '
        'color: #fff; text-decoration: none; border-radius: 6px; margin: 16px 0;">Acceder a la plataforma</a>',
        f'<p style="color: #666; font-size: 14px;">Inicia sesión con tu cuenta de Google asociada a <strong>{html.escape(destino)}</strong>.</p>',
        "</div>", "</body>", "</html>"])
    cuerpo = json.dumps({"action": "Cleber.enviarEmail", "params": {
        "subject": f"Invitación al módulo de {nombre_modulo} — {marca}", "fromName": NOMBRE_REMITENTE,
        "to": [destino], "cc": [], "bcc": [], "content": contenido}}).encode("utf-8")
    try:
        _, texto = http.request(url, cuerpo, {"Content-Type": "application/json", **({"x-api-key": clave} if clave else {})}, timeout=15)
        respuesta = json.loads(texto)
        envios = respuesta.get("info") if isinstance(respuesta.get("info"), list) else []
        fallido = next((e for e in envios if e.get("status") not in ENVIADOS), None)
        if not respuesta.get("successful") or fallido or not envios:
            raise ValueError(str((fallido or {}).get("reject_reason") or respuesta.get("errorMessage") or "sin confirmación del envío"))
    except Exception as e:
        log.error("No se pudo enviar el correo de invitación a %s: %s", destino, e)
        raise Rechazo("ERROR_CORREO", "No se pudo enviar el correo; el alta quedó hecha y se puede reenviar") from None
    return {"enviado": True}


ACCIONES: dict[str, Callable[[str, dict], dict]] = {
    "Hub.consultaPlantillaProveedor": consulta_plantilla_proveedor,
    "Hub.enviaInvitacion": envia_invitacion,
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
