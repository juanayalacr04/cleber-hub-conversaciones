import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { verifyAuthToken } from "@/lib/auth-middleware";
import { getSalesforceCredentials, getSalesforceToken } from "@/lib/salesforce-env";

const RATE_LIMIT_DELAY_MS = 200;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatAvailableAt(availableAtMs: number): string {
  const d = new Date(availableAtMs);
  const hours = d.getHours().toString().padStart(2, "0");
  const minutes = d.getMinutes().toString().padStart(2, "0");
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return `hoy a las ${hours}:${minutes}`;
  if (d.toDateString() === tomorrow.toDateString()) return `mañana a las ${hours}:${minutes}`;
  return `${d.getDate()}/${d.getMonth() + 1} a las ${hours}:${minutes}`;
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

async function getOpenConversation(phone: string, organizationId: string): Promise<string | null> {
  const snap = await adminDb
    .collection("conversations")
    .where("customerPhone", "==", `whatsapp:${phone}`)
    .where("organizationId", "==", organizationId)
    .orderBy("lastMessageAt", "desc")
    .get();
  const open = snap.docs.find((d) => d.data().status !== "closed");
  return open?.id ?? null;
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
  } catch (err) {
    console.error(`Error priming Abacus session ${convId}:`, err);
  }
}

function buildTemplateComponents(
  defaultComponents: Record<string, unknown>[],
  recipientVariables: Record<string, string> | null
): Record<string, unknown>[] {
  if (!recipientVariables || !defaultComponents.length) return defaultComponents;
  return defaultComponents.map((component) => {
    const cloned = JSON.parse(JSON.stringify(component));
    if (cloned.type === "body" && Array.isArray(cloned.parameters)) {
      cloned.parameters = cloned.parameters.map(
        (param: Record<string, unknown>, index: number) => {
          const key = String(index + 1);
          if (recipientVariables[key]) return { ...param, type: "text", text: recipientVariables[key] };
          return param;
        }
      );
    }
    return cloned;
  });
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

    const callerDoc = await adminDb.collection("users").doc(authUser.uid).get();
    if (!callerDoc.data()?.isSuperAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const { id: broadcastId } = await params;
    const body = await request.json();
    const testPhone: string = body.testPhone;
    const recipientId: string | undefined = body.recipientId;
    const count = 1;

    if (!testPhone) {
      return NextResponse.json({ error: "testPhone is required" }, { status: 400 });
    }

    const broadcastRef = adminDb.collection("broadcasts").doc(broadcastId);
    const broadcastDoc = await broadcastRef.get();
    if (!broadcastDoc.exists) {
      return NextResponse.json({ error: "Broadcast not found" }, { status: 404 });
    }

    const broadcast = broadcastDoc.data()!;

    const waNumberDoc = await adminDb.collection("whatsappNumbers").doc(broadcast.whatsappNumberId).get();
    if (!waNumberDoc.exists) {
      return NextResponse.json({ error: "WhatsApp number not found" }, { status: 404 });
    }

    const waNumber = waNumberDoc.data()!;
    const provider = waNumber.provider || "twilio";

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

    let recipientDocs: FirebaseFirestore.DocumentSnapshot[];
    if (recipientId) {
      const recipientDoc = await broadcastRef.collection("recipients").doc(recipientId).get();
      if (!recipientDoc.exists) {
        return NextResponse.json({ error: "Destinatario no encontrado" }, { status: 404 });
      }
      recipientDocs = [recipientDoc];
    } else {
      const recipientsSnap = await broadcastRef.collection("recipients").limit(count).get();
      recipientDocs = recipientsSnap.docs;
    }

    const templateText = `[Template: ${broadcast.templateName}]`;
    const testPhoneRaw = testPhone.replace(/\D/g, "");
    const testPhoneE164 = `+${testPhoneRaw}`;
    // Normalize to match how the webhook stores customerPhone (strips leading 1 from 521 numbers)
    const testPhoneNormalized = (() => {
      if (testPhoneRaw.length === 13 && testPhoneRaw.startsWith("521")) return `+52${testPhoneRaw.slice(3)}`;
      if (testPhoneRaw.length === 12 && testPhoneRaw.startsWith("52")) return `+${testPhoneRaw}`;
      if (testPhoneRaw.length === 10) return `+52${testPhoneRaw}`;
      return testPhoneE164;
    })();
    const results: { index: number; success: boolean; conversationId?: string; error?: string }[] = [];

    const WINDOW_MS = 24 * 60 * 60 * 1000;

    for (let i = 0; i < recipientDocs.length; i++) {
      const recipient = recipientDocs[i].data()!;

      try {
        // 1. Check 24-hour window BEFORE sending to provider
        const existingConvId = await getOpenConversation(testPhoneNormalized, broadcast.organizationId);

        if (existingConvId) {
          const convDoc = await adminDb.collection("conversations").doc(existingConvId).get();
          const convData = convDoc.data()!;
          const nowMs = Date.now();

          const lastCustomerAt: Date | undefined = convData.lastCustomerMessageAt?.toDate?.();
          const lastTemplateAt: Date | undefined = convData.lastTemplateSentAt?.toDate?.();

          const templateRecentAndUnanswered =
            lastTemplateAt &&
            (nowMs - lastTemplateAt.getTime()) < WINDOW_MS &&
            (!lastCustomerAt || lastCustomerAt.getTime() < lastTemplateAt.getTime());

          if (templateRecentAndUnanswered) {
            const availableAt = formatAvailableAt(lastTemplateAt!.getTime() + WINDOW_MS);
            results.push({ index: i + 1, success: false, error: `Plantilla sin respuesta en las últimas 24h — puedes enviar ${availableAt}` });
            continue;
          }
        }

        // 2. Send to provider
        const components = buildTemplateComponents(broadcast.templateComponents || [], recipient.variables);

        if (provider === "meta") {
          const metaResponse = await fetch(
            `https://graph.facebook.com/v21.0/${metaPhoneNumberId}/messages`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${metaAccessToken}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                messaging_product: "whatsapp",
                to: testPhoneNormalized,
                type: "template",
                template: { name: broadcast.templateName, language: { code: broadcast.templateLanguage || "es" }, components },
              }),
            }
          );
          if (!metaResponse.ok) throw new Error(`Meta API error ${metaResponse.status}: ${await metaResponse.text()}`);
        } else if (provider === "twilio") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const msgOptions: any = { from: twilioFromNumber, to: `whatsapp:${testPhoneE164}` };
          if (broadcast.contentSid) {
            msgOptions.contentSid = broadcast.contentSid;
            if (recipient.variables) msgOptions.contentVariables = JSON.stringify(recipient.variables);
          } else {
            msgOptions.body = templateText;
          }
          await twilioClient!.messages.create(msgOptions);
        } else if (provider === "valuetext") {
          const sfResponse = await fetch(
            `${sfInstanceUrl}/services/data/v59.0/sobjects/rsplus__SMS_Bucket__c/`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${sfAccessToken}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                rsplus__Number__c: testPhoneE164,
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
          if (!sfResponse.ok) throw new Error(`Salesforce API error ${sfResponse.status}: ${await sfResponse.text()}`);
        }

        // 3. Update/create conversation and save lastTemplateSentAt
        const plantillaMsg = broadcast.templateBody
          ? `<<PLANTILLA>> ${broadcast.templateBody}`
          : `<<PLANTILLA>> ${broadcast.templateName}`;
        const contextoMsg = buildContextoMessage(
          recipient.name || "",
          (recipient.variables as Record<string, string> | null) ?? null
        );
        const now = FieldValue.serverTimestamp();
        let convId: string;

        if (existingConvId) {
          convId = existingConvId;
          const convRef = adminDb.collection("conversations").doc(existingConvId);
          const m1 = convRef.collection("messages").doc();
          const m2 = convRef.collection("messages").doc();
          await Promise.all([
            m1.set({ id: m1.id, conversationId: existingConvId, sender: "bot", agentId: null, text: plantillaMsg, mediaUrl: null, createdAt: now }),
            m2.set({ id: m2.id, conversationId: existingConvId, sender: "bot", agentId: null, text: contextoMsg, mediaUrl: null, createdAt: now }),
            convRef.update({ lastMessageAt: now, lastMessageSender: "bot", lastMessagePreview: plantillaMsg.slice(0, 100), broadcastId, broadcastName: broadcast.name || null, lastTemplateSentAt: now }),
          ]);
          await primeAbacusSession(broadcast.botId, existingConvId, plantillaMsg, contextoMsg);
        } else {
          const convRef = adminDb.collection("conversations").doc();
          convId = convRef.id;
          await convRef.set({
            id: convRef.id,
            botId: broadcast.botId,
            organizationId: broadcast.organizationId,
            customerPhone: `whatsapp:${testPhoneNormalized}`,
            customerName: null,
            status: "bot",
            assignedAgentId: null,
            priority: "normal",
            tags: ["broadcast", "test"],
            lastMessageAt: now,
            lastTemplateSentAt: now,
            createdAt: now,
            broadcastId,
            broadcastName: broadcast.name || null,
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
            m1.set({ id: m1.id, conversationId: convRef.id, sender: "bot", agentId: null, text: plantillaMsg, mediaUrl: null, createdAt: now }),
            m2.set({ id: m2.id, conversationId: convRef.id, sender: "bot", agentId: null, text: contextoMsg, mediaUrl: null, createdAt: now }),
          ]);
          await primeAbacusSession(broadcast.botId, convRef.id, plantillaMsg, contextoMsg);
        }

        results.push({ index: i + 1, success: true, conversationId: convId });
        await sleep(RATE_LIMIT_DELAY_MS);
      } catch (error) {
        results.push({ index: i + 1, success: false, error: error instanceof Error ? error.message : "Unknown error" });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const conversationId = results.find((r) => r.conversationId)?.conversationId ?? null;
    return NextResponse.json({ success: true, sent: successCount, failed: results.length - successCount, conversationId, results });
  } catch (error) {
    console.error("Error in test send:", error);
    return NextResponse.json({ error: "Failed to send test" }, { status: 500 });
  }
}
