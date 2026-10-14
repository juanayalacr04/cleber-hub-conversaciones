import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { verifyAuthToken } from "@/lib/auth-middleware";
import { authorizeOrg } from "@/lib/authz";
import { getSalesforceCredentials, getSalesforceToken } from "@/lib/salesforce-env";

function parseDescriptionField(description: string, field: string): string | null {
  const match = description.match(new RegExp(`${field}:[ \\t]*([^\\r\\n]+)`));
  return match?.[1]?.trim() || null;
}

const BRAND_FIELD_MAP: Record<string, { name: string; phone: string; taller: string; operacion: string; auto: string; vin: string; tipoCita: string; recepcionista: string; email: string; observaciones: string }> = {
  KI: {
    name: "CONTACTO", phone: "TELEFONO", taller: "TALLER",
    operacion: "SERVICIO", auto: "MODELO DEL VEHICULO", vin: "VIN",
    tipoCita: "ESTADO", recepcionista: "ASESOR DE SERVICIO",
    email: "EMAIL", observaciones: "NOTAS",
  },
  default: {
    name: "CONTACTO", phone: "TELEFONO", taller: "TALLER",
    operacion: "OPERACION", auto: "AUTO", vin: "VIN",
    tipoCita: "TIPO CITA", recepcionista: "RECEPCIONISTA",
    email: "EMAIL", observaciones: "OBSERVACIONES",
  },
};

function getFieldMap(sfBrandCode: string | undefined) {
  return BRAND_FIELD_MAP[sfBrandCode ?? ""] ?? BRAND_FIELD_MAP.default;
}

function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 10) return `+52${digits}`;
  if (digits.length === 12 && digits.startsWith("52")) return `+${digits}`;
  if (digits.length === 13 && digits.startsWith("521")) return `+52${digits.slice(3)}`;
  return null;
}

