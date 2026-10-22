"use client";

import { useEffect, useState, useMemo } from "react";
import { useParams } from "next/navigation";
import { getModule } from "@/lib/modules";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Phone,
  Plus,
  Loader2,
  MoreVertical,
  Pencil,
  Trash2,
  Bot,
  Users2,
  Eye,
  EyeOff,
  XCircle,
  RefreshCw,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { auth, db } from "@/lib/firebase";
import {
  collection,
  query,
  where,
  onSnapshot,
  doc,
  getDoc,
  getDocs,
} from "firebase/firestore";
import { useAuth } from "@/contexts/AuthContext";
import { callHubAction } from "@/lib/hub-actions";

interface WhatsAppNumber {
  id: string;
  phoneNumber: string;
  displayName: string;
  provider: "twilio" | "valuetext" | "meta" | "vapi";
  twilioAccountSid: string;
  twilioAuthToken: string;
  valuetextSenderId: string;
  metaPhoneNumberId: string;
  metaAccessToken: string;
  metaWebhookVerifyToken: string;
  /** Credenciales ya configuradas (el valor nunca llega al navegador): twilioAuthToken, metaAccessToken, metaWebhookVerifyToken. */
  secretsSet: string[];
  teamId: string | null;
  defaultBotId: string | null;
  status: "active" | "inactive";
  reopenWindowHours: number | null;
  closeWebhookUrl: string | null;
  inactivityCloseHours: number | null;
  leadTemplateId: string | null;
  followupOpeningTemplateId: string | null;
  followupReminderTemplateId: string | null;
  followupClosingTemplateId: string | null;
  scheduledContactTemplateId: string | null;
  situationTemplateId: string | null;
  serviceHandoffContentSid: string;
  serviceHandoffTemplateName: string;
  serviceHandoffTemplateLanguage: string;
  serviceHandoffTemplatePreview: string;
}

interface SfTemplate {
  id: string;
  displayName: string;
  structure: string;
}

interface Team {
  id: string;
  name: string;
  vertical?: string | null;
}

interface BotItem {
  id: string;
  name: string;
  vertical?: string | null;
}

