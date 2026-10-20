"""Escalación a un asesor por inactividad del cliente (tarea 1.32): el cron la pide, el núcleo la decide.

Portada de `escalateToAdvisor` del cron `inactivity-followup`. El núcleo decide el estado de la conversación según el
`assignmentMode` del equipo y el horario del bot; lo que cada módulo hace además en su CRM se despacha como eventos:

    escalation_never_responded     el cliente nunca contestó (Ventas: el Lead vuelve a "Sin validar")
    escalation_out_of_hours_owner  modo "salesforce" fuera de horario (Ventas: el Lead pasa al owner de BDC);
                                   el handler pone `p["handled"] = True` si pudo hacerlo
    escalation_assigned            modo "salesforce" dentro de horario (Ventas: Flow de round robin)

Todos reciben `{bot, conv_id, sf_config, db}`; `sf_config` es la configuración de Salesforce de la organización y el módulo.

Resultado de `escalate_to_advisor`:
    escalated          la conversación quedó con un asesor o esperando uno, y se selló `inactivityEscalatedAt`
    owner_only         fuera de horario en modo "salesforce": solo se reasignó el Lead; el status no cambia
    out_of_hours       fuera de horario en los demás modos: no se toca nada y el siguiente cron lo reintenta
    not_ready          modo "salesforce" fuera de horario sin lo necesario (Lead, owner de BDC): se reintenta
"""
import logging

from google.cloud import firestore

from core import handoff as ho
from core.numbers import sf_config_for
from core.tools import dispatch

log = logging.getLogger(__name__)

ESCALATED, OWNER_ONLY, OUT_OF_HOURS, NOT_READY = "escalated", "owner_only", "out_of_hours", "not_ready"


def escalate_to_advisor(conv_id: str, conv: dict, bot: dict | None, db, extra_fields: dict | None = None) -> str:
    conv_ref = db.collection("conversations").document(conv_id)
    stamp = {**(extra_fields or {}), "inactivityEscalatedAt": firestore.SERVER_TIMESTAMP}
    team_id = conv.get("teamId")
    team = (db.collection("teams").document(team_id).get().to_dict() or {}) if team_id else {}
    mode = team.get("assignmentMode")
    org_id = (bot or {}).get("organizationId") or conv.get("organizationId")
    params = {"bot": bot, "conv_id": conv_id, "db": db, "sf_config": sf_config_for(db, org_id, conv.get("vertical"))}

    # El cliente nunca contestó: el CRM lo registra aunque la escalación se reintente
    if not conv.get("lastCustomerMessageAt"):
        dispatch("escalation_never_responded", conv, params)

    within_hours = not bot or ho.check_business_hours(bot.get("scheduleConfig"))
    salesforce_mode = mode == "salesforce"

    # Fuera de horario en modo "salesforce": esperar a que abra chocaría con el proceso de Salesforce que reasigna la cola
    # de BDC al abrir, así que se reasigna el Lead ya y Salesforce es el único que asigna agente. El status no cambia.
    if not within_hours and salesforce_mode:
        outcome = {**params, "handled": False}
        dispatch("escalation_out_of_hours_owner", conv, outcome)
        if not outcome["handled"]:
            log.info("escalate_owner_patch_skipped conv=%s", conv_id)
            return NOT_READY
        conv_ref.update(stamp)
        return OWNER_ONLY

    # Fuera de horario en los demás modos no se marca nada: el cron reintenta hasta que caiga dentro de horario
    if not within_hours:
        log.info("escalate_skipped_out_of_hours conv=%s", conv_id)
        return OUT_OF_HOURS

    if team_id and mode in ("round_robin", "least_busy"):
        if ho.auto_assign_agent(org_id, conv_id, team_id, handoff_reason="inactivity", db=db):
            conv_ref.update(stamp)
            return ESCALATED
        # sin agentes disponibles: cae a waiting_agent, como el modo manual

    if salesforce_mode:
        status = {"status": "with_agent", "assignedAgentId": None, "assignedAt": firestore.SERVER_TIMESTAMP,
                  "waitingStartedAt": firestore.SERVER_TIMESTAMP}
    else:
        status = {"status": "waiting_agent"}
    conv_ref.update({**status, **stamp})
    if salesforce_mode:
        dispatch("escalation_assigned", conv, params)
    return ESCALATED