// A broadcast still "sending" after this long is considered stuck (Vercel killed the
// send function mid-loop, see send/route.ts's maxDuration) rather than genuinely busy —
// same threshold used by retry/route.ts and the cron routes.
const STALE_SENDING_MS = 10 * 60 * 1000;

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

    const broadcastDoc = await adminDb.collection("broadcasts").doc(broadcastId).get();
    if (!broadcastDoc.exists) {
      return NextResponse.json({ error: "Broadcast not found" }, { status: 404 });
    }

    const broadcast = broadcastDoc.data()!;

    const denied = await authorizeOrg(authUser.uid, broadcast.organizationId, { write: true });
    if (denied) return denied;

    if (broadcast.type !== "appointment_reminder" && broadcast.type !== "no_show") {
      return NextResponse.json({ error: "Solo broadcasts de tipo appointment_reminder o no_show pueden refrescarse" }, { status: 400 });
    }

    if (broadcast.status === "sending") {
      const sendingStartedAtMs: number | undefined = broadcast.sendingStartedAt?.toDate?.()?.getTime?.();
      const isStaleSending = !sendingStartedAtMs || Date.now() - sendingStartedAtMs > STALE_SENDING_MS;
      if (!isStaleSending) {
        return NextResponse.json({ error: "No se puede refrescar mientras se está enviando" }, { status: 400 });
      }
      // Recover: unstick it so the refresh below can run and replace the stale
      // (never-finished) recipients with today's target.
      await broadcastDoc.ref.update({ status: "failed", completedAt: FieldValue.serverTimestamp() });
    }

    const { organizationId, reminderConfig } = broadcast;

    if (!reminderConfig?.eventType) {
      return NextResponse.json({ error: "Missing reminderConfig.eventType" }, { status: 400 });
    }
    if (broadcast.type === "appointment_reminder" && reminderConfig?.daysBefore == null) {
      return NextResponse.json({ error: "Missing reminderConfig.daysBefore" }, { status: 400 });
    }

    const { daysBefore, eventType } = reminderConfig;

    const orgDoc = await adminDb.collection("organizations").doc(organizationId).get();
    const sfCreds = getSalesforceCredentials(broadcast.vertical);
    if (!sfCreds) {
      return NextResponse.json({ error: "Salesforce no configurado (variables SF_*)" }, { status: 400 });
    }
    const { accessToken, instanceUrl } = await getSalesforceToken(sfCreds);

    const sfBrandCode = orgDoc.data()?.sfBrandCode;
    const sfCalendario = orgDoc.data()?.sfCalendario;
    const calendarioFilter = sfCalendario ? ` AND Calendario__c = '${sfCalendario}'` : "";

    const nowIso = new Date().toISOString();
    let dateQueryClause: string;
    let asistioFilter: string;
    if (broadcast.type === "no_show") {
      dateQueryClause = `ActivityDate = TODAY AND ActivityDateTime < ${nowIso}`;
      asistioFilter = " AND GCL_SeRealizo__c = 'No'";
    } else {
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + daysBefore);
      const dateStr = targetDate.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
      dateQueryClause = `ActivityDate = ${dateStr}`;
      asistioFilter = " AND GCL_SeRealizo__c = null";
    }

    let allEvents: { Id: string; Subject: string; Description: string | null; Location: string | null; WhoId: string | null; ActivityDate: string | null; ActivityDateTime: string | null; Tel_fono_Prospecto__c: string | null; Celular_Prospecto__c: string | null; VIN__c: string | null; EventLeadConcesionaria__c: string | null; EventLead__c: string | null; IdQuiter__c: string | null }[] = [];
    let nextUrl: string | null = `${instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(
      `SELECT Id, Subject, Description, Location, WhoId, ActivityDate, ActivityDateTime, Tel_fono_Prospecto__c, Celular_Prospecto__c, VIN__c, EventLeadConcesionaria__c, EventLead__c, IdQuiter__c FROM Event WHERE Type = '${eventType}' AND ${dateQueryClause}${asistioFilter}${calendarioFilter} AND Journey_borrar__c = false`
    )}`;

    while (nextUrl) {
      const res: Response = await fetch(nextUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      const data = await res.json();
      allEvents = allEvents.concat(data.records || []);
      nextUrl = data.nextRecordsUrl ? `${instanceUrl}${data.nextRecordsUrl}` : null;
    }

    const fieldMap = getFieldMap(sfBrandCode);
    const recipients: { phone: string; name: string; salesforceRecordId: string; variables: Record<string, string> }[] = [];
    const skippedRecipients: { name: string; salesforceRecordId: string; errorMessage: string; variables: Record<string, string> }[] = [];
    const skippedDetails: { id: string; reason: string; rawPhone: string | null; name: string | null }[] = [];

    for (const event of allEvents) {
      const description = event.Description || "";
      const horaCita = event.ActivityDateTime
        ? new Date(event.ActivityDateTime).toLocaleTimeString("es-MX", { timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit", hour12: false })
        : "";
      const variables: Record<string, string> = {
        taller:         event.Location || parseDescriptionField(description, fieldMap.taller) || "",
        auto:           parseDescriptionField(description, fieldMap.auto) || "",
        operacion:      parseDescriptionField(description, fieldMap.operacion) || "",
        vin:            event.VIN__c || parseDescriptionField(description, fieldMap.vin) || "",
        recepcionista:  parseDescriptionField(description, fieldMap.recepcionista) || "",
        email:          parseDescriptionField(description, fieldMap.email) || "",
        observaciones:  parseDescriptionField(description, fieldMap.observaciones) || "",
        fechaCita:      event.ActivityDate || "",
        horaCita,
        idReservacion:  parseDescriptionField(description, "RESERVACION") || "",
        idQuiter:       event.IdQuiter__c || "",
      };
      const name = parseDescriptionField(description, fieldMap.name) || "";

      // Rellena variables numeradas ({{1}}, {{2}}, ...) según el mapeo definido al crear
      // la campaña, para que el mensaje de WhatsApp (no solo el contexto del bot) las incluya.
      const variableMapping: string[] = broadcast.variableMapping || [];
      variableMapping.forEach((field, idx) => {
        const val = field === "name" ? name : variables[field];
        if (val) variables[String(idx + 1)] = val;
      });

      const rawPhone = event.Tel_fono_Prospecto__c || event.Celular_Prospecto__c || parseDescriptionField(description, fieldMap.phone);
      if (!rawPhone) {
        skippedDetails.push({ id: event.Id, reason: "no_phone_field", rawPhone: null, name });
        skippedRecipients.push({ name, salesforceRecordId: event.Id, errorMessage: "Sin teléfono", variables });
        continue;
      }
      const phone = normalizePhone(rawPhone);
      if (!phone) {
        skippedDetails.push({ id: event.Id, reason: "invalid_phone_format", rawPhone, name });
        skippedRecipients.push({ name, salesforceRecordId: event.Id, errorMessage: `Teléfono inválido: ${rawPhone}`, variables });
        continue;
      }

      recipients.push({ phone, name, salesforceRecordId: event.Id, variables });
    }

    const recipientsRef = adminDb.collection("broadcasts").doc(broadcastId).collection("recipients");
    const existingSnap = await recipientsRef.get();

    // Separate already-sent recipients (preserve them) from pending/failed (replace them)
    const sentIds = new Set<string>();
    const docsToDelete: FirebaseFirestore.DocumentReference[] = [];

    for (const d of existingSnap.docs) {
      const s = d.data().status;
      if (s === "sent" || s === "delivered" || s === "read") {
        const sfId = d.data().salesforceRecordId;
        if (sfId) sentIds.add(sfId);
      } else {
        docsToDelete.push(d.ref);
      }
    }

    // Delete only non-sent recipients
    for (let i = 0; i < docsToDelete.length; i += 500) {
      const batch = adminDb.batch();
      docsToDelete.slice(i, i + 500).forEach((ref) => batch.delete(ref));
      await batch.commit();
    }

    // Insert only recipients not already sent
    const newRecipients = recipients.filter((r) => !sentIds.has(r.salesforceRecordId));
    for (let i = 0; i < newRecipients.length; i += 500) {
      const batch = adminDb.batch();
      for (const recipient of newRecipients.slice(i, i + 500)) {
        const recipientRef = recipientsRef.doc();
        batch.set(recipientRef, {
          id: recipientRef.id,
          phone: recipient.phone,
          name: recipient.name,
          variables: recipient.variables,
          salesforceRecordId: recipient.salesforceRecordId,
          conversationId: null,
          status: "pending",
          errorMessage: null,
          whatsappMessageId: null,
          sentAt: null,
        });
      }
      await batch.commit();
    }

    const preserved = sentIds.size;
    await broadcastDoc.ref.update({
      status: newRecipients.length > 0 ? "draft" : broadcast.status,
      totalRecipients: newRecipients.length + preserved,
      sentCount: preserved,
      deliveredCount: 0,
      failedCount: 0,
      skippedCount: 0,
      completedAt: null,
      lastRefreshedAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({ recipients: newRecipients.length, preserved, skipped: skippedDetails.length, skippedDetails });
  } catch (error) {
    console.error("Error refreshing broadcast:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
