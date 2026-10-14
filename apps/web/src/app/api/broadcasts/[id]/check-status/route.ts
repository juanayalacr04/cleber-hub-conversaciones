import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { verifyAuthToken } from "@/lib/auth-middleware";
import { authorizeOrg } from "@/lib/authz";
import { getSalesforceCredentials, getSalesforceToken } from "@/lib/salesforce-env";

const SF_BATCH = 500;
const TWILIO_CONCURRENCY = 10;

export const maxDuration = 60;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await verifyAuthToken(request);
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: broadcastId } = await params;
    const broadcastRef = adminDb.collection("broadcasts").doc(broadcastId);
    const broadcastDoc = await broadcastRef.get();
    if (!broadcastDoc.exists) return NextResponse.json({ error: "Broadcast not found" }, { status: 404 });

    const broadcast = broadcastDoc.data()!;

    const denied = await authorizeOrg(authUser.uid, broadcast.organizationId, { write: true });
    if (denied) return denied;

    const waNumberDoc = await adminDb.collection("whatsappNumbers").doc(broadcast.whatsappNumberId).get();
    const provider = waNumberDoc.data()?.provider;
    if (provider !== "valuetext" && provider !== "twilio") {
      return NextResponse.json({ error: "Solo disponible para campañas ValueText o Twilio" }, { status: 400 });
    }

    // Get all "sent" recipients that haven't reached a final delivery state yet
    // (once deliveryStatus is set — delivered/read/failed — it never changes, so we never re-check it)
    const sentSnap = await broadcastRef.collection("recipients").where("status", "==", "sent").get();
    const toCheck = sentSnap.docs.filter((d) => {
      const { whatsappMessageId, deliveryStatus } = d.data();
      return whatsappMessageId && !deliveryStatus;
    });
    if (toCheck.length === 0) return NextResponse.json({ checked: 0, delivered: 0, failed: 0 });

    let delivered = 0;
    let failed = 0;

    if (provider === "valuetext") {
      const sfCreds = getSalesforceCredentials(broadcast.vertical);
      if (!sfCreds) {
        return NextResponse.json({ error: "Salesforce credentials not configured (SF_* env)" }, { status: 500 });
      }
      let sfToken: string;
      let sfInstanceUrl: string;
      try {
        const tk = await getSalesforceToken(sfCreds);
        sfToken = tk.accessToken;
        sfInstanceUrl = tk.instanceUrl;
      } catch {
        return NextResponse.json({ error: "Salesforce auth failed" }, { status: 500 });
      }

      const idToDoc = new Map(toCheck.map((d) => [d.data().whatsappMessageId as string, d]));
      const allIds = [...idToDoc.keys()];

      for (let i = 0; i < allIds.length; i += SF_BATCH) {
        const ids = allIds.slice(i, i + SF_BATCH);
        const inClause = ids.map((id) => `'${id}'`).join(",");
        const soql = `SELECT Id, rsplus__Processed__c, rsplus__Status__c, rsplus__Status_Message__c FROM rsplus__SMS_Bucket__c WHERE Id IN (${inClause})`;

        const sfRes = await fetch(
          `${sfInstanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`,
          { headers: { Authorization: `Bearer ${sfToken}` } }
        );
        if (!sfRes.ok) continue;

        const { records = [] } = await sfRes.json();

        const batch = adminDb.batch();
        let batchCount = 0;

        for (const record of records) {
          if (!record.rsplus__Processed__c) continue; // still processing

          const doc = idToDoc.get(record.Id);
          if (!doc) continue;

          if (record.rsplus__Status__c === "FAIL") {
            batch.update(doc.ref, {
              deliveryStatus: "failed",
              deliveryStatusMessage: record.rsplus__Status_Message__c || "Delivery failed",
            });
            failed++;
          } else {
            batch.update(doc.ref, {
              deliveryStatus: record.rsplus__Status__c === "Read" ? "read" : "delivered",
              deliveryStatusMessage: record.rsplus__Status_Message__c || null,
            });
            delivered++;
          }
          batchCount++;
        }

        if (batchCount > 0) await batch.commit();
      }
    } else {
      // Twilio
      const accountSid = waNumberDoc.data()?.twilioAccountSid || "";
      const authToken = waNumberDoc.data()?.twilioAuthToken || "";
      if (!accountSid || !authToken) {
        return NextResponse.json({ error: "Twilio credentials not configured" }, { status: 500 });
      }
      const twilioClient = twilio(accountSid, authToken);

      for (let i = 0; i < toCheck.length; i += TWILIO_CONCURRENCY) {
        const batch = toCheck.slice(i, i + TWILIO_CONCURRENCY);
        await Promise.all(
          batch.map(async (doc) => {
            const { whatsappMessageId } = doc.data();
            try {
              const msg = await twilioClient.messages(whatsappMessageId).fetch();

              if (msg.status === "failed" || msg.status === "undelivered") {
                await doc.ref.update({
                  deliveryStatus: "failed",
                  deliveryStatusMessage: msg.errorMessage || "Delivery failed",
                });
                failed++;
              } else if (msg.status === "delivered" || msg.status === "read") {
                await doc.ref.update({
                  deliveryStatus: msg.status === "read" ? "read" : "delivered",
                  deliveryStatusMessage: null,
                });
                delivered++;
              }
              // queued/sending/sent: still in transit, leave for next check
            } catch (err) {
              console.error(`Error fetching Twilio status for ${whatsappMessageId}:`, err);
            }
          })
        );
      }
    }

    if (delivered > 0 || failed > 0) {
      const updates: Record<string, ReturnType<typeof FieldValue.increment>> = {};
      if (delivered > 0) updates.deliveredCount = FieldValue.increment(delivered);
      if (failed > 0) updates.failedCount = FieldValue.increment(failed);
      await broadcastRef.update(updates);
    }

    return NextResponse.json({ checked: toCheck.length, delivered, failed });
  } catch (error) {
    console.error("Error checking broadcast status:", error);
    return NextResponse.json({ error: "Failed to check status" }, { status: 500 });
  }
}
