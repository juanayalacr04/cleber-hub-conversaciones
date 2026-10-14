import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { isCronAuthorized } from "@/lib/cron-auth";
import { getSalesforceCredentials, getSalesforceToken } from "@/lib/salesforce-env";
import { FieldValue } from "firebase-admin/firestore";

const INACTIVITY_FUNCTION_URL = process.env.INACTIVITY_FUNCTION_URL!;
const CRON_SECRET = process.env.CRON_SECRET;
const WINDOW_24H_MS = 24 * 60 * 60 * 1000;

// Sin límite de recordatorios por ladder. El código que recibe el bot identifica en
// qué paso del ladder está (1-indexado), para que Abacus module el tono del mensaje
// según el intento sin depender de un flag de cierre.
function reminderStageCode(index: number): string {
  return `__ADMIN_FOLLOWUP_${index + 1}_RECORDATORIO__`;
}

interface InactivityReminder {
  order: number;
  hours: number;
  closeAfter: boolean;
}

// Config por marca (no secreta) de organizations/{id}.salesforceConfig. Las credenciales de
// Salesforce salen de variables de entorno (SF_*, override SF_<MODULO>_*), no de Firestore.
interface BrandConfig {
  bdcFallbackOwnerId?: string;
  marcaRR?: string;
}

// Conexión a Salesforce lista para usar (credenciales del entorno + config de la marca)
interface SalesforceConfig extends BrandConfig {
  instanceUrl: string;
  accessToken: string;
}

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

async function autoAssignAgent(
  convId: string,
  teamId: string,
  mode: "round_robin" | "least_busy"
): Promise<string | null> {
  const teamDoc = await adminDb.collection("teams").doc(teamId).get();
  const maxConvs: number | undefined = teamDoc.data()?.maxConversationsPerAgent;

  const usersSnap = await adminDb
    .collection("users")
    .where("teamId", "==", teamId)
    .where("role", "in", ["admin", "agent"])
    .get();

  const availableAgents = usersSnap.docs
    .map((d) => ({ id: d.id, ...(d.data() as { isAvailable?: boolean; activeConversations?: number }) }))
    .filter((a) => a.isAvailable ?? true)
    .filter((a) => maxConvs == null || (a.activeConversations ?? 0) < maxConvs)
    .map((a) => ({ id: a.id, activeConversations: a.activeConversations ?? 0 }));

  if (availableAgents.length === 0) return null;

  let assignedAgentId: string;
  if (mode === "round_robin") {
    // ponytail: mismo criterio no-transaccional que auto_assign_agent() en main.py —
    // bajo alta concurrencia dos handoffs casi simultáneos podrían leer el mismo
    // índice; aceptable para el volumen actual.
    availableAgents.sort((a, b) => a.id.localeCompare(b.id));
    const teamRef = adminDb.collection("teams").doc(teamId);
    await teamRef.update({ roundRobinCounter: FieldValue.increment(1) });
    const counter: number = (await teamRef.get()).data()?.roundRobinCounter ?? 0;
    assignedAgentId = availableAgents[counter % availableAgents.length].id;
  } else {
    availableAgents.sort((a, b) => a.activeConversations - b.activeConversations);
    assignedAgentId = availableAgents[0].id;
  }

  await adminDb.collection("conversations").doc(convId).update({
    status: "with_agent",
    assignedAgentId,
    assignedAt: FieldValue.serverTimestamp(),
    waitingStartedAt: FieldValue.serverTimestamp(),
    assignedAgentType: "human",
    assignedBotId: null,
    assignedUserId: assignedAgentId,
  });
  await adminDb.collection("users").doc(assignedAgentId).update({
    activeConversations: FieldValue.increment(1),
    lastActivityAt: FieldValue.serverTimestamp(),
  });

  return assignedAgentId;
}

/**
 * Conexión a Salesforce de una organización: credenciales del entorno según el módulo de la
 * conversación + config por marca de la organización. undefined si faltan las credenciales.
 */
