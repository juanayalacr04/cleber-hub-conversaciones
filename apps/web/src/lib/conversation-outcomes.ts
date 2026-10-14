import type { Timestamp } from "firebase/firestore";

export type ConversationOutcome =
  | "interes_cita"
  | "otro_motivo"
  | "cita_bot"
  | "inactividad"
  | "cita_agente_bdc";

export interface ConversationOutcomeHistoryEntry {
  outcome: ConversationOutcome;
  at: Timestamp;
}

export const OUTCOME_LABELS: Record<ConversationOutcome, string> = {
  interes_cita: "Interés de Cita",
  otro_motivo: "Otro Motivo",
  cita_bot: "Cita Agendada BOT",
  inactividad: "Inactividad",
  cita_agente_bdc: "Cita Agendada Agente BDC",
};

// Estados terminales: una vez alcanzados, ningún trigger automático (bot/crons)
// puede volver a escribir conversationOutcome ni conversationOutcomeHistory —
// solo una acción manual del agente (ver ConversationChat.tsx).
export const TERMINAL_OUTCOMES: ConversationOutcome[] = ["cita_bot", "cita_agente_bdc"];

export const OUTCOME_COLORS: Record<ConversationOutcome, string> = {
  interes_cita: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  otro_motivo: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  cita_bot: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  inactividad: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  cita_agente_bdc: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
};

export const OUTCOME_VALUES: ConversationOutcome[] = [
  "interes_cita",
  "otro_motivo",
  "cita_bot",
  "inactividad",
  "cita_agente_bdc",
];

/**
 * Quién originó la conversación. Sin backfill de histórico (ver doc de
 * segmentación), las conversaciones creadas antes de este cambio no tienen
 * `direction` — este fallback las clasifica igual que hacía la métrica vieja.
 */
export function resolveDirection(c: {
  direction?: string | null;
  broadcastId?: string | null;
  tags?: string[];
}): "inbound" | "outbound" {
  if (c.direction === "inbound" || c.direction === "outbound") return c.direction;
  if (c.broadcastId || c.tags?.includes("broadcast") || c.tags?.includes("situacion_detectada")) {
    return "outbound";
  }
  return "inbound";
}
