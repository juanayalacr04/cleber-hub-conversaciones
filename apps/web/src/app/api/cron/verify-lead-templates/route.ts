import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { isCronAuthorized } from "@/lib/cron-auth";
import { getSalesforceCredentials, getSalesforceToken } from "@/lib/salesforce-env";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

interface ScheduleDay { day: string; startTime: string; endTime: string }
interface ScheduleConfig { enabled?: boolean; timezone?: string; schedule?: ScheduleDay[] }

function checkBusinessHours(cfg: ScheduleConfig | undefined): boolean {
  if (!cfg?.enabled) return true;
  const tz = cfg.timezone ?? "America/Mexico_City";
  const now = new Date();
  const dayName = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(now).toLowerCase();
  const timeStr = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const entry = cfg.schedule?.find((s) => s.day === dayName);
  if (!entry) return false;
  return timeStr >= entry.startTime && timeStr < entry.endTime;
}

// Config por marca (no secreta) de organizations/{id}.salesforceConfig; las credenciales salen del entorno.
interface BrandConfig {
  bdcFallbackOwnerId?: string;
  marcaRR?: string;
}

async function verifyLeadTemplates(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cutoff = Timestamp.fromMillis(Date.now() - 3 * 60 * 1000);

  const snap = await adminDb
    .collection("conversations")
    .where("templateVerified", "==", false)
    .get();

  if (snap.empty) return NextResponse.json({ verified: 0, escalated: 0 });

  // Filtrar los que ya tienen al menos 3 min y tienen bucket ID
  const toCheck: { convId: string; bucketId: string; orgId: string; leadId: string; botId: string }[] = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    const lastTemplate: Timestamp | undefined = d.lastTemplateMessageAt;
    const bucketId: string | undefined = d.smsBucketId;
    const orgId: string | undefined = d.organizationId;
    if (!lastTemplate || !bucketId || !orgId) continue;
    if (d.vertical === "servicio") continue; // los Leads de Salesforce son solo de Ventas
    if (lastTemplate > cutoff) continue; // Aún muy reciente
    toCheck.push({ convId: doc.id, bucketId, orgId, leadId: d.leadId ?? "", botId: d.botId ?? "" });
  }

  if (!toCheck.length) return NextResponse.json({ verified: 0, escalated: 0 });

  // Precargar bots únicos para el scheduleConfig (horario de atención)
  const botIds = [...new Set(toCheck.map((i) => i.botId).filter(Boolean))];
  const botDocs = await Promise.all(botIds.map((id) => adminDb.collection("bots").doc(id).get()));
  const botSchedule = new Map(botDocs.map((d) => [d.id, d.data()?.scheduleConfig as ScheduleConfig | undefined]));

  // Agrupar por org para un solo token de Salesforce por org
  const byOrg = new Map<string, typeof toCheck>();
  for (const item of toCheck) {
    if (!byOrg.has(item.orgId)) byOrg.set(item.orgId, []);
    byOrg.get(item.orgId)!.push(item);
  }

  let verified = 0;
  let escalated = 0;

  for (const [orgId, items] of byOrg) {
    const orgDoc = await adminDb.collection("organizations").doc(orgId).get();
    const brandConfig: BrandConfig = orgDoc.data()?.salesforceConfig ?? {};
    // Este cron solo aplica a Ventas (Leads de Salesforce)
    const creds = getSalesforceCredentials("ventas");
    if (!creds) {
      console.error("verify-lead-templates: faltan las credenciales SF_* en el entorno");
      continue;
    }

    let accessToken: string;
    try {
      ({ accessToken } = await getSalesforceToken(creds));
    } catch (e) {
      console.error(`verify-lead-templates: SF auth failed for org ${orgId}`, e);
      continue;
    }

    const idsStr = items.map((i) => i.bucketId).join("','");
    const soql = `SELECT Id, rsplus__Processed__c, rsplus__Status__c FROM rsplus__SMS_Bucket__c WHERE Id IN ('${idsStr}')`;

    let records: { Id: string; rsplus__Processed__c: boolean; rsplus__Status__c: string }[];
    try {
      const sfRes = await fetch(
        `${creds.instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!sfRes.ok) throw new Error(`SF query ${sfRes.status}`);
      const data = await sfRes.json();
      records = data.records ?? [];
    } catch (e) {
      console.error(`verify-lead-templates: SF query failed for org ${orgId}`, e);
      continue;
    }

    const statusById = new Map(records.map((r) => [r.Id, r]));

    await Promise.allSettled(
      items.map(async ({ convId, bucketId, leadId, botId }) => {
        const rec = statusById.get(bucketId);
        if (!rec || !rec.rsplus__Processed__c) return; // Aún pendiente en ValueText

        const convRef = adminDb.collection("conversations").doc(convId);
        if (rec.rsplus__Status__c === "FAIL") {
          const withinHours = checkBusinessHours(botSchedule.get(botId));

          await convRef.update({
            status: "with_agent",
            templateVerified: true,
            templateFailed: true,
            templateFailedAt: FieldValue.serverTimestamp(),
          });

          // Mismo comportamiento que un handoff normal: actualizar Lead + asignar asesor.
          // Dentro de horario se usa el Flow RR; fuera de horario se asigna el OwnerId del BDC de inmediato.
          if (leadId) {
            const marca = brandConfig.marcaRR ?? "";
            await Promise.allSettled([
              fetch(
                `${creds.instanceUrl}/services/data/v59.0/sobjects/Lead/${leadId}`,
                {
                  method: "PATCH",
                  headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                    "Sforce-Auto-Assign": "FALSE",
                  },
                  body: JSON.stringify(
                    withinHours || !brandConfig.bdcFallbackOwnerId
                      ? { Validacion_Prospecto__c: "Error plantilla", Status: "Nuevo", Fecha_Deal__c: null }
                      : { Validacion_Prospecto__c: "Error plantilla", Status: "Nuevo", Fecha_Deal__c: null, OwnerId: brandConfig.bdcFallbackOwnerId }
                  ),
                }
              ),
              // Flow RRAgenteIACLEBER para reasignar owner del lead (solo dentro de horario)
              withinHours && marca
                ? fetch(
                    `${creds.instanceUrl}/services/data/v66.0/actions/custom/flow/RRAgenteIACLEBER`,
                    {
                      method: "POST",
                      headers: {
                        Authorization: `Bearer ${accessToken}`,
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify({ inputs: [{ leadId, marcaRR: marca }] }),
                    }
                  )
                : Promise.resolve(),
            ]);
          }

          escalated++;
        } else {
          await convRef.update({ templateVerified: true });
          verified++;
        }
      })
    );
  }

  console.log(`verify-lead-templates: verified=${verified} escalated=${escalated}`);
  return NextResponse.json({ verified, escalated });
}

export async function GET(request: NextRequest) {
  return verifyLeadTemplates(request);
}

export async function POST(request: NextRequest) {
  return verifyLeadTemplates(request);
}
