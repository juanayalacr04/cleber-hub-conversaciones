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
"""
import json
import logging

import functions_framework

import modules  # noqa: F401  registra los handlers de cada módulo contra el núcleo
from channels import webhooks
from core import actions
from core.db import get_executor
from jobs import inactivity
from jobs.auth import cron_authorized


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
