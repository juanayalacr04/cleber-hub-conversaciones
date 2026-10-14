/**
 * Autorización de las rutas de API. Estas rutas usan el Admin SDK, que no pasa por las reglas de
 * Firestore, así que lo que las reglas garantizan al navegador hay que garantizarlo aquí:
 * pertenecer a la organización del recurso, y el equipo para quien no es admin.
 */
import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

export interface Requester {
  uid: string;
  role: string;
  isSuperAdmin: boolean;
  orgIds: string[];
  orgTeams: Record<string, string>;
  teamId: string | null;
}

export async function loadRequester(uid: string): Promise<Requester | null> {
  const doc = await adminDb.collection("users").doc(uid).get();
  if (!doc.exists) return null;
  const d = doc.data()!;
  return {
    uid,
    role: d.role ?? "viewer",
    isSuperAdmin: d.isSuperAdmin === true,
    orgIds: d.organizationIds ?? (d.organizationId ? [d.organizationId] : []),
    orgTeams: d.orgTeams ?? {},
    teamId: d.teamId ?? null,
  };
}

export const inOrg = (r: Requester, orgId: string | null | undefined): boolean =>
  r.isSuperAdmin || (!!orgId && r.orgIds.includes(orgId));

export const isAdminIn = (r: Requester, orgId: string | null | undefined): boolean =>
  r.isSuperAdmin || (r.role === "admin" && inOrg(r, orgId));

/** Equipo del usuario en una organización: `orgTeams` manda sobre el `teamId` plano (legado). */
export const teamIn = (r: Requester, orgId: string): string | null => r.orgTeams[orgId] ?? r.teamId;

/** Misma regla que Firestore: admin ve toda su organización; el agente, solo su equipo. */
export function canAccessConversation(r: Requester, conv: { organizationId?: string; teamId?: string | null }): boolean {
  if (!inOrg(r, conv.organizationId)) return false;
  if (isAdminIn(r, conv.organizationId)) return true;
  const team = teamIn(r, conv.organizationId!);
  return !!team && team === conv.teamId;
}

const forbidden = (msg = "No tienes permiso para esta operación") => NextResponse.json({ error: msg }, { status: 403 });

/**
 * Verifica que el usuario pertenezca a la organización. `write` exige rol admin o agente (no viewer);
 * `admin` exige administrador. Devuelve la respuesta 403 si no procede, o null si está autorizado.
 */
export async function authorizeOrg(uid: string, orgId: string | null | undefined, opts: { write?: boolean; admin?: boolean } = {}): Promise<NextResponse | null> {
  const r = await loadRequester(uid);
  if (!r || !inOrg(r, orgId)) return forbidden();
  if (opts.admin && !isAdminIn(r, orgId)) return forbidden("Solo un administrador puede hacer esto");
  if (opts.write && !r.isSuperAdmin && !["admin", "agent"].includes(r.role)) return forbidden();
  return null;
}

/** SOQL de solo lectura: una sola sentencia SELECT. */
export function isReadOnlySoql(soql: string): boolean {
  const s = soql.trim();
  return /^select\s/i.test(s) && !s.includes(";") && s.length <= 4000;
}
