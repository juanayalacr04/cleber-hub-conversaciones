import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { verifyAuthToken } from "@/lib/auth-middleware";
import { authorizeOrg } from "@/lib/authz";
import { getSalesforceCredentials, getSalesforceToken } from "@/lib/salesforce-env";

// Allow up to 5 min of execution (Vercel) so large reminder lists finish
// before the function is killed mid-loop (which would leave status="sending").
export const maxDuration = 300;

const RATE_LIMIT_DELAY_MS = 50; // ~20 msg/sec per group
const BATCH_SIZE = 100;
const PARALLEL_GROUPS = 4;
const TWILIO_STATUS_CALLBACK_URL =
  process.env.TWILIO_STATUS_CALLBACK_URL ||
  "https://us-central1-atomic-hybrid-482121-n7.cloudfunctions.net/whatsapp-honda-bot";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatAvailableAt(availableAtMs: number): string {
  const tz = "America/Mexico_City";
  const d = new Date(availableAtMs);
  const timeStr = d.toLocaleTimeString("es-MX", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  const dayStr = d.toLocaleDateString("es-MX", { timeZone: tz });
  const today = new Date();
  const todayStr = today.toLocaleDateString("es-MX", { timeZone: tz });
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const tomorrowStr = tomorrow.toLocaleDateString("es-MX", { timeZone: tz });
  if (dayStr === todayStr) return `hoy a las ${timeStr} (CDMX)`;
  if (dayStr === tomorrowStr) return `mañana a las ${timeStr} (CDMX)`;
  return `${dayStr} a las ${timeStr} (CDMX)`;
}

function buildContextoMessage(recipientName: string, variables: Record<string, string> | null): string {
  const parts: string[] = [];
  if (recipientName) parts.push(`CONTACTO: ${recipientName}`);
  if (variables?.taller) parts.push(`TALLER: ${variables.taller}`);
  if (variables?.auto) parts.push(`AUTO: ${variables.auto}`);
  if (variables?.operacion) parts.push(`OPERACION: ${variables.operacion}`);
  if (variables?.vin) parts.push(`VIN: ${variables.vin}`);
  if (variables?.tipoCita) parts.push(`TIPO CITA: ${variables.tipoCita}`);
  if (variables?.recepcionista) parts.push(`RECEPCIONISTA: ${variables.recepcionista}`);
  if (variables?.email) parts.push(`EMAIL: ${variables.email}`);
  if (variables?.observaciones) parts.push(`OBSERVACIONES: ${variables.observaciones}`);
  if (variables?.fechaCita) parts.push(`FECHA CITA: ${variables.fechaCita}`);
  if (variables?.horaCita) parts.push(`HORA CITA: ${variables.horaCita}`);
  if (variables?.idReservacion) parts.push(`ID RESERVACION: ${variables.idReservacion}`);
  if (variables?.idQuiter) parts.push(`ID QUITER: ${variables.idQuiter}`);
  return `<<CONTEXTO>> ${parts.join(", ")}`;
}

async function primeAbacusSession(botId: string, convId: string, plantilla: string, contexto: string): Promise<void> {
  try {
    const botDoc = await adminDb.collection("bots").doc(botId).get();
    if (!botDoc.exists) return;

    const bot = botDoc.data()!;
    const botType = bot.type || "chatllm";
    const abacus = bot.abacusConfig || {};
    const combinedMessage = `${plantilla}\n${contexto}`;

    if (botType === "workflow") {
      const proxyRes = await fetch(
        `https://api.abacus.ai/api/v0/getApiEndpoint?deploymentId=${encodeURIComponent(abacus.deploymentId)}&deploymentToken=${encodeURIComponent(abacus.deploymentToken)}`
      );
      const proxyData = await proxyRes.json();
      const proxyEndpoint = proxyData?.result?.proxyEndpoint;
      if (!proxyEndpoint) return;

      await fetch(
        `${proxyEndpoint}/api/executeSyncConversationAgent?deploymentToken=${encodeURIComponent(abacus.deploymentToken)}&deploymentId=${encodeURIComponent(abacus.deploymentId)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(abacus.apiKey ? { APIKEY: abacus.apiKey } : {}),
          },
          body: JSON.stringify({
            keywordArguments: { message: combinedMessage },
            externalSessionId: convId,
          }),
        }
      );
    } else if (botType === "chatllm") {
      await fetch("https://api.abacus.ai/api/v0/getConversationResponse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deploymentToken: abacus.deploymentToken,
          deploymentId: abacus.deploymentId,
          message: combinedMessage,
          externalSessionId: convId,
        }),
      });
    }
    // vertex_ai: Firestore history is passed on each call — no priming needed
  } catch (err) {
    console.error(`Error priming Abacus session ${convId}:`, err);
  }
}

async function getOpenConversation(phone: string, organizationId: string): Promise<string | null> {
  const snap = await adminDb
    .collection("conversations")
    .where("customerPhone", "==", `whatsapp:${phone}`)
    .where("organizationId", "==", organizationId)
    .get();

  const open = snap.docs.find((d) => d.data().status !== "closed");
  return open?.id ?? null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await verifyAuthToken(request);
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: broadcastId } = await params;

    // Get broadcast
    const broadcastRef = adminDb.collection("broadcasts").doc(broadcastId);
    const broadcastDoc = await broadcastRef.get();

    if (!broadcastDoc.exists) {
      return NextResponse.json({ error: "Broadcast not found" }, { status: 404 });
    }

    const broadcast = broadcastDoc.data()!;

    const denied = await authorizeOrg(authUser.uid, broadcast.organizationId, { write: true });
    if (denied) return denied;

    if (broadcast.status !== "draft" && broadcast.status !== "sending") {
      return NextResponse.json(
        { error: `Broadcast is already ${broadcast.status}` },
        { status: 400 }
      );
    }

    // Get WhatsApp number config
    const waNumberDoc = await adminDb
      .collection("whatsappNumbers")
      .doc(broadcast.whatsappNumberId)
      .get();

    if (!waNumberDoc.exists) {
      return NextResponse.json({ error: "WhatsApp number not found" }, { status: 404 });
    }

    const waNumber = waNumberDoc.data()!;
    const provider = waNumber.provider || "twilio";

    // Get provider credentials
    let metaPhoneNumberId = "";
    let metaAccessToken = "";
    let twilioClient: ReturnType<typeof twilio> | null = null;
    let twilioFromNumber = "";
    let sfAccessToken = "";
    let sfInstanceUrl = "";
    let valuetextSenderId = "";

    if (provider === "meta") {
      metaPhoneNumberId = waNumber.metaPhoneNumberId || "";
      metaAccessToken = waNumber.metaAccessToken || "";
      if (!metaPhoneNumberId || !metaAccessToken) {
        return NextResponse.json({ error: "Meta credentials not configured" }, { status: 500 });
      }
    } else if (provider === "twilio") {
      const accountSid = waNumber.twilioAccountSid || "";
      const authToken = waNumber.twilioAuthToken || "";
      twilioFromNumber = waNumber.phoneNumber || "";
      if (!accountSid || !authToken || !twilioFromNumber) {
        return NextResponse.json({ error: "Twilio credentials not configured" }, { status: 500 });
      }
      twilioClient = twilio(accountSid, authToken);
    } else if (provider === "valuetext") {
      valuetextSenderId = waNumber.valuetextSenderId || "";
      const sfCreds = getSalesforceCredentials(broadcast.vertical);
      if (!sfCreds) {
        return NextResponse.json({ error: "Salesforce credentials not configured (SF_* env)" }, { status: 500 });
      }
      try {
        const sfToken = await getSalesforceToken(sfCreds);
        sfAccessToken = sfToken.accessToken;
        sfInstanceUrl = sfToken.instanceUrl;
      } catch {
        return NextResponse.json({ error: "Salesforce auth failed" }, { status: 500 });
      }
    }

    // Mark as "sending" on first call; allow resuming if interrupted
    if (broadcast.status === "draft") {
      await broadcastRef.update({
        status: "sending",
        sendingStartedAt: FieldValue.serverTimestamp(),
      });
    }

    const WINDOW_MS = 24 * 60 * 60 * 1000;
    const templateText = `[Template: ${broadcast.templateName}]`;

    // Fetch all pending recipients, then split into parallel groups
    const allPending = await broadcastRef
      .collection("recipients")
      .where("status", "==", "pending")
      .get();

    const groups = allPending.docs.reduce<FirebaseFirestore.QueryDocumentSnapshot[][]>(
      (acc, doc, i) => { acc[i % PARALLEL_GROUPS].push(doc); return acc; },
      Array.from({ length: PARALLEL_GROUPS }, () => [])
    );

    const groupResults = await Promise.all(groups.map(async (group) => {
      let sentCount = 0;
      let failedCount = 0;
      let skippedCount = 0;

      for (const recipientDoc of group) {
      const recipient = recipientDoc.data();

      try {
        const plantillaMsg = broadcast.templateBody
          ? `<<PLANTILLA>> ${broadcast.templateBody}`
          : `<<PLANTILLA>> ${broadcast.templateName}`;
        const contextoMsg = buildContextoMessage(
          recipient.name || "",
          (recipient.variables as Record<string, string> | null) ?? null
        );

        // 1. Find open conversation or create new one
        const existingConvId = await getOpenConversation(recipient.phone, broadcast.organizationId);
        const now = FieldValue.serverTimestamp();
        const nowMs = Date.now();
        let convId: string;

        if (existingConvId) {
          // Check 24-hour window: skip if customer or we sent a template recently
          const convDoc = await adminDb.collection("conversations").doc(existingConvId).get();
          const convData = convDoc.data()!;

          const lastCustomerAt: Date | undefined = convData.lastCustomerMessageAt?.toDate?.();
          const lastTemplateAt: Date | undefined = convData.lastTemplateSentAt?.toDate?.();

          // Block only if we sent a template recently AND the customer hasn't replied since
          const templateRecentAndUnanswered =
            lastTemplateAt &&
            (nowMs - lastTemplateAt.getTime()) < WINDOW_MS &&
            (!lastCustomerAt || lastCustomerAt.getTime() < lastTemplateAt.getTime());

          if (templateRecentAndUnanswered) {
            const availableAt = formatAvailableAt(lastTemplateAt!.getTime() + WINDOW_MS);
            await recipientDoc.ref.update({
              status: "skipped",
              errorMessage: `Plantilla sin respuesta en las últimas 24h — puedes enviar ${availableAt}`,
            });
            skippedCount++;
            continue;
          }

          // Existing open conversation — add context messages and update lastTemplateSentAt
          convId = existingConvId;
          const convRef = adminDb.collection("conversations").doc(convId);
          const m1 = convRef.collection("messages").doc();
          const m2 = convRef.collection("messages").doc();
          await Promise.all([
            m1.set({ id: m1.id, conversationId: convId, sender: "bot", agentId: null, text: plantillaMsg, mediaUrl: null, createdAt: now }),
            m2.set({ id: m2.id, conversationId: convId, sender: "bot", agentId: null, text: contextoMsg, mediaUrl: null, createdAt: now }),
            convRef.update({
              lastTemplateSentAt: now,
              lastBroadcastRecipientId: recipientDoc.ref.id,
              broadcastId: broadcastId,
              broadcastName: broadcast.name || null,
            }),
          ]);
        } else {
          // No open conversation — create from scratch
          const convRef = adminDb.collection("conversations").doc();
          convId = convRef.id;
          await convRef.set({
            id: convId,
            botId: broadcast.botId,
            organizationId: broadcast.organizationId,
            customerPhone: `whatsapp:${recipient.phone}`,
            customerName: recipient.name || null,
            status: "bot",
            assignedAgentId: null,
            priority: "normal",
            tags: ["broadcast"],
            lastMessageAt: now,
            lastTemplateSentAt: now,
            createdAt: now,
            broadcastId: broadcastId,
            broadcastName: broadcast.name || null,
            lastBroadcastRecipientId: recipientDoc.ref.id,
            broadcastContext: buildRecipientContext(broadcast.botInstructions, recipient as { name?: string; phone: string; variables?: Record<string, string> | null }),
            whatsappNumberId: broadcast.whatsappNumberId,
            teamId: waNumber.teamId || null,
            vertical: broadcast.vertical ?? null,
            assignedAgentType: "bot",
            assignedBotId: broadcast.botId,
            assignedUserId: null,
            direction: "outbound",
          });
          const m1 = convRef.collection("messages").doc();
          const m2 = convRef.collection("messages").doc();
          await Promise.all([
            m1.set({ id: m1.id, conversationId: convId, sender: "bot", agentId: null, text: plantillaMsg, mediaUrl: null, createdAt: now }),
            m2.set({ id: m2.id, conversationId: convId, sender: "bot", agentId: null, text: contextoMsg, mediaUrl: null, createdAt: now }),
          ]);
        }

        // Prime Abacus session with template + context before customer replies.
        // Fire-and-forget: this makes 1-2 slow calls to Abacus per recipient and
        // awaiting it serially was the main cause of the function timing out (and
        // leaving the broadcast stuck in "sending"). The session only needs to be
        // primed before the customer replies, which is far slower than this loop.
        void primeAbacusSession(broadcast.botId, convId, plantillaMsg, contextoMsg);

        // 3. Send template via provider
        let whatsappMessageId: string | null = null;
        const recipientPhone = recipient.phone.replace("+", "");

        // Merge default template components with per-recipient variables
        const components = buildTemplateComponents(
          broadcast.templateComponents || [],
          recipient.variables
        );

        if (provider === "meta") {
          const metaResponse = await fetch(
            `https://graph.facebook.com/v21.0/${metaPhoneNumberId}/messages`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${metaAccessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                messaging_product: "whatsapp",
                to: recipientPhone,
                type: "template",
                template: {
                  name: broadcast.templateName,
                  language: { code: broadcast.templateLanguage || "es" },
                  components,
                },
              }),
            }
          );

          if (!metaResponse.ok) {
            const errorText = await metaResponse.text();
            throw new Error(`Meta API error ${metaResponse.status}: ${errorText}`);
          }

          const metaResult = await metaResponse.json();
          whatsappMessageId = metaResult.messages?.[0]?.id || null;
        } else if (provider === "twilio") {
          // Build content variables from recipient
          const contentVariables = recipient.variables
            ? JSON.stringify(recipient.variables)
            : undefined;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const msgOptions: any = {
            from: twilioFromNumber,
            to: `whatsapp:${recipient.phone}`,
            statusCallback: TWILIO_STATUS_CALLBACK_URL,
          };

          if (broadcast.contentSid) {
            msgOptions.contentSid = broadcast.contentSid;
            if (contentVariables) {
              msgOptions.contentVariables = contentVariables;
            }
          } else {
            msgOptions.body = templateText;
          }

          const twilioMsg = await twilioClient!.messages.create(msgOptions);
          whatsappMessageId = twilioMsg.sid;
        } else if (provider === "valuetext") {
          const sfResponse = await fetch(
            `${sfInstanceUrl}/services/data/v59.0/sobjects/rsplus__SMS_Bucket__c/`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${sfAccessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                rsplus__Number__c: recipient.phone,
                rsplus__Sender_ID__c: valuetextSenderId,
                Origen__c: "Plataforma IA",
                ...(broadcast.templateName ? { rsplus__Template_ID__c: broadcast.templateName } : {}),
                ...(recipient.salesforceRecordId ? { rsplus__Related_To__c: recipient.salesforceRecordId } : {}),
                // Plantillas ValueText por objeto de Salesforce (capacidad de Comercial)
                ...(broadcast.valuetextObjectApi
                  ? {
                      rsplus__Object_API__c: broadcast.valuetextObjectApi,
                      rsplus__Message__c: `[Template: ${broadcast.templateName}]`,
                      ...(recipient.salesforceRecordId ? { rsplus__Record_Id__c: recipient.salesforceRecordId } : {}),
                    }
                  : {}),
              }),
            }
          );

          if (!sfResponse.ok) {
            const errorText = await sfResponse.text();
            throw new Error(`Salesforce API error ${sfResponse.status}: ${errorText}`);
          }

          const sfResult = await sfResponse.json();
          whatsappMessageId = sfResult.id || null;
        }

        // 4. Update recipient
        await recipientDoc.ref.update({
          status: "sent",
          conversationId: convId,
          whatsappMessageId,
          errorMessage: null,
          sentAt: FieldValue.serverTimestamp(),
        });

        sentCount++;

        // Rate limiting
        await sleep(RATE_LIMIT_DELAY_MS);
      } catch (error) {
        console.error(`Error sending to ${recipient.phone}:`, error);
        failedCount++;

        await recipientDoc.ref.update({
          status: "failed",
          errorMessage: error instanceof Error ? error.message : "Unknown error",
        });
      }
      }

      await broadcastRef.update({
        sentCount: FieldValue.increment(sentCount),
        failedCount: FieldValue.increment(failedCount),
        skippedCount: FieldValue.increment(skippedCount),
      });

      return { sentCount, failedCount, skippedCount };
    }));

    const totalSent = groupResults.reduce((s, r) => s + r.sentCount, 0);
    const totalFailed = groupResults.reduce((s, r) => s + r.failedCount, 0);
    const totalSkipped = groupResults.reduce((s, r) => s + r.skippedCount, 0);

    await broadcastRef.update({
      status: totalSent === 0 && totalFailed > 0 ? "failed" : "completed",
      completedAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({
      done: true,
      sentCount: totalSent,
      failedCount: totalFailed,
      skippedCount: totalSkipped,
    });
  } catch (error) {
    console.error("Error sending broadcast:", error);
    return NextResponse.json({ error: "Failed to send broadcast" }, { status: 500 });
  }
}

