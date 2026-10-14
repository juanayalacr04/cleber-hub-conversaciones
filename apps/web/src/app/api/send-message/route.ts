import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { verifyAuthToken } from "@/lib/auth-middleware";
import { canAccessConversation, isAdminIn, loadRequester } from "@/lib/authz";
import { getSalesforceCredentials, getSalesforceToken } from "@/lib/salesforce-env";

export async function POST(request: NextRequest) {
  try {
    const authUser = await verifyAuthToken(request);
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { conversationId, text, agentId, mediaUrl } = body;

    // Validate required fields (text or mediaUrl required, not both mandatory)
    if (!conversationId || (!text && !mediaUrl) || !agentId) {
      return NextResponse.json(
        { error: "Missing required fields: conversationId, agentId, and text or mediaUrl" },
        { status: 400 }
      );
    }

    // Get conversation to find customer phone and botId
    const conversationRef = adminDb.collection("conversations").doc(conversationId);
    const conversationDoc = await conversationRef.get();

    if (!conversationDoc.exists) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    const conversation = conversationDoc.data();

    // Esta ruta usa el Admin SDK y no pasa por firestore.rules: la autorización va aquí.
    // Hay que pertenecer a la organización y, si no se es admin, al equipo de la conversación.
    const requester = await loadRequester(authUser.uid);
    if (!requester || !canAccessConversation(requester, { organizationId: conversation?.organizationId, teamId: conversation?.teamId })) {
      return NextResponse.json({ error: "No tienes permiso para escribir en esta conversación" }, { status: 403 });
    }
    // El autor del mensaje es quien manda la petición, no lo que diga el cuerpo
    if (agentId !== authUser.uid) {
      return NextResponse.json({ error: "agentId no coincide con el usuario autenticado" }, { status: 403 });
    }
    // Con conversación asignada (with_agent), solo el agente dueño o un admin pueden mandar mensajes
    if (conversation?.status === "with_agent" && conversation?.assignedAgentId !== authUser.uid && !isAdminIn(requester, conversation?.organizationId)) {
      return NextResponse.json({ error: "No tienes permiso para escribir en esta conversación" }, { status: 403 });
    }

    const customerPhone = conversation?.customerPhone;
    const botId = conversation?.botId;
    const whatsappNumberId = conversation?.whatsappNumberId;

    if (!customerPhone) {
      return NextResponse.json(
        { error: "Customer phone not found in conversation" },
        { status: 400 }
      );
    }

    if (!botId) {
      return NextResponse.json(
        { error: "Bot ID not found in conversation" },
        { status: 400 }
      );
    }

    // Determine provider from whatsappNumber doc
    let provider = "twilio";
    let valuetextSenderId = "";
    let waNumberOrgId = "";
    let metaPhoneNumberId = "";
    let metaAccessToken = "";

    if (whatsappNumberId) {
      const waNumberDoc = await adminDb.collection("whatsappNumbers").doc(whatsappNumberId).get();
      if (waNumberDoc.exists) {
        const waData = waNumberDoc.data();
        provider = waData?.provider || "twilio";
        valuetextSenderId = waData?.valuetextSenderId || "";
        waNumberOrgId = waData?.organizationId || "";
        metaPhoneNumberId = waData?.metaPhoneNumberId || "";
        metaAccessToken = waData?.metaAccessToken || "";
      }
    }

    // Web channel: only save to Firestore (widget picks up via onSnapshot)
    if (conversation?.channel === "web") {
      // Skip external provider — message is saved to Firestore below
    } else if (provider === "meta") {
      // Send via Meta WhatsApp Cloud API
      if (!metaPhoneNumberId || !metaAccessToken) {
        return NextResponse.json(
          { error: "Meta WhatsApp credentials not configured" },
          { status: 500 }
        );
      }

      const recipientPhone = customerPhone.replace("whatsapp:", "");

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
            type: "text",
            text: { body: text },
          }),
        }
      );

      if (!metaResponse.ok) {
        const errorText = await metaResponse.text();
        console.error("Meta API error:", metaResponse.status, errorText);
        return NextResponse.json(
          { error: `Meta API error: ${metaResponse.status}` },
          { status: 500 }
        );
      }
    } else if (provider === "valuetext") {
      // Send via Salesforce REST API (insert SMS_Bucket__c for ValueText)
      if (!waNumberOrgId) {
        return NextResponse.json(
          { error: "Organization ID not found for WhatsApp number" },
          { status: 500 }
        );
      }

      // Credenciales de Salesforce desde variables de entorno (SF_*, con override SF_<MODULO>_*)
      const sfCreds = getSalesforceCredentials(conversation?.vertical);
      if (!sfCreds) {
        return NextResponse.json(
          { error: "Credenciales de Salesforce no configuradas en el servidor (SF_*)" },
          { status: 500 }
        );
      }

      // 1. Get access token via username-password flow
      let accessToken: string;
      try {
        ({ accessToken } = await getSalesforceToken(sfCreds));
      } catch (err) {
        console.error("Salesforce token error:", err);
        return NextResponse.json({ error: "Salesforce auth error" }, { status: 500 });
      }

      // 2. Insert SMS_Bucket__c record
      const mobileNumber = customerPhone.replace("whatsapp:", "");

      const sfResponse = await fetch(
        `${sfCreds.instanceUrl}/services/data/v59.0/sobjects/rsplus__SMS_Bucket__c/`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            rsplus__Number__c: mobileNumber,
            rsplus__Message__c: text,
            rsplus__Sender_ID__c: valuetextSenderId,
            Origen__c: "Plataforma IA",
          }),
        }
      );

      if (!sfResponse.ok) {
        const errorText = await sfResponse.text();
        console.error("Salesforce insert error:", sfResponse.status, errorText);
        return NextResponse.json(
          { error: `Salesforce API error: ${sfResponse.status}` },
          { status: 500 }
        );
      }
    } else {
      // Send via Twilio (existing flow)
      const botDoc = await adminDb.collection("bots").doc(botId).get();

      if (!botDoc.exists) {
        return NextResponse.json(
          { error: "Bot not found" },
          { status: 404 }
        );
      }

      const botData = botDoc.data();

      // Get Twilio credentials: prefer whatsappNumber-level, fallback to bot-level
      let accountSid = "";
      let authToken = "";
      let fromNumber = "";

      if (whatsappNumberId) {
        const waNumberDoc = await adminDb.collection("whatsappNumbers").doc(whatsappNumberId).get();
        if (waNumberDoc.exists) {
          const waData = waNumberDoc.data();
          accountSid = waData?.twilioAccountSid || "";
          authToken = waData?.twilioAuthToken || "";
          fromNumber = waData?.phoneNumber || "";
        }
      }

      // Fallback to bot's twilioConfig
      if (!accountSid || !authToken) {
        const twilioConfig = botData?.twilioConfig;
        accountSid = twilioConfig?.accountSid || "";
        authToken = twilioConfig?.authToken || "";
        fromNumber = fromNumber || twilioConfig?.phoneNumber || "";
      }

      if (!accountSid || !authToken || !fromNumber) {
        return NextResponse.json(
          { error: "Twilio configuration incomplete" },
          { status: 500 }
        );
      }

      const client = twilio(accountSid, authToken);

      await client.messages.create({
        body: text || "",
        from: fromNumber,
        to: customerPhone,
        ...(mediaUrl && { mediaUrl: [mediaUrl] }),
      });
    }

    // Save message to Firestore
    const messagesRef = conversationRef.collection("messages");
    const messageDoc = await messagesRef.add({
      conversationId,
      sender: "agent",
      agentId,
      text: text || "",
      mediaUrl: mediaUrl || null,
      createdAt: FieldValue.serverTimestamp(),
    });

    // Update conversation lastMessageAt and preview
    const convUpdate: Record<string, unknown> = {
      lastMessageAt: FieldValue.serverTimestamp(),
      lastMessagePreview: text ? text.slice(0, 100) : "📎 Archivo adjunto",
      lastMessageSender: "agent",
    };

    // Record first agent response time for this cycle (only once per cycle)
    if (!conversation?.firstAgentResponseAt && conversation?.waitingStartedAt) {
      const waitingDate = conversation.waitingStartedAt.toDate
        ? conversation.waitingStartedAt.toDate()
        : new Date(conversation.waitingStartedAt);
      const responseTimeSecs = Math.max(0, Math.round((Date.now() - waitingDate.getTime()) / 1000));
      convUpdate.firstAgentResponseAt = FieldValue.serverTimestamp();
      convUpdate.responseTimeSecs = responseTimeSecs; // kept for index compatibility
      convUpdate.responseTimes = FieldValue.arrayUnion(responseTimeSecs); // historical array
    }

    await conversationRef.update(convUpdate);

    return NextResponse.json({
      success: true,
      messageId: messageDoc.id,
    });
  } catch (error) {
    console.error("Error sending message:", error);
    return NextResponse.json(
      { error: "Failed to send message" },
      { status: 500 }
    );
  }
}
