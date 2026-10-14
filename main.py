"""Entry points de las Cloud Functions. Solo entry points: la lógica vive en core/, channels/, ai/, crm/ y modules/.

Despliegue (las cinco funciones comparten el paquete; cambia solo el entry point):

    gcloud functions deploy <nombre> --gen2 --runtime=python311 --region=us-central1 --source=. \\
        --entry-point=<entry point> --trigger-http --project=<proyecto explícito> \\
        --max-instances=300 --concurrency=40

    whatsapp-webhook    whatsapp_webhook     Twilio
    valuetext-webhook   valuetext_webhook    ValueText (Outbound Message de Salesforce)
    meta-webhook        meta_webhook         Meta Cloud API
"""
import functions_framework

import modules  # noqa: F401  registra los handlers de cada módulo contra el núcleo
from channels import webhooks
from core.db import get_executor


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
def meta_webhook(request):
    if request.method == "GET":
        return webhooks.handle_meta_verification(request.args)
    if request.method != "POST":
        return "OK", 200
    return webhooks.handle_meta(request.get_json(silent=True), _run)