/**
 * Build per-recipient context for the bot by combining broadcast botInstructions
 * with recipient-specific variables (name, appointment time, etc.).
 */
function buildRecipientContext(
  botInstructions: string | null,
  recipient: { name?: string; phone: string; variables?: Record<string, string> | null }
): string | null {
  const parts: string[] = [];

  if (botInstructions) {
    parts.push(botInstructions);
  }

  if (recipient.name) {
    parts.push(`Nombre del cliente: ${recipient.name}`);
  }

  if (recipient.variables && Object.keys(recipient.variables).length > 0) {
    const varsText = Object.entries(recipient.variables)
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ");
    parts.push(`Datos adicionales: ${varsText}`);
  }

  return parts.length > 0 ? parts.join(". ") : null;
}

/**
 * Build template components merging default values with per-recipient variables.
 * Per-recipient variables override defaults.
 */
function buildTemplateComponents(
  defaultComponents: Record<string, unknown>[],
  recipientVariables: Record<string, string> | null
): Record<string, unknown>[] {
  if (!recipientVariables || !defaultComponents.length) {
    return defaultComponents;
  }

  // Deep clone and override parameters with recipient-specific variables
  return defaultComponents.map((component) => {
    const cloned = JSON.parse(JSON.stringify(component));
    if (cloned.type === "body" && Array.isArray(cloned.parameters)) {
      cloned.parameters = cloned.parameters.map(
        (param: Record<string, unknown>, index: number) => {
          const key = String(index + 1);
          if (recipientVariables[key]) {
            return { ...param, type: "text", text: recipientVariables[key] };
          }
          return param;
        }
      );
    }
    return cloned;
  });
}
