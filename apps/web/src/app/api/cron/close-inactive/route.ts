import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { isCronAuthorized } from "@/lib/cron-auth";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { TERMINAL_OUTCOMES } from "@/lib/conversation-outcomes";

const DEFAULT_INACTIVITY_HOURS = 2;

async function closeInactiveConversations(request: NextRequest) {
  try {
    if (!isCronAuthorized(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const now = Date.now();

    // Cargar inactivityCloseHours de todos los whatsappNumbers activos
    const waSnap = await adminDb.collection("whatsappNumbers").where("status", "==", "active").get();
    const hoursMap = new Map<string, number>();
    let minHours = DEFAULT_INACTIVITY_HOURS;
    for (const doc of waSnap.docs) {
      const h = doc.data().inactivityCloseHours;
      const hours = typeof h === "number" && h > 0 ? h : DEFAULT_INACTIVITY_HOURS;
      hoursMap.set(doc.id, hours);
      if (hours < minHours) minHours = hours;
    }

    // waiting_agent y with_agent siempre; bot solo si ya tiene cita (esas no reciben recordatorios)
    const earliestCutoff = new Date(now - minHours * 60 * 60 * 1000);
    const statuses = ["bot", "waiting_agent", "with_agent"];

    const snapshot = await adminDb
      .collection("conversations")
      .where("status", "in", statuses)
      .where("lastMessageAt", "<", earliestCutoff)
      .get();

    if (snapshot.empty) {
      return NextResponse.json({ closed: 0, message: "No inactive conversations" });
    }

    const batch = adminDb.batch();
    const closedIds: string[] = [];

    for (const doc of snapshot.docs) {
      const conv = doc.data();
      const waId: string | undefined = conv.whatsappNumberId;
      const thresholdHours = (waId ? hoursMap.get(waId) : undefined) ?? DEFAULT_INACTIVITY_HOURS;
      const cutoff = new Date(now - thresholdHours * 60 * 60 * 1000);

      const lastMessageAt: Date | null = conv.lastMessageAt?.toDate?.() ?? null;
      if (!lastMessageAt || lastMessageAt >= cutoff) continue;

      // Conversaciones bot sin cita las maneja inactivity_followup con recordatorios
      const hasAppointment = conv.appointmentStatus === "cita_bot" || conv.appointmentStatus === "cita_agente";
      if (conv.status === "bot" && !hasAppointment) continue;

      // statusBeforeClose/agentBeforeClose los lee el reopen en main.py: si la conversación
      // ya la traía un asesor cuando se cerró, al reabrirse vuelve con él y no al bot.
      const updates: Record<string, unknown> = {
        status: "closed",
        statusBeforeClose: conv.status ?? null,
        agentBeforeClose: conv.assignedAgentId ?? null,
        assignedAgentId: null,
        assignedAt: null,
        closedAt: FieldValue.serverTimestamp(),
        closedReason: "inactivity",
      };
      // Outcome "inactividad" (como Servicio), sin pisar un outcome terminal (cita agendada)
      if (!TERMINAL_OUTCOMES.includes(conv.conversationOutcome)) {
        updates.conversationOutcome = "inactividad";
        updates.conversationOutcomeAt = FieldValue.serverTimestamp();
        updates.conversationOutcomeHistory = FieldValue.arrayUnion({ outcome: "inactividad", at: Timestamp.now() });
      }
      batch.update(doc.ref, updates);
      closedIds.push(doc.id);
    }

    if (closedIds.length > 0) await batch.commit();

    console.log(`Closed ${closedIds.length} inactive conversations:`, closedIds);

    return NextResponse.json({
      closed: closedIds.length,
      conversationIds: closedIds,
    });
  } catch (error) {
    console.error("Error closing inactive conversations:", error);
    return NextResponse.json(
      { error: "Failed to close inactive conversations" },
      { status: 500 }
    );
  }
}

// GET: called by Vercel Cron
export async function GET(request: NextRequest) {
  return closeInactiveConversations(request);
}

// POST: called manually or from external cron services
export async function POST(request: NextRequest) {
  return closeInactiveConversations(request);
}
