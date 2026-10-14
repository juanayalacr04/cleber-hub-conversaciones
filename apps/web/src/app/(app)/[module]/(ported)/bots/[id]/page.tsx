"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Loader2, Save, Eye, EyeOff, RefreshCw, Brain, Wrench, FileText, Search } from "lucide-react";
import { db } from "@/lib/firebase";
import { doc, getDoc, updateDoc, deleteField, collection, query, where, getDocs } from "firebase/firestore";
import { useAuth } from "@/contexts/AuthContext";
import Link from "next/link";
import { modulePath } from "@/lib/routes";

interface BotTool {
  name: string;
  event: string;
  phase: "early" | "main";
  match?: string;
}

interface CounterRow {
  action: string;
  counter: string;
}

interface InactivityReminder {
  order: number;
  hours: number;
  closeAfter: boolean;
}

interface SituationRoute {
  situacion: string;
  destino: "cambiar_bot" | "interno" | "externo" | "ninguno" | "lead";
  internalOrganizationId?: string;
  internalWhatsappNumberId?: string;
  internalBotId?: string;
  externalUrl?: string;
  externalTargetPhone?: string;
  seminuevoOwnerId?: string;
}

// Sin límite de recordatorios por ladder — el código de cada paso es dinámico.
function reminderStageLabel(index: number): string {
  return `__ADMIN_FOLLOWUP_${index + 1}_RECORDATORIO__`;
}

const SITUACIONES = [
  { value: "servicio_postventa", label: "Servicio / Postventa" },
  { value: "seminuevo", label: "Seminuevos" },
  { value: "fuera_de_alcance", label: "Fuera de alcance (descartar)" },
  { value: "finalizado_por_cliente", label: "Cliente pide no ser contactado" },
];

interface BotData {
  id: string;
  name: string;
  description: string;
  type: "chatllm" | "workflow" | "vertex_ai" | "external";
  category?: string;
  vertical?: "servicio" | "ventas";
  optOutAction?: "close" | "handoff";
  tools?: BotTool[];
  outcomeActions?: string[];
  broadcastResponseCounters?: Record<string, string>;
  injectPhoneContext?: boolean;
  status: "active" | "paused" | "draft";
  organizationId: string;
  twilioConfig: {
    phoneNumber: string;
    accountSid: string;
    authToken: string;
  };
  abacusConfig: {
    deploymentId: string;
    deploymentToken: string;
    workflowInputName?: string;
    apiKey?: string;
  };
  vertexAiConfig?: {
    endpoint: string;
    projectId?: string;
    location?: string;
  };
  externalConfig?: {
    endpoint: string;
    apiKey?: string;
  };
  handoffConfig: {
    enabled: boolean;
    triggerKeywords: string[];
    handoffMessage?: string;
    waitingMessage?: string;
  };
  inactivityConfig?: {
    enabled: boolean;
    reminders: InactivityReminder[];
    sendingHours?: {
      enabled: boolean;
      from: string;
      to: string;
      timezone: string;
    };
    escalateEnabled?: boolean;
    escalateHours?: number;
    escalateOnLastReminder?: boolean;
    inboundOverride?: {
      reminders: InactivityReminder[];
    };
    noResponseOverride?: {
      reminders: InactivityReminder[];
    };
  };
  scheduleConfig?: {
    enabled: boolean;
    viaBot?: boolean;
    timezone: string;
    outOfHoursMessage: string;
    schedule: {
      day: "monday"|"tuesday"|"wednesday"|"thursday"|"friday"|"saturday"|"sunday";
      startTime: string;
      endTime: string;
    }[];
  };
  situationRouting?: SituationRoute[];
}

