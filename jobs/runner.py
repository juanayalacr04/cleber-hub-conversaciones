"""Los jobs programados de la función 2 y su despacho por nombre (tarea 1.32).

El cron (Cloud Scheduler) solo avisa la hora: llama a `POST /jobs/run?job=<nombre>` y la función decide qué toca. Un solo
entry point para todos, así cada job conserva su propia cadencia:

    inactivity-followup       escalera de recordatorios, escalación y cierre del bot por inactividad
    scheduled-contact         contactos que el cliente pidió programar y ya llegaron a su hora
    close-inactive            cierre de las conversaciones con asesor sin mensajes
    verify-lead-templates     plantillas de Lead de ValueText que fallaron
    appointment-reminders     destinatarios de las campañas de recordatorio de cita
    no-show                   destinatarios de las campañas de no-show
    conversation-summaries    resumen de las conversaciones cerradas, para el expediente del cliente (1.38)

Todos son idempotentes: un tick repetido o fuera de hora no manda nada dos veces.
"""
from jobs import close_inactive, inactivity_ladder, reminders, scheduled_contacts, summaries, verify_templates

JOBS = {
    "inactivity-followup": inactivity_ladder.run,
    "scheduled-contact": scheduled_contacts.run,
    "close-inactive": close_inactive.run,
    "verify-lead-templates": verify_templates.run,
    "appointment-reminders": lambda db=None: reminders.run("appointment_reminder", db),
    "no-show": lambda db=None: reminders.run("no_show", db),
    "conversation-summaries": summaries.run,
}


def run(job: str, db=None) -> dict | None:
    """Resultado del job, o None si no existe."""
    fn = JOBS.get(job)
    return fn(db=db) if fn else None
