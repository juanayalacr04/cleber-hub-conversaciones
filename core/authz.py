"""Permisos de los usuarios del dashboard (tarea 1.37).

Port a Python de `apps/web/src/lib/authz.ts` y de las reglas de escritura de `firestore.rules`. Con la
función 2 como única puerta de escritura (1.39, 1.40), este es el único lugar donde se decide quién puede
hacer qué: pertenecer a la organización, el equipo para quien no es admin y el agente asignado.

Todo opera sobre datos ya leídos: no toca Firestore salvo `load_requester`.
"""
from dataclasses import dataclass, field

WRITE_ROLES = ("admin", "agent")


@dataclass
class Requester:
    uid: str
    role: str = "viewer"
    is_super_admin: bool = False
    org_ids: list = field(default_factory=list)
    org_teams: dict = field(default_factory=dict)
    team_id: str | None = None


def load_requester(db, uid: str) -> Requester | None:
    """El usuario de `users/{uid}`, o None si no está registrado."""
    snap = db.collection("users").document(uid).get()
    if not snap.exists:
        return None
    d = snap.to_dict() or {}
    return Requester(
        uid=uid,
        role=d.get("role") or "viewer",
        is_super_admin=d.get("isSuperAdmin") is True,
        # Formato nuevo (`organizationIds`) o legado (`organizationId`)
        org_ids=list(d.get("organizationIds") or ([d["organizationId"]] if d.get("organizationId") else [])),
        org_teams=d.get("orgTeams") or {},
        team_id=d.get("teamId"),
    )


def in_org(r: Requester, org_id: str | None) -> bool:
    return r.is_super_admin or (bool(org_id) and org_id in r.org_ids)


def is_admin_in(r: Requester, org_id: str | None) -> bool:
    return r.is_super_admin or (r.role == "admin" and in_org(r, org_id))


def can_write(r: Requester) -> bool:
    """Rol que puede escribir: admin o agente (el viewer solo lee)."""
    return r.is_super_admin or r.role in WRITE_ROLES


def team_in(r: Requester, org_id: str) -> str | None:
    """Equipo del usuario en una organización: `orgTeams` manda sobre el `teamId` plano (legado)."""
    return r.org_teams.get(org_id) or r.team_id


def can_access_conversation(r: Requester, conv: dict) -> bool:
    """Admin ve toda su organización; el agente, solo su equipo. Sin equipo en el documento: solo admins."""
    org_id = conv.get("organizationId")
    if not in_org(r, org_id):
        return False
    if is_admin_in(r, org_id):
        return True
    team = team_in(r, org_id)
    return bool(team) and team == conv.get("teamId")


def can_act_on_conversation(r: Requester, conv: dict) -> bool:
    """Escribir sobre una conversación (la regla `update` de Firestore).

    Con la conversación tomada (`with_agent`), solo su agente asignado o un admin. Quién puede *tomarla*
    o reasignarla (solo admin) lo decide la acción con `is_admin_in`, no esta función.
    """
    org_id = conv.get("organizationId")
    if not can_write(r) or not can_access_conversation(r, conv):
        return False
    if is_admin_in(r, org_id):
        return True
    if conv.get("status") == "with_agent":
        return conv.get("assignedAgentId") == r.uid
    return True