export default function EditBotPage() {
  const params = useParams();
  const moduleId = params.module as string;
  const router = useRouter();
  const { userData, user, organizations: authOrgs } = useAuth();
  const [bot, setBot] = useState<BotData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showTwilioToken, setShowTwilioToken] = useState(false);
  const [showAbacusToken, setShowAbacusToken] = useState(false);

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [botType, setBotType] = useState<"chatllm" | "workflow" | "vertex_ai" | "external">("chatllm");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [twilioAccountSid, setTwilioAccountSid] = useState("");
  const [twilioAuthToken, setTwilioAuthToken] = useState("");
  const [abacusDeploymentId, setAbacusDeploymentId] = useState("");
  const [abacusDeploymentToken, setAbacusDeploymentToken] = useState("");
  const [workflowInputName, setWorkflowInputName] = useState("");
  const [abacusApiKey, setAbacusApiKey] = useState("");
  const [showAbacusApiKey, setShowAbacusApiKey] = useState(false);
  const [vertexAiEndpoint, setVertexAiEndpoint] = useState("");
  const [vertexAiProjectId, setVertexAiProjectId] = useState("");
  const [vertexAiLocation, setVertexAiLocation] = useState("");
  const [externalEndpoint, setExternalEndpoint] = useState("");
  const [externalApiKey, setExternalApiKey] = useState("");
  const [showExternalApiKey, setShowExternalApiKey] = useState(false);
  const [category, setCategory] = useState("");
  const [botVerticalValue, setBotVerticalValue] = useState<"servicio" | "ventas" | "none">("none");
  const [optOutAction, setOptOutAction] = useState<"inherit" | "close" | "handoff">("inherit");
  const [tools, setTools] = useState<BotTool[]>([]);
  const [outcomeActionsText, setOutcomeActionsText] = useState("");
  const [counterRows, setCounterRows] = useState<CounterRow[]>([]);
  const [injectPhoneContext, setInjectPhoneContext] = useState<"default" | "yes" | "no">("default");
  const [handoffMessage, setHandoffMessage] = useState("");
  const [waitingMessage, setWaitingMessage] = useState("");
  const [scheduleViaBot, setScheduleViaBot] = useState(false);
  const [handoffEnabled, setHandoffEnabled] = useState(false);
  const [handoffKeywords, setHandoffKeywords] = useState("");
  const [inactivityEnabled, setInactivityEnabled] = useState(false);
  const [inactivityReminders, setInactivityReminders] = useState<InactivityReminder[]>([]);
  const [sendingHoursEnabled, setSendingHoursEnabled] = useState(false);
  const [sendingHoursFrom, setSendingHoursFrom] = useState("09:00");
  const [sendingHoursTo, setSendingHoursTo] = useState("20:00");
  const [sendingHoursTimezone, setSendingHoursTimezone] = useState("America/Mexico_City");
  const [escalateEnabled, setEscalateEnabled] = useState(false);
  const [escalateHours, setEscalateHours] = useState(1);
  const [escalateOnLastReminder, setEscalateOnLastReminder] = useState(false);
  const [inboundOverrideEnabled, setInboundOverrideEnabled] = useState(false);
  const [inboundReminders, setInboundReminders] = useState<InactivityReminder[]>([]);
  const [noResponseOverrideEnabled, setNoResponseOverrideEnabled] = useState(false);
  const [noResponseReminders, setNoResponseReminders] = useState<InactivityReminder[]>([]);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleTimezone, setScheduleTimezone] = useState("America/Mexico_City");
  const [scheduleOutOfHoursMessage, setScheduleOutOfHoursMessage] = useState("");
  const [scheduleDays, setScheduleDays] = useState<Record<string, { enabled: boolean; startTime: string; endTime: string }>>({
    monday:    { enabled: false, startTime: "09:00", endTime: "18:00" },
    tuesday:   { enabled: false, startTime: "09:00", endTime: "18:00" },
    wednesday: { enabled: false, startTime: "09:00", endTime: "18:00" },
    thursday:  { enabled: false, startTime: "09:00", endTime: "18:00" },
    friday:    { enabled: false, startTime: "09:00", endTime: "18:00" },
    saturday:  { enabled: false, startTime: "09:00", endTime: "18:00" },
    sunday:    { enabled: false, startTime: "09:00", endTime: "18:00" },
  });
  const [formOrgId, setFormOrgId] = useState("");
  const [situationRouting, setSituationRouting] = useState<SituationRoute[]>([]);
  const [numbersByOrg, setNumbersByOrg] = useState<Record<string, { id: string; displayName: string }[]>>({});
  const [botsByOrg, setBotsByOrg] = useState<Record<string, { id: string; name: string }[]>>({});

  const loadNumbersForOrg = async (orgId: string) => {
    if (!orgId || numbersByOrg[orgId]) return;
    const numbersSnap = await getDocs(
      query(collection(db, "whatsappNumbers"), where("organizationId", "==", orgId))
    );
    setNumbersByOrg((prev) => ({
      ...prev,
      [orgId]: numbersSnap.docs.map((d) => ({ id: d.id, displayName: d.data().displayName || d.data().phoneNumber || d.id })),
    }));
  };

  const loadBotsForOrg = async (orgId: string) => {
    if (!orgId || botsByOrg[orgId]) return;
    const botsSnap = await getDocs(
      query(collection(db, "bots"), where("organizationId", "==", orgId))
    );
    setBotsByOrg((prev) => ({
      ...prev,
      [orgId]: botsSnap.docs.map((d) => ({ id: d.id, name: d.data().name || d.id })),
    }));
  };

  // ChatLLM config state
  const [chatllmConfig, setChatllmConfig] = useState<Record<string, unknown> | null>(null);
  const [chatllmLoading, setChatllmLoading] = useState(false);
  const [chatllmError, setChatllmError] = useState("");

  useEffect(() => {
    const fetchBot = async () => {
      if (!params.id) return;

      try {
        const botDoc = await getDoc(doc(db, "bots", params.id as string));
        if (botDoc.exists()) {
          const data = { id: botDoc.id, ...botDoc.data() } as BotData;
          setBot(data);

          // Populate form
          setName(data.name || "");
          setDescription(data.description || "");
          setBotType(data.type || "chatllm");
          setPhoneNumber(data.twilioConfig?.phoneNumber || "");
          setTwilioAccountSid(data.twilioConfig?.accountSid || "");
          setTwilioAuthToken(data.twilioConfig?.authToken || "");
          setAbacusDeploymentId(data.abacusConfig?.deploymentId || "");
          setAbacusDeploymentToken(data.abacusConfig?.deploymentToken || "");
          setWorkflowInputName(data.abacusConfig?.workflowInputName || "");
          setAbacusApiKey(data.abacusConfig?.apiKey || "");
          setVertexAiEndpoint(data.vertexAiConfig?.endpoint || "");
          setVertexAiProjectId(data.vertexAiConfig?.projectId || "");
          setVertexAiLocation(data.vertexAiConfig?.location || "");
          setExternalEndpoint(data.externalConfig?.endpoint || "");
          setExternalApiKey(data.externalConfig?.apiKey || "");
          setCategory(data.category || "");
          const catLower = (data.category || "").toLowerCase();
          setBotVerticalValue(
            data.vertical ?? (catLower === "servicio" || catLower === "ventas" ? (catLower as "servicio" | "ventas") : "none")
          );
          setOptOutAction(data.optOutAction ?? "inherit");
          setTools(data.tools ?? []);
          setOutcomeActionsText((data.outcomeActions ?? []).join(", "));
          setCounterRows(
            Object.entries(data.broadcastResponseCounters ?? {}).map(([action, counter]) => ({ action, counter }))
          );
          setInjectPhoneContext(
            data.injectPhoneContext === undefined ? "default" : data.injectPhoneContext ? "yes" : "no"
          );
          setHandoffMessage(data.handoffConfig?.handoffMessage || "");
          setWaitingMessage(data.handoffConfig?.waitingMessage || "");
          setScheduleViaBot(data.scheduleConfig?.viaBot ?? false);
          setHandoffEnabled(data.handoffConfig?.enabled || false);
          setHandoffKeywords(data.handoffConfig?.triggerKeywords?.join(", ") || "");
          setInactivityEnabled(data.inactivityConfig?.enabled ?? false);
          setInactivityReminders(data.inactivityConfig?.reminders ?? []);
          setSendingHoursEnabled(data.inactivityConfig?.sendingHours?.enabled ?? false);
          setSendingHoursFrom(data.inactivityConfig?.sendingHours?.from ?? "09:00");
          setSendingHoursTo(data.inactivityConfig?.sendingHours?.to ?? "20:00");
          setSendingHoursTimezone(data.inactivityConfig?.sendingHours?.timezone ?? "America/Mexico_City");
          setEscalateEnabled(data.inactivityConfig?.escalateEnabled ?? false);
          setEscalateHours(data.inactivityConfig?.escalateHours ?? 1);
          setEscalateOnLastReminder(data.inactivityConfig?.escalateOnLastReminder ?? false);
          setInboundOverrideEnabled((data.inactivityConfig?.inboundOverride?.reminders?.length ?? 0) > 0);
          setInboundReminders(data.inactivityConfig?.inboundOverride?.reminders ?? []);
          setNoResponseOverrideEnabled((data.inactivityConfig?.noResponseOverride?.reminders?.length ?? 0) > 0);
          setNoResponseReminders(data.inactivityConfig?.noResponseOverride?.reminders ?? []);
          setScheduleEnabled(data.scheduleConfig?.enabled ?? false);
          setScheduleTimezone(data.scheduleConfig?.timezone ?? "America/Mexico_City");
          setScheduleOutOfHoursMessage(data.scheduleConfig?.outOfHoursMessage ?? "");
          if (data.scheduleConfig?.schedule?.length) {
            const days: Record<string, { enabled: boolean; startTime: string; endTime: string }> = {
              monday:    { enabled: false, startTime: "09:00", endTime: "18:00" },
              tuesday:   { enabled: false, startTime: "09:00", endTime: "18:00" },
              wednesday: { enabled: false, startTime: "09:00", endTime: "18:00" },
              thursday:  { enabled: false, startTime: "09:00", endTime: "18:00" },
              friday:    { enabled: false, startTime: "09:00", endTime: "18:00" },
              saturday:  { enabled: false, startTime: "09:00", endTime: "18:00" },
              sunday:    { enabled: false, startTime: "09:00", endTime: "18:00" },
            };
            for (const slot of data.scheduleConfig.schedule) {
              days[slot.day] = { enabled: true, startTime: slot.startTime, endTime: slot.endTime };
            }
            setScheduleDays(days);
          }
          const routes = data.situationRouting ?? [];
          setSituationRouting(routes);

          const orgIdsToLoad = new Set<string>();
          if (data.organizationId) orgIdsToLoad.add(data.organizationId);
          for (const r of routes) {
            if (r.internalOrganizationId) orgIdsToLoad.add(r.internalOrganizationId);
          }
          await Promise.all([
            ...[...orgIdsToLoad].map(loadNumbersForOrg),
            ...[...orgIdsToLoad].map(loadBotsForOrg),
          ]);
        }
      } catch (error) {
        console.error("Error fetching bot:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchBot();
  }, [params.id]);

  const fetchChatLLMConfig = async () => {
    if (!params.id) return;

    setChatllmLoading(true);
    setChatllmError("");
    try {
      const token = await user?.getIdToken();
      const res = await fetch(`/api/abacus-config?botId=${params.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        setChatllmError(data.error || "Error al obtener configuracion");
        return;
      }

      setChatllmConfig(data.result);
    } catch (error) {
      console.error("Error fetching ChatLLM config:", error);
      setChatllmError("Error de conexion con Abacus AI");
    } finally {
      setChatllmLoading(false);
    }
  };

  const handleSave = async () => {
    if (!bot) return;

    setSaving(true);
    try {
      const updates: Record<string, unknown> = {};
      if (userData?.isSuperAdmin && formOrgId) {
        updates.organizationId = formOrgId;
      }
      const cleanTools = tools
        .filter((t) => t.name.trim() && t.event.trim())
        .map((t) => ({ ...t, name: t.name.trim(), event: t.event.trim() }));
      const outcomeActionsList = outcomeActionsText.split(",").map((a) => a.trim()).filter(Boolean);
      const countersMap: Record<string, string> = {};
      for (const row of counterRows) {
        if (row.action.trim() && row.counter.trim()) countersMap[row.action.trim()] = row.counter.trim();
      }
      await updateDoc(doc(db, "bots", bot.id), {
        ...updates,
        name,
        description,
        type: botType,
        ...(botVerticalValue !== "none"
          ? { vertical: botVerticalValue, category: botVerticalValue === "servicio" ? "Servicio" : "Ventas" }
          : { category: category && category !== "none" ? category : null }),
        optOutAction: optOutAction === "inherit" ? deleteField() : optOutAction,
        tools: cleanTools.length > 0 ? cleanTools : deleteField(),
        outcomeActions: outcomeActionsList.length > 0 ? outcomeActionsList : deleteField(),
        broadcastResponseCounters: Object.keys(countersMap).length > 0 ? countersMap : deleteField(),
        injectPhoneContext: injectPhoneContext === "default" ? deleteField() : injectPhoneContext === "yes",
        twilioConfig: {
          phoneNumber,
          accountSid: twilioAccountSid,
          authToken: twilioAuthToken,
        },
        abacusConfig: {
          deploymentId: abacusDeploymentId,
          deploymentToken: abacusDeploymentToken,
          ...(botType === "workflow" && workflowInputName ? { workflowInputName } : {}),
          ...(botType === "workflow" && abacusApiKey ? { apiKey: abacusApiKey } : {}),
        },
        ...(botType === "vertex_ai" ? {
          vertexAiConfig: {
            endpoint: vertexAiEndpoint,
            ...(vertexAiProjectId ? { projectId: vertexAiProjectId } : {}),
            ...(vertexAiLocation ? { location: vertexAiLocation } : {}),
          },
        } : {}),
        ...(botType === "external" ? {
          externalConfig: {
            endpoint: externalEndpoint,
            ...(externalApiKey ? { apiKey: externalApiKey } : {}),
          },
        } : {}),
        handoffConfig: {
          enabled: handoffEnabled,
          triggerKeywords: handoffKeywords
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean),
          ...(handoffMessage.trim() ? { handoffMessage: handoffMessage.trim() } : {}),
          ...(waitingMessage.trim() ? { waitingMessage: waitingMessage.trim() } : {}),
        },
        inactivityConfig: {
          enabled: inactivityEnabled,
          reminders: inactivityReminders.map((r, i) => ({ ...r, order: i + 1 })),
          sendingHours: {
            enabled: sendingHoursEnabled,
            from: sendingHoursFrom,
            to: sendingHoursTo,
            timezone: sendingHoursTimezone,
          },
          escalateEnabled,
          escalateHours,
          escalateOnLastReminder,
          ...(inboundOverrideEnabled && inboundReminders.length > 0 ? {
            inboundOverride: {
              reminders: inboundReminders.map((r, i) => ({ ...r, order: i + 1 })),
            },
          } : {}),
          ...(noResponseOverrideEnabled && noResponseReminders.length > 0 ? {
            noResponseOverride: {
              reminders: noResponseReminders.map((r, i) => ({ ...r, order: i + 1 })),
            },
          } : {}),
        },
        scheduleConfig: {
          enabled: scheduleEnabled,
          viaBot: scheduleViaBot,
          timezone: scheduleTimezone,
          outOfHoursMessage: scheduleOutOfHoursMessage,
          schedule: Object.entries(scheduleDays)
            .filter(([, v]) => v.enabled)
            .map(([day, v]) => ({ day, startTime: v.startTime, endTime: v.endTime })),
        },
        situationRouting,
      });
      router.push(modulePath(moduleId, "/bots"));
    } catch (error) {
      console.error("Error saving bot:", error);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!bot) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Bot no encontrado</p>
        <Link href={modulePath(moduleId, "/bots")}>
          <Button variant="link">Volver a Bots</Button>
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-8">
        <Link href={modulePath(moduleId, "/bots")}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Editar Bot</h1>
          <p className="text-gray-500">{bot.name}</p>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Guardar Cambios
        </Button>
      </div>

      <Tabs defaultValue="general" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="twilio">Twilio</TabsTrigger>
          <TabsTrigger value="abacus">Abacus AI</TabsTrigger>
          <TabsTrigger value="handoff">Handoff</TabsTrigger>
          <TabsTrigger value="inactividad">Inactividad</TabsTrigger>
          <TabsTrigger value="horarios">Horarios</TabsTrigger>
          <TabsTrigger value="situaciones">Situaciones</TabsTrigger>
          <TabsTrigger value="avanzado">Avanzado</TabsTrigger>
          <TabsTrigger value="chatllm" onClick={() => { if (!chatllmConfig && !chatllmLoading) fetchChatLLMConfig(); }}>
            ChatLLM
          </TabsTrigger>
        </TabsList>

        <TabsContent value="general">
          <Card>
            <CardHeader>
              <CardTitle>Informacion General</CardTitle>
              <CardDescription>
                Configura el nombre y descripcion de tu bot
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {userData?.isSuperAdmin && authOrgs.length > 0 && (
                <div className="space-y-2">
                  <Label>Organizacion</Label>
                  <Select value={formOrgId || bot?.organizationId || ""} onValueChange={setFormOrgId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Seleccionar organizacion" />
                    </SelectTrigger>
                    <SelectContent>
                      {authOrgs.map((org) => (
                        <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="name">Nombre del Bot</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ej: Bot de Ventas"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Descripcion</Label>
                <Input
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Ej: Bot para atencion de clientes de ventas"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="vertical">Modulo</Label>
                <Select
                  value={botVerticalValue}
                  onValueChange={(v) => setBotVerticalValue(v as "servicio" | "ventas" | "none")}
                >
                  <SelectTrigger id="vertical">
                    <SelectValue placeholder="Sin modulo" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Sin modulo (solo visible en General)</SelectItem>
                    <SelectItem value="servicio">Servicio</SelectItem>
                    <SelectItem value="ventas">Ventas</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-gray-500">
                  Acota el bot a un modulo. La categoria se guarda de forma coherente (Servicio / Ventas).
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="twilio">
          <Card>
            <CardHeader>
              <CardTitle>Configuracion de Twilio</CardTitle>
              <CardDescription>
                Credenciales de tu cuenta de Twilio para WhatsApp
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="phoneNumber">Numero de WhatsApp</Label>
                <Input
                  id="phoneNumber"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  placeholder="whatsapp:+528120854452"
                />
                <p className="text-xs text-gray-500">
                  Formato: whatsapp:+[codigo pais][numero]
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="twilioAccountSid">Account SID</Label>
                <Input
                  id="twilioAccountSid"
                  value={twilioAccountSid}
                  onChange={(e) => setTwilioAccountSid(e.target.value)}
                  placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="twilioAuthToken">Auth Token</Label>
                <div className="relative">
                  <Input
                    id="twilioAuthToken"
                    type={showTwilioToken ? "text" : "password"}
                    value={twilioAuthToken}
                    onChange={(e) => setTwilioAuthToken(e.target.value)}
                    placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7"
                    onClick={() => setShowTwilioToken(!showTwilioToken)}
                  >
                    {showTwilioToken ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="abacus">
          <Card>
            <CardHeader>
              <CardTitle>Configuracion de Abacus AI</CardTitle>
              <CardDescription>
                Credenciales de tu deployment de ChatLLM
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="botType">Tipo de Bot</Label>
                <Select value={botType} onValueChange={(v) => setBotType(v as "chatllm" | "workflow" | "vertex_ai" | "external")}>
                  <SelectTrigger id="botType">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="chatllm">ChatLLM</SelectItem>
                    <SelectItem value="workflow">AI Workflow</SelectItem>
                    <SelectItem value="vertex_ai">Vertex AI</SelectItem>
                    <SelectItem value="external">Bot Externo (HTTP)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-gray-500">
                  ChatLLM usa getConversationResponse. AI Workflow usa executeSyncConversationAgent. Vertex AI y Bot Externo (HTTP) llaman a un endpoint que implementa el contrato de la plataforma.
                </p>
              </div>
              {!["vertex_ai", "external"].includes(botType) && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="abacusDeploymentId">Deployment ID</Label>
                    <Input
                      id="abacusDeploymentId"
                      value={abacusDeploymentId}
                      onChange={(e) => setAbacusDeploymentId(e.target.value)}
                      placeholder="xxxxxxxxx"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="abacusDeploymentToken">Deployment Token</Label>
                    <div className="relative">
                      <Input
                        id="abacusDeploymentToken"
                        type={showAbacusToken ? "text" : "password"}
                        value={abacusDeploymentToken}
                        onChange={(e) => setAbacusDeploymentToken(e.target.value)}
                        placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7"
                        onClick={() => setShowAbacusToken(!showAbacusToken)}
                      >
                        {showAbacusToken ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                </>
              )}
              {botType === "workflow" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="workflowInputName">Nombre del input del workflow</Label>
                    <Input
                      id="workflowInputName"
                      value={workflowInputName}
                      onChange={(e) => setWorkflowInputName(e.target.value)}
                      placeholder="message"
                    />
                    <p className="text-xs text-gray-500">
                      Nombre del parametro que recibe el mensaje en el workflow de Abacus (ej: &quot;message&quot;, &quot;mensaje&quot;). Por defecto: &quot;message&quot;.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="abacusApiKey">API Key de Abacus</Label>
                    <div className="relative">
                      <Input
                        id="abacusApiKey"
                        type={showAbacusApiKey ? "text" : "password"}
                        value={abacusApiKey}
                        onChange={(e) => setAbacusApiKey(e.target.value)}
                        placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7"
                        onClick={() => setShowAbacusApiKey(!showAbacusApiKey)}
                      >
                        {showAbacusApiKey ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    <p className="text-xs text-gray-500">
                      API Key de tu cuenta Abacus AI. Requerida para mantener contexto de conversacion en workflows.
                    </p>
                  </div>
                </>
              )}
              {botType === "vertex_ai" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="vertexAiEndpoint">Endpoint del Bot</Label>
                    <Input
                      id="vertexAiEndpoint"
                      value={vertexAiEndpoint}
                      onChange={(e) => setVertexAiEndpoint(e.target.value)}
                      placeholder="https://us-central1-PROJECT.cloudfunctions.net/toyota-bot-vertex-ai"
                    />
                    <p className="text-xs text-gray-500">
                      URL del Cloud Function o Cloud Run que ejecuta el bot con Vertex AI.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="vertexAiProjectId">Project ID (opcional)</Label>
                    <Input
                      id="vertexAiProjectId"
                      value={vertexAiProjectId}
                      onChange={(e) => setVertexAiProjectId(e.target.value)}
                      placeholder="mi-proyecto-gcp"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="vertexAiLocation">Location (opcional)</Label>
                    <Input
                      id="vertexAiLocation"
                      value={vertexAiLocation}
                      onChange={(e) => setVertexAiLocation(e.target.value)}
                      placeholder="us-central1"
                    />
                  </div>
                </>
              )}
              {botType === "external" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="externalEndpoint">Endpoint del Bot Externo</Label>
                    <Input
                      id="externalEndpoint"
                      value={externalEndpoint}
                      onChange={(e) => setExternalEndpoint(e.target.value)}
                      placeholder="https://api.mi-agente.com/webhook"
                    />
                    <p className="text-xs text-gray-500">
                      URL del agente externo (ej. Openclaw, Hermes) que implementa el contrato HTTP de la plataforma.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="externalApiKey">API Key (opcional)</Label>
                    <div className="relative">
                      <Input
                        id="externalApiKey"
                        type={showExternalApiKey ? "text" : "password"}
                        value={externalApiKey}
                        onChange={(e) => setExternalApiKey(e.target.value)}
                        placeholder="Se envía como Authorization: Bearer ..."
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7"
                        onClick={() => setShowExternalApiKey(!showExternalApiKey)}
                      >
                        {showExternalApiKey ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    <p className="text-xs text-gray-500">
                      Si se configura, se envía en el header <code>Authorization: Bearer</code> a cada request del bot.
                    </p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="handoff">
          <Card>
            <CardHeader>
              <CardTitle>Configuracion de Handoff</CardTitle>
              <CardDescription>
                Configura cuando el bot debe transferir a un agente humano
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="handoffEnabled"
                  checked={handoffEnabled}
                  onChange={(e) => setHandoffEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <Label htmlFor="handoffEnabled">Habilitar handoff a agentes</Label>
              </div>
              {handoffEnabled && (
                <div className="space-y-2">
                  <Label htmlFor="handoffKeywords">
                    Palabras clave para handoff
                  </Label>
                  <Input
                    id="handoffKeywords"
                    value={handoffKeywords}
                    onChange={(e) => setHandoffKeywords(e.target.value)}
                    placeholder="hablar con humano, asesor, agente"
                  />
                  <p className="text-xs text-gray-500">
                    Separadas por comas. Cuando el cliente escriba alguna de estas
                    palabras, se transferira a un agente.
                  </p>
                </div>
              )}
              {handoffEnabled && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="handoffMessage">Mensaje al escalar</Label>
                    <Input
                      id="handoffMessage"
                      value={handoffMessage}
                      onChange={(e) => setHandoffMessage(e.target.value)}
                      placeholder="Entendido, te comunico con un asesor. En un momento te atenderán."
                    />
                    <p className="text-xs text-gray-500">Vacío = mensaje por defecto.</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="waitingMessage">Mensaje mientras espera asesor</Label>
                    <Input
                      id="waitingMessage"
                      value={waitingMessage}
                      onChange={(e) => setWaitingMessage(e.target.value)}
                      placeholder="Tu mensaje fue recibido. Un asesor te atenderá pronto."
                    />
                    <p className="text-xs text-gray-500">Vacío = mensaje por defecto.</p>
                  </div>
                </>
              )}
              <div className="space-y-2">
                <Label htmlFor="optOutAction">Cuando el cliente pide no ser contactado (&ldquo;stop&rdquo;)</Label>
                <Select value={optOutAction} onValueChange={(v) => setOptOutAction(v as "inherit" | "close" | "handoff")}>
                  <SelectTrigger id="optOutAction">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">Usar la configuracion del equipo</SelectItem>
                    <SelectItem value="close">Cerrar la conversacion</SelectItem>
                    <SelectItem value="handoff">Pasar a un asesor</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="inactividad">
          <Card>
            <CardHeader>
              <CardTitle>Seguimiento por Inactividad</CardTitle>
              <CardDescription>
                Envía recordatorios automáticos cuando el cliente deja de contestar. El último recordatorio siempre cierra la conversación.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="inactivityEnabled"
                  checked={inactivityEnabled}
                  onChange={(e) => setInactivityEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <Label htmlFor="inactivityEnabled">Habilitar seguimiento por inactividad</Label>
              </div>
              {inactivityEnabled && (
                <div className="space-y-4">
                  {/* Horario de envío */}
                  <div className="p-3 border rounded-lg space-y-3">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="sendingHoursEnabled"
                        checked={sendingHoursEnabled}
                        onChange={(e) => setSendingHoursEnabled(e.target.checked)}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      <Label htmlFor="sendingHoursEnabled" className="font-medium">Restringir horario de envío</Label>
                    </div>
                    {sendingHoursEnabled && (
                      <div className="space-y-3 pl-6">
                        <div className="flex items-center gap-3 flex-wrap">
                          <div className="flex items-center gap-2">
                            <Label className="text-sm text-muted-foreground w-10">De</Label>
                            <Input
                              type="time"
                              value={sendingHoursFrom}
                              onChange={(e) => setSendingHoursFrom(e.target.value)}
                              className="w-32"
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <Label className="text-sm text-muted-foreground w-10">a</Label>
                            <Input
                              type="time"
                              value={sendingHoursTo}
                              onChange={(e) => setSendingHoursTo(e.target.value)}
                              className="w-32"
                            />
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Label className="text-sm text-muted-foreground w-24">Zona horaria</Label>
                          <Select value={sendingHoursTimezone} onValueChange={setSendingHoursTimezone}>
                            <SelectTrigger className="w-56">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="America/Mexico_City">Centro (CDMX, MTY, GDL)</SelectItem>
                              <SelectItem value="America/Monterrey">Monterrey</SelectItem>
                              <SelectItem value="America/Chihuahua">Chihuahua / Sonora</SelectItem>
                              <SelectItem value="America/Tijuana">Tijuana / Baja California</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Los recordatorios solo se enviarán dentro de este rango horario. Fuera de él, el cron los omite hasta la siguiente ejecución dentro del horario.
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Ladder de recordatorios */}
                  <div className="p-3 border rounded-lg space-y-3">
                    <p className="text-sm font-medium">Ladder de recordatorios</p>

                    {inactivityReminders.map((reminder, index) => {
                      const isLast = index === inactivityReminders.length - 1;
                      return (
                        <div key={index} className="flex items-center gap-3 p-3 border rounded-lg bg-muted/30">
                          <span className="text-sm font-medium text-muted-foreground w-6">{index + 1}</span>
                          <div className="flex items-center gap-2 flex-1">
                            <Input
                              type="number"
                              min={0.25}
                              step={0.25}
                              value={reminder.hours}
                              onChange={(e) => {
                                const updated = [...inactivityReminders];
                                updated[index] = { ...updated[index], hours: Number(e.target.value) };
                                setInactivityReminders(updated);
                              }}
                              className="w-24"
                            />
                            <span className="text-sm text-muted-foreground">horas sin respuesta (ej. 0.25 = 15 min)</span>
                          </div>
                          <span className="text-xs text-muted-foreground px-2 py-1 bg-muted rounded">
                            {reminderStageLabel(index)}
                          </span>
                          {isLast && !escalateOnLastReminder && (
                            <span className="text-xs text-orange-600 dark:text-orange-400">cierra</span>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setInactivityReminders(inactivityReminders.filter((_, i) => i !== index))}
                            className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                          >
                            ✕
                          </Button>
                        </div>
                      );
                    })}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setInactivityReminders([
                          ...inactivityReminders,
                          { order: inactivityReminders.length + 1, hours: 1, closeAfter: false },
                        ])
                      }
                    >
                      + Agregar recordatorio
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      El último recordatorio siempre envía el mensaje de cierre y cierra la conversación
                      (salvo que la opción de abajo esté activada).
                    </p>

                    <div className="flex items-center gap-2 pt-1">
                      <input
                        type="checkbox"
                        id="escalateOnLastReminder"
                        checked={escalateOnLastReminder}
                        onChange={(e) => setEscalateOnLastReminder(e.target.checked)}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      <Label htmlFor="escalateOnLastReminder" className="font-medium">
                        En vez de cerrar en el último recordatorio, escalar a asesor
                      </Label>
                    </div>
                    {escalateOnLastReminder && (
                      <p className="text-xs text-muted-foreground pl-1">
                        No se envía el mensaje de cierre. La conversación pasa a asesor usando el modo de
                        asignación configurado en el equipo (Teams → equipo → Configuración). Si el equipo
                        usa asignación &quot;salesforce&quot;, además asigna el Lead en Salesforce (RR dentro de
                        horario, OwnerId fuera de horario) y pasa directo a with_agent.
                      </p>
                    )}

                    <div className="border-t pt-3 space-y-3">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          id="inboundOverrideEnabled"
                          checked={inboundOverrideEnabled}
                          onChange={(e) => setInboundOverrideEnabled(e.target.checked)}
                          className="h-4 w-4 rounded border-gray-300"
                        />
                        <Label htmlFor="inboundOverrideEnabled" className="font-medium">
                          Ladder distinto para leads inbound
                        </Label>
                      </div>
                      {inboundOverrideEnabled && (
                        <div className="space-y-3 pl-1">
                          <p className="text-xs text-muted-foreground">
                            Aplica solo a conversaciones inbound (el cliente escribió primero). Las
                            conversaciones outbound (lead recibido desde Salesforce vía plantilla inicial)
                            siguen usando el ladder de arriba sin cambios.
                          </p>
                          {inboundReminders.map((reminder, index) => {
                            const isLastInbound = index === inboundReminders.length - 1;
                            return (
                              <div key={index} className="flex items-center gap-3 p-3 border rounded-lg bg-muted/30">
                                <span className="text-sm font-medium text-muted-foreground w-6">{index + 1}</span>
                                <div className="flex items-center gap-2 flex-1">
                                  <Input
                                    type="number"
                                    min={0.25}
                                    step={0.25}
                                    value={reminder.hours}
                                    onChange={(e) => {
                                      const updated = [...inboundReminders];
                                      updated[index] = { ...updated[index], hours: Number(e.target.value) };
                                      setInboundReminders(updated);
                                    }}
                                    className="w-24"
                                  />
                                  <span className="text-sm text-muted-foreground">horas sin respuesta (ej. 0.25 = 15 min)</span>
                                </div>
                                <span className="text-xs text-muted-foreground px-2 py-1 bg-muted rounded">
                                  {reminderStageLabel(index)}
                                </span>
                                {isLastInbound && !escalateOnLastReminder && (
                                  <span className="text-xs text-orange-600 dark:text-orange-400">cierra</span>
                                )}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setInboundReminders(inboundReminders.filter((_, i) => i !== index))}
                                  className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                                >
                                  ✕
                                </Button>
                              </div>
                            );
                          })}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setInboundReminders([
                                ...inboundReminders,
                                { order: inboundReminders.length + 1, hours: 1, closeAfter: false },
                              ])
                            }
                          >
                            + Agregar recordatorio inbound
                          </Button>
                          <p className="text-xs text-muted-foreground">
                            El último recordatorio de esta lista también respeta la opción de escalar a
                            asesor en vez de cerrar, igual que el ladder de arriba.
                          </p>
                        </div>
                      )}
                    </div>

                    <div className="border-t pt-3 space-y-3">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          id="noResponseOverrideEnabled"
                          checked={noResponseOverrideEnabled}
                          onChange={(e) => setNoResponseOverrideEnabled(e.target.checked)}
                          className="h-4 w-4 rounded border-gray-300"
                        />
                        <Label htmlFor="noResponseOverrideEnabled" className="font-medium">
                          Ladder distinto para leads sin respuesta
                        </Label>
                      </div>
                      {noResponseOverrideEnabled && (
                        <div className="space-y-3 pl-1">
                          <p className="text-xs text-muted-foreground">
                            Aplica solo a conversaciones outbound (lead recibido desde Salesforce) donde el
                            cliente nunca ha respondido. En cuanto el cliente responde una sola vez, la
                            conversación pasa a usar el ladder de arriba (con el contador reiniciado desde
                            el primer paso). Las conversaciones donde el cliente ya respondió —outbound o
                            inbound— nunca usan esta lista.
                          </p>
                          {noResponseReminders.map((reminder, index) => {
                            const isLastNoResponse = index === noResponseReminders.length - 1;
                            return (
                              <div key={index} className="flex items-center gap-3 p-3 border rounded-lg bg-muted/30">
                                <span className="text-sm font-medium text-muted-foreground w-6">{index + 1}</span>
                                <div className="flex items-center gap-2 flex-1">
                                  <Input
                                    type="number"
                                    min={0.25}
                                    step={0.25}
                                    value={reminder.hours}
                                    onChange={(e) => {
                                      const updated = [...noResponseReminders];
                                      updated[index] = { ...updated[index], hours: Number(e.target.value) };
                                      setNoResponseReminders(updated);
                                    }}
                                    className="w-24"
                                  />
                                  <span className="text-sm text-muted-foreground">horas sin respuesta (ej. 24 = 1 día)</span>
                                </div>
                                <span className="text-xs text-muted-foreground px-2 py-1 bg-muted rounded">
                                  {reminderStageLabel(index)}
                                </span>
                                {isLastNoResponse && !escalateOnLastReminder && (
                                  <span className="text-xs text-orange-600 dark:text-orange-400">cierra</span>
                                )}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setNoResponseReminders(noResponseReminders.filter((_, i) => i !== index))}
                                  className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                                >
                                  ✕
                                </Button>
                              </div>
                            );
                          })}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setNoResponseReminders([
                                ...noResponseReminders,
                                { order: noResponseReminders.length + 1, hours: 24, closeAfter: false },
                              ])
                            }
                          >
                            + Agregar recordatorio sin respuesta
                          </Button>
                          <p className="text-xs text-muted-foreground">
                            El último recordatorio de esta lista también respeta la opción de escalar a
                            asesor en vez de cerrar, igual que el ladder de arriba.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Regla de 24h — informativo */}
                  <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20 p-3 space-y-1">
                    <p className="text-xs font-medium text-amber-800 dark:text-amber-400">Regla de 24h de WhatsApp</p>
                    <p className="text-xs text-amber-700 dark:text-amber-500">
                      Los recordatorios configurados a <span className="font-medium">menos de 24h</span> se envían como mensajes personalizados generados por el bot, siempre que el cliente haya respondido previamente y su última respuesta tenga menos de 24h.
                    </p>
                    <p className="text-xs text-amber-700 dark:text-amber-500">
                      Cuando han pasado <span className="font-medium">más de 24h</span> desde el último mensaje del cliente (o si nunca respondió), WhatsApp obliga a usar plantillas aprobadas. Asegúrate de configurar las plantillas de <span className="font-medium">Apertura</span>, <span className="font-medium">Recordatorio</span> y <span className="font-medium">Cierre</span> en la configuración del número de WhatsApp.
                    </p>
                    <p className="text-xs text-amber-700 dark:text-amber-500">
                      Si el cliente <span className="font-medium">nunca ha respondido</span>, cada plantilla enviada reinicia el contador de 24h. Independientemente de las horas configuradas, los recordatorios se enviarán con un mínimo de <span className="font-medium">24h de separación</span> entre sí por política de WhatsApp.
                    </p>
                  </div>

                  {/* Escalación independiente (Trigger 1) */}
                  <div className="p-3 border rounded-lg space-y-3">
                    <p className="text-sm font-medium">Escalación por inactividad (independiente del ladder)</p>
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="escalateEnabled"
                        checked={escalateEnabled}
                        onChange={(e) => setEscalateEnabled(e.target.checked)}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      <Label htmlFor="escalateEnabled" className="font-medium">Escalar a asesor tras respuesta del cliente</Label>
                    </div>
                    {escalateEnabled && (
                      <div className="flex items-center gap-2 pl-1">
                        <Input
                          type="number"
                          min={0.1}
                          step={0.1}
                          value={escalateHours}
                          onChange={(e) => setEscalateHours(Number(e.target.value))}
                          className="w-24"
                        />
                        <span className="text-sm text-muted-foreground">horas después de la respuesta del cliente</span>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Independiente del ladder de recordatorios de arriba. Aplica a cualquier conversación con un lead ya creado en Salesforce (sin importar si inició por plantilla saliente o por mensaje entrante del cliente) donde el cliente ya respondió al menos una vez — cambia el status a <span className="font-medium">waiting_agent</span> y asigna asesor, sin enviar mensaje. Si el cliente nunca respondió, no escala y siguen aplicando los recordatorios normales.
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="horarios">
          <ScheduleConfigTab
            enabled={scheduleEnabled}
            onEnabledChange={setScheduleEnabled}
            timezone={scheduleTimezone}
            onTimezoneChange={setScheduleTimezone}
            outOfHoursMessage={scheduleOutOfHoursMessage}
            onOutOfHoursMessageChange={setScheduleOutOfHoursMessage}
            days={scheduleDays}
            onDaysChange={setScheduleDays}
            viaBot={scheduleViaBot}
            onViaBotChange={setScheduleViaBot}
          />
        </TabsContent>

        <TabsContent value="situaciones">
          <SituationRoutingTab
            routes={situationRouting}
            onRoutesChange={setSituationRouting}
            defaultOrgId={bot.organizationId}
            authOrgs={authOrgs}
            isSuperAdmin={!!userData?.isSuperAdmin}
            numbersByOrg={numbersByOrg}
            onLoadOrgNumbers={loadNumbersForOrg}
            botsByOrg={botsByOrg}
            onLoadOrgBots={loadBotsForOrg}
            currentBotId={bot.id}
          />
        </TabsContent>

        <TabsContent value="avanzado">
          <AdvancedConfigTab
            tools={tools}
            onToolsChange={setTools}
            outcomeActionsText={outcomeActionsText}
            onOutcomeActionsTextChange={setOutcomeActionsText}
            counterRows={counterRows}
            onCounterRowsChange={setCounterRows}
            injectPhoneContext={injectPhoneContext}
            onInjectPhoneContextChange={setInjectPhoneContext}
          />
        </TabsContent>

        <TabsContent value="chatllm">
          {chatllmLoading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
            </div>
          ) : chatllmError ? (
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-gray-500 mb-4">{chatllmError}</p>
                <Button variant="outline" onClick={fetchChatLLMConfig}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Reintentar
                </Button>
              </CardContent>
            </Card>
          ) : chatllmConfig ? (
            <ChatLLMConfigView config={chatllmConfig} onRefresh={fetchChatLLMConfig} />
          ) : (
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-gray-500 mb-4">
                  Carga la configuracion del modelo ChatLLM desde Abacus AI.
                </p>
                <Button onClick={fetchChatLLMConfig}>
                  <Brain className="mr-2 h-4 w-4" />
                  Cargar Configuracion
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

const SCHEDULE_DAY_ORDER = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] as const;
const SCHEDULE_DAY_NAMES: Record<string, string> = {
  monday: "Lunes", tuesday: "Martes", wednesday: "Miércoles",
  thursday: "Jueves", friday: "Viernes", saturday: "Sábado", sunday: "Domingo",
};
const FIXED_CLOSING = "Si necesitas un asesor en otro momento, con gusto lo intento de nuevo.";
const TIMEZONES = [
  "America/Mexico_City",
  "America/Monterrey",
  "America/Tijuana",
  "America/Bogota",
  "America/Lima",
  "America/Santiago",
  "America/Argentina/Buenos_Aires",
  "America/New_York",
  "America/Los_Angeles",
];

type DayState = { enabled: boolean; startTime: string; endTime: string };

function buildPreviewMessage(message: string, days: Record<string, DayState>): string {
  const base = message || "Nuestros asesores no están disponibles en este momento.";
  const lines = ["\n\nNuestro horario de atención:"];
  for (const day of SCHEDULE_DAY_ORDER) {
    const d = days[day];
    lines.push(`\n  ${SCHEDULE_DAY_NAMES[day]}: ${d?.enabled ? `${d.startTime} - ${d.endTime}` : "Cerrado"}`);
  }
  lines.push(`\n\n${FIXED_CLOSING}`);
  return base + lines.join("");
}

function ScheduleConfigTab({
  enabled, onEnabledChange,
  timezone, onTimezoneChange,
  outOfHoursMessage, onOutOfHoursMessageChange,
  days, onDaysChange,
  viaBot, onViaBotChange,
}: {
  enabled: boolean; onEnabledChange: (v: boolean) => void;
  timezone: string; onTimezoneChange: (v: string) => void;
  outOfHoursMessage: string; onOutOfHoursMessageChange: (v: string) => void;
  days: Record<string, DayState>; onDaysChange: (v: Record<string, DayState>) => void;
  viaBot: boolean; onViaBotChange: (v: boolean) => void;
}) {
  const updateDay = (day: string, field: keyof DayState, value: boolean | string) => {
    onDaysChange({ ...days, [day]: { ...days[day], [field]: value } });
  };
  const preview = buildPreviewMessage(outOfHoursMessage, days);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Horarios de Atención</CardTitle>
        <CardDescription>
          Configura los horarios en que los asesores están disponibles. Si el cliente pide un asesor fuera de horario, el bot le enviará el mensaje de no disponibilidad.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="scheduleEnabled"
            checked={enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300"
          />
          <Label htmlFor="scheduleEnabled">Habilitar verificación de horarios</Label>
        </div>

        {enabled && (
          <>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="scheduleViaBot"
                checked={viaBot}
                onChange={(e) => onViaBotChange(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              <Label htmlFor="scheduleViaBot">El bot redacta el aviso de fuera de horario</Label>
            </div>
            <div className="space-y-2">
              <Label>Zona horaria</Label>
              <Select value={timezone} onValueChange={onTimezoneChange}>
                <SelectTrigger className="w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((tz) => (
                    <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="outOfHoursMessage">Mensaje base (fuera de horario)</Label>
              <textarea
                id="outOfHoursMessage"
                value={outOfHoursMessage}
                onChange={(e) => onOutOfHoursMessageChange(e.target.value)}
                placeholder="Nuestros asesores no están disponibles en este momento."
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <p className="text-xs text-muted-foreground">El sistema agregará automáticamente el horario formateado y el texto de cierre.</p>
            </div>

            <div className="space-y-2">
              <Label>Días y horarios</Label>
              <div className="rounded-lg border divide-y">
                {SCHEDULE_DAY_ORDER.map((day) => {
                  const d = days[day];
                  return (
                    <div key={day} className="flex items-center gap-4 px-4 py-3">
                      <div className="flex items-center gap-2 w-36">
                        <input
                          type="checkbox"
                          id={`day-${day}`}
                          checked={d?.enabled ?? false}
                          onChange={(e) => updateDay(day, "enabled", e.target.checked)}
                          className="h-4 w-4 rounded border-gray-300"
                        />
                        <Label htmlFor={`day-${day}`} className="font-normal cursor-pointer">
                          {SCHEDULE_DAY_NAMES[day]}
                        </Label>
                      </div>
                      {d?.enabled ? (
                        <div className="flex items-center gap-2">
                          <Input
                            type="time"
                            value={d.startTime}
                            onChange={(e) => updateDay(day, "startTime", e.target.value)}
                            className="w-32"
                          />
                          <span className="text-muted-foreground text-sm">a</span>
                          <Input
                            type="time"
                            value={d.endTime}
                            onChange={(e) => updateDay(day, "endTime", e.target.value)}
                            className="w-32"
                          />
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">Cerrado</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Vista previa del mensaje al cliente</Label>
              <div className="rounded-lg border bg-muted/30 p-4">
                <p className="text-sm whitespace-pre-wrap text-muted-foreground">{preview}</p>
              </div>
              <p className="text-xs text-muted-foreground">
                El texto <span className="font-medium text-foreground">&ldquo;{FIXED_CLOSING}&rdquo;</span> se agrega siempre automáticamente.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AdvancedConfigTab({
  tools, onToolsChange,
  outcomeActionsText, onOutcomeActionsTextChange,
  counterRows, onCounterRowsChange,
  injectPhoneContext, onInjectPhoneContextChange,
}: {
  tools: BotTool[]; onToolsChange: (v: BotTool[]) => void;
  outcomeActionsText: string; onOutcomeActionsTextChange: (v: string) => void;
  counterRows: CounterRow[]; onCounterRowsChange: (v: CounterRow[]) => void;
  injectPhoneContext: "default" | "yes" | "no"; onInjectPhoneContextChange: (v: "default" | "yes" | "no") => void;
}) {
  const updateTool = (i: number, patch: Partial<BotTool>) => {
    const updated = [...tools];
    updated[i] = { ...updated[i], ...patch };
    onToolsChange(updated);
  };
  const updateRow = (i: number, patch: Partial<CounterRow>) => {
    const updated = [...counterRows];
    updated[i] = { ...updated[i], ...patch };
    onCounterRowsChange(updated);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Herramientas (tools)</CardTitle>
          <CardDescription>
            Cada fila asocia un tool del motor de IA con un evento del sistema. Si no defines ninguna fila,
            el bot usa los tools por defecto (Crear_Lead, Guardar_Nombre_Cliente, Detectar_Situacion, etc.).
            Fase &ldquo;early&rdquo; se ejecuta antes de contestar; &ldquo;main&rdquo; durante la respuesta.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {tools.map((tool, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 p-3 border rounded-lg bg-muted/30">
              <Input
                className="flex-1 min-w-40"
                placeholder="Nombre del tool"
                value={tool.name}
                onChange={(e) => updateTool(i, { name: e.target.value })}
              />
              <Input
                className="flex-1 min-w-40"
                placeholder="Evento"
                value={tool.event}
                onChange={(e) => updateTool(i, { event: e.target.value })}
              />
              <Select value={tool.phase} onValueChange={(v) => updateTool(i, { phase: v as "early" | "main" })}>
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="early">early</SelectItem>
                  <SelectItem value="main">main</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                onClick={() => onToolsChange(tools.filter((_, idx) => idx !== i))}
              >
                ✕
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => onToolsChange([...tools, { name: "", event: "", phase: "main" }])}
          >
            + Agregar tool
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Clasificacion y campañas</CardTitle>
          <CardDescription>Vocabularios que el backend usa para clasificar motivos y contar respuestas a campañas.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="outcomeActions">Acciones de clasificacion de motivo</Label>
            <Input
              id="outcomeActions"
              value={outcomeActionsText}
              onChange={(e) => onOutcomeActionsTextChange(e.target.value)}
              placeholder="interes_cita, otro_motivo"
            />
            <p className="text-xs text-gray-500">Separadas por comas. Vacio = valores por defecto (interes_cita, otro_motivo).</p>
          </div>
          <div className="space-y-2">
            <Label>Contadores de respuesta a campañas</Label>
            {counterRows.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  placeholder="Accion (ej. confirmar_cita)"
                  value={row.action}
                  onChange={(e) => updateRow(i, { action: e.target.value })}
                />
                <Input
                  placeholder="Contador (ej. confirmedCount)"
                  value={row.counter}
                  onChange={(e) => updateRow(i, { counter: e.target.value })}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => onCounterRowsChange(counterRows.filter((_, idx) => idx !== i))}
                >
                  ✕
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => onCounterRowsChange([...counterRows, { action: "", counter: "" }])}
            >
              + Agregar contador
            </Button>
            <p className="text-xs text-gray-500">
              Sin filas se usan los contadores por defecto (confirmar_cita, cancelar_cita, reagendar_cita).
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Contexto de telefono</CardTitle>
          <CardDescription>Antepone el telefono del cliente a la primera respuesta del bot.</CardDescription>
        </CardHeader>
        <CardContent>
          <Select
            value={injectPhoneContext}
            onValueChange={(v) => onInjectPhoneContextChange(v as "default" | "yes" | "no")}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Por defecto (solo Twilio)</SelectItem>
              <SelectItem value="yes">Siempre</SelectItem>
              <SelectItem value="no">Nunca</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>
    </div>
  );
}

function SituationRoutingTab({
  routes, onRoutesChange, defaultOrgId, authOrgs, isSuperAdmin, numbersByOrg, onLoadOrgNumbers,
  botsByOrg, onLoadOrgBots, currentBotId,
}: {
  routes: SituationRoute[];
  onRoutesChange: (v: SituationRoute[]) => void;
  defaultOrgId: string;
  authOrgs: { id: string; name: string }[];
  isSuperAdmin: boolean;
  numbersByOrg: Record<string, { id: string; displayName: string }[]>;
  onLoadOrgNumbers: (orgId: string) => void;
  botsByOrg: Record<string, { id: string; name: string }[]>;
  onLoadOrgBots: (orgId: string) => void;
  currentBotId: string;
}) {
  const updateRoute = (index: number, patch: Partial<SituationRoute>) => {
    const updated = [...routes];
    updated[index] = { ...updated[index], ...patch };
    onRoutesChange(updated);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Detección de situaciones</CardTitle>
        <CardDescription>
          Cuando el bot detecta una situación fuera de su alcance (ej. el cliente pregunta por seminuevos o
          servicio/postventa), la conversación se resuelve según el destino configurado aquí: cambiando el bot
          que responde en el mismo número, transfiriendo a otro número/sistema y cerrando la venta, o derivando
          el lead a Salesforce sin cerrar. Una situación sin configurar aquí no hace nada: el bot solo responde
          lo que su prompt indique y la conversación sigue su curso normal.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {routes.length === 0 && (
          <p className="text-sm text-muted-foreground">No hay situaciones configuradas.</p>
        )}
        {routes.map((route, index) => (
          <div key={index} className="p-3 border rounded-lg space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex-1 space-y-2">
                <Label>Situación</Label>
                <Select
                  value={route.situacion}
                  onValueChange={(v) =>
                    updateRoute(index, {
                      situacion: v,
                      // "lead" solo existe para Seminuevos
                      ...(v !== "seminuevo" && route.destino === "lead" ? { destino: "ninguno" as const } : {}),
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Seleccionar situación" />
                  </SelectTrigger>
                  <SelectContent>
                    {SITUACIONES.map((s) => (
                      <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive mt-6"
                onClick={() => onRoutesChange(routes.filter((_, i) => i !== index))}
              >
                ✕
              </Button>
            </div>

            <div className="space-y-2">
              <Label>Destino</Label>
              <Select value={route.destino} onValueChange={(v) => updateRoute(index, { destino: v as SituationRoute["destino"] })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cambiar_bot">Cambiar el bot que responde (mismo número)</SelectItem>
                  <SelectItem value="interno">Otro número de esta plataforma</SelectItem>
                  <SelectItem value="externo">Sistema externo (POST)</SelectItem>
                  {route.situacion === "seminuevo" && (
                    <SelectItem value="lead">Crear lead de Seminuevos en Salesforce</SelectItem>
                  )}
                  <SelectItem value="ninguno">Ninguno (solo descartar)</SelectItem>
                </SelectContent>
              </Select>
              {route.destino === "ninguno" && (
                <p className="text-xs text-muted-foreground">
                  No se transfiere a ningún bot: el cliente recibe la respuesta del bot y se cierra la conversación.
                  {route.situacion === "seminuevo"
                    ? " No se crea ningún lead de Seminuevos y un lead previo del bot de ventas queda intacto."
                    : " Además se descarta el lead en Salesforce."}
                </p>
              )}
              {route.destino === "lead" && (
                <p className="text-xs text-muted-foreground">
                  Si la conversación todavía no tiene lead, se crea uno asignado al owner de abajo. Si ya venía con
                  un lead (conversaciones iniciadas desde Salesforce), ese lead no se modifica: solo se deriva al
                  Round Robin de Salesforce para que reasigne al asesor. En ambos casos la conversación pasa a
                  &quot;Con asesor&quot; sin asignarse a nadie del dashboard. No se transfiere a ningún bot ni se
                  cierra la conversación.
                </p>
              )}
            </div>

            {route.destino === "lead" && (
              <div className="space-y-2">
                <Label>Owner ID del lead (Salesforce)</Label>
                <Input
                  placeholder="005xx0000000000AAA"
                  value={route.seminuevoOwnerId || ""}
                  onChange={(e) => updateRoute(index, { seminuevoOwnerId: e.target.value })}
                />
                {route.seminuevoOwnerId?.trim() ? (
                  <p className="text-xs text-muted-foreground">
                    Usuario de Salesforce que queda como <code>OwnerId</code> y <code>GCL_ResponsableBDC__c</code> del
                    lead. El lead se crea con el RecordType de Seminuevos y sin pasar por Reglas de Asignación.
                  </p>
                ) : (
                  <p className="text-xs text-amber-600 dark:text-amber-500">
                    Sin owner configurado los leads se asignan al owner de Seminuevos por defecto de la plataforma.
                    Captura el Owner ID de esta marca.
                  </p>
                )}
              </div>
            )}

            {route.destino === "cambiar_bot" ? (
              <>
                {isSuperAdmin && authOrgs.length > 0 && (
                  <div className="space-y-2">
                    <Label>Empresa / Organización</Label>
                    <Select
                      value={route.internalOrganizationId || defaultOrgId}
                      onValueChange={(v) => {
                        updateRoute(index, { internalOrganizationId: v, internalBotId: "" });
                        onLoadOrgBots(v);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Seleccionar organización" />
                      </SelectTrigger>
                      <SelectContent>
                        {authOrgs.map((org) => (
                          <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="space-y-2">
                  <Label>Bot que toma la conversación</Label>
                  <Select
                    value={route.internalBotId || ""}
                    onValueChange={(v) => updateRoute(index, { internalBotId: v })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Seleccionar bot" />
                    </SelectTrigger>
                    <SelectContent>
                      {(botsByOrg[route.internalOrganizationId || defaultOrgId] || [])
                        .filter((b) => b.id !== currentBotId)
                        .map((b) => (
                          <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    La conversación sigue abierta en el mismo número y con el mismo equipo; solo cambia el bot que
                    responde, desde este mismo mensaje y hasta que se cierre. No se toca el lead de Salesforce.
                  </p>
                </div>
              </>
            ) : route.destino === "interno" ? (
              <>
                {isSuperAdmin && authOrgs.length > 0 && (
                  <div className="space-y-2">
                    <Label>Empresa / Organización</Label>
                    <Select
                      value={route.internalOrganizationId || defaultOrgId}
                      onValueChange={(v) => {
                        updateRoute(index, { internalOrganizationId: v, internalWhatsappNumberId: "" });
                        onLoadOrgNumbers(v);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Seleccionar organización" />
                      </SelectTrigger>
                      <SelectContent>
                        {authOrgs.map((org) => (
                          <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      El bot destino puede pertenecer a otra empresa dentro de la plataforma.
                    </p>
                  </div>
                )}
                <div className="space-y-2">
                  <Label>Número de WhatsApp destino</Label>
                  <Select
                    value={route.internalWhatsappNumberId || ""}
                    onValueChange={(v) => updateRoute(index, { internalWhatsappNumberId: v })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Seleccionar número" />
                    </SelectTrigger>
                    <SelectContent>
                      {(numbersByOrg[route.internalOrganizationId || defaultOrgId] || []).map((n) => (
                        <SelectItem key={n.id} value={n.id}>{n.displayName}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Se crea una conversación nueva en este número (con su bot y plantilla configurados).
                  </p>
                </div>
              </>
            ) : route.destino === "externo" ? (
              <>
                <div className="space-y-2">
                  <Label>URL del webhook externo</Label>
                  <Input
                    placeholder="https://..."
                    value={route.externalUrl || ""}
                    onChange={(e) => updateRoute(index, { externalUrl: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Número de WhatsApp destino (opcional)</Label>
                  <Input
                    placeholder="+521234567890"
                    value={route.externalTargetPhone || ""}
                    onChange={(e) => updateRoute(index, { externalTargetPhone: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Se envía como <code>targetPhone</code> en el POST, por si el mismo webhook atiende a varios números.
                  </p>
                </div>
              </>
            ) : null}
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            onRoutesChange([...routes, { situacion: SITUACIONES[0].value, destino: "cambiar_bot" }])
          }
        >
          + Agregar situación
        </Button>
      </CardContent>
    </Card>
  );
}

function ChatLLMConfigView({ config, onRefresh }: { config: Record<string, unknown>; onRefresh: () => void }) {
  const deployment = config.deployment as Record<string, unknown> || {};
  const model = config.model as Record<string, unknown> || {};
  const cfg = config.config as Record<string, unknown> || {};
  const retriever = config.documentRetriever as Record<string, unknown> | null;
  const bestAlgorithm = model.bestAlgorithm as Record<string, string> || {};
  const deployableAlgorithms = model.deployableAlgorithms as Array<Record<string, string>> || [];
  const customTools = cfg.customTools as string[] || [];
  const builtinTools = cfg.builtinTools as string[] || [];
  const documentRetrievers = cfg.documentRetrievers as string[] || [];

  const statusColors: Record<string, string> = {
    ACTIVE: "bg-green-100 text-green-800",
    STOPPED: "bg-red-100 text-red-800",
    PENDING: "bg-yellow-100 text-yellow-800",
    COMPLETE: "bg-green-100 text-green-800",
  };

  return (
    <div className="space-y-4">
      {/* Deployment & Model Info */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Brain className="h-5 w-5" />
              Deployment y Modelo
            </CardTitle>
            <CardDescription>
              Informacion del deployment y modelo LLM en Abacus AI
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCw className="mr-2 h-3 w-3" />
            Actualizar
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
              <div>
                <p className="text-xs text-gray-500">Deployment</p>
                <p className="text-sm font-medium">{deployment.name as string}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Status</p>
                <Badge className={statusColors[deployment.status as string] || "bg-gray-100 text-gray-800"}>
                  {deployment.status as string}
                </Badge>
              </div>
              <div>
                <p className="text-xs text-gray-500">Modelo desplegado</p>
                <p className="text-sm font-medium">{deployment.algoName as string}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Region</p>
                <p className="text-sm">{deployment.region as string}</p>
              </div>
            </div>
            <div className="space-y-3">
              <div>
                <p className="text-xs text-gray-500">Mejor algoritmo (entrenamiento)</p>
                <p className="text-sm font-medium">{bestAlgorithm.name}</p>
                <p className="text-xs text-gray-400">{bestAlgorithm.llmName}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Entrenamiento</p>
                <Badge className={statusColors[model.trainingStatus as string] || "bg-gray-100 text-gray-800"}>
                  {model.trainingStatus as string}
                </Badge>
              </div>
              <div>
                <p className="text-xs text-gray-500">Modelos disponibles</p>
                <div className="flex flex-wrap gap-1 mt-1">
                  {deployableAlgorithms.map((algo, i) => (
                    <Badge key={algo.llmName || i} variant="outline" className="text-xs">
                      {algo.name}
                    </Badge>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs text-gray-500">Auto-deploy</p>
                <p className="text-sm">{deployment.autoDeploy ? "Activado" : "Desactivado"}</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tools */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wrench className="h-5 w-5" />
            Tools
          </CardTitle>
          <CardDescription>
            Herramientas configuradas en el modelo
          </CardDescription>
        </CardHeader>
        <CardContent>
          {customTools.length === 0 && builtinTools.length === 0 ? (
            <p className="text-sm text-gray-500">No hay tools configurados</p>
          ) : (
            <div className="space-y-2">
              {customTools.map((tool) => (
                <div key={tool} className="flex items-center gap-2 p-2 rounded border">
                  <Badge variant="secondary" className="text-xs">Custom</Badge>
                  <span className="text-sm font-mono">{tool}</span>
                </div>
              ))}
              {builtinTools.map((tool) => (
                <div key={tool} className="flex items-center gap-2 p-2 rounded border">
                  <Badge variant="outline" className="text-xs">Builtin</Badge>
                  <span className="text-sm font-mono">{tool}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Document Retriever */}
      {retriever && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Search className="h-5 w-5" />
              Document Retriever
            </CardTitle>
            <CardDescription>
              Configuracion de busqueda de documentos
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-gray-500">Nombre</p>
                  <p className="text-sm font-medium">{retriever.name as string}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Feature Group</p>
                  <p className="text-sm">{retriever.featureGroupName as string}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Chunks</p>
                  <p className="text-sm">{retriever.numberOfChunks as number} chunks indexados</p>
                </div>
              </div>
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-gray-500">Chunk Size</p>
                  <p className="text-sm">{retriever.chunkSize as number} tokens</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Overlap</p>
                  <p className="text-sm">{((retriever.chunkOverlapFraction as number) * 100)}%</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Encoder</p>
                  <p className="text-sm">{retriever.textEncoder as string}</p>
                </div>
              </div>
            </div>
            {documentRetrievers.length > 0 && (
              <div className="mt-3 pt-3 border-t">
                <p className="text-xs text-gray-500 mb-1">Retrievers activos</p>
                <div className="flex flex-wrap gap-1">
                  {documentRetrievers.map((r) => (
                    <Badge key={r} variant="outline" className="text-xs">{r}</Badge>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Behavior Instructions */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Instrucciones de Comportamiento
          </CardTitle>
          <CardDescription>
            System prompt principal del modelo
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="whitespace-pre-wrap text-sm bg-gray-50 p-4 rounded-lg border max-h-96 overflow-y-auto font-mono leading-relaxed">
            {cfg.behaviorInstructions as string || "Sin instrucciones configuradas"}
          </pre>
        </CardContent>
      </Card>

      {/* Response Instructions */}
      <Card>
        <CardHeader>
          <CardTitle>Instrucciones de Respuesta</CardTitle>
          <CardDescription>
            Como debe formatear las respuestas
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="whitespace-pre-wrap text-sm bg-gray-50 p-4 rounded-lg border max-h-64 overflow-y-auto font-mono leading-relaxed">
            {cfg.responseInstructions as string || "Sin instrucciones configuradas"}
          </pre>
        </CardContent>
      </Card>

      {/* Unknown Answer Phrase */}
      <Card>
        <CardHeader>
          <CardTitle>Frase de Respuesta Desconocida</CardTitle>
          <CardDescription>
            Respuesta cuando el modelo no encuentra informacion relevante
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="bg-gray-50 p-4 rounded-lg border">
            <p className="text-sm italic">
              {cfg.unknownAnswerPhrase as string || "Sin frase configurada"}
            </p>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <span className="text-xs text-gray-500">Conocimiento general:</span>
            <Badge variant={cfg.includeGeneralKnowledge ? "default" : "secondary"}>
              {cfg.includeGeneralKnowledge ? "Activado" : "Desactivado"}
            </Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
