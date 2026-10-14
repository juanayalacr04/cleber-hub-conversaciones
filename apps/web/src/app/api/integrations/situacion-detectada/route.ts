import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { getSalesforceCredentials, getSalesforceToken } from "@/lib/salesforce-env";
import { hasApiSecret } from "@/lib/cron-auth";

// Webhook público (sin auth, por contrato) que recibe el bot de Ventas cuando
// detecta que un cliente necesita Servicio/Postventa. Ver docs/integracion-bot-servicio.md
// (repo cleber-bot-platform-comercial) para el contrato completo.
//
// Config requerida en whatsappNumbers/{id} (el número que reciben en targetPhone), editable
// desde Numeros de WhatsApp → Plantilla de Handoff a Servicio:
//   serviceHandoffContentSid       — Twilio Content Template Sid
//   serviceHandoffTemplateName     — nombre de plantilla (Meta) / Template Id (ValueText)
//   serviceHandoffTemplateLanguage — código de idioma Meta (default "es")
// La plantilla debe tener exactamente 2 variables de body: {{1}} = nombre del cliente, {{2}} = motivo.

function normalizePhone(rawPhone: string): { e164: string; digits: string } {
  const digits = rawPhone.replace(/\D/g, "");
  let normalizedDigits = digits;
  if (digits.length === 13 && digits.startsWith("521")) normalizedDigits = `52${digits.slice(3)}`;
  else if (digits.length === 10) normalizedDigits = `52${digits}`;
  return { e164: `+${normalizedDigits}`, digits: normalizedDigits };
}

async function getOpenConversation(customerPhone: string, organizationId: string): Promise<string | null> {
  const snap = await adminDb
    .collection("conversations")
    .where("customerPhone", "==", customerPhone)
    .where("organizationId", "==", organizationId)
    .orderBy("lastMessageAt", "desc")
    .get();
  const open = snap.docs.find((d) => d.data().status !== "closed");
  return open?.id ?? null;
}

// Mismo mecanismo que broadcasts/[id]/test-send: le "cuenta" al bot lo que se
// mandó fuera de banda (plantilla + contexto) para que tenga el contexto listo
// cuando el cliente responda.
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
    console.error(`situacion-detectada: error priming Abacus session ${convId}:`, err);
  }
}

