"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Upload, Loader2, FileText, X } from "lucide-react";
import { db } from "@/lib/firebase";
import { getModule } from "@/lib/modules";
import { modulePath } from "@/lib/routes";
import {
  collection,
  query,
  where,
  onSnapshot,
  getDocs,
  doc,
  setDoc,
  writeBatch,
  serverTimestamp,
} from "firebase/firestore";
import { useAuth } from "@/contexts/AuthContext";

interface WhatsAppNumber {
  id: string;
  phoneNumber: string;
  label: string;
  provider: string;
  defaultBotId: string;
  teamId: string;
}

interface SFTemplate {
  id: string;
  name: string;
  uniqueName: string;
  messageBody: string;
  structure: string;
  objectApiName: string;
}

interface Bot {
  id: string;
  name: string;
  vertical: string | null;
}

interface ParsedRecipient {
  phone: string;
  name: string | null;
  variables: Record<string, string> | null;
  salesforceRecordId: string | null;
}

// Campos disponibles para mapear a variables numeradas de plantilla ({{1}}, {{2}}, ...)
// en campañas de Salesforce (appointment_reminder / no_show). Deben coincidir con las
// claves que generan cron/appointment-reminders, cron/no-show y broadcasts/[id]/refresh.
const REMINDER_VARIABLE_OPTIONS: { value: string; label: string }[] = [
  { value: "name", label: "Nombre" },
  { value: "taller", label: "Taller" },
  { value: "auto", label: "Auto" },
  { value: "operacion", label: "Operación" },
  { value: "vin", label: "VIN" },
  { value: "recepcionista", label: "Recepcionista / Asesor" },
  { value: "email", label: "Email" },
  { value: "observaciones", label: "Observaciones" },
  { value: "fechaCita", label: "Fecha de cita" },
  { value: "horaCita", label: "Hora de cita" },
  { value: "idReservacion", label: "ID Reservación" },
];