async function loadSalesforceConfig(
  orgId: string,
  vertical: string | undefined,
  cache: Map<string, SalesforceConfig | undefined>
): Promise<SalesforceConfig | undefined> {
  const key = `${orgId}|${vertical ?? ""}`;
  if (cache.has(key)) return cache.get(key);
  let result: SalesforceConfig | undefined;
  const creds = getSalesforceCredentials(vertical);
  if (creds) {
    const orgDoc = await adminDb.collection("organizations").doc(orgId).get();
    const brand: BrandConfig = orgDoc.exists ? (orgDoc.data()?.salesforceConfig ?? {}) : {};
    const { accessToken, instanceUrl } = await getSalesforceToken(creds);
    result = { ...brand, instanceUrl, accessToken };
  }
  cache.set(key, result);
  return result;
}

async function resetLeadSinRespuesta(sfConfig: SalesforceConfig, leadId: string, convId: string) {
  const accessToken = sfConfig.accessToken;
  const res = await fetch(`${sfConfig.instanceUrl}/services/data/v59.0/sobjects/Lead/${leadId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Sforce-Auto-Assign": "FALSE",
    },
    body: JSON.stringify({
      Validacion_Prospecto__c: "Sin validar",
      Status: "Nuevo",
      Fecha_Deal__c: null,
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    console.error(JSON.stringify({ event: "escalate_reset_sin_respuesta_error", convId, leadId, status: res.status, body: errBody.slice(0, 2000) }));
  } else {
    console.log(JSON.stringify({ event: "escalate_reset_sin_respuesta_ok", convId, leadId }));
  }
}

async function escalateToAdvisor(
  convId: string,
  conv: Record<string, any>,
  botCache: Map<string, Record<string, any>>,
  sfConfigCache: Map<string, SalesforceConfig | undefined>,
  teamCache: Map<string, Record<string, any> | undefined>,
  extraFields?: Record<string, any>
) {
  const botId: string | undefined = conv.botId;
  if (botId && !botCache.has(botId)) {
    const botDoc = await adminDb.collection("bots").doc(botId).get();
    botCache.set(botId, botDoc.exists ? (botDoc.data() as Record<string, any>) : {});
  }
  const bot = botId ? botCache.get(botId) : undefined;

  // Cliente nunca respondió: mismo criterio que _reset_lead_sin_respuesta en main.py
  // (rama de cierre por inactividad). Como casi todos los bots escalan en vez de cerrar
  // (escalateOnLastReminder), sin este patch el Lead se quedaba con lo que ya traía en
  // vez de marcarse Sin validar / Nuevo / sin fecha deal. Independiente del assignmentMode
  // del equipo (eso solo decide la asignación en la plataforma, no estos campos).
  if (!conv.lastCustomerMessageAt) {
    const leadIdReset: string | undefined = conv.leadId;
    const orgIdReset: string | undefined = bot?.organizationId;
    if (leadIdReset && orgIdReset) {
      const sfConfigReset = await loadSalesforceConfig(orgIdReset, conv.vertical, sfConfigCache);
      if (sfConfigReset?.instanceUrl) {
        await resetLeadSinRespuesta(sfConfigReset, leadIdReset, convId);
      }
    }
  }

  // Mismo criterio que apply_handoff_status() en main.py: el assignmentMode del
  // equipo decide cómo se escala. "salesforce" pasa a with_agent sin agente
  // asignado y es el único modo que dispara la asignación en Salesforce
  // (RR/OwnerId). "round_robin"/"least_busy" auto-asignan un agente disponible
  // del team. "manual" (o sin team) usa waiting_agent sin asignar, igual que antes.
  const teamId: string | undefined = conv.teamId;
  let mode: string | undefined;
  if (teamId) {
    if (!teamCache.has(teamId)) {
      const teamDoc = await adminDb.collection("teams").doc(teamId).get();
      teamCache.set(teamId, teamDoc.exists ? (teamDoc.data() as Record<string, any>) : undefined);
    }
    mode = teamCache.get(teamId)?.assignmentMode;
  }

  const withinHoursNow = !bot || checkBusinessHours(bot.scheduleConfig as ScheduleConfig | undefined);
  const isSalesforceMode = mode === "salesforce";

  // Fuera de horario ahora mismo y modo "salesforce": no tiene sentido esperar a que
  // abra para ahí sí pedir un agente en tiempo real — eso choca con el proceso propio
  // de Salesforce que reasigna todo lo que está en la cola BDC a las 8:28 (L-V) / 9:00
  // (sábado). En vez de esperar, se patchea el OwnerId ya mismo (igual que el handoff
  // manual fuera de horario en main.py) y se deja que Salesforce sea el único que
  // asigna agente. El status de la conversación no se toca, igual que en main.py.
  if (!withinHoursNow && isSalesforceMode) {
    const leadId: string | undefined = conv.leadId;
    if (!leadId || !botId || !bot) {
      console.log(JSON.stringify({ event: "escalate_owner_patch_skipped_no_lead_or_bot", convId, leadId, botId }));
      return;
    }
    const orgId: string | undefined = bot.organizationId;
    if (!orgId) {
      console.log(JSON.stringify({ event: "escalate_owner_patch_skipped_no_org", convId, leadId, botId }));
      return;
    }
    const sfConfig = await loadSalesforceConfig(orgId, conv.vertical, sfConfigCache);
    if (!sfConfig?.instanceUrl) {
      console.log(JSON.stringify({ event: "escalate_owner_patch_skipped_no_sf_config", convId, leadId, orgId }));
      return;
    }
    if (!sfConfig.bdcFallbackOwnerId) {
      console.log(JSON.stringify({ event: "escalate_owner_patch_skipped_no_bdc_owner", convId, leadId, orgId }));
      return;
    }

    const accessToken = sfConfig.accessToken;
    console.log(JSON.stringify({ event: "escalate_owner_patch_request", convId, leadId }));
    const res = await fetch(`${sfConfig.instanceUrl}/services/data/v59.0/sobjects/Lead/${leadId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Sforce-Auto-Assign": "FALSE",
      },
      body: JSON.stringify({ OwnerId: sfConfig.bdcFallbackOwnerId }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error(JSON.stringify({ event: "escalate_owner_patch_error", convId, leadId, status: res.status, body: errBody.slice(0, 2000) }));
    } else {
      console.log(JSON.stringify({ event: "escalate_owner_patch_ok", convId, leadId }));
    }

    await adminDb.collection("conversations").doc(convId).update({
      ...extraFields,
      inactivityEscalatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  // Fuera de horario para cualquier otro modo (round_robin/least_busy/manual): no se
  // toca nada todavía. No se marca inactivityEscalatedAt/escalatedOnLastReminder, así
  // que el cron reintenta en el siguiente tick hasta que caiga dentro de horario.
  if (!withinHoursNow) {
    console.log(JSON.stringify({ event: "escalate_skipped_out_of_hours", convId }));
    return;
  }

  if (teamId && (mode === "round_robin" || mode === "least_busy")) {
    const assignedAgentId = await autoAssignAgent(convId, teamId, mode);
    if (assignedAgentId) {
      await adminDb.collection("conversations").doc(convId).update({
        ...extraFields,
        inactivityEscalatedAt: FieldValue.serverTimestamp(),
      });
      return;
    }
    // sin agentes disponibles → cae a waiting_agent como el modo manual
  }

  const statusUpdate: Record<string, any> = isSalesforceMode
    ? {
        status: "with_agent",
        assignedAgentId: null,
        assignedAt: FieldValue.serverTimestamp(),
        waitingStartedAt: FieldValue.serverTimestamp(),
      }
    : { status: "waiting_agent" };

  await adminDb.collection("conversations").doc(convId).update({
    ...statusUpdate,
    ...extraFields,
    inactivityEscalatedAt: FieldValue.serverTimestamp(),
  });

  if (!isSalesforceMode) return;

  const leadId: string | undefined = conv.leadId;
  if (!leadId || !botId || !bot) {
    console.log(JSON.stringify({ event: "escalate_rr_skipped_no_lead_or_bot", convId, leadId, botId }));
    return;
  }

  const orgId: string | undefined = bot.organizationId;
  if (!orgId) {
    console.log(JSON.stringify({ event: "escalate_rr_skipped_no_org", convId, leadId, botId }));
    return;
  }

  const sfConfig = await loadSalesforceConfig(orgId, conv.vertical, sfConfigCache);
  if (!sfConfig?.instanceUrl) {
    console.log(JSON.stringify({ event: "escalate_rr_skipped_no_sf_config", convId, leadId, orgId }));
    return;
  }

  const accessToken = sfConfig.accessToken;
  const marca: string = sfConfig.marcaRR ?? "";

  // A esta altura ya se garantizó withinHoursNow=true más arriba (la rama de fuera de
  // horario para modo "salesforce" ya salió antes con el patch), así que aquí siempre
  // se pide asignación en tiempo real vía el Flow RR.
  if (marca) {
    console.log(JSON.stringify({ event: "escalate_rr_flow_request", convId, leadId, marca }));
    const res = await fetch(`${sfConfig.instanceUrl}/services/data/v66.0/actions/custom/flow/RRAgenteIACLEBER`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: [{ leadId, marcaRR: marca }] }),
    });
    const bodyText = await res.text();
    let isSuccess: boolean | undefined;
    try {
      const parsed = JSON.parse(bodyText);
      isSuccess = Array.isArray(parsed) ? parsed[0]?.isSuccess : undefined;
    } catch {
      // respuesta no-JSON, se loguea cruda abajo
    }
    console.log(JSON.stringify({
      event: res.ok && isSuccess ? "escalate_rr_flow_ok" : "escalate_rr_flow_failed",
      convId, leadId, marca, status: res.status, body: bodyText.slice(0, 2000),
    }));
  } else {
    console.log(JSON.stringify({ event: "escalate_rr_flow_skipped_no_marca", convId, leadId }));
  }
}

