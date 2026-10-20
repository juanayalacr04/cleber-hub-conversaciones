"""Entry points de las Cloud Functions. Solo entry points: la lógica vive en core/, channels/, ai/, crm/ y modules/.

Despliegue (las funciones comparten el paquete; cambia solo el entry point):

    gcloud functions deploy <nombre> --gen2 --runtime=python311 --region=us-central1 --source=. \\
        --entry-point=<entry point> --trigger-http --project=<proyecto explícito> \\
        --max-instances=300 --concurrency=40

    router              router               función 1, las tres rutas de webhook (channels/router.py):
                                               /webhook/twilio     firma X-Twilio-Signature; PUBLIC_BASE_URL = URL pública de la función
                                               /webhook/meta       firma X-Hub-Signature-256 (META_APP_SECRET); el GET de verificación no lleva firma
                                               /webhook/valuetext  Outbound Message de Salesforce (?secret= = VALUETEXT_WEBHOOK_SECRET)
    inactivity-followup inactivity_followup  cron del dashboard (X-Cron-Secret)
    lead-webhook        lead_webhook         Fase 2, sobre el contrato de entrada único
    queue-incoming      queue_incoming       consumidor de la cola, función 2: push de Pub/Sub (?secret= = QUEUE_PUSH_SECRET). `--timeout=540`, ack deadline de la suscripción
                                             igual o mayor (el turno llama a Abacus); suscripción con orden por clave. INCOMING_TOPIC en el router
    bot                 bot                  función 3, sin estado: /bot/turn y /bot/summary (ai/service.py; X-Service-Secret = BOT_FUNCTION_SECRET).
                                             Timeout largo (`--timeout=300`) por la llamada a Abacus, concurrencia propia (1.25)
    actions-execute     actions_execute      endpoint de acciones: los bots piden, el hub ejecuta (X-Bot-Id + Bearer)
    user-actions-execute user_actions_execute endpoint de los usuarios del dashboard (token de Firebase; FIREBASE_PROJECT_ID, ALLOWED_ORIGINS)
    situacion-detectada situacion_detectada      webhook del bot de Ventas hacia Servicio (X-Api-Secret = SITUACION_API_SECRET)
    close-by-phone      close_by_phone           Outbound Message de Salesforce que cierra conversaciones por teléfono (?secret= = EXTERNAL_API_SECRET)
    jobs-run            jobs_run                 los jobs programados: `?job=<nombre>` (X-Cron-Secret); ver jobs/runner.py

router sin cola (primera versión, hasta que exista Pub/Sub, 1.34): sin INCOMING_TOPIC el router procesa en proceso y en segundo plano, así
que esa misma función hace de reglas. Sin orden por conversación ni reintentos; `--no-cpu-throttling` evita que la instancia se congele
al responder 200 y mate el hilo. PUBLIC_BASE_URL es la URL de la función (se conoce hasta el primer despliegue: desplegar, leerla con
`gcloud functions describe` y volver a desplegar con ella). Desarrollo:

    gcloud functions deploy hub-router --gen2 --runtime=python311 --region=us-central1 --source=. \\
        --entry-point=router --trigger-http --allow-unauthenticated --project=ambiente-desarrollo-ti \\
        --timeout=540 --max-instances=300 --concurrency=40 --no-cpu-throttling \\
        --set-env-vars=FIRESTORE_DATABASE=dev-hub-conversaciones,GOOGLE_CLOUD_PROJECT=ambiente-desarrollo-ti,PUBLIC_BASE_URL=<url de la función>,META_APP_SECRET=<secreto de la app de Meta>,VALUETEXT_WEBHOOK_SECRET=<secreto compartido>

Los webhooks de los proveedores apuntan a `<url>/webhook/twilio`, `<url>/webhook/meta` y `<url>/webhook/valuetext?secret=<VALUETEXT_WEBHOOK_SECRET>`.

user-actions-execute atiende también `broadcast.send` y `broadcast.retry`, que mandan una campaña completa y tardan minutos:
desplegarla con `--timeout=900` (el valor por defecto, 60 s, la cortaría a medias).

jobs-run corre los jobs programados (un tick puede mandar recordatorios a cientos de conversaciones): `--timeout=540`, `--max-instances=1`
para que dos ticks no se pisen, y un Cloud Scheduler por job con su cadencia (inactivity-followup, scheduled-contact, close-inactive
y verify-lead-templates cada pocos minutos; appointment-reminders y no-show según el horario de las citas).
"""
import json
import logging