export default function NewBroadcastPage() {
  const { userData, user } = useAuth();
  const router = useRouter();
  const { module: moduleId } = useParams<{ module: string }>();
  const moduleVertical = getModule(moduleId)?.vertical ?? null;
  const [teamVerticals, setTeamVerticals] = useState<Record<string, string>>({});

  const [whatsappNumbers, setWhatsappNumbers] = useState<WhatsAppNumber[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [sfTemplates, setSfTemplates] = useState<SFTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);

  // Form state
  const [name, setName] = useState("");
  const [whatsappNumberId, setWhatsappNumberId] = useState("");
  const [botId, setBotId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templateBody, setTemplateBody] = useState("");
  const [templateLanguage, setTemplateLanguage] = useState("es");
  const [type, setType] = useState<"manual" | "appointment_reminder" | "no_show">("manual");
  const [daysBefore, setDaysBefore] = useState(1);
  const [eventType, setEventType] = useState("Cita Servicio");
  const [contentSid, setContentSid] = useState("");
  const [variableMapping, setVariableMapping] = useState<string[]>([]);
  const [valuetextObjectApi, setValuetextObjectApi] = useState("");
  const [botInstructions, setBotInstructions] = useState("");
  const [recipients, setRecipients] = useState<ParsedRecipient[]>([]);
  const [csvFileName, setCsvFileName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Alcance por módulo: solo números (por la vertical de su equipo) y bots del módulo activo
  const visibleNumbers = moduleVertical
    ? whatsappNumbers.filter((n) => teamVerticals[n.teamId] === moduleVertical)
    : whatsappNumbers;
  const visibleBots = moduleVertical ? bots.filter((b) => b.vertical === moduleVertical) : bots;

  const selectedNumber = whatsappNumbers.find((n) => n.id === whatsappNumberId);
  const provider = selectedNumber?.provider || "";
  const selectedBotVertical = bots.find((b) => b.id === botId)?.vertical ?? null;
  const campaignVertical =
    moduleVertical || (selectedNumber ? teamVerticals[selectedNumber.teamId] : undefined) || selectedBotVertical || null;

  // Load WhatsApp numbers and bots
  useEffect(() => {
    if (!userData?.organizationId) return;

    const unsubNumbers = onSnapshot(
      query(
        collection(db, "whatsappNumbers"),
        where("organizationId", "==", userData.organizationId),
        where("status", "==", "active")
      ),
      (snapshot) => {
        const items: WhatsAppNumber[] = [];
        snapshot.forEach((doc) => {
          const data = doc.data();
          items.push({
            id: doc.id,
            phoneNumber: data.phoneNumber || "",
            label: data.label || data.phoneNumber || "",
            provider: data.provider || "twilio",
            defaultBotId: data.defaultBotId || "",
            teamId: data.teamId || "",
          });
        });
        setWhatsappNumbers(items);
      }
    );

    const unsubBots = onSnapshot(
      query(
        collection(db, "bots"),
        where("organizationId", "==", userData.organizationId)
      ),
      (snapshot) => {
        const items: Bot[] = [];
        snapshot.forEach((doc) => {
          const data = doc.data();
          const cat = typeof data.category === "string" ? data.category.toLowerCase() : "";
          const vertical = data.vertical || (cat === "servicio" || cat === "ventas" ? cat : null);
          items.push({ id: doc.id, name: data.name || "", vertical });
        });
        setBots(items);
      }
    );

    getDocs(query(collection(db, "teams"), where("organizationId", "==", userData.organizationId)))
      .then((snap) => {
        const map: Record<string, string> = {};
        snap.forEach((d) => {
          if (d.data().vertical) map[d.id] = d.data().vertical;
        });
        setTeamVerticals(map);
      })
      .catch(() => setTeamVerticals({}));

    return () => {
      unsubNumbers();
      unsubBots();
    };
  }, [userData?.organizationId]);

  // Auto-select bot when WhatsApp number changes
  useEffect(() => {
    if (whatsappNumberId && selectedNumber?.defaultBotId && (!moduleVertical || bots.some((b) => b.id === selectedNumber.defaultBotId && b.vertical === moduleVertical))) {
      setBotId(selectedNumber.defaultBotId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whatsappNumberId, selectedNumber?.defaultBotId, bots]);

  // Load SF templates when provider is valuetext
  useEffect(() => {
    if (provider !== "valuetext" || !userData?.organizationId) return;
    setLoadingTemplates(true);
    user?.getIdToken().then((token) => {
      fetch(`/api/salesforce/templates?organizationId=${userData.organizationId}${campaignVertical ? `&vertical=${campaignVertical}` : ""}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => r.json())
        .then((data) => setSfTemplates(data.templates || []))
        .catch(() => setSfTemplates([]))
        .finally(() => setLoadingTemplates(false));
    });
  }, [provider, userData?.organizationId, user, campaignVertical]);

  function handleCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setCsvFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      const parsed = parseCsv(text);
      setRecipients(parsed);
    };
    reader.readAsText(file);
    // Reset input so the same file can be re-selected
    e.target.value = "";
  }

  function parseCsv(text: string): ParsedRecipient[] {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return [];

    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const phoneIdx = headers.indexOf("phone");
    if (phoneIdx === -1) return [];

    const nameIdx = headers.indexOf("name");
    const sfRecordIdIdx = headers.findIndex(
      (h) => h === "salesforcerecordid" || h === "salesforce_record_id" || h === "recordid"
    );
    // Reserved columns — everything else is treated as a template variable
    const reservedCols = new Set(["phone", "name", "salesforcerecordid", "salesforce_record_id", "recordid"]);
    const variableHeaders = headers
      .map((h, i) => ({ header: h, index: i }))
      .filter((h) => !reservedCols.has(h.header));

    const result: ParsedRecipient[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map((c) => c.trim());
      const phone = cols[phoneIdx];
      if (!phone) continue;

      // Normalize phone: ensure it starts with +
      const normalizedPhone = phone.startsWith("+") ? phone : `+${phone}`;

      const variables: Record<string, string> = {};
      for (const vh of variableHeaders) {
        if (cols[vh.index]) {
          // Use 1-indexed keys to match Meta template variables
          variables[String(Object.keys(variables).length + 1)] = cols[vh.index];
        }
      }

      result.push({
        phone: normalizedPhone,
        name: nameIdx !== -1 ? cols[nameIdx] || null : null,
        variables: Object.keys(variables).length > 0 ? variables : null,
        salesforceRecordId: sfRecordIdIdx !== -1 ? cols[sfRecordIdIdx] || null : null,
      });
    }

    return result;
  }

  async function handleSubmit() {
    setError("");

    if (!name || !whatsappNumberId || !botId || !templateName) {
      setError("Completa todos los campos requeridos.");
      return;
    }

    if (type === "manual" && recipients.length === 0) {
      setError("Sube un CSV con al menos un destinatario.");
      return;
    }

    setSaving(true);
    try {
      const broadcastRef = doc(collection(db, "broadcasts"));

      const isReminderType = type === "appointment_reminder" || type === "no_show";
      const cleanMapping = isReminderType ? variableMapping.filter(Boolean) : [];

      await setDoc(broadcastRef, {
        id: broadcastRef.id,
        organizationId: userData?.organizationId,
        vertical: campaignVertical,
        name,
        whatsappNumberId,
        botId,
        templateName,
        templateBody: templateBody || null,
        templateLanguage,
        // Para appointment_reminder/no_show con mapeo definido, genera un skeleton de
        // parámetros para Meta (buildTemplateComponents los rellena por índice al enviar).
        // Twilio y ValueText ignoran este campo, usan contentSid/rsplus__Template_ID__c.
        templateComponents: cleanMapping.length > 0
          ? [{ type: "body", parameters: cleanMapping.map(() => ({ type: "text", text: "" })) }]
          : [],
        contentSid: contentSid || null,
        valuetextObjectApi: valuetextObjectApi || null,
        variableMapping: isReminderType ? cleanMapping : null,
        botInstructions: botInstructions || null,
        type,
        reminderConfig: type === "appointment_reminder" ? { daysBefore, eventType } : type === "no_show" ? { eventType } : null,
        status: "draft",
        totalRecipients: type === "manual" ? recipients.length : 0,
        sentCount: 0,
        deliveredCount: 0,
        failedCount: 0,
        createdBy: user?.uid ?? null,
        createdAt: serverTimestamp(),
        completedAt: null,
      });

      const recipientsRef = collection(db, "broadcasts", broadcastRef.id, "recipients");
      for (let i = 0; i < recipients.length; i += 500) {
        const batch = writeBatch(db);
        for (const recipient of recipients.slice(i, i + 500)) {
          const recipientRef = doc(recipientsRef);
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

      router.push(modulePath(moduleId, `/campanas/${broadcastRef.id}`));
    } catch {
      setError("Error al crear la campaña");
    } finally {
      setSaving(false);
    }
  }

  if (!userData?.organizationId) {
    return (
      <div className="flex items-center justify-center h-96">
        <Card><CardContent className="p-6">Necesitas pertenecer a una organización.</CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href={modulePath(moduleId, "/campanas")}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold">Nueva Campaña</h1>
          <p className="text-muted-foreground">Configura y envía un broadcast por WhatsApp</p>
        </div>
      </div>

      {/* Form */}
      <Card>
        <CardHeader>
          <CardTitle>Configuración</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Nombre de la campaña *</Label>
            <Input
              id="name"
              placeholder="Promo Honda CR-V Marzo"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Tipo de campaña</Label>
              <Select value={type} onValueChange={(v) => setType(v as "manual" | "appointment_reminder" | "no_show")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="appointment_reminder">Recordatorio de cita</SelectItem>
                  <SelectItem value="no_show">No Show</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {(type === "appointment_reminder" || type === "no_show") && (
              <div className="space-y-4">
                {type === "appointment_reminder" && (
                  <div className="space-y-2">
                    <Label htmlFor="daysBefore">Días antes de la cita</Label>
                    <Input
                      id="daysBefore"
                      type="number"
                      min={0}
                      value={daysBefore}
                      onChange={(e) => setDaysBefore(Number(e.target.value))}
                    />
                    <p className="text-xs text-muted-foreground">
                      0 = mismo día, 1 = un día antes, etc.
                    </p>
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="eventType">Tipo de evento (Salesforce)</Label>
                  <Input
                    id="eventType"
                    placeholder="Cita Servicio"
                    value={eventType}
                    onChange={(e) => setEventType(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Valor del campo Type en Salesforce Event.
                  </p>
                </div>
                {type === "no_show" && (
                  <p className="text-xs text-muted-foreground">
                    El cron detecta citas de hoy cuya hora ya pasó y cuyo ESTADO no indica entrega.
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Número WhatsApp *</Label>
              <Select value={whatsappNumberId} onValueChange={setWhatsappNumberId}>
                <SelectTrigger>
                  <SelectValue placeholder="Seleccionar número" />
                </SelectTrigger>
                <SelectContent>
                  {visibleNumbers.map((n) => (
                    <SelectItem key={n.id} value={n.id}>
                      {n.label} ({n.provider})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Bot asociado *</Label>
              <Select value={botId} onValueChange={setBotId}>
                <SelectTrigger>
                  <SelectValue placeholder="Seleccionar bot" />
                </SelectTrigger>
                <SelectContent>
                  {visibleBots.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {provider === "valuetext" ? (
            <div className="space-y-2">
              <Label>Template *</Label>
              {loadingTemplates ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Cargando templates...
                </div>
              ) : sfTemplates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {whatsappNumberId ? "No se encontraron templates para esta organización." : "Selecciona un número WhatsApp primero."}
                </p>
              ) : (
                <Select
                  value={templateName}
                  onValueChange={(v) => {
                    const t = sfTemplates.find((t) => t.id === v);
                    setTemplateName(v);
                    setTemplateBody(t?.messageBody || "");
                    if (t?.objectApiName && !valuetextObjectApi) setValuetextObjectApi(t.objectApiName);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Seleccionar template" />
                  </SelectTrigger>
                  <SelectContent>
                    {sfTemplates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {templateBody && (
                <div className="rounded-md border bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap">{templateBody}</p>
                </div>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="templateName">Nombre del template *</Label>
                <Input
                  id="templateName"
                  placeholder="promo_crv_marzo"
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="templateLanguage">Idioma</Label>
                <Select value={templateLanguage} onValueChange={setTemplateLanguage}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="es">Español (es)</SelectItem>
                    <SelectItem value="es_MX">Español México (es_MX)</SelectItem>
                    <SelectItem value="en">English (en)</SelectItem>
                    <SelectItem value="en_US">English US (en_US)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {provider === "twilio" && (
            <div className="space-y-2">
              <Label htmlFor="contentSid">Content SID (Twilio)</Label>
              <Input
                id="contentSid"
                placeholder="HX..."
                value={contentSid}
                onChange={(e) => setContentSid(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Content SID del template aprobado en Twilio
              </p>
            </div>
          )}

          {provider === "valuetext" && (
            <div className="space-y-2">
              <Label htmlFor="valuetextObjectApi">Objeto Salesforce</Label>
              <Input
                id="valuetextObjectApi"
                placeholder="Lead"
                value={valuetextObjectApi}
                onChange={(e) => setValuetextObjectApi(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                API Name del objeto de Salesforce (ej: Lead, Contact). Las variables del template se toman del registro.
                Incluye una columna <code>salesforceRecordId</code> en el CSV con el ID de cada registro.
              </p>
            </div>
          )}

          {(type === "appointment_reminder" || type === "no_show") && provider && provider !== "valuetext" && (
            <div className="space-y-2">
              <Label>Variables en el mensaje (opcional)</Label>
              <p className="text-xs text-muted-foreground">
                Define qué dato de Salesforce va en cada espacio {"{{n}}"} de la plantilla aprobada, en orden.
                Si la plantilla no tiene variables, deja esto vacío.
              </p>
              <div className="space-y-2">
                {variableMapping.map((field, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-10 shrink-0">{`{{${idx + 1}}}`}</span>
                    <Select
                      value={field}
                      onValueChange={(v) => {
                        const next = [...variableMapping];
                        next[idx] = v;
                        setVariableMapping(next);
                      }}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Selecciona un campo" />
                      </SelectTrigger>
                      <SelectContent>
                        {REMINDER_VARIABLE_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setVariableMapping(variableMapping.filter((_, i) => i !== idx))}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setVariableMapping([...variableMapping, ""])}
                >
                  + Agregar variable
                </Button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="botInstructions">Instrucciones para el bot (opcional)</Label>
            <textarea
              id="botInstructions"
              className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="El cliente recibió promo de CR-V, enfócate en agendar prueba de manejo..."
              value={botInstructions}
              onChange={(e) => setBotInstructions(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* CSV Upload */}
      {type === "manual" && <Card>
        <CardHeader>
          <CardTitle>Destinatarios</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <label className="cursor-pointer">
              <input
                type="file"
                accept=".csv"
                className="hidden"
                onChange={handleCsvUpload}
              />
              <div className="flex items-center gap-2 px-4 py-2 border rounded-md hover:bg-muted/50 transition-colors">
                <Upload className="h-4 w-4" />
                <span className="text-sm">Subir CSV</span>
              </div>
            </label>

            {csvFileName && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FileText className="h-4 w-4" />
                {csvFileName}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => {
                    setRecipients([]);
                    setCsvFileName("");
                  }}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            Formato CSV: <code>phone,name,var1,var2,...</code> — La primera fila es el encabezado.
            Las columnas extras (además de phone y name) se usan como variables del template.
            {provider === "valuetext" && (
              <> Para ValueText, agrega una columna <code>salesforceRecordId</code> con el ID del registro de Salesforce.</>
            )}
          </p>

          {recipients.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{recipients.length} destinatarios</Badge>
              </div>
              <div className="max-h-48 overflow-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr>
                      <th className="text-left p-2 font-medium">Teléfono</th>
                      <th className="text-left p-2 font-medium">Nombre</th>
                      <th className="text-left p-2 font-medium">Variables</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recipients.slice(0, 50).map((r, i) => (
                      <tr key={i} className="border-t">
                        <td className="p-2 font-mono text-xs">{r.phone}</td>
                        <td className="p-2">{r.name || "—"}</td>
                        <td className="p-2 text-xs text-muted-foreground">
                          {r.variables
                            ? Object.entries(r.variables)
                                .map(([k, v]) => `{{${k}}}=${v}`)
                                .join(", ")
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {recipients.length > 50 && (
                  <p className="p-2 text-xs text-muted-foreground text-center">
                    ...y {recipients.length - 50} más
                  </p>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>}

      {/* Error */}
      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {/* Actions */}
      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={() => router.push(modulePath(moduleId, "/campanas"))}>
          Cancelar
        </Button>
        <Button onClick={handleSubmit} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Crear Campaña
        </Button>
      </div>
    </div>
  );
}