interface SendingHours {
  enabled: boolean;
  from: string;      // "09:00"
  to: string;        // "20:00"
  timezone?: string;
}

interface BotInactivityConfig {
  enabled: boolean;
  reminders: InactivityReminder[];
  sendingHours?: SendingHours;
  escalateEnabled?: boolean;
  escalateHours?: number;
  escalateOnLastReminder?: boolean;
  inboundOverride?: { reminders: InactivityReminder[] };
  noResponseOverride?: { reminders: InactivityReminder[] };
}

function isWithinSendingHours(sendingHours?: SendingHours): boolean {
  if (!sendingHours?.enabled) return true;

  const tz = sendingHours.timezone ?? "America/Mexico_City";
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);

  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);

  const [fromH, fromM] = sendingHours.from.split(":").map(Number);
  const [toH, toM] = sendingHours.to.split(":").map(Number);

  const nowMins = hour * 60 + minute;
  return nowMins >= fromH * 60 + fromM && nowMins <= toH * 60 + toM;
}

async function processInactivityFollowups(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Cargar bots activos con inactivityConfig habilitado
  const botsSnap = await adminDb
    .collection("bots")
    .where("status", "==", "active")
    .get();

  const activeBots = botsSnap.docs
    .map((d) => ({ id: d.id, ...(d.data() as { inactivityConfig?: BotInactivityConfig }) }))
    .filter(
      (b) =>
        b.inactivityConfig?.enabled &&
        (b.inactivityConfig?.reminders?.length ?? 0) > 0
    );

  if (activeBots.length === 0) {
    return NextResponse.json({ processed: 0, skipped: 0, message: "No bots with inactivity config" });
  }

  // Cutoff mínimo global para Query A (reminder o escalación con menos horas entre todos los bots).
  // Incluye inboundOverride.reminders y noResponseOverride.reminders — si no, el primer paso de
  // un ladder más corto que el base no entraría a tiempo a las queries A/B.
  const minHoursGlobal = Math.min(
    ...activeBots.flatMap((b) => [
      ...b.inactivityConfig!.reminders.map((r) => r.hours),
      ...(b.inactivityConfig!.inboundOverride?.reminders.map((r) => r.hours) ?? []),
      ...(b.inactivityConfig!.noResponseOverride?.reminders.map((r) => r.hours) ?? []),
      ...(b.inactivityConfig!.escalateEnabled ? [b.inactivityConfig!.escalateHours ?? 1] : []),
    ])
  );
  const now = Date.now();
  const earliestCutoff = new Date(now - minHoursGlobal * 60 * 60 * 1000);

  // Mapa botId → inactivityConfig
  const botMap = new Map(activeBots.map((b) => [b.id, b.inactivityConfig!]));

  // Query A: inactivos por mensaje del cliente (casos ①②)
  // "waiting_agent" se incluye para seguir el ladder de recordatorios/cierre de
  // conversaciones ya escaladas por este mismo cron (ver guard de inactivityEscalatedAt abajo).
  const convSnapA = await adminDb
    .collection("conversations")
    .where("status", "in", ["bot", "waiting_agent"])
    .where("lastMessageSender", "==", "bot")
    .where("lastCustomerMessageAt", "<", earliestCutoff)
    .get();

  // Query B: plantilla enviada hace tiempo y sin respuesta del cliente (casos ③④).
  // Usa earliestCutoff (mínimo configurado entre reminders/escalateHours de todos los
  // bots activos), no el fijo de 24h — un ladder puede tener un paso a <24h del anterior
  // (ej. escalateOnLastReminder 1h después de un recordatorio de 24h) y con cutoff24h esa
  // conversación nunca entraba al convMap para evaluarse (el guard de 24h real sigue
  // aplicando después, dentro del loop, vía WINDOW_24H_MS).
  const convSnapB = await adminDb
    .collection("conversations")
    .where("status", "in", ["bot", "waiting_agent"])
    .where("lastMessageSender", "==", "bot")
    .where("lastTemplateMessageAt", "<", earliestCutoff)
    .get();

  // Merge deduplicado por convId
  const convMap = new Map<string, (typeof convSnapA.docs)[number]>();
  for (const doc of [...convSnapA.docs, ...convSnapB.docs]) {
    convMap.set(doc.id, doc);
  }

  if (convMap.size === 0) {
    return NextResponse.json({ processed: 0, skipped: 0 });
  }

  // Cache de whatsappNumbers para no hacer N queries
  const waNumberCache = new Map<string, Record<string, unknown>>();
  // Caches para la rama de escalación (bots y salesforceConfig por org)
  const botCache = new Map<string, Record<string, any>>();
  const sfConfigCache = new Map<string, SalesforceConfig | undefined>();
  const teamCache = new Map<string, Record<string, any> | undefined>();

  const results = { processed: 0, skipped: 0, errors: 0 };
  const tasks: Promise<void>[] = [];

  for (const [, convDoc] of convMap) {
    const conv = convDoc.data();

    // Conversaciones de campañas de Servicio (recordatorios de cita, no-show): sin escalera de inactividad
    if (conv.broadcastId && conv.vertical === "servicio") {
      results.skipped++;
      continue;
    }

    // waiting_agent solo se procesa aquí si fue escalada por este mismo cron;
    // una conversación escalada manualmente (keyword) no debe tocarse.
    if (conv.status === "waiting_agent" && !conv.inactivityEscalatedAt) {
      results.skipped++;
      continue;
    }

    // Ya se escaló en el último recordatorio (reemplaza el cierre) — no seguir
    // el ladder ni volver a intentar cerrar/escalar esta conversación.
    if (conv.escalatedOnLastReminder) {
      results.skipped++;
      continue;
    }

    // El cliente pidió asesor fuera de horario (ValueText): el lead quedó con el owner de BDC y
    // el job de SF lo reasigna al abrir, así que el asesor toma la conversación — ni
    // recordatorios ni escalación.
    if (conv.handoffBlockedAt) {
      results.skipped++;
      continue;
    }

    // Si el cliente agendó un contacto específico, no interrumpir con recordatorios de inactividad
    if (conv.scheduledContactAt) {
      results.skipped++;
      continue;
    }

    // Si ya hay cita agendada (por bot o agente), no mandar recordatorios de inactividad
    if (conv.appointmentStatus === "cita_bot" || conv.appointmentStatus === "cita_agente") {
      results.skipped++;
      continue;
    }

    const botConfig = botMap.get(conv.botId) ?? null;

    // Escalación a asesor: independiente del ladder de recordatorios de abajo. Dispara una
    // sola vez (marcada con inactivityEscalatedAt) si el bot tiene escalateEnabled, el lead
    // está completo (outbound vía smsBucketId, o inbound ya calificado vía completedLead) y
    // el cliente ya respondió (lastCustomerMessageAt) hace >= escalateHours. Si el cliente
    // nunca respondió, no escala y sigue el ladder normal. No respeta sendingHours porque no
    // manda mensaje. Leads inbound incompletos (solo nombre) siguen el ladder sin escalar.
    const isLeadComplete = !!conv.smsBucketId || conv.completedLead === true;
    if (
      botConfig?.escalateEnabled &&
      !conv.inactivityEscalatedAt &&
      conv.leadId &&
      isLeadComplete &&
      conv.lastCustomerMessageAt
    ) {
      const clmMs: number = conv.lastCustomerMessageAt.toDate().getTime();
      if (now - clmMs >= (botConfig.escalateHours ?? 1) * 60 * 60 * 1000) {
        tasks.push(
          escalateToAdvisor(convDoc.id, conv, botCache, sfConfigCache, teamCache)
            .then(() => { results.processed++; })
            .catch((err) => {
              console.error(`inactivity-followup escalate error for conv ${convDoc.id}:`, err);
              results.errors++;
            })
        );
        continue;
      }
    }

    // Respetar horario de envío configurado — no mandar recordatorios fuera del rango
    if (!isWithinSendingHours(botConfig?.sendingHours)) {
      results.skipped++;
      continue;
    }

    if (!botConfig) {
      // Bot sin inactivityConfig activo (deshabilitado o config eliminada)
      // → cerrar sin mensaje para no dejar la conversación atascada
      const fhpCheck: Date | null = conv.lastTemplateMessageAt?.toDate?.() ?? null;
      if (fhpCheck && now - fhpCheck.getTime() < WINDOW_24H_MS) {
        results.skipped++;
        continue;
      }
      tasks.push(
        callInactivityFunction({
          convId: convDoc.id,
          botId: conv.botId,
          code: "__ADMIN_FOLLOWUP_CIERRE__",
          closeAfter: true,
          reminderIndex: conv.inactivityRemindersSent ?? 0,
          useTemplate: false,
          templateId: null,
        })
          .then(() => { results.processed++; })
          .catch((err) => {
            console.error(`inactivity-followup close error for conv ${convDoc.id}:`, err);
            results.errors++;
          })
      );
      continue;
    }

    const remindersSent: number = conv.inactivityRemindersSent ?? 0;
    // Tres ladders posibles, en orden de prioridad:
    // 1. noResponseOverride: lead outbound (smsBucketId seteado) que nunca respondió
    //    (lastCustomerMessageAt vacío) — típicamente más largo (ej. plantilla a 24h,
    //    escalar a 25h) porque no hay urgencia de "rescatar" una conversación que
    //    nunca estuvo viva. El check de smsBucketId (no solo lastCustomerMessageAt)
    //    evita un falso positivo: lead_webhook borra lastCustomerMessageAt SIEMPRE que
    //    llega un lead (incluso si el cliente está en sesión activa y se omite la
    //    plantilla por skip_template) pero en ese caso no setea smsBucketId, así que
    //    esa conversación activa sigue cayendo en el ladder normal de abajo.
    // 2. inboundOverride: conversación inbound (el cliente escribió primero, sin
    //    smsBucketId) — típicamente con un paso extra ya que no arrastra la plantilla
    //    inicial que manda lead_webhook.
    // 3. reminders (base): todo lo demás, incluyendo outbound que ya respondió.
    const isOutboundLead = !!conv.smsBucketId;
    const hasResponded = !!conv.lastCustomerMessageAt;
    const effectiveReminders =
      isOutboundLead && !hasResponded && botConfig.noResponseOverride?.reminders.length
        ? botConfig.noResponseOverride.reminders
        : !isOutboundLead && botConfig.inboundOverride?.reminders.length
        ? botConfig.inboundOverride.reminders
        : botConfig.reminders;
    const reminders = [...effectiveReminders].sort((a, b) => a.order - b.order);
    const nextReminder = reminders[remindersSent];
    if (!nextReminder) {
      // Ya se enviaron más recordatorios de los configurados (config reducida)
      // → tratar como si este fuera el último recordatorio: respeta escalateOnLastReminder
      // y manda la plantilla de cierre si existe, en vez de cerrar en silencio.
      const fhpCheck: Date | null = conv.lastTemplateMessageAt?.toDate?.() ?? null;
      if (fhpCheck && now - fhpCheck.getTime() < WINDOW_24H_MS) {
        results.skipped++;
        continue;
      }

      if (botConfig.escalateOnLastReminder) {
        tasks.push(
          escalateToAdvisor(convDoc.id, conv, botCache, sfConfigCache, teamCache, {
            escalatedOnLastReminder: true,
          })
            .then(() => { results.processed++; })
            .catch((err) => {
              console.error(`inactivity-followup escalate-on-last-reminder error for conv ${convDoc.id}:`, err);
              results.errors++;
            })
        );
        continue;
      }

      let closingTemplateId: string | null = null;
      const waId: string = conv.whatsappNumberId;
      if (waId) {
        if (!waNumberCache.has(waId)) {
          const waDoc = await adminDb.collection("whatsappNumbers").doc(waId).get();
          waNumberCache.set(waId, waDoc.exists ? (waDoc.data() as Record<string, unknown>) : {});
        }
        const waData = waNumberCache.get(waId)!;
        closingTemplateId = (waData.followupClosingTemplateId as string) ?? null;
      }

      tasks.push(
        callInactivityFunction({
          convId: convDoc.id,
          botId: conv.botId,
          code: reminderStageCode(remindersSent),
          closeAfter: true,
          reminderIndex: remindersSent,
          // Sin followupClosingTemplateId → main.py omite el envío (useTemplate=true, templateId=null)
          useTemplate: true,
          templateId: closingTemplateId,
        })
          .then(() => { results.processed++; })
          .catch((err) => {
            console.error(`inactivity-followup close error for conv ${convDoc.id}:`, err);
            results.errors++;
          })
      );
      continue;
    }

    // Timestamps clave
    const clm: Date | null = conv.lastCustomerMessageAt?.toDate?.() ?? null;
    const fhp: Date | null = conv.lastTemplateMessageAt?.toDate?.() ?? null;

    // Casos ③④: verificar horas configuradas desde el último mensaje del cliente.
    // Si CLM es null (lead sin respuesta), usar createdAt como referencia. Este check
    // va antes del cooldown de 24h para poder distinguir "aún no toca este paso" (skip
    // real) de "toca pero no se puede mandar plantilla todavía" (avanza sin enviar,
    // ver cooldownBlocked más abajo) — si no, el cierre/escalación 1h después de un
    // recordatorio quedaba atorado hasta la siguiente ventana completa de 24h.
    const inactivityRef: Date | null = clm ?? (conv.createdAt?.toDate?.() ?? null);
    if (fhp && inactivityRef && now - inactivityRef.getTime() < nextReminder.hours * 60 * 60 * 1000) {
      results.skipped++;
      continue;
    }

    // Determinar caso y tipo de mensaje
    let useTemplate = false;
    let templateId: string | null = null;

    if (!fhp && clm && now - clm.getTime() < WINDOW_24H_MS) {
      // Caso ①: ventana libre abierta por el cliente — aplica horas configuradas
      const hoursInactive = (now - clm.getTime()) / (1000 * 60 * 60);
      if (hoursInactive < nextReminder.hours) {
        results.skipped++;
        continue;
      }
      useTemplate = false;
    } else if (!fhp) {
      // Caso ②: FHP nulo y ventana de 24h expirada (CLM nulo o ≥ 24h) → plantilla apertura
      useTemplate = true;
    } else {
      // Casos ③④: FHP existe y han pasado ≥24h → plantilla recordatorio
      useTemplate = true;
    }

    const isLast = remindersSent === reminders.length - 1;

    // Último recordatorio configurado para escalar en vez de cerrar: en lugar de
    // mandar la plantilla de cierre, se delega a Salesforce con la misma lógica
    // que la escalación independiente (RR/OwnerId según horario, with_agent si
    // el equipo usa assignmentMode "salesforce"). Marca escalatedOnLastReminder
    // para que el guard de arriba no vuelva a tocar la conversación.
    //
    // NO se exige `!conv.inactivityEscalatedAt`: una conversación ya escalada por
    // `escalateHours` puede seguir viva en el ladder si esa escalación no alcanzó a
    // pasarla a un asesor — el caso típico es modo "salesforce" fuera del horario del
    // bot, donde solo se patchea el OwnerId y el status se queda en "bot". Con ese
    // guard, el último recordatorio se saltaba la escalación y caía al cierre
    // (closeAfter), cerrando la conversación y marcando el Lead como
    // "Finalizado sin cita" justo cuando debía estar con el asesor. Volver a llamar a
    // escalateToAdvisor es idempotente en la práctica: si ya hay horario, ahora sí
    // pasa a with_agent + RR; si sigue fuera, repite el patch de OwnerId. En ambos
    // casos sella con escalatedOnLastReminder y el ladder no la vuelve a tocar.
    if (isLast && botConfig.escalateOnLastReminder) {
      tasks.push(
        escalateToAdvisor(convDoc.id, conv, botCache, sfConfigCache, teamCache, {
          escalatedOnLastReminder: true,
        })
          .then(() => { results.processed++; })
          .catch((err) => {
            console.error(`inactivity-followup escalate-on-last-reminder error for conv ${convDoc.id}:`, err);
            results.errors++;
          })
      );
      continue;
    }

    // Cooldown de 24h: ya tocaba este paso (pasó el check de arriba) pero la última
    // plantilla se mandó hace <24h, así que no se puede mandar otra todavía. En vez
    // de saltarnos el tick entero (lo que atoraba el cierre/escalación 1h después de
    // un recordatorio hasta la siguiente ventana completa de 24h), se avanza el
    // conteo sin enviar mensaje — misma rama "sin plantilla válida" que ya soporta
    // inactivity_followup en main.py.
    const cooldownBlocked = useTemplate && !!fhp && now - fhp.getTime() < WINDOW_24H_MS;

    // Resolver templateId desde whatsappNumbers
    if (useTemplate && !cooldownBlocked) {
      const waId: string = conv.whatsappNumberId;
      if (waId) {
        if (!waNumberCache.has(waId)) {
          const waDoc = await adminDb.collection("whatsappNumbers").doc(waId).get();
          waNumberCache.set(waId, waDoc.exists ? (waDoc.data() as Record<string, unknown>) : {});
        }
        const waData = waNumberCache.get(waId)!;
        if (isLast || nextReminder.closeAfter) {
          // último intento → plantilla de cierre. Tiene prioridad sobre la reapertura
          // para que el cierre nunca se omita cuando FHP quedó null tras un mensaje
          // libre (siempre hay al menos un recordatorio antes del cierre).
          // Sin followupClosingTemplateId → cierra sin mandar mensaje. useTemplate se
          // queda en true con templateId null para que main.py omita el envío
          // (rama "useTemplate=True pero sin plantilla válida" en inactivity_followup).
          templateId = (waData.followupClosingTemplateId as string) ?? null;
        } else if (!fhp) {
          // caso ②: reapertura de ventana
          templateId = (waData.followupOpeningTemplateId as string) ?? null;
        } else {
          // casos ③④ intermedio → plantilla de recordatorio
          templateId = (waData.followupReminderTemplateId as string) ?? null;
        }
      }
    }

    const code = reminderStageCode(remindersSent);
    const closeAfter = isLast || nextReminder.closeAfter;

    tasks.push(
      callInactivityFunction({
        convId: convDoc.id,
        botId: conv.botId,
        code,
        closeAfter,
        reminderIndex: remindersSent + 1,
        useTemplate,
        templateId,
      })
        .then(() => { results.processed++; })
        .catch((err) => {
          console.error(`inactivity-followup error for conv ${convDoc.id}:`, err);
          results.errors++;
        })
    );
  }

  // Procesar en lotes de 10 para no saturar la Cloud Function
  const batchSize = 10;
  for (let i = 0; i < tasks.length; i += batchSize) {
    await Promise.allSettled(tasks.slice(i, i + batchSize));
  }

  return NextResponse.json(results);
}

// Cuerpo que espera la Cloud Function `inactivity_followup` (jobs/inactivity.py)
async function callInactivityFunction(payload: {
  convId: string;
  botId: string;
  code: string;
  closeAfter: boolean;
  reminderIndex: number;
  useTemplate: boolean;
  templateId: string | null;
}) {
  if (!INACTIVITY_FUNCTION_URL) throw new Error("INACTIVITY_FUNCTION_URL no está configurada");
  const res = await fetch(INACTIVITY_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cron-Secret": CRON_SECRET ?? "",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(150_000),
  });
  if (!res.ok) throw new Error(`Cloud Function returned ${res.status}`);
}

export async function GET(request: NextRequest) {
  return processInactivityFollowups(request);
}

export async function POST(request: NextRequest) {
  return processInactivityFollowups(request);
}
