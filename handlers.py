"""Handlers de las Lambdas del hub (DISENO_BACKEND_AWS.md §3). Solo puntos de entrada: la lógica vive en core/, channels/,
ai/, crm/ y modules/. Reemplaza a main.py (functions_framework, GCP) conforme cada función se muda.

Una sola imagen con todo el paquete; cada Lambda cambia solo el handler (`handlers.<nombre>`):

    hub-entry-point        handlers.entry_point        entrada de otros sistemas al hub. Hoy: contrato ① (Valuación, u otro
                                                       sistema, abre una conversación)
                                                       Invocación directa (lambda:InvokeFunction, el evento es el cuerpo) o por
                                                       API Gateway /internal (proxy). Regresa el envelope de la convención.
    hub-acciones-usuario   handlers.acciones_usuario   acciones del dashboard que tocan algo externo (core/acciones_usuario.py).
                                                       Solo por API Gateway /hub-acciones con el authorizer de Google: el email
                                                       sale de requestContext.authorizer.email.

Entorno de todas (además de lo de core/postgrest.py):
    SECRET_NAME          secreto con las variables del ambiente (core/entorno.py)
    SECRETOS_EN=aws      credenciales de números y bots en Secrets Manager, con SECRETOS_PREFIJO (core/credentials.py)
"""
import logging

import modules  # noqa: F401  registra los handlers de cada módulo (y las fuentes del contrato ①) contra el núcleo
from channels import (check_campaign_ready, delivery_statuses, describe_template, render_template_text, send_campaign_template,
                      send_handoff_template, send_whatsapp_message)
from core import acciones_usuario as usuario, contrato_entrada as contrato, entorno, http_lambda, outbound

logging.getLogger().setLevel(logging.INFO)
log = logging.getLogger(__name__)


def _prepara() -> None:
    """Una vez por instancia: secretos del ambiente y envíos de los canales."""
    entorno.carga_secretos()
    if not outbound.is_configured("campaign"):
        outbound.configure(send_text=send_whatsapp_message, send_template=send_handoff_template, send_campaign=send_campaign_template,
                           check_campaign=check_campaign_ready, delivery_statuses=delivery_statuses,
                           render_template=render_template_text, describe_template=describe_template)


def entry_point(event, context=None):
    """Contrato ①. Directa: regresa el envelope. Por API Gateway: 200 con el envelope (el éxito o el rechazo va dentro)."""
    try:
        _prepara()
    except Exception:
        log.exception("entry_point: no se pudo preparar la instancia")
        falla = {"successful": False, "errorCode": "CONFIGURACION", "errorMessage": "No se pudo preparar la función"}
        return falla if http_lambda.es_invocacion_directa(event) else http_lambda.respuesta(500, falla)

    if http_lambda.es_invocacion_directa(event):
        return contrato.maneja(event)
    peticion = http_lambda.Peticion.de_evento(event)
    if peticion.method != "POST":
        return http_lambda.respuesta(405, {"error": "Method not allowed"})
    return http_lambda.respuesta(200, contrato.maneja(peticion.get_json(silent=True)))


def acciones_usuario(event, context=None):
    """Acciones del dashboard (core/acciones_usuario.py). Solo por API Gateway con el authorizer: sin usuario, SIN_PERMISO.
    Responde 200 con el envelope (el éxito o el rechazo va dentro)."""
    if http_lambda.es_invocacion_directa(event):
        return {"successful": False, "errorCode": "SIN_PERMISO", "errorMessage": "Solo por API Gateway con la sesión del usuario"}
    try:
        _prepara()
    except Exception:
        log.exception("acciones_usuario: no se pudo preparar la instancia")
        return http_lambda.respuesta(500, {"successful": False, "errorCode": "CONFIGURACION", "errorMessage": "No se pudo preparar la función"})
    peticion = http_lambda.Peticion.de_evento(event)
    if peticion.method != "POST":
        return http_lambda.respuesta(405, {"error": "Method not allowed"})
    email = ((event.get("requestContext") or {}).get("authorizer") or {}).get("email")
    return http_lambda.respuesta(200, usuario.maneja(peticion.get_json(silent=True), email))