export async function POST(request: NextRequest) {
  try {
    // Webhook público por contrato (sin auth). Con SITUACION_API_SECRET definido exige el secreto
    // (cabecera X-Api-Secret): sin él, cualquiera puede disparar plantillas de WhatsApp a cualquier teléfono.
    const requiredSecret = process.env.SITUACION_API_SECRET;
    if (requiredSecret && !hasApiSecret(request, requiredSecret)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = await request.json();
    const {
      event,
      situacion,
      targetPhone,
      phone,
      customerName,
      leadId,
      organizationId: sourceOrganizationId,
      motivo,
      sourceConversationId,
    } = body ?? {};

    if (event !== "situacion_detectada" || !situacion || !targetPhone || !phone) {
      return NextResponse.json({ error: "Missing or invalid required fields" }, { status: 400 });
    }

    const targetPhoneRaw = targetPhone.replace("whatsapp:", "");
    const waNumberSnap = await adminDb
      .collection("whatsappNumbers")
      .where("phoneNumber", "in", [targetPhoneRaw, `whatsapp:${targetPhoneRaw}`])
      .where("status", "==", "active")
      .limit(1)
      .get();

    if (waNumberSnap.empty) {
      console.error(`situacion-detectada: no active whatsappNumber for targetPhone=${targetPhone}`);
      return NextResponse.json({ error: "targetPhone not configured" }, { status: 404 });
    }

    const waNumber = waNumberSnap.docs[0].data();
    const provider = waNumber.provider || "twilio";
    const botId = waNumber.defaultBotId;
    const orgId = waNumber.organizationId;

    // Módulo del número: por la vertical de su equipo (el número no la guarda)
    let vertical: string | null = null;
    if (waNumber.teamId) {
      const teamDoc = await adminDb.collection("teams").doc(waNumber.teamId).get();
      vertical = teamDoc.data()?.vertical ?? null;
    }

    const { e164: customerPhoneE164 } = normalizePhone(phone.replace("whatsapp:", ""));
    const templateVariables: Record<string, string> = {
      "1": customerName || "Cliente",
      "2": motivo || "",
    };

    if (provider === "meta") {
      const metaPhoneNumberId = waNumber.metaPhoneNumberId || "";
      const metaAccessToken = waNumber.metaAccessToken || "";
      const templateName = waNumber.serviceHandoffTemplateName || "";
      if (!metaPhoneNumberId || !metaAccessToken || !templateName) {
        return NextResponse.json({ error: "Meta service handoff template not configured" }, { status: 500 });
      }
      const components = [
        {
          type: "body",
          parameters: [
            { type: "text", text: templateVariables["1"] },
            { type: "text", text: templateVariables["2"] },
          ],
        },
      ];
      const metaResponse = await fetch(`https://graph.facebook.com/v21.0/${metaPhoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${metaAccessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: customerPhoneE164.replace("+", ""),
          type: "template",
          template: { name: templateName, language: { code: waNumber.serviceHandoffTemplateLanguage || "es" }, components },
        }),
      });
      if (!metaResponse.ok) {
        console.error(`situacion-detectada: Meta send failed ${metaResponse.status}: ${await metaResponse.text()}`);
        return NextResponse.json({ error: "Failed to send WhatsApp template" }, { status: 502 });
      }
    } else if (provider === "twilio") {
      const accountSid = waNumber.twilioAccountSid || "";
      const authToken = waNumber.twilioAuthToken || "";
      const contentSid = waNumber.serviceHandoffContentSid || "";
      if (!accountSid || !authToken || !contentSid) {
        return NextResponse.json({ error: "Twilio service handoff template not configured" }, { status: 500 });
      }
      try {
        await twilio(accountSid, authToken).messages.create({
          from: waNumber.phoneNumber,
          to: `whatsapp:${customerPhoneE164}`,
          contentSid,
          contentVariables: JSON.stringify(templateVariables),
        });
      } catch (err) {
        console.error("situacion-detectada: Twilio send failed:", err);
        return NextResponse.json({ error: "Failed to send WhatsApp template" }, { status: 502 });
      }
    } else if (provider === "valuetext") {
      // Credenciales desde el entorno (SF_*, override por módulo del equipo del número)
      const sfCreds = getSalesforceCredentials(vertical);
      if (!sfCreds) {
        return NextResponse.json({ error: "Salesforce credentials not configured" }, { status: 500 });
      }
      let sfAccessToken: string;
      try {
        ({ accessToken: sfAccessToken } = await getSalesforceToken(sfCreds));
      } catch {
        return NextResponse.json({ error: "Salesforce auth failed" }, { status: 500 });
      }
      const sfResponse = await fetch(`${sfCreds.instanceUrl}/services/data/v59.0/sobjects/rsplus__SMS_Bucket__c/`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sfAccessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          rsplus__Number__c: customerPhoneE164,
          rsplus__Sender_ID__c: waNumber.valuetextSenderId || "",
          ...(waNumber.serviceHandoffTemplateName ? { rsplus__Template_ID__c: waNumber.serviceHandoffTemplateName } : {}),
          ...(leadId ? { rsplus__Related_To__c: leadId } : {}),
        }),
      });
      if (!sfResponse.ok) {
        console.error(`situacion-detectada: ValueText send failed ${sfResponse.status}: ${await sfResponse.text()}`);
        return NextResponse.json({ error: "Failed to send WhatsApp template" }, { status: 502 });
      }
    }

    // Reusar conversación abierta con este número si existe; si no, crear una nueva.
    const customerPhone = `whatsapp:${customerPhoneE164}`;
    const now = FieldValue.serverTimestamp();
    const plantillaMsg = `<<PLANTILLA>> ${waNumber.serviceHandoffTemplatePreview || waNumber.serviceHandoffTemplateName || waNumber.serviceHandoffContentSid || "Handoff a Servicio"}`;
    const contextoMsg = `<<CONTEXTO>> NOMBRE: ${customerName || "Cliente"}, MOTIVO: ${motivo || situacion}`;

    const existingConvId = await getOpenConversation(customerPhone, orgId);
    let convId: string;

    if (existingConvId) {
      convId = existingConvId;
      const convRef = adminDb.collection("conversations").doc(existingConvId);
      const m1 = convRef.collection("messages").doc();
      const m2 = convRef.collection("messages").doc();
      await Promise.all([
        m1.set({ id: m1.id, conversationId: existingConvId, sender: "bot", agentId: null, text: plantillaMsg, mediaUrl: null, createdAt: now }),
        m2.set({ id: m2.id, conversationId: existingConvId, sender: "bot", agentId: null, text: contextoMsg, mediaUrl: null, createdAt: now }),
        convRef.update({
          lastMessageAt: now,
          lastMessagePreview: plantillaMsg.slice(0, 100),
          lastMessageSender: "bot",
          lastTemplateSentAt: now,
          sourceLeadId: leadId || null,
          sourceOrganizationId: sourceOrganizationId || null,
          sourceConversationId: sourceConversationId || null,
          tags: FieldValue.arrayUnion("situacion_detectada"),
        }),
      ]);
      if (botId) await primeAbacusSession(botId, existingConvId, plantillaMsg, contextoMsg);
    } else {
      const botDoc = botId ? await adminDb.collection("bots").doc(botId).get() : null;
      const botData = botDoc?.exists ? botDoc.data() : null;
      const convRef = adminDb.collection("conversations").doc();
      convId = convRef.id;
      await convRef.set({
        id: convRef.id,
        botId: botId || null,
        organizationId: orgId,
        teamId: waNumber.teamId || null,
        vertical,
        whatsappNumberId: waNumberSnap.docs[0].id,
        customerPhone,
        customerName: customerName || null,
        status: "bot",
        assignedAgentId: null,
        assignedAgentType: "bot",
        assignedBotId: botId || null,
        assignedUserId: null,
        priority: "normal",
        tags: ["situacion_detectada"],
        lastMessageAt: now,
        lastMessagePreview: plantillaMsg.slice(0, 100),
        lastMessageSender: "bot",
        lastTemplateSentAt: now,
        createdAt: now,
        botName: botData?.name || null,
        botCategory: botData?.category || null,
        channel: "whatsapp",
        sourceLeadId: leadId || null,
        sourceOrganizationId: sourceOrganizationId || null,
        sourceConversationId: sourceConversationId || null,
        direction: "outbound",
      });
      const m1 = convRef.collection("messages").doc();
      const m2 = convRef.collection("messages").doc();
      await Promise.all([
        m1.set({ id: m1.id, conversationId: convId, sender: "bot", agentId: null, text: plantillaMsg, mediaUrl: null, createdAt: now }),
        m2.set({ id: m2.id, conversationId: convId, sender: "bot", agentId: null, text: contextoMsg, mediaUrl: null, createdAt: now }),
      ]);
      if (botId) await primeAbacusSession(botId, convId, plantillaMsg, contextoMsg);
    }

    return NextResponse.json({ success: true, conversationId: convId });
  } catch (error) {
    console.error("Error in situacion-detectada webhook:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
