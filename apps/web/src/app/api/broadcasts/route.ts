import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { verifyAuthToken } from "@/lib/auth-middleware";
import { authorizeOrg } from "@/lib/authz";

export async function GET(request: NextRequest) {
  try {
    const authUser = await verifyAuthToken(request);
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const organizationId = request.nextUrl.searchParams.get("organizationId");
    if (!organizationId) {
      return NextResponse.json({ error: "Missing organizationId" }, { status: 400 });
    }

    const denied = await authorizeOrg(authUser.uid, organizationId);
    if (denied) return denied;

    const snapshot = await adminDb
      .collection("broadcasts")
      .where("organizationId", "==", organizationId)
      .orderBy("createdAt", "desc")
      .get();

    const broadcasts = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return NextResponse.json({ broadcasts });
  } catch (error) {
    console.error("Error fetching broadcasts:", error);
    return NextResponse.json({ error: "Failed to fetch broadcasts" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const authUser = await verifyAuthToken(request);
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const {
      organizationId,
      name,
      whatsappNumberId,
      botId,
      templateName,
      templateLanguage,
      templateComponents,
      contentSid,
      valuetextObjectApi,
      botInstructions,
      recipients,
    } = body;

    if (!organizationId || !name || !whatsappNumberId || !botId || !templateName) {
      return NextResponse.json(
        { error: "Missing required fields: organizationId, name, whatsappNumberId, botId, templateName" },
        { status: 400 }
      );
    }

    const denied = await authorizeOrg(authUser.uid, organizationId, { write: true });
    if (denied) return denied;

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return NextResponse.json(
        { error: "At least one recipient is required" },
        { status: 400 }
      );
    }

    // Módulo de la campaña: vertical del equipo del número de WhatsApp (o del bot como respaldo)
    let vertical: string | null = null;
    const waDoc = await adminDb.collection("whatsappNumbers").doc(whatsappNumberId).get();
    const teamId = waDoc.data()?.teamId as string | undefined;
    if (teamId) {
      const teamDoc = await adminDb.collection("teams").doc(teamId).get();
      vertical = (teamDoc.data()?.vertical as string | undefined) || null;
    }
    if (!vertical) {
      const botDoc = await adminDb.collection("bots").doc(botId).get();
      const bd = botDoc.data();
      const cat = typeof bd?.category === "string" ? bd.category.toLowerCase() : "";
      vertical = bd?.vertical || (cat === "servicio" || cat === "ventas" ? cat : null);
    }

    // Create broadcast document
    const broadcastRef = adminDb.collection("broadcasts").doc();
    const broadcastData = {
      id: broadcastRef.id,
      organizationId,
      name,
      whatsappNumberId,
      botId,
      templateName,
      templateLanguage: templateLanguage || "es",
      templateComponents: templateComponents || [],
      contentSid: contentSid || null,
      valuetextObjectApi: valuetextObjectApi || null,
      botInstructions: botInstructions || null,
      status: "draft",
      totalRecipients: recipients.length,
      sentCount: 0,
      deliveredCount: 0,
      failedCount: 0,
      createdBy: authUser.uid,
      createdAt: FieldValue.serverTimestamp(),
      completedAt: null,
    };

    await broadcastRef.set(broadcastData);

    // Add recipients in batches of 500 (Firestore limit)
    const recipientsRef = broadcastRef.collection("recipients");
    const batchSize = 500;

    for (let i = 0; i < recipients.length; i += batchSize) {
      const batch = adminDb.batch();
      const chunk = recipients.slice(i, i + batchSize);

      for (const recipient of chunk) {
        const recipientRef = recipientsRef.doc();
        batch.set(recipientRef, {
          id: recipientRef.id,
          phone: recipient.phone,
          name: recipient.name || null,
          variables: recipient.variables || null,
          salesforceRecordId: recipient.salesforceRecordId || null,
          conversationId: null,
          status: "pending",
          errorMessage: null,
          whatsappMessageId: null,
          sentAt: null,
        });
      }

      await batch.commit();
    }

    return NextResponse.json({
      success: true,
      broadcastId: broadcastRef.id,
    });
  } catch (error) {
    console.error("Error creating broadcast:", error);
    return NextResponse.json({ error: "Failed to create broadcast" }, { status: 500 });
  }
}
