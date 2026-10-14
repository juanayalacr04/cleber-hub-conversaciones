import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { isCronAuthorized } from "@/lib/cron-auth";
import { getSalesforceCredentials, getSalesforceToken } from "@/lib/salesforce-env";
import { FieldValue } from "firebase-admin/firestore";

// Extracts a field value from the Description block format:
// "CAMPO: valor\r\n"
function parseDescriptionField(description: string, field: string): string | null {
  const match = description.match(new RegExp(`${field}:[ \\t]*([^\\r\\n]+)`));
  return match?.[1]?.trim() || null;
}

// Field mappings per brand — Description format differs between brands
const BRAND_FIELD_MAP: Record<string, {
  name: string; phone: string; taller: string; operacion: string;
  auto: string; vin: string; tipoCita: string; recepcionista: string;
  email: string; observaciones: string;
}> = {
  KI: {
    name: "CONTACTO", phone: "TELEFONO", taller: "TALLER",
    operacion: "SERVICIO", auto: "MODELO DEL VEHICULO", vin: "VIN",
    tipoCita: "ESTADO", recepcionista: "ASESOR DE SERVICIO",
    email: "EMAIL", observaciones: "NOTAS",
  },
  // Default (Nissan and others with the same format)
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
// send function mid-loop, see send/route.ts's maxDuration). If left alone, the query
// below would skip it forever and its stale recipients would never get refreshed —
// only to be blasted out later (with a now-wrong target date) whenever someone opens
// the broadcast page (which auto-resumes sends stuck in "sending") or clicks "Enviar".
const STALE_SENDING_MS = 10 * 60 * 1000;

export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const broadcastsSnap = await adminDb
    .collection("broadcasts")
    .where("type", "==", "appointment_reminder")
    .get();

  if (broadcastsSnap.empty) {
    return NextResponse.json({ processed: 0, message: "No appointment_reminder broadcasts found" });
  }

  const results: { broadcastId: string; recipients?: number; date?: string; skipped?: number; error?: string }[] = [];

  for (const broadcastDoc of broadcastsSnap.docs) {
    const broadcast = broadcastDoc.data();
    const { organizationId, reminderConfig } = broadcast;

    if (broadcast.status === "sending") {
      const sendingStartedAtMs: number | undefined = broadcast.sendingStartedAt?.toDate?.()?.getTime?.();
      const isStaleSending = !sendingStartedAtMs || Date.now() - sendingStartedAtMs > STALE_SENDING_MS;
      if (!isStaleSending) {
        results.push({ broadcastId: broadcastDoc.id, error: "Still sending (not stale), skipped" });
        continue;
      }
      // Recover: unstick it so the refresh below can run and replace the stale
      // (never-finished) recipients with the current day's target.
      await broadcastDoc.ref.update({ status: "failed", completedAt: FieldValue.serverTimestamp() });
    }

    if (!reminderConfig?.eventType || reminderConfig?.daysBefore == null) {
      results.push({ broadcastId: broadcastDoc.id, error: "Missing reminderConfig fields" });
      continue;
    }

    const { daysBefore, eventType } = reminderConfig;

    try {
      const orgDoc = await adminDb.collection("organizations").doc(organizationId).get();

      // Credenciales de Salesforce desde el entorno (SF_*, override SF_SERVICIO_*)
      const creds = getSalesforceCredentials("servicio");
      if (!creds) {
        results.push({ broadcastId: broadcastDoc.id, error: "Salesforce no configurado en el servidor (SF_*)" });
        continue;
      }

      const { accessToken, instanceUrl } = await getSalesforceToken(creds);

      // Calculate target date in Mexico City timezone
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + daysBefore);
      const dateStr = targetDate.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });

      const sfBrandCode = orgDoc.data()?.sfBrandCode;
      const sfCalendario = orgDoc.data()?.sfCalendario;
      const calendarioFilter = sfCalendario ? ` AND Calendario__c = '${sfCalendario}'` : "";

      // Fetch all Events for target date — GCL_SeRealizo__c = null means still scheduled
      let allEvents: { Id: string; Subject: string; Description: string | null; Location: string | null; WhoId: string | null; ActivityDate: string | null; ActivityDateTime: string | null; Tel_fono_Prospecto__c: string | null; Celular_Prospecto__c: string | null; VIN__c: string | null; EventLeadConcesionaria__c: string | null; EventLead__c: string | null; IdQuiter__c: string | null }[] = [];
      let nextUrl: string | null =
        `${instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(
          `SELECT Id, Subject, Description, Location, WhoId, ActivityDate, ActivityDateTime, Tel_fono_Prospecto__c, Celular_Prospecto__c, VIN__c, EventLeadConcesionaria__c, EventLead__c, IdQuiter__c FROM Event WHERE Type = '${eventType}' AND ActivityDate = ${dateStr} AND GCL_SeRealizo__c = null${calendarioFilter} AND Journey_borrar__c = false`
        )}`;

      while (nextUrl) {
        const res: Response = await fetch(nextUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
        const data = await res.json();
        allEvents = allEvents.concat(data.records || []);
        nextUrl = data.nextRecordsUrl ? `${instanceUrl}${data.nextRecordsUrl}` : null;
      }

      // Build recipients — native fields preferred, Description parsing as fallback
      const fieldMap = getFieldMap(sfBrandCode);
      const recipients: { phone: string; name: string; salesforceRecordId: string; variables: Record<string, string> }[] = [];
      const skippedRecipients: { name: string; salesforceRecordId: string; errorMessage: string; variables: Record<string, string> }[] = [];

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
          skippedRecipients.push({ name, salesforceRecordId: event.Id, errorMessage: "Sin teléfono", variables });
          continue;
        }
        const phone = normalizePhone(rawPhone);
        if (!phone) {
          skippedRecipients.push({ name, salesforceRecordId: event.Id, errorMessage: `Teléfono inválido: ${rawPhone}`, variables });
          continue;
        }

        recipients.push({ phone, name, salesforceRecordId: event.Id, variables });
      }

      const recipientsRef = adminDb.collection("broadcasts").doc(broadcastDoc.id).collection("recipients");
      const existingSnap = await recipientsRef.get();
      const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;

      const sentIds = new Set<string>();
      const toDelete: FirebaseFirestore.DocumentReference[] = [];

      for (const d of existingSnap.docs) {
        const data = d.data();
        const isSent = ["sent", "delivered", "read"].includes(data.status);
        const sentAt: number = data.sentAt?.toMillis?.() ?? 0;
        if (isSent && sentAt > cutoff) {
          if (data.salesforceRecordId) sentIds.add(data.salesforceRecordId);
        } else {
          toDelete.push(d.ref);
        }
      }

      // Delete stale and expired recipients
      for (let i = 0; i < toDelete.length; i += 500) {
        const batch = adminDb.batch();
        toDelete.slice(i, i + 500).forEach((ref) => batch.delete(ref));
        await batch.commit();
      }

      // Insert only recipients not already in history
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

      await broadcastDoc.ref.update({
        status: newRecipients.length > 0 ? "draft" : broadcastDoc.data().status,
        totalRecipients: sentIds.size + newRecipients.length,
        completedAt: newRecipients.length > 0 ? null : broadcastDoc.data().completedAt,
        lastRefreshedAt: FieldValue.serverTimestamp(),
      });

      results.push({ broadcastId: broadcastDoc.id, recipients: recipients.length, skipped: skippedRecipients.length, date: dateStr });
    } catch (error) {
      console.error(`Error processing broadcast ${broadcastDoc.id}:`, error);
      results.push({ broadcastId: broadcastDoc.id, error: String(error) });
    }
  }

  return NextResponse.json({ processed: results.length, results });
}
