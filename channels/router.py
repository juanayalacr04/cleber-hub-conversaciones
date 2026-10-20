"""Función 1 (router de canal, tarea 1.36): una sola función con las tres rutas de webhook.

    /webhook/twilio     Twilio: firma `X-Twilio-Signature`
    /webhook/meta       Meta Cloud API: GET de verificación (sin firma) y POST firmado con `X-Hub-Signature-256`
    /webhook/valuetext  ValueText, Outbound Message de Salesforce: secreto compartido (`?secret=`)

Cada ruta valida la autenticidad (tarea 1.42), normaliza, deduplica por el ID del proveedor, publica el evento en la cola (1.34) y
responde 200 cuando la cola lo aceptó (500 si no, para que el proveedor reintente). Es la única que conoce los formatos de los tres
proveedores y no escribe en Firestore. Una ruta desconocida responde 404 sin procesar nada.

`route` recibe la petición de Flask y `publish(event)` (la cola, `channels/event_queue.py`): así se prueba sin Pub/Sub.
"""
from channels import webhook_auth, webhooks

TWILIO, META, VALUETEXT = "/webhook/twilio", "/webhook/meta", "/webhook/valuetext"


def _twilio(request, publish) -> tuple:
    if request.method != "POST":
        return "OK", 200
    if not webhook_auth.twilio_authorized(webhook_auth.public_url(request), request.form, request.headers):
        return "Forbidden", 403
    return webhooks.handle_twilio(request.form, publish)


def _meta(request, publish) -> tuple:
    if request.method == "GET":
        return webhooks.handle_meta_verification(request.args)
    if request.method != "POST":
        return "OK", 200
    if not webhook_auth.meta_authorized(request.get_data(), request.headers):   # el cuerpo crudo: la firma se calcula sobre los bytes exactos
        return "Forbidden", 403
    return webhooks.handle_meta(request.get_json(silent=True), publish)


def _valuetext(request, publish) -> tuple:
    if request.method != "POST":
        return "OK", 200
    if not webhook_auth.valuetext_authorized(request.args, request.headers):
        return "Forbidden", 403
    return webhooks.handle_valuetext(request.get_data(as_text=True), publish)


ROUTES = {TWILIO: _twilio, META: _meta, VALUETEXT: _valuetext}


def route(request, publish) -> tuple:
    """Despacha por la ruta. Se compara el final del path: detrás de algunos balanceadores llega con un prefijo (el de la función)."""
    path = (request.path or "/").rstrip("/")
    for suffix, handler in ROUTES.items():
        if path.endswith(suffix):
            return handler(request, publish)
    return "Not Found", 404