import functions_framework

from ai import service as bot_service
import modules  # noqa: F401  registra los handlers de cada módulo contra el núcleo
from channels import (check_campaign_ready, delivery_statuses, send_campaign_template, send_handoff_template,
                      send_whatsapp_message)
from channels import event_queue, ingest
from channels import router as channel_router
from core import actions, close_by_phone as close_by_phone_mod, outbound, situacion, user_actions
from core import account_actions, admin_actions, broadcast_actions, conversation_actions  # noqa: F401  declaran las acciones de usuario
from core.db import get_executor
from jobs import inactivity, runner
from jobs.auth import cron_authorized


def wire_outbound() -> None:
    """Inyecta en `core.outbound` los envíos del router (`channels/`)."""
    outbound.configure(send_text=send_whatsapp_message, send_template=send_handoff_template, send_campaign=send_campaign_template,
                       check_campaign=check_campaign_ready, delivery_statuses=delivery_statuses)


wire_outbound()


def wire_queue() -> None:
    """Fija la cola del router: Pub/Sub si hay `INCOMING_TOPIC`; si no, se procesa en proceso (desarrollo)."""
    event_queue.configure(event_queue.from_env(direct=event_queue.DirectPublisher(ingest.process_event, lambda fn, *a: _run(fn, *a))))


wire_queue()


def _run(fn, *args):
    return get_executor().submit(fn, *args)


@functions_framework.http
def health(request):
    return {"status": "ok"}, 200


@functions_framework.http
def router(request):
    """Función 1: /webhook/twilio, /webhook/meta y /webhook/valuetext (channels/router.py)."""
    return channel_router.route(request, event_queue.publish)


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
def queue_incoming(request):
    """POST /queue/incoming: push de Pub/Sub con un evento del router; se aplica antes de contestar (channels/ingest.py)."""
    if request.method != "POST":
        return json.dumps({"error": "Method not allowed"}), 405, {"Content-Type": "application/json"}
    try:
        body, status = ingest.handle(request.args, request.headers, request.get_json(silent=True))
    except Exception:
        logging.getLogger(__name__).exception("queue_incoming")
        body, status = {"error": "Internal error"}, 500
    return json.dumps(body), status, {"Content-Type": "application/json"}


@functions_framework.http
def bot(request):
    """Función 3: /bot/turn y /bot/summary, sin estado (ai/service.py). Solo la llama la función 2 (X-Service-Secret)."""
    if request.method != "POST":
        return json.dumps({"error": "Method not allowed"}), 405, {"Content-Type": "application/json"}
    try:
        body, status = bot_service.handle(request.path, request.headers, request.get_json(silent=True))
    except Exception:
        logging.getLogger(__name__).exception("bot")
        body, status = {"error": "Internal error"}, 500
    return json.dumps(body), status, {"Content-Type": "application/json"}


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


@functions_framework.http
def jobs_run(request):
    """POST /jobs/run?job=<nombre>: el cron avisa la hora y la función decide qué toca (jobs/runner.py)."""
    headers = {"Content-Type": "application/json"}
    if request.method != "POST":
        return json.dumps({"error": "Method not allowed"}), 405, headers
    if not cron_authorized(request.headers):
        return json.dumps({"error": "Unauthorized"}), 401, headers
    job = request.args.get("job") or (request.get_json(silent=True) or {}).get("job")
    if job not in runner.JOBS:
        return json.dumps({"error": f"Unknown job {job!r}", "jobs": sorted(runner.JOBS)}), 400, headers
    try:
        body, status = runner.run(job), 200
    except Exception as e:
        logging.getLogger(__name__).exception("jobs_run %s", job)
        body, status = {"success": False, "error": str(e)}, 500
    return json.dumps(body, default=str), status, headers


@functions_framework.http
def close_by_phone(request):
    """POST /integrations/close-by-phone: Salesforce pide cerrar las conversaciones de un teléfono (core/close_by_phone.py)."""
    if request.method != "POST":
        return json.dumps({"error": "Method not allowed"}), 405, {"Content-Type": "application/json"}
    try:
        body, status, content_type = close_by_phone_mod.handle(request.headers, request.args, request.get_data(as_text=True))
    except Exception:
        logging.getLogger(__name__).exception("close_by_phone")
        body, status, content_type = json.dumps({"error": "Internal server error"}), 500, "application/json"
    return body, status, {"Content-Type": content_type}
