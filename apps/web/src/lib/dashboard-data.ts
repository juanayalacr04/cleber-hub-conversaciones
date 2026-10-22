/**
 * Consultas del dashboard por módulo. Todas cuentan en el servidor (getCountFromServer) y se acotan por
 * organización y, en un módulo, por `conversations.vertical`. Un agente solo puede consultar su equipo
 * (lo exigen las reglas de Firestore), así que a él se le agrega `teamId` y no ve métricas históricas.
 */
import { collection, getCountFromServer, getDocs, limit, query, Timestamp, where, type QueryConstraint } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { OUTCOME_VALUES, type ConversationOutcome } from "@/lib/conversation-outcomes";
import type { Vertical } from "@/lib/modules";

export interface Scope {
  orgId: string;
  vertical: Vertical | null; // null = todos los módulos
  teamId?: string | null; // solo para quien no es admin
}

const conversations = () => collection(db, "conversations");

function base(scope: Scope): QueryConstraint[] {
  const c: QueryConstraint[] = [where("organizationId", "==", scope.orgId)];
  if (scope.vertical) c.push(where("vertical", "==", scope.vertical));
  if (scope.teamId) c.push(where("teamId", "==", scope.teamId));
  return c;
}

const count = async (...c: QueryConstraint[]) => (await getCountFromServer(query(conversations(), ...c))).data().count;

export interface LiveStats {
  waiting: number;
  bot: number;
  withAgent: number;
  active: number;
}

export async function loadLiveStats(scope: Scope): Promise<LiveStats> {
  const [waiting, bot, withAgent] = await Promise.all([
    count(...base(scope), where("status", "==", "waiting_agent")),
    count(...base(scope), where("status", "==", "bot")),
    count(...base(scope), where("status", "==", "with_agent")),
  ]);
  return { waiting, bot, withAgent, active: waiting + bot + withAgent };
}

export interface HistoricalStats {
  total: number;
  inbound: number;
  outbound: number;
  citasBot: number;
  citasAgente: number;
  prospectos: number;
  outcomes: Record<ConversationOutcome, number>;
}

export async function loadHistoricalStats(scope: Scope, from: string, to: string): Promise<HistoricalStats> {
  const start = Timestamp.fromDate(new Date(`${from}T00:00:00`));
  const end = Timestamp.fromDate(new Date(`${to}T23:59:59`));
  const created = [...base(scope), where("createdAt", ">=", start), where("createdAt", "<=", end)];
  const cited = [...base(scope), where("appointmentDate", ">=", start), where("appointmentDate", "<=", end)];
  const inbound = [...created, where("direction", "==", "inbound")];

  const [total, inboundN, outbound, citasBot, citasAgente, prospectos, ...outcomes] = await Promise.all([
    count(...created),
    count(...inbound),
    count(...created, where("direction", "==", "outbound")),
    count(...cited, where("appointmentStatus", "==", "cita_bot")),
    count(...cited, where("appointmentStatus", "==", "cita_agente")),
    count(...created, where("completedLead", "==", true)),
    ...OUTCOME_VALUES.map((o) => count(...inbound, where("conversationOutcome", "==", o))),
  ]);
  return {
    total, inbound: inboundN, outbound, citasBot, citasAgente, prospectos,
    outcomes: Object.fromEntries(OUTCOME_VALUES.map((o, i) => [o, outcomes[i]])) as Record<ConversationOutcome, number>,
  };
}

/** Tiempo medio de primera respuesta del agente, en texto ("12 min", "1h 5m") o null si no hay datos. */
export async function loadAvgResponse(scope: Scope, agentId?: string | null): Promise<string | null> {
  const q = query(conversations(), where("organizationId", "==", scope.orgId), where("responseTimeSecs", ">", 0), limit(200));
  const docs = (await getDocs(q)).docs.map((d) => d.data());
  const mine = docs.filter((d) => (!scope.vertical || d.vertical === scope.vertical) && (!scope.teamId || d.teamId === scope.teamId) && (!agentId || d.assignedAgentId === agentId));
  const times: number[] = [];
  for (const d of mine) {
    if (Array.isArray(d.responseTimes) && d.responseTimes.length) times.push(...d.responseTimes);
    else if (typeof d.responseTimeSecs === "number" && d.responseTimeSecs > 0) times.push(d.responseTimeSecs);
  }
  if (!times.length) return null;
  const mins = Math.round(times.reduce((a, b) => a + b, 0) / times.length / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export interface WaitingItem {
  id: string;
  name: string;
  preview: string;
  status: string;
}

/** Conversaciones que piden atención ahora (esperando agente). */
export async function loadWaiting(scope: Scope, max = 6): Promise<WaitingItem[]> {
  const snap = await getDocs(query(conversations(), ...base(scope), where("status", "==", "waiting_agent"), limit(max)));
  return snap.docs.map((d) => {
    const x = d.data();
    return { id: d.id, name: x.customerName || x.customerPhone || "Cliente", preview: x.lastMessagePreview || "", status: x.status };
  });
}
