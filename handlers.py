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
    hub-router             handlers.router             webhooks de los proveedores (/webhook/twilio, /meta, /valuetext): valida
                                                       la firma y publica en la cola SQS FIFO. Sin authorizer ni API key.
    hub-msj-entrantes      handlers.entrantes          consumidor de la cola: cada mensaje del cliente por el pipeline de
                                                       core/entrada_mensajes.py (hub_cleber), con fallos parciales de lote.

Entorno de todas (además de lo de core/postgrest.py):
    SECRET_NAME          secreto con las variables del ambiente (core/entorno.py); trae TWILIO_ACCOUNT_SID y TWILIO_AUTH_TOKEN
    SECRETOS_EN=aws      credenciales de números y bots en Secrets Manager, con SECRETOS_PREFIJO (core/credentials.py)
    APPSYNC_EVENTS_URL   endpoint HTTP de AppSync Events para los avisos de tiempo real (core/appsync.py); sin ella no se
                         publican. El rol necesita appsync:EventPublish sobre el namespace `hub`
hub-router además:
    COLA_ENTRANTES_URL   URL de la cola hub-entrantes-<ambiente>.fifo
    PUBLIC_BASE_URL      URL pública del API hasta el stage (https://<api>.execute-api.us-east-1.amazonaws.com/dev): Twilio
                         firma la URL exacta del webhook
"""
import logging
import os

import modules  # noqa: F401  registra los handlers de cada módulo (y las fuentes del contrato ①) contra el núcleo
from channels import (check_campaign_ready, cola_sqs, delivery_statuses, describe_template, event_queue, render_template_text,
                      router as canal_router, send_campaign_template, send_handoff_template, send_whatsapp_message, webhooks)
from contracts.messages import ChannelEvent
from core import (acciones_usuario as usuario, appsync, contrato_entrada as contrato, entorno, entrada_mensajes, http_lambda,
                  outbound, tiempo_real)

logging.getLogger().setLevel(logging.INFO)
log = logging.getLogger(__name__)


def _prepara() -> None:
    """Una vez por instancia: secretos del ambiente, avisos de tiempo real y envíos de los canales."""
    entorno.carga_secretos()
    if not tiempo_real.esta_configurado():
        publicador = appsync.Publicador.de_entorno()
        if publicador is None:
            log.warning("Sin APPSYNC_EVENTS_URL: no se publican avisos de tiempo real")
        tiempo_real.configure(publicador)
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


def _prepara_router() -> None:
    _prepara()
    webhooks.DEDUPLICA_EN_FIRESTORE = False
    if event_queue._publisher is None:
        url = (os.environ.get("COLA_ENTRANTES_URL") or "").strip()
        if not url:
            raise RuntimeError("falta COLA_ENTRANTES_URL")
        event_queue.configure(event_queue.SqsPublisher(url))


def router(event, context=None):
    """Webhooks de los proveedores. 200 solo cuando la cola aceptó el evento; 500 para que el proveedor reintente."""
    try:
        _prepara_router()
    except Exception:
        log.exception("router: no se pudo preparar la instancia")
        return http_lambda.respuesta(500, "Service Unavailable")
    peticion = http_lambda.Peticion.de_evento(event)
    return http_lambda.de_flask(canal_router.route(peticion, event_queue.publish))


def _aplica_evento(evento: ChannelEvent) -> None:
    if evento.kind == "message":
        entrada_mensajes.procesa(evento.message, send_whatsapp_message)
    else:
        # Estados de entrega y ecos de ValueText: los usan campañas y Servicio; llegan con su mudanza (fases 3 y 4)
        log.info("entrantes: evento %s ignorado (%s)", evento.kind, evento.event_id)


def entrantes(event, context=None):
    """Consumidor de la cola hub-entrantes. Si la instancia no se puede preparar, todo el lote vuelve a la cola."""
    try:
        _prepara()
    except Exception:
        log.exception("entrantes: no se pudo preparar la instancia")
        return {"batchItemFailures": [{"itemIdentifier": r.get("messageId", "")} for r in (event or {}).get("Records", [])]}
    return cola_sqs.consume(event, _aplica_evento)
