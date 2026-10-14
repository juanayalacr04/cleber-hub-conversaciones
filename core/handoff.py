"""Handoff a un asesor: horarios, asignación (round robin / menos ocupado) y status resultante.

Servicio aporta la asignación transaccional y por `orgTeams`; Comercial aporta el modo
"salesforce" y el aviso de fuera de horario. El límite `maxConversationsPerAgent` de Comercial
se conserva como configuración del equipo: si el equipo no lo define, no hay límite (como
Servicio).
"""
import bisect
import logging
from datetime import datetime, time as dt_time, timezone
from zoneinfo import ZoneInfo

from google.cloud import firestore

from core.db import get_db, run_transaction

log = logging.getLogger(__name__)

DEFAULT_TIMEZONE = "America/Mexico_City"
DAY_NAMES_ES = {
    "monday": "Lunes", "tuesday": "Martes", "wednesday": "Miércoles", "thursday": "Jueves",
    "friday": "Viernes", "saturday": "Sábado", "sunday": "Domingo",
}
DAY_ORDER = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
FIXED_CLOSING = "Si necesitas un asesor en otro momento, con gusto lo intento de nuevo."
OUT_OF_HOURS_CONTEXT = (
    "<<CONTEXTO>> El cliente ya pidió un asesor pero estamos fuera de horario: NO está conectado con nadie todavía. "
    "No digas que ya lo conectaste ni que su solicitud ya está con un asesor; si lo pregunta, dile que lo contactarán "
    "cuando abra el horario de atención. Sigue ayudando con lo que sí puedes responder."
)


def check_handoff_keywords(message: str, keywords: list) -> bool:
    """¿El mensaje contiene alguna keyword de handoff?"""
    lowered = message.lower()
    return any(k.lower() in lowered for k in keywords)


def check_business_hours(schedule_config: dict | None, now: datetime | None = None) -> bool:
    """True si estamos dentro del horario configurado. Sin config o deshabilitado = siempre disponible."""
    if not schedule_config or not schedule_config.get("enabled"):
        return True
    try:
        tz = ZoneInfo(schedule_config.get("timezone", DEFAULT_TIMEZONE))
    except Exception:
        tz = ZoneInfo(DEFAULT_TIMEZONE)
    local = now.astimezone(tz) if now else datetime.now(tz)
    day_name = local.strftime("%A").lower()
    for slot in schedule_config.get("schedule", []):
        if slot.get("day") == day_name:
            start = dt_time.fromisoformat(slot["startTime"])
            end = dt_time.fromisoformat(slot["endTime"])
            if start <= local.time() <= end:
                return True
    return False


def build_out_of_hours_message(schedule_config: dict) -> str:
    """Texto del admin + horario formateado + cierre fijo."""
    base = schedule_config.get("outOfHoursMessage", "Nuestros asesores no están disponibles en este momento.")
    by_day = {s["day"]: s for s in schedule_config.get("schedule", [])}
    lines = ["\n\nNuestro horario de atención:"]
    for day in DAY_ORDER:
        if day in by_day:
            lines.append(f"\n  {DAY_NAMES_ES[day]}: {by_day[day]['startTime']} - {by_day[day]['endTime']}")
        else:
            lines.append(f"\n  {DAY_NAMES_ES[day]}: Cerrado")
    lines.append(f"\n\n{FIXED_CLOSING}")
    return base + "".join(lines)


def apply_out_of_hours_context(messages: list, conv_data: dict, schedule_config: dict, now: datetime | None = None) -> list:
    """Antepone el aviso "asesor no disponible" al último mensaje del cliente mientras el handoff siga bloqueado por horario."""
    if not conv_data.get("handoffBlockedAt") or check_business_hours(schedule_config, now):
        return messages
    primed = list(messages)
    if primed and primed[-1].get("is_user"):
        primed[-1] = {"is_user": True, "text": f"{OUT_OF_HOURS_CONTEXT}\n\n{primed[-1].get('text', '')}".strip()}
    return primed


# --------------------------------------------------------------------------- asignación

def next_round_robin_agent(transaction, team_ref, agent_ids: list) -> str:
    """Siguiente agente de la rotación; avanza el puntero del equipo.

    Va en transacción porque los webhooks corren en instancias concurrentes: sin ella, dos
    handoffs simultáneos leerían el mismo puntero y caerían en el mismo agente.
    """
    team_data = team_ref.get(transaction=transaction).to_dict() or {}
    last_id = team_data.get("lastAssignedAgentId")
    # Primer id (lista ordenada) mayor al último asignado. Si ese agente ya no está en la lista,
    # bisect devuelve dónde caería alfabéticamente: la rotación sigue desde ahí, no reinicia.
    start = bisect.bisect_right(agent_ids, last_id) % len(agent_ids) if last_id else 0
    next_id = agent_ids[start]
    transaction.update(team_ref, {"lastAssignedAgentId": next_id})
    return next_id