export default function WhatsAppNumbersPage() {
  const { userData, user, organizations: authOrgs } = useAuth();
  const [numbers, setNumbers] = useState<WhatsAppNumber[]>([]);
  // Módulo activo (URL): acota equipos, bots y números. `general` no acota.
  const { module: moduleId } = useParams<{ module: string }>();
  const vertical = getModule(moduleId)?.vertical ?? null;
  const area = vertical === "servicio" ? "Servicio" : "Ventas";
  const [allTeams, setAllTeams] = useState<Team[]>([]);
  const [allBots, setAllBots] = useState<BotItem[]>([]);
  const teams = useMemo(() => (vertical ? allTeams.filter((t) => t.vertical === vertical) : allTeams), [allTeams, vertical]);
  const bots = useMemo(() => (vertical ? allBots.filter((b) => b.vertical === vertical) : allBots), [allBots, vertical]);
  const [loading, setLoading] = useState(true);

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [selectedNumber, setSelectedNumber] = useState<WhatsAppNumber | null>(null);

  // Form states
  const [formPhoneNumber, setFormPhoneNumber] = useState("");
  const [formDisplayName, setFormDisplayName] = useState("");
  const [formProvider, setFormProvider] = useState<"twilio" | "valuetext" | "meta" | "vapi">("twilio");
  const [formAccountSid, setFormAccountSid] = useState("");
  const [formAuthToken, setFormAuthToken] = useState("");
  const [formValuetextSenderId, setFormValuetextSenderId] = useState("");
  const [formMetaPhoneNumberId, setFormMetaPhoneNumberId] = useState("");
  const [formMetaAccessToken, setFormMetaAccessToken] = useState("");
  const [formMetaWebhookVerifyToken, setFormMetaWebhookVerifyToken] = useState("");
  const [formServiceHandoffContentSid, setFormServiceHandoffContentSid] = useState("");
  const [formServiceHandoffTemplateName, setFormServiceHandoffTemplateName] = useState("");
  const [formServiceHandoffTemplateLanguage, setFormServiceHandoffTemplateLanguage] = useState("es");
  const [formServiceHandoffTemplatePreview, setFormServiceHandoffTemplatePreview] = useState("");
  const [formTeamId, setFormTeamId] = useState<string>("");
  const [formBotId, setFormBotId] = useState<string>("");
  const [showAuthToken, setShowAuthToken] = useState(false);
  const [formReopenWindowHours, setFormReopenWindowHours] = useState<string>("96");
  const [formCloseWebhookUrl, setFormCloseWebhookUrl] = useState("");
  const [formInactivityCloseHours, setFormInactivityCloseHours] = useState<string>("2");
  const [formLeadTemplateId, setFormLeadTemplateId] = useState("");
  const [formFollowupOpeningTemplateId, setFormFollowupOpeningTemplateId] = useState("");
  const [formFollowupReminderTemplateId, setFormFollowupReminderTemplateId] = useState("");
  const [formFollowupClosingTemplateId, setFormFollowupClosingTemplateId] = useState("");
  const [formScheduledContactTemplateId, setFormScheduledContactTemplateId] = useState("");
  const [formSituationTemplateId, setFormSituationTemplateId] = useState("");
  const [sfLeadTemplates, setSfLeadTemplates] = useState<SfTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [formOrgId, setFormOrgId] = useState("");
  const [formOrgTeams, setFormOrgTeams] = useState<Team[]>([]);
  const [formOrgBots, setFormOrgBots] = useState<BotItem[]>([]);
  const [saving, setSaving] = useState(false);

  // Load teams/bots for the selected org in the form (superAdmin switching orgs)
  const effectiveFormOrgId = formOrgId || userData?.organizationId;
  useEffect(() => {
    if (!userData?.isSuperAdmin || !effectiveFormOrgId || effectiveFormOrgId === userData?.organizationId) {
      setFormOrgTeams([]);
      setFormOrgBots([]);
      return;
    }
    const loadOrgData = async () => {
      const [teamsSnap, botsSnap] = await Promise.all([
        getDocs(query(collection(db, "teams"), where("organizationId", "==", effectiveFormOrgId))),
        getDocs(query(collection(db, "bots"), where("organizationId", "==", effectiveFormOrgId))),
      ]);
      setFormOrgTeams(teamsSnap.docs.map(d => ({ id: d.id, name: d.data().name })));
      setFormOrgBots(botsSnap.docs.map(d => ({ id: d.id, name: d.data().name || "Sin nombre" })));
    };
    loadOrgData();
  }, [effectiveFormOrgId, userData?.isSuperAdmin, userData?.organizationId]);

  // Use org-specific teams/bots in dialogs when superAdmin picks a different org
  const dialogTeams = formOrgTeams.length > 0 ? formOrgTeams : teams;
  const dialogBots = formOrgBots.length > 0 ? formOrgBots : bots;

  useEffect(() => {
    if (!userData?.organizationId) {
      setLoading(false);
      return;
    }

    // Subscribe to WhatsApp numbers
    const numbersRef = collection(db, "whatsappNumbers");
    const numbersQuery = query(numbersRef, where("organizationId", "==", userData.organizationId));

    const unsubNumbers = onSnapshot(numbersQuery, (snapshot) => {
      const numbersData: WhatsAppNumber[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        numbersData.push({
          id: doc.id,
          phoneNumber: data.phoneNumber || "",
          displayName: data.displayName || "",
          provider: data.provider || (data.twilioAccountSid ? "twilio" : "twilio"),
          twilioAccountSid: data.twilioAccountSid || "",
          twilioAuthToken: "",
          valuetextSenderId: data.valuetextSenderId || "",
          metaPhoneNumberId: data.metaPhoneNumberId || "",
          metaAccessToken: "",
          metaWebhookVerifyToken: "",
          secretsSet: data.secretsSet || [],
          teamId: data.teamId || null,
          defaultBotId: data.defaultBotId || null,
          status: data.status || "active",
          reopenWindowHours: data.reopenWindowHours ?? null,
          closeWebhookUrl: data.closeWebhookUrl || null,
          inactivityCloseHours: data.inactivityCloseHours ?? null,
          leadTemplateId: data.leadTemplateId || null,
          followupOpeningTemplateId: data.followupOpeningTemplateId || null,
          followupReminderTemplateId: data.followupReminderTemplateId || null,
          followupClosingTemplateId: data.followupClosingTemplateId || null,
          scheduledContactTemplateId: data.scheduledContactTemplateId || null,
          situationTemplateId: data.situationTemplateId || null,
          serviceHandoffContentSid: data.serviceHandoffContentSid || "",
          serviceHandoffTemplateName: data.serviceHandoffTemplateName || "",
          serviceHandoffTemplateLanguage: data.serviceHandoffTemplateLanguage || "es",
          serviceHandoffTemplatePreview: data.serviceHandoffTemplatePreview || "",
        });
      });
      setNumbers(numbersData);
      setLoading(false);
    });

    // Subscribe to teams
    const teamsRef = collection(db, "teams");
    const teamsQuery = query(teamsRef, where("organizationId", "==", userData.organizationId));

    const unsubTeams = onSnapshot(teamsQuery, (snapshot) => {
      const teamsData: Team[] = [];
      snapshot.forEach((doc) => {
        teamsData.push({ id: doc.id, name: doc.data().name, vertical: doc.data().vertical ?? null });
      });
      setAllTeams(teamsData);
    });

    // Subscribe to bots
    const botsRef = collection(db, "bots");
    const botsQuery = query(botsRef, where("organizationId", "==", userData.organizationId));

    const unsubBots = onSnapshot(botsQuery, (snapshot) => {
      const botsData: BotItem[] = [];
      snapshot.forEach((doc) => {
        const d = doc.data();
        botsData.push({ id: doc.id, name: d.name || "Sin nombre", vertical: d.vertical ?? (typeof d.category === "string" ? d.category.toLowerCase() : null) });
      });
      setAllBots(botsData);
    });

    return () => {
      unsubNumbers();
      unsubTeams();
      unsubBots();
    };
  }, [userData?.organizationId]);

  // Número Merkauto registrado como Honda — excepción temporal
  const MERKAUTO_PHONE = "8120854731";

  const loadLeadTemplates = async (orgId: string, phoneNumber: string) => {
    if (!orgId) return;
    setLoadingTemplates(true);
    setSfLeadTemplates([]);
    try {
      const token = await auth.currentUser?.getIdToken();

      const digits = phoneNumber.replace(/\D/g, "").slice(-10);
      let marcaFilter: string;
      if (digits === MERKAUTO_PHONE) {
        marcaFilter = `Marca__c = 'Merkauto'`;
      } else {
        const orgSnap = await getDoc(doc(db, "organizations", orgId));
        const sfBrandCode = orgSnap.exists() ? orgSnap.data()?.sfBrandCode || "" : "";
        marcaFilter = sfBrandCode ? `Marca__c = '${sfBrandCode}' AND Area__c = '${area}'` : `Area__c = '${area}'`;
      }

      const soql = `SELECT Name, rsplus__Template_name__c, rsplus__WA_template_structure__c FROM rsplus__RSP_Templates__c WHERE rsplus__Inactive__c = false AND (rsplus__Object_API_Name__c = 'Lead' OR rsplus__Object_API_Name__c = null) AND ${marcaFilter} ORDER BY rsplus__Template_name__c ASC`;

      const res = await fetch("/api/salesforce/query", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ soql, organizationId: orgId, vertical }),
      });
      if (res.ok) {
        const data = await res.json();
        setSfLeadTemplates(
          (data.records || []).map((r: Record<string, string>) => ({
            id: r.Name,
            displayName: r.rsplus__Template_name__c || r.Name,
            structure: r.rsplus__WA_template_structure__c || "",
          }))
        );
      }
    } catch (e) {
      console.error("Error loading SF templates:", e);
    } finally {
      setLoadingTemplates(false);
    }
  };

  const resetForm = () => {
    setFormPhoneNumber("");
    setFormDisplayName("");
    setFormProvider("twilio");
    setFormAccountSid("");
    setFormAuthToken("");
    setFormValuetextSenderId("");
    setFormMetaPhoneNumberId("");
    setFormMetaAccessToken("");
    setFormMetaWebhookVerifyToken("");
    setFormServiceHandoffContentSid("");
    setFormServiceHandoffTemplateName("");
    setFormServiceHandoffTemplateLanguage("es");
    setFormServiceHandoffTemplatePreview("");
    setFormTeamId("");
    setFormBotId("");
    setFormReopenWindowHours("96");
    setFormCloseWebhookUrl("");
    setFormInactivityCloseHours("2");
    setFormLeadTemplateId("");
    setFormSituationTemplateId("");
    setSfLeadTemplates([]);
    setShowAuthToken(false);
    setSelectedNumber(null);
  };

  const handleCreate = async () => {
    const orgId = (userData?.isSuperAdmin && formOrgId) ? formOrgId : userData?.organizationId;
    if (!formPhoneNumber.trim()) return;
    if (!orgId) {
      alert("No hay una organización activa. Si eres superadmin, crea una en Organizaciones y elígela en el selector.");
      return;
    }

    setSaving(true);
    try {
      // Format phone number with whatsapp: prefix if not present
      let phoneNumber = formPhoneNumber.trim();
      if (!phoneNumber.startsWith("whatsapp:")) {
        phoneNumber = `whatsapp:${phoneNumber}`;
      }

      const docData: Record<string, unknown> = {
        phoneNumber,
        displayName: formDisplayName.trim() || phoneNumber,
        provider: formProvider,
        teamId: formTeamId || null,
        defaultBotId: formBotId || null,
        reopenWindowHours: formReopenWindowHours ? parseInt(formReopenWindowHours, 10) : null,
        closeWebhookUrl: formCloseWebhookUrl.trim() || null,
        inactivityCloseHours: formInactivityCloseHours ? parseInt(formInactivityCloseHours, 10) : null,
      };

      if (formProvider === "twilio") {
        docData.twilioAccountSid = formAccountSid.trim();
        docData.twilioAuthToken = formAuthToken.trim();
        docData.serviceHandoffContentSid = formServiceHandoffContentSid.trim();
      } else if (formProvider === "valuetext") {
        docData.valuetextSenderId = formValuetextSenderId.trim();
        docData.leadTemplateId = formLeadTemplateId || null;
        docData.followupOpeningTemplateId = formFollowupOpeningTemplateId || null;
        docData.followupReminderTemplateId = formFollowupReminderTemplateId || null;
        docData.followupClosingTemplateId = formFollowupClosingTemplateId || null;
        docData.scheduledContactTemplateId = formScheduledContactTemplateId || null;
        docData.situationTemplateId = formSituationTemplateId || null;
      } else if (formProvider === "meta") {
        docData.metaPhoneNumberId = formMetaPhoneNumberId.trim();
        docData.metaAccessToken = formMetaAccessToken.trim();
        docData.metaWebhookVerifyToken = formMetaWebhookVerifyToken.trim();
        docData.serviceHandoffTemplateName = formServiceHandoffTemplateName.trim();
        docData.serviceHandoffTemplateLanguage = formServiceHandoffTemplateLanguage.trim() || "es";
      }

      await callHubAction(user, "number.create", { organizationId: orgId, fields: docData });
      setCreateDialogOpen(false);
      resetForm();
    } catch (error) {
      console.error("Error creating WhatsApp number:", error);
      alert(error instanceof Error ? error.message : "Error al crear el numero de WhatsApp");
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = async () => {
    if (!selectedNumber || !formPhoneNumber.trim()) return;

    setSaving(true);
    try {
      let phoneNumber = formPhoneNumber.trim();
      if (!phoneNumber.startsWith("whatsapp:")) {
        phoneNumber = `whatsapp:${phoneNumber}`;
      }

      const updateData: Record<string, unknown> = {
        phoneNumber,
        displayName: formDisplayName.trim() || phoneNumber,
        provider: formProvider,
        teamId: formTeamId || null,
        defaultBotId: formBotId || null,
        reopenWindowHours: formReopenWindowHours ? parseInt(formReopenWindowHours, 10) : null,
        closeWebhookUrl: formCloseWebhookUrl.trim() || null,
        inactivityCloseHours: formInactivityCloseHours ? parseInt(formInactivityCloseHours, 10) : null,
      };
      if (userData?.isSuperAdmin && formOrgId) {
        updateData.organizationId = formOrgId;
      }

      if (formProvider === "twilio") {
        updateData.twilioAccountSid = formAccountSid.trim();
        // Only update auth token if it was changed
        if (formAuthToken && formAuthToken !== "********") {
          updateData.twilioAuthToken = formAuthToken.trim();
        }
        updateData.serviceHandoffContentSid = formServiceHandoffContentSid.trim();
      } else if (formProvider === "valuetext") {
        updateData.valuetextSenderId = formValuetextSenderId.trim();
        updateData.leadTemplateId = formLeadTemplateId || null;
        updateData.followupOpeningTemplateId = formFollowupOpeningTemplateId || null;
        updateData.followupReminderTemplateId = formFollowupReminderTemplateId || null;
        updateData.followupClosingTemplateId = formFollowupClosingTemplateId || null;
        updateData.scheduledContactTemplateId = formScheduledContactTemplateId || null;
        updateData.situationTemplateId = formSituationTemplateId || null;
      } else if (formProvider === "meta") {
        updateData.metaPhoneNumberId = formMetaPhoneNumberId.trim();
        if (formMetaAccessToken && formMetaAccessToken !== "********") {
          updateData.metaAccessToken = formMetaAccessToken.trim();
        }
        if (formMetaWebhookVerifyToken && formMetaWebhookVerifyToken !== "********") {
          updateData.metaWebhookVerifyToken = formMetaWebhookVerifyToken.trim();
        }
        updateData.serviceHandoffTemplateName = formServiceHandoffTemplateName.trim();
        updateData.serviceHandoffTemplateLanguage = formServiceHandoffTemplateLanguage.trim() || "es";
      }

      // Si cambia de equipo, la función 2 también mueve sus conversaciones abiertas
      await callHubAction(user, "number.update", { id: selectedNumber.id, set: updateData });

      setEditDialogOpen(false);
      resetForm();
    } catch (error) {
      console.error("Error updating WhatsApp number:", error);
      alert(error instanceof Error ? error.message : "Error al actualizar el numero");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (numberId: string) => {
    if (!confirm("Estas seguro de que deseas eliminar este numero de WhatsApp?")) return;

    try {
      await callHubAction(user, "number.delete", { id: numberId });
    } catch (error) {
      console.error("Error deleting WhatsApp number:", error);
      alert(error instanceof Error ? error.message : "Error al eliminar el numero");
    }
  };

  const handleToggleStatus = async (number: WhatsAppNumber) => {
    try {
      await callHubAction(user, "number.update", {
        id: number.id,
        set: { status: number.status === "active" ? "inactive" : "active" },
      });
    } catch (error) {
      console.error("Error toggling status:", error);
      alert(error instanceof Error ? error.message : "Error al cambiar el estado");
    }
  };

  const openEditDialog = (number: WhatsAppNumber) => {
    setSelectedNumber(number);
    setFormPhoneNumber(number.phoneNumber.replace("whatsapp:", ""));
    setFormDisplayName(number.displayName);
    setFormProvider(number.provider);
    setFormAccountSid(number.twilioAccountSid);
    setFormAuthToken(number.secretsSet.includes("twilioAuthToken") ? "********" : ""); // enmascarado: el valor no está en el navegador
    setFormValuetextSenderId(number.valuetextSenderId);
    setFormMetaPhoneNumberId(number.metaPhoneNumberId);
    setFormMetaAccessToken(number.secretsSet.includes("metaAccessToken") ? "********" : "");
    setFormMetaWebhookVerifyToken(number.secretsSet.includes("metaWebhookVerifyToken") ? "********" : "");
    setFormServiceHandoffContentSid(number.serviceHandoffContentSid);
    setFormServiceHandoffTemplateName(number.serviceHandoffTemplateName);
    setFormServiceHandoffTemplateLanguage(number.serviceHandoffTemplateLanguage || "es");
    setFormServiceHandoffTemplatePreview(number.serviceHandoffTemplatePreview);
    setFormTeamId(number.teamId || "");
    setFormBotId(number.defaultBotId || "");
    setFormReopenWindowHours(number.reopenWindowHours != null ? String(number.reopenWindowHours) : "96");
    setFormCloseWebhookUrl(number.closeWebhookUrl || "");
    setFormInactivityCloseHours(number.inactivityCloseHours != null ? String(number.inactivityCloseHours) : "2");
    setFormLeadTemplateId(number.leadTemplateId || "");
    setFormFollowupOpeningTemplateId(number.followupOpeningTemplateId || "");
    setFormFollowupReminderTemplateId(number.followupReminderTemplateId || "");
    setFormFollowupClosingTemplateId(number.followupClosingTemplateId || "");
    setFormScheduledContactTemplateId(number.scheduledContactTemplateId || "");
    setFormSituationTemplateId(number.situationTemplateId || "");
    if (number.provider === "valuetext") {
      const orgId = userData?.organizationId || "";
      loadLeadTemplates(orgId, number.phoneNumber);
    }
    setShowAuthToken(false);
    setEditDialogOpen(true);
  };

  const visibleNumbers = useMemo(
    () => (vertical ? numbers.filter((n) => teams.some((t) => t.id === n.teamId)) : numbers),
    [numbers, teams, vertical]
  );

  const getTeamName = (teamId: string | null) => {
    if (!teamId) return "Sin equipo";
    const team = teams.find((t) => t.id === teamId);
    return team?.name || "Sin equipo";
  };

  const getBotName = (botId: string | null) => {
    if (!botId) return "Sin bot";
    const bot = bots.find((b) => b.id === botId);
    return bot?.name || "Sin bot";
  };

  const isCurrentUserAdmin = userData?.role === "admin";

  if (!userData?.organizationId) {
    return (
      <div>
        <div className="mb-8">
          <h1 className="text-2xl font-bold">Numeros de WhatsApp</h1>
          <p className="text-gray-500">Gestiona tus numeros de WhatsApp Business</p>
        </div>
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-gray-500">
              Necesitas pertenecer a una organizacion para ver los numeros.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  // Provider-specific fields for create/edit dialogs
  const providerFields = (idPrefix: string) => (
    <>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-provider`}>Proveedor</Label>
        <Select value={formProvider} onValueChange={(v) => setFormProvider(v as "twilio" | "valuetext" | "meta" | "vapi")}>
          <SelectTrigger>
            <SelectValue placeholder="Seleccionar proveedor" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="twilio">Twilio</SelectItem>
            <SelectItem value="valuetext">ValueText</SelectItem>
            <SelectItem value="meta">Meta (WhatsApp Cloud API)</SelectItem>
            <SelectItem value="vapi">Vapi (Voz)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {formProvider === "twilio" && (
        <>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-accountSid`}>Twilio Account SID</Label>
            <Input
              id={`${idPrefix}-accountSid`}
              placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              value={formAccountSid}
              onChange={(e) => setFormAccountSid(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-authToken`}>Twilio Auth Token</Label>
            <div className="relative">
              <Input
                id={`${idPrefix}-authToken`}
                type={showAuthToken ? "text" : "password"}
                placeholder={idPrefix === "edit" ? "Dejar vacio para mantener actual" : "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}
                value={formAuthToken}
                onChange={(e) => setFormAuthToken(e.target.value)}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                onClick={() => setShowAuthToken(!showAuthToken)}
              >
                {showAuthToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            {idPrefix === "edit" && (
              <p className="text-xs text-gray-500">Dejar como ******** para no cambiar</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-serviceHandoffContentSid`}>Plantilla de Handoff a Servicio (Content SID)</Label>
            <Input
              id={`${idPrefix}-serviceHandoffContentSid`}
              placeholder="HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              value={formServiceHandoffContentSid}
              onChange={(e) => setFormServiceHandoffContentSid(e.target.value)}
            />
            <p className="text-xs text-gray-500">
              Plantilla que se envía cuando otro bot detecta una situación de servicio. Debe tener 2 variables: nombre del cliente y motivo.
            </p>
          </div>
        </>
      )}
      {formProvider === "valuetext" && (
        <>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-senderId`}>Sender ID (ValueText)</Label>
            <Input
              id={`${idPrefix}-senderId`}
              placeholder="Identificador del remitente en ValueText"
              value={formValuetextSenderId}
              onChange={(e) => setFormValuetextSenderId(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Plantilla de lead</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 text-xs"
                disabled={loadingTemplates}
                onClick={() => loadLeadTemplates(effectiveFormOrgId || "", formPhoneNumber)}
              >
                {loadingTemplates ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                Cargar plantillas
              </Button>
            </div>
            <Select
              value={formLeadTemplateId || "none"}
              onValueChange={(v) => setFormLeadTemplateId(v === "none" ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Seleccionar plantilla" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Sin plantilla</SelectItem>
                {sfLeadTemplates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.displayName} ({t.id})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {formLeadTemplateId && (() => {
              const selected = sfLeadTemplates.find(t => t.id === formLeadTemplateId);
              return selected?.structure ? (
                <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground whitespace-pre-wrap">
                  {selected.structure}
                </div>
              ) : null;
            })()}
            <p className="text-xs text-gray-500">Plantilla que se envía al recibir un lead de Salesforce.</p>
          </div>
          <div className="space-y-2">
            <Label>Plantilla de seguimiento — Apertura</Label>
            <Select
              value={formFollowupOpeningTemplateId || "none"}
              onValueChange={(v) => setFormFollowupOpeningTemplateId(v === "none" ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Seleccionar plantilla" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Sin plantilla</SelectItem>
                {sfLeadTemplates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.displayName} ({t.id})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-gray-500">Se usa cuando el cliente respondió pero ya pasaron 24h desde su último mensaje.</p>
            {formFollowupOpeningTemplateId && (() => {
              const selected = sfLeadTemplates.find(t => t.id === formFollowupOpeningTemplateId);
              return selected?.structure ? (
                <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground whitespace-pre-wrap">
                  {selected.structure}
                </div>
              ) : null;
            })()}
          </div>
          <div className="space-y-2">
            <Label>Plantilla de seguimiento — Recordatorio</Label>
            <Select
              value={formFollowupReminderTemplateId || "none"}
              onValueChange={(v) => setFormFollowupReminderTemplateId(v === "none" ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Seleccionar plantilla" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Sin plantilla</SelectItem>
                {sfLeadTemplates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.displayName} ({t.id})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-gray-500">Se usa cuando ya se envió una plantilla y el cliente no ha respondido en 24h.</p>
            {formFollowupReminderTemplateId && (() => {
              const selected = sfLeadTemplates.find(t => t.id === formFollowupReminderTemplateId);
              return selected?.structure ? (
                <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground whitespace-pre-wrap">
                  {selected.structure}
                </div>
              ) : null;
            })()}
          </div>
          <div className="space-y-2">
            <Label>Plantilla de seguimiento — Cierre</Label>
            <Select
              value={formFollowupClosingTemplateId || "none"}
              onValueChange={(v) => setFormFollowupClosingTemplateId(v === "none" ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Seleccionar plantilla" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Sin plantilla</SelectItem>
                {sfLeadTemplates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.displayName} ({t.id})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-gray-500">Se usa en el último intento antes de cerrar la conversación por inactividad.</p>
            {formFollowupClosingTemplateId && (() => {
              const selected = sfLeadTemplates.find(t => t.id === formFollowupClosingTemplateId);
              return selected?.structure ? (
                <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground whitespace-pre-wrap">
                  {selected.structure}
                </div>
              ) : null;
            })()}
          </div>
          <div className="space-y-2">
            <Label>Plantilla de contacto programado</Label>
            <Select
              value={formScheduledContactTemplateId || "none"}
              onValueChange={(v) => setFormScheduledContactTemplateId(v === "none" ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Seleccionar plantilla" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Sin plantilla</SelectItem>
                {sfLeadTemplates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.displayName} ({t.id})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-gray-500">Se usa cuando el cliente pidió ser contactado a una hora específica y la ventana de 24h ya expiró.</p>
            {formScheduledContactTemplateId && (() => {
              const selected = sfLeadTemplates.find(t => t.id === formScheduledContactTemplateId);
              return selected?.structure ? (
                <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground whitespace-pre-wrap">
                  {selected.structure}
                </div>
              ) : null;
            })()}
          </div>
          <div className="space-y-2">
            <Label>Plantilla de detección de situación</Label>
            <Select
              value={formSituationTemplateId || "none"}
              onValueChange={(v) => setFormSituationTemplateId(v === "none" ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Seleccionar plantilla" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Sin plantilla</SelectItem>
                {sfLeadTemplates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.displayName} ({t.id})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-gray-500">Se usa cuando este número recibe una conversación transferida por otro bot (ej. detección de servicio/postventa).</p>
            {formSituationTemplateId && (() => {
              const selected = sfLeadTemplates.find(t => t.id === formSituationTemplateId);
              return selected?.structure ? (
                <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground whitespace-pre-wrap">
                  {selected.structure}
                </div>
              ) : null;
            })()}
          </div>
        </>
      )}
      {formProvider === "meta" && (
        <>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-metaPhoneNumberId`}>Phone Number ID</Label>
            <Input
              id={`${idPrefix}-metaPhoneNumberId`}
              placeholder="ID numerico del numero en Meta"
              value={formMetaPhoneNumberId}
              onChange={(e) => setFormMetaPhoneNumberId(e.target.value)}
            />
            <p className="text-xs text-gray-500">Se encuentra en Meta Business Suite → WhatsApp → Phone Numbers</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-metaAccessToken`}>Access Token</Label>
            <div className="relative">
              <Input
                id={`${idPrefix}-metaAccessToken`}
                type={showAuthToken ? "text" : "password"}
                placeholder={idPrefix === "edit" ? "Dejar vacio para mantener actual" : "System User Access Token"}
                value={formMetaAccessToken}
                onChange={(e) => setFormMetaAccessToken(e.target.value)}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                onClick={() => setShowAuthToken(!showAuthToken)}
              >
                {showAuthToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            {idPrefix === "edit" && (
              <p className="text-xs text-gray-500">Dejar como ******** para no cambiar</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-metaVerifyToken`}>Webhook Verify Token</Label>
            <Input
              id={`${idPrefix}-metaVerifyToken`}
              placeholder="Token para verificacion del webhook"
              value={formMetaWebhookVerifyToken}
              onChange={(e) => setFormMetaWebhookVerifyToken(e.target.value)}
            />
            <p className="text-xs text-gray-500">Token que defines tu, se usa para verificar el webhook en Meta. Se guarda en el servidor y no se puede volver a ver: para cambiarlo, escribe uno nuevo.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-serviceHandoffTemplateName`}>Plantilla de Handoff a Servicio</Label>
            <Input
              id={`${idPrefix}-serviceHandoffTemplateName`}
              placeholder="nombre_plantilla_aprobada"
              value={formServiceHandoffTemplateName}
              onChange={(e) => setFormServiceHandoffTemplateName(e.target.value)}
            />
            <p className="text-xs text-gray-500">
              Plantilla que se envía cuando otro bot detecta una situación de servicio. Debe tener 2 variables de body: nombre del cliente y motivo.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-serviceHandoffTemplateLanguage`}>Idioma de la plantilla</Label>
            <Input
              id={`${idPrefix}-serviceHandoffTemplateLanguage`}
              placeholder="es"
              value={formServiceHandoffTemplateLanguage}
              onChange={(e) => setFormServiceHandoffTemplateLanguage(e.target.value)}
            />
          </div>
        </>
      )}
    </>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Numeros de WhatsApp</h1>
          <p className="text-gray-500">
            {visibleNumbers.length} numero{visibleNumbers.length !== 1 ? "s" : ""} configurado{visibleNumbers.length !== 1 ? "s" : ""}
          </p>
        </div>
        {isCurrentUserAdmin && (
          <Button onClick={() => { resetForm(); setCreateDialogOpen(true); }}>
            <Plus className="mr-2 h-4 w-4" />
            Agregar Numero
          </Button>
        )}
      </div>

      {visibleNumbers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="rounded-full bg-gray-100 p-4 mb-4">
              <Phone className="h-8 w-8 text-gray-400" />
            </div>
            <h3 className="text-lg font-medium mb-2">
              No hay numeros configurados
            </h3>
            <p className="text-gray-500 text-center mb-4">
              Agrega numeros de WhatsApp Business para recibir mensajes.
            </p>
            {isCurrentUserAdmin && (
              <Button onClick={() => { resetForm(); setCreateDialogOpen(true); }}>
                <Plus className="mr-2 h-4 w-4" />
                Agregar Numero
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {visibleNumbers.map((number) => (
            <Card key={number.id}>
              <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                <div>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Phone className="h-5 w-5 text-green-600" />
                    {number.displayName}
                  </CardTitle>
                  <p className="text-sm text-gray-500 mt-1 font-mono">
                    {number.phoneNumber.replace("whatsapp:", "")}
                  </p>
                </div>
                {isCurrentUserAdmin && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openEditDialog(number)}>
                        <Pencil className="mr-2 h-4 w-4" />
                        Editar
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleToggleStatus(number)}>
                        {number.status === "active" ? (
                          <>
                            <EyeOff className="mr-2 h-4 w-4" />
                            Desactivar
                          </>
                        ) : (
                          <>
                            <Eye className="mr-2 h-4 w-4" />
                            Activar
                          </>
                        )}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-red-600"
                        onClick={() => handleDelete(number.id)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Eliminar
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Badge variant={number.status === "active" ? "default" : "secondary"}>
                      {number.status === "active" ? "Activo" : "Inactivo"}
                    </Badge>
                    <Badge variant="outline" className={
                      number.provider === "twilio" ? "border-green-500 text-green-700" :
                      number.provider === "meta" ? "border-blue-500 text-blue-700" :
                      number.provider === "vapi" ? "border-orange-500 text-orange-700" :
                      "border-purple-500 text-purple-700"
                    }>
                      {number.provider === "twilio" ? "Twilio" : number.provider === "meta" ? "Meta" : number.provider === "vapi" ? "Vapi" : "ValueText"}
                    </Badge>
                  </div>

                  <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2">
                      <Users2 className="h-4 w-4 text-gray-400" />
                      <span>Equipo: {getTeamName(number.teamId)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Bot className="h-4 w-4 text-gray-400" />
                      <span>Bot: {getBotName(number.defaultBotId)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <XCircle className="h-4 w-4 text-gray-400" />
                      <span>Cierre por inactividad: {number.inactivityCloseHours ?? 2}h</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <RefreshCw className="h-4 w-4 text-gray-400" />
                      <span>Ventana reapertura: {number.reopenWindowHours ?? 96}h</span>
                    </div>
                  </div>

                  {number.provider === "twilio" && number.twilioAccountSid && (
                    <div className="pt-2 border-t">
                      <p className="text-xs text-gray-500">
                        Account SID: {number.twilioAccountSid.slice(0, 8)}...
                      </p>
                    </div>
                  )}
                  {number.provider === "valuetext" && number.valuetextSenderId && (
                    <div className="pt-2 border-t space-y-1">
                      <p className="text-xs text-gray-500">
                        Sender ID: {number.valuetextSenderId}
                      </p>
                      {number.leadTemplateId && (
                        <p className="text-xs text-gray-500">
                          Plantilla lead: {number.leadTemplateId}
                        </p>
                      )}
                    </div>
                  )}
                  {number.provider === "meta" && number.metaPhoneNumberId && (
                    <div className="pt-2 border-t">
                      <p className="text-xs text-gray-500">
                        Phone Number ID: {number.metaPhoneNumberId.slice(0, 10)}...
                      </p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Agregar Numero de WhatsApp</DialogTitle>
            <DialogDescription>
              Configura un nuevo numero de WhatsApp Business.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {userData?.isSuperAdmin && authOrgs.length > 0 && (
              <div className="space-y-2">
                <Label>Organizacion</Label>
                <Select value={formOrgId || userData?.organizationId || ""} onValueChange={setFormOrgId}>
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
              <Label htmlFor="phoneNumber">Numero de telefono</Label>
              <Input
                id="phoneNumber"
                placeholder="+528120854452"
                value={formPhoneNumber}
                onChange={(e) => setFormPhoneNumber(e.target.value)}
              />
              <p className="text-xs text-gray-500">Formato: +[codigo pais][numero]</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="displayName">Nombre para mostrar</Label>
              <Input
                id="displayName"
                placeholder="Ventas WhatsApp"
                value={formDisplayName}
                onChange={(e) => setFormDisplayName(e.target.value)}
              />
            </div>

            {providerFields("create")}

            <div className="space-y-2">
              <Label htmlFor="teamId">Equipo</Label>
              <Select value={formTeamId || "none"} onValueChange={(v) => setFormTeamId(v === "none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Seleccionar equipo" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sin equipo</SelectItem>
                  {dialogTeams.map((team) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="botId">Bot por defecto</Label>
              <Select value={formBotId || "none"} onValueChange={(v) => setFormBotId(v === "none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Seleccionar bot" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sin bot</SelectItem>
                  {dialogBots.map((bot) => (
                    <SelectItem key={bot.id} value={bot.id}>
                      {bot.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Closure config */}
            <div className="pt-2 border-t space-y-2">
              <p className="text-sm font-medium">Configuracion de cierre</p>
              <div className="space-y-2">
                <Label htmlFor="inactivityCloseHours">Cierre por inactividad (horas)</Label>
                <Input
                  id="inactivityCloseHours"
                  type="number"
                  min="1"
                  placeholder="2"
                  value={formInactivityCloseHours}
                  onChange={(e) => setFormInactivityCloseHours(e.target.value)}
                />
                <p className="text-xs text-gray-500">Cierra automaticamente conversaciones sin actividad despues de este tiempo. Default: 2h.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="reopenWindowHours">Ventana de reapertura (horas)</Label>
                <Input
                  id="reopenWindowHours"
                  type="number"
                  min="0"
                  placeholder="96"
                  value={formReopenWindowHours}
                  onChange={(e) => setFormReopenWindowHours(e.target.value)}
                />
                <p className="text-xs text-gray-500">Si el cliente escribe dentro de este periodo, se reabre la conversacion anterior. Default: 96h.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="closeWebhookUrl">Webhook de cierre (opcional)</Label>
                <Input
                  id="closeWebhookUrl"
                  placeholder="https://..."
                  value={formCloseWebhookUrl}
                  onChange={(e) => setFormCloseWebhookUrl(e.target.value)}
                />
                <p className="text-xs text-gray-500">Se dispara un POST a esta URL cuando se cierra una conversacion de este canal.</p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleCreate} disabled={saving || !formPhoneNumber.trim()}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Agregar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar Numero de WhatsApp</DialogTitle>
            <DialogDescription>
              Modifica la configuracion del numero.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {userData?.isSuperAdmin && authOrgs.length > 0 && (
              <div className="space-y-2">
                <Label>Organizacion</Label>
                <Select value={formOrgId || userData?.organizationId || ""} onValueChange={setFormOrgId}>
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
              <Label htmlFor="edit-phoneNumber">Numero de telefono</Label>
              <Input
                id="edit-phoneNumber"
                placeholder="+528120854452"
                value={formPhoneNumber}
                onChange={(e) => setFormPhoneNumber(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-displayName">Nombre para mostrar</Label>
              <Input
                id="edit-displayName"
                placeholder="Ventas WhatsApp"
                value={formDisplayName}
                onChange={(e) => setFormDisplayName(e.target.value)}
              />
            </div>

            {providerFields("edit")}

            <div className="space-y-2">
              <Label htmlFor="edit-teamId">Equipo</Label>
              <Select value={formTeamId || "none"} onValueChange={(v) => setFormTeamId(v === "none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Seleccionar equipo" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sin equipo</SelectItem>
                  {dialogTeams.map((team) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-botId">Bot por defecto</Label>
              <Select value={formBotId || "none"} onValueChange={(v) => setFormBotId(v === "none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Seleccionar bot" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sin bot</SelectItem>
                  {dialogBots.map((bot) => (
                    <SelectItem key={bot.id} value={bot.id}>
                      {bot.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Closure config */}
            <div className="pt-2 border-t space-y-2">
              <p className="text-sm font-medium">Configuracion de cierre</p>
              <div className="space-y-2">
                <Label htmlFor="edit-inactivityCloseHours">Cierre por inactividad (horas)</Label>
                <Input
                  id="edit-inactivityCloseHours"
                  type="number"
                  min="1"
                  placeholder="2"
                  value={formInactivityCloseHours}
                  onChange={(e) => setFormInactivityCloseHours(e.target.value)}
                />
                <p className="text-xs text-gray-500">Cierra automaticamente conversaciones sin actividad despues de este tiempo. Default: 2h.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-reopenWindowHours">Ventana de reapertura (horas)</Label>
                <Input
                  id="edit-reopenWindowHours"
                  type="number"
                  min="0"
                  placeholder="96"
                  value={formReopenWindowHours}
                  onChange={(e) => setFormReopenWindowHours(e.target.value)}
                />
                <p className="text-xs text-gray-500">Si el cliente escribe dentro de este periodo, se reabre la conversacion anterior. Default: 96h.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-closeWebhookUrl">Webhook de cierre (opcional)</Label>
                <Input
                  id="edit-closeWebhookUrl"
                  placeholder="https://..."
                  value={formCloseWebhookUrl}
                  onChange={(e) => setFormCloseWebhookUrl(e.target.value)}
                />
                <p className="text-xs text-gray-500">Se dispara un POST a esta URL cuando se cierra una conversacion de este canal.</p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleEdit} disabled={saving || !formPhoneNumber.trim()}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
