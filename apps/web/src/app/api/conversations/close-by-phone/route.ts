import { hasApiSecret } from "@/lib/cron-auth";
import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

const ACTIVE_STATUSES = ["bot", "waiting_agent", "with_agent"];

// ACK SOAP que espera Salesforce para no reintentar el Outbound Message.
const SOAP_ACK =
  '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><notificationsResponse xmlns="http://soap.sforce.com/2005/09/outbound"><Ack>true</Ack></notificationsResponse></soapenv:Body></soapenv:Envelope>';

const SOAP_HEADERS = { "Content-Type": "text/xml" };

/**
 * Construye las variantes de customerPhone para buscar en Firestore.
 * Acepta el teléfono en formatos sueltos (10 dígitos, 52..., +52..., whatsapp:+52...,
 * legacy 521...) y devuelve las variantes moderna y legacy en formato whatsapp:.
 */
function buildPhoneVariants(input: string): string[] {
  const digits = input.replace(/\D/g, "");

  let ten: string | null = null;
  if (digits.length === 10) {
    ten = digits;
  } else if (digits.length === 12 && digits.startsWith("52")) {
    ten = digits.slice(2);
  } else if (digits.length === 13 && digits.startsWith("521")) {
    ten = digits.slice(3);
  }

  // Si no es un número MX de 10 dígitos reconocible, usar el input crudo como variante única
  if (!ten) {
    const raw = input.startsWith("whatsapp:") ? input : `whatsapp:${input.startsWith("+") ? "" : "+"}${input}`;
    return [raw];
  }

  return [`whatsapp:+52${ten}`, `whatsapp:+521${ten}`];
}

/**
 * Extrae los valores de rsplus__Phone_Number__c del SOAP XML de Salesforce.
 * Maneja tags con o sin prefijo de namespace (ej. <sf:rsplus__Phone_Number__c>).
 */
function extractPhonesFromXml(xml: string): string[] {
  const re = /<(?:\w+:)?rsplus__Phone_Number__c>([^<]+)<\/(?:\w+:)?rsplus__Phone_Number__c>/g;
  const phones: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const val = m[1].trim();
    if (val) phones.push(val);
  }
  return phones;
}

/** Cierra (silenciosamente) todas las conversaciones activas de un teléfono. Devuelve los IDs cerrados. */
async function closeConversationsForPhone(phone: string, reason: string): Promise<string[]> {
  const variants = buildPhoneVariants(phone);
  const convsRef = adminDb.collection("conversations");

  // Una query por variante (Firestore no permite dos filtros 'in' en una sola query).
  const docsMap = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  for (const variant of variants) {
    const snap = await convsRef
      .where("customerPhone", "==", variant)
      .where("status", "in", ACTIVE_STATUSES)
      .get();
    snap.docs.forEach((d) => docsMap.set(d.id, d));
  }

  if (docsMap.size === 0) return [];

  const batch = adminDb.batch();
  const closedIds: string[] = [];
  for (const doc of docsMap.values()) {
    batch.update(doc.ref, {
      status: "closed",
      assignedAgentId: null,
      assignedAt: null,
      waitingStartedAt: null,
      firstAgentResponseAt: null,
      responseTimeSecs: null,
      closedAt: FieldValue.serverTimestamp(),
      closedReason: reason,
      closedBy: "salesforce",
      manualClose: true,
    });
    closedIds.push(doc.id);
  }
  await batch.commit();
  return closedIds;
}

/** Valida el secreto vía query string (?secret=) — Salesforce no puede mandar headers. */
function isAuthorized(request: NextRequest): boolean {
  const apiSecret = process.env.EXTERNAL_API_SECRET;
  return hasApiSecret(request, apiSecret);
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawBody = await request.text();
  const contentType = request.headers.get("content-type") ?? "";
  const looksLikeXml = contentType.includes("xml") || rawBody.trimStart().startsWith("<");

  // --- Modo Salesforce Outbound Message (SOAP XML) ---
  if (looksLikeXml) {
    const phones = extractPhonesFromXml(rawBody);
    let totalClosed = 0;
    for (const phone of phones) {
      try {
        const closed = await closeConversationsForPhone(phone, "salesforce");
        totalClosed += closed.length;
        console.log(`close-by-phone (xml) closed ${closed.length} for ${phone}:`, closed);
      } catch (err) {
        console.error(`close-by-phone (xml) error for ${phone}:`, err);
      }
    }
    console.log(`close-by-phone (xml) processed ${phones.length} phone(s), closed ${totalClosed} total`);
    // Siempre responder ACK para que Salesforce no reintente.
    return new NextResponse(SOAP_ACK, { status: 200, headers: SOAP_HEADERS });
  }

  // --- Modo JSON (pruebas manuales / otros consumidores) ---
  let body: { phone?: string; reason?: string };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid body (expected SOAP XML or JSON)" }, { status: 400 });
  }

  const phone = body.phone?.trim();
  if (!phone) {
    return NextResponse.json({ error: "Missing 'phone' in body" }, { status: 400 });
  }

  const reason = body.reason?.trim() || "salesforce";
  const closedIds = await closeConversationsForPhone(phone, reason);
  const variants = buildPhoneVariants(phone);

  if (closedIds.length === 0) {
    return NextResponse.json({ closed: 0, message: "No active conversations for phone", variants });
  }
  return NextResponse.json({ closed: closedIds.length, conversationIds: closedIds, variants });
}
