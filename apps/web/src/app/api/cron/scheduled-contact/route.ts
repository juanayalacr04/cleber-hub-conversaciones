import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { isCronAuthorized } from "@/lib/cron-auth";
import { Timestamp } from "firebase-admin/firestore";

const SCHEDULED_CONTACT_FUNCTION_URL = process.env.INACTIVITY_FUNCTION_URL!;
const CRON_SECRET = process.env.CRON_SECRET;
const WINDOW_24H_MS = 24 * 60 * 60 * 1000;

async function processScheduledContacts(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const nowTimestamp = Timestamp.fromMillis(now);

  // Buscar convs donde el cliente pidió ser contactado y ya llegó la hora
  const convSnap = await adminDb
    .collection("conversations")
    .where("status", "==", "bot")
    .where("scheduledContactAt", "<=", nowTimestamp)
    .get();

  if (convSnap.empty) {
    return NextResponse.json({ processed: 0, skipped: 0 });
  }

  // Cache de whatsappNumbers para no hacer N queries
  const waNumberCache = new Map<string, Record<string, unknown>>();
  const results = { processed: 0, skipped: 0, errors: 0 };
  const tasks: Promise<void>[] = [];

  for (const convDoc of convSnap.docs) {
    const conv = convDoc.data();

    // Determinar si la ventana de 24h sigue abierta
    const lastCustomerMsgAt: Date | null = conv.lastCustomerMessageAt?.toDate?.() ?? null;
    const windowOpen = lastCustomerMsgAt && now - lastCustomerMsgAt.getTime() < WINDOW_24H_MS;

    const useTemplate = !windowOpen;
    let templateId: string | null = null;

    if (useTemplate) {
      const waId: string = conv.whatsappNumberId;
      if (waId) {
        if (!waNumberCache.has(waId)) {
          const waDoc = await adminDb.collection("whatsappNumbers").doc(waId).get();
          waNumberCache.set(waId, waDoc.exists ? (waDoc.data() as Record<string, unknown>) : {});
        }
        templateId = (waNumberCache.get(waId)!.scheduledContactTemplateId as string) ?? null;
      }
      if (!templateId) {
        // Sin template configurado no podemos reabrir la ventana — skip sin limpiar el campo
        console.warn(`No scheduledContactTemplateId for conv ${convDoc.id}, skipping`);
        results.skipped++;
        continue;
      }
    }

    tasks.push(
      callScheduledContactFunction({
        convId: convDoc.id,
        botId: conv.botId,
        useTemplate,
        templateId,
      })
        .then(() => { results.processed++; })
        .catch((err) => {
          console.error(`scheduled-contact error for conv ${convDoc.id}:`, err);
          results.errors++;
        })
    );
  }

  const batchSize = 10;
  for (let i = 0; i < tasks.length; i += batchSize) {
    await Promise.allSettled(tasks.slice(i, i + batchSize));
  }

  return NextResponse.json(results);
}

async function callScheduledContactFunction(payload: {
  convId: string;
  botId: string;
  useTemplate: boolean;
  templateId: string | null;
}) {
  if (!SCHEDULED_CONTACT_FUNCTION_URL) throw new Error("INACTIVITY_FUNCTION_URL no está configurada");
  const res = await fetch(SCHEDULED_CONTACT_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cron-Secret": CRON_SECRET ?? "",
    },
    body: JSON.stringify({ type: "scheduled_contact", ...payload }),
    signal: AbortSignal.timeout(150_000),
  });
  if (!res.ok) throw new Error(`Cloud Function returned ${res.status}`);
}

export async function GET(request: NextRequest) {
  return processScheduledContacts(request);
}

export async function POST(request: NextRequest) {
  return processScheduledContacts(request);
}
