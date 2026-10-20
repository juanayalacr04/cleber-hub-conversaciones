"""Entry points de las Cloud Functions. Solo entry points: la lógica vive en core/, channels/, ai/, crm/ y modules/.

Despliegue (las funciones comparten el paquete; cambia solo el entry point):

    gcloud functions deploy <nombre> --gen2 --runtime=python311 --region=us-central1 --source=. \\
        --entry-point=<entry point> --trigger-http --project=<proyecto explícito> \\
        --max-instances=300 --concurrency=40

    whatsapp-webhook    whatsapp_webhook     Twilio
    valuetext-webhook   valuetext_webhook    ValueText (Outbound Message de Salesforce)
    meta-webhook        meta_webhook         Meta Cloud API
    inactivity-followup inactivity_followup  cron del dashboard (X-Cron-Secret)
    lead-webhook        lead_webhook         Fase 2, sobre el contrato de entrada único
    actions-execute     actions_execute      endpoint de acciones: los bots piden, el hub ejecuta (X-Bot-Id + Bearer)
    user-actions-execute user_actions_execute endpoint de los usuarios del dashboard (token de Firebase; FIREBASE_PROJECT_ID, ALLOWED_ORIGINS)
    situacion-detectada situacion_detectada      webhook del bot de Ventas hacia Servicio (X-Api-Secret = SITUACION_API_SECRET)
"""
import json
import logging

import functions_framework

import modules  # noqa: F401  registra los handlers de cada módulo contra el núcleo
from channels import send_handoff_template, send_whatsapp_message, webhooks
from core import actions, outbound, situacion, user_actions
from core import account_actions, admin_actions, broadcast_actions, conversation_actions  # noqa: F401  declaran las acciones de usuario
from core.db import get_executor
from jobs import inactivity
from jobs.auth import cron_authorized


outbound.configure(send_text=send_whatsapp_message, send_template=send_handoff_template)


def _run(fn, *args):
    return get_executor().submit(fn, *args)


@functions_framework.http
def health(request):
    return {"status": "ok"}, 200


@functions_framework.http
def whatsapp_webhook(request):
    if request.method != "POST":
        return "OK", 200
    return webhooks.handle_twilio(request.form, _run)


@functions_framework.http
def valuetext_webhook(request):
    if request.method != "POST":
        return "OK", 200
    return webhooks.handle_valuetext(request.get_data(as_text=True), _run)


@functions_framework.http
def inactivity_followup(request):
    """Recordatorio de inactividad o contacto programado, invocado por el cron del dashboard."""
    headers = {"Content-Type": "application/json"}
    if request.method != "POST":
        return json.dumps({"error": "Method not allowed"}), 405, headers
    if not cron_authorized(request.headers):
        return json.dumps({"error": "Unauthorized"}), 401, headers
    try:
        body, status = inactivity.run_followup(request.get_json(silent=True) or {})
    except Exception as e:
        logging.getLogger(__name__).exception("inactivity_followup")
        body, status = {"success": False, "error": str(e)}, 500
    return json.dumps(body), status, headers


@functions_framework.http
def meta_webhook(request):
    if request.method == "GET":
        return webhooks.handle_meta_verification(request.args)
    if request.method != "POST":
        return "OK", 200
    return webhooks.handle_meta(request.get_json(silent=True), _run)


@functions_framework.http
def actions_execute(request):
    """POST /actions/execute: un bot pide una acción y recibe el resultado (core/actions.py)."""
    if request.method != "POST":
        return json.dumps({"error": "Method not allowed"}), 405, {"Content-Type": "application/json"}
    try:
        body, status = actions.handle(request.headers, request.get_json(silent=True))
    except Exception:
        logging.getLogger(__name__).exception("actions_execute")
        body, status = {"error": "Internal error"}, 500
    return json.dumps(body), status, {"Content-Type": "application/json"}


@functions_framework.http
def user_actions_execute(request):
    """POST /user-actions/execute: un usuario del dashboard pide una escritura (core/user_actions.py)."""
    cors = user_actions.cors_headers(request.headers.get("Origin"))
    headers = {"Content-Type": "application/json", **cors}
    if request.method == "OPTIONS":
        return "", 204, cors
    if request.method != "POST":
        return json.dumps({"error": "Method not allowed"}), 405, headers
    try:
        body, status = user_actions.handle(request.headers, request.get_json(silent=True))
    except Exception:
        logging.getLogger(__name__).exception("user_actions_execute")
        body, status = {"error": "Internal error"}, 500
    return json.dumps(body), status, headers


@functions_framework.http
def situacion_detectada(request):
    """POST /integrations/situacion-detectada: el bot de Ventas pide mandar al cliente a Servicio (core/situacion.py)."""
    headers = {"Content-Type": "application/json"}
    if request.method != "POST":
        return json.dumps({"error": "Method not allowed"}), 405, headers
    try:
        body, status = situacion.handle(request.headers, request.args, request.get_json(silent=True))
    except Exception:
        logging.getLogger(__name__).exception("situacion_detectada")
        body, status = {"error": "Internal server error"}, 500
    return json.dumps(body), status, headers
