import { hasApiSecret } from "@/lib/cron-auth";
import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

const SOAP_ACK =
  '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><notificationsResponse xmlns="http://soap.sforce.com/2005/09/outbound"><Ack>true</Ack></notificationsResponse></soapenv:Body></soapenv:Envelope>';

const SOAP_HEADERS = { "Content-Type": "text/xml" };

/** Extrae los sf:Id de cada sObject del SOAP XML de Salesforce. */
function extractLeadIdsFromXml(xml: string): string[] {
  const re = /<(?:\w+:)?Id>([^<]+)<\/(?:\w+:)?Id>/g;
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const val = m[1].trim();
    if (val) ids.push(val);
  }
  return ids;
}

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

  if (!looksLikeXml) {
    return new NextResponse(SOAP_ACK, { status: 200, headers: SOAP_HEADERS });
  }

  const leadIds = extractLeadIdsFromXml(rawBody);
  console.log("assign-agent-by-lead received", { leadIds });

  for (const leadId of leadIds) {
    try {
      const snap = await adminDb
        .collection("conversations")
        .where("leadId", "==", leadId)
        .where("status", "in", ["bot", "waiting_agent"])
        .limit(1)
        .get();

      if (snap.empty) {
        console.log("assign-agent-by-lead no conv", { leadId });
        continue;
      }

      const doc = snap.docs[0];
      await doc.ref.update({
        status: "with_agent",
        assignedAgentId: null,
        assignedAt: FieldValue.serverTimestamp(),
      });
      console.log("assign-agent-by-lead done", { leadId, convId: doc.id });
    } catch (err) {
      console.error("assign-agent-by-lead error", { leadId, err });
    }
  }

  return new NextResponse(SOAP_ACK, { status: 200, headers: SOAP_HEADERS });
}