def _team_agents(db, org_id: str, team_id: str) -> dict[str, dict]:
    """Agentes del equipo. `orgTeams[orgId]` es autoritativo; el `teamId` plano es legado y pierde si difieren."""
    roles = ["admin", "agent"]
    users = db.collection("users")
    found = {d.id: d.to_dict() for d in users.where(f"orgTeams.{org_id}", "==", team_id).where("role", "in", roles).stream()}
    for d in users.where("teamId", "==", team_id).where("role", "in", roles).stream():
        if d.id in found:
            continue
        data = d.to_dict()
        org_teams = data.get("orgTeams") or {}
        if org_id in org_teams and org_teams.get(org_id) != team_id:
            continue  # el mapa lo tiene en otro equipo de esta org: el teamId plano está viejo
        found[d.id] = data
    return found


def auto_assign_agent(org_id: str, conv_id: str, team_id: str | None = None,
                      handoff_reason: str = "keyword", db=None) -> str | None:
    """Asigna la conversación según el `assignmentMode` del equipo.

    "round_robin" (rotativo), "least_busy" (menos carga, por defecto) o "manual" (no asigna).
    Sin equipo no se asigna. Devuelve el id del agente o None si no hay agentes disponibles.
    """
    db = db or get_db()
    if not team_id:
        log.info("Conversación %s sin equipo: no se asigna agente automáticamente", conv_id)
        return None

    team = db.collection("teams").document(team_id).get()
    team_data = team.to_dict() if team.exists else {}
    mode = team_data.get("assignmentMode") or "least_busy"
    if mode == "manual":
        log.info("Equipo %s en modo manual: la conversación queda para que un asesor la tome", team_id)
        return None
    max_convs = team_data.get("maxConversationsPerAgent")  # opcional: sin valor, sin límite

    available = []
    for agent_id, data in _team_agents(db, org_id, team_id).items():
        if not data.get("isAvailable", True):
            continue
        active = data.get("activeConversations", 0)
        if max_convs is not None and active >= max_convs:
            continue
        available.append({"id": agent_id, "activeConversations": active})
    if not available:
        log.info("Sin agentes disponibles en el equipo %s (org %s)", team_id, org_id)
        return None

    if mode == "round_robin":
        ids = sorted(a["id"] for a in available)
        assigned = run_transaction(next_round_robin_agent, db.collection("teams").document(team_id), ids, db=db)
    else:
        available.sort(key=lambda a: a["activeConversations"])
        assigned = available[0]["id"]

    now = datetime.now(timezone.utc)
    db.collection("conversations").document(conv_id).update({
        "status": "with_agent", "assignedAgentId": assigned, "assignedAt": now, "handoffReason": handoff_reason,
        "assignedAgentType": "human", "assignedBotId": None, "assignedUserId": assigned,
    })
    db.collection("users").document(assigned).update({"activeConversations": firestore.Increment(1), "lastActivityAt": now})
    log.info("Conversación %s asignada a %s (mode=%s)", conv_id, assigned, mode)
    return assigned


def apply_handoff_status(conv_id: str, team_id: str | None = None, org_id: str | None = None,
                         handoff_reason: str = "keyword", db=None) -> None:
    """Status de la conversación tras un handoff, según el `assignmentMode` del equipo.

    - "salesforce": pasa a "with_agent" SIN asignar agente; la asignación real se hace en Salesforce.
    - "round_robin" / "least_busy": intenta auto-asignar; si no hay agentes, "waiting_agent".
    - "manual" (o sin equipo): "waiting_agent" sin asignar.
    """
    db = db or get_db()
    conv_ref = db.collection("conversations").document(conv_id)
    mode = None
    if team_id:
        try:
            team = db.collection("teams").document(team_id).get()
            mode = team.to_dict().get("assignmentMode") if team.exists else None
        except Exception as e:
            log.warning("handoff_team_lookup_error team_id=%s error=%s", team_id, e)

    if mode == "salesforce":
        conv_ref.update({
            "status": "with_agent", "assignedAgentId": None,
            "assignedAt": firestore.SERVER_TIMESTAMP, "waitingStartedAt": firestore.SERVER_TIMESTAMP,
        })
    elif mode in ("round_robin", "least_busy"):
        if not auto_assign_agent(org_id, conv_id, team_id, handoff_reason, db=db):
            conv_ref.update({"status": "waiting_agent"})
    else:
        conv_ref.update({"status": "waiting_agent"})
