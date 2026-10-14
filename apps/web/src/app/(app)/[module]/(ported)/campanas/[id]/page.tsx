"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  Loader2,
  Send,
  CheckCircle2,
  XCircle,
  Clock,
  Eye,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import { db } from "@/lib/firebase";
import {
  doc,
  collection,
  onSnapshot,
  query,
  orderBy,
  Timestamp,
} from "firebase/firestore";
import { useAuth } from "@/contexts/AuthContext";
import { modulePath, conversationPath } from "@/lib/routes";
import { formatDistanceToNow, format } from "date-fns";
import { es } from "date-fns/locale";

interface BroadcastData {
  id: string;
  name: string;
  type: string | null;
  templateName: string;
  templateLanguage: string;
  botInstructions: string | null;
  status: "draft" | "sending" | "completed" | "failed";
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  failedCount: number;
  skippedCount: number;
  confirmedCount: number;
  cancelledCount: number;
  rescheduledCount: number;
  createdAt: Timestamp | null;
  completedAt: Timestamp | null;
  sendingStartedAt: Timestamp | null;
}

interface RecipientRow {
  id: string;
  phone: string;
  name: string | null;
  variables: Record<string, string> | null;
  status: "pending" | "sent" | "delivered" | "read" | "failed" | "skipped";
  deliveryStatus: "delivered" | "read" | "failed" | null;
  deliveryStatusMessage: string | null;
  response: "confirmar_cita" | "cancelar_cita" | "reagendar_cita" | null;
  errorMessage: string | null;
  conversationId: string | null;
  sentAt: Timestamp | null;
}

const statusConfig: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  draft: { label: "Borrador", variant: "secondary" },
  sending: { label: "Enviando", variant: "default" },
  completed: { label: "Completado", variant: "outline" },
  failed: { label: "Fallido", variant: "destructive" },
};

const recipientStatusConfig: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  pending: { label: "Pendiente", icon: Clock, color: "text-muted-foreground" },
  sent: { label: "Enviado", icon: Send, color: "text-blue-500" },
  delivered: { label: "Entregado", icon: CheckCircle2, color: "text-green-500" },
  read: { label: "Leído", icon: Eye, color: "text-green-600" },
  failed: { label: "Fallido", icon: XCircle, color: "text-destructive" },
  skipped: { label: "Omitido", icon: Clock, color: "text-amber-500" },
};

export default function BroadcastDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { user, userData } = useAuth();
  const broadcastId = params.id as string;
  const moduleId = params.module as string;

  const [broadcast, setBroadcast] = useState<BroadcastData | null>(null);
  const [recipients, setRecipients] = useState<RecipientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [testRecipientId, setTestRecipientId] = useState("");
  const [testSending, setTestSending] = useState(false);
  const [testResult, setTestResult] = useState<{ sent: number; failed: number; conversationId: string | null; results: { index: number; success: boolean; error?: string }[] } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<{ recipients: number; preserved: number; skipped: number; date?: string; skippedDetails?: { id: string; reason: string; rawPhone: string | null; name: string | null }[] } | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [checkStatusResult, setCheckStatusResult] = useState<{ checked: number; delivered: number; failed: number } | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [sentDateFilter, setSentDateFilter] = useState<string>("all");
  const [responseFilter, setResponseFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [deliveryFilter, setDeliveryFilter] = useState<string>("all");
  const PAGE_SIZE = 50;

  // Subscribe to broadcast doc
  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, "broadcasts", broadcastId), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setBroadcast({
          id: docSnap.id,
          name: data.name || "",
          type: data.type || null,
          templateName: data.templateName || "",
          templateLanguage: data.templateLanguage || "es",
          botInstructions: data.botInstructions || null,
          status: data.status || "draft",
          totalRecipients: data.totalRecipients || 0,
          sentCount: data.sentCount || 0,
          deliveredCount: data.deliveredCount || 0,
          failedCount: data.failedCount || 0,
          skippedCount: data.skippedCount || 0,
          confirmedCount: data.confirmedCount || 0,
          cancelledCount: data.cancelledCount || 0,
          rescheduledCount: data.rescheduledCount || 0,
          createdAt: data.createdAt || null,
          completedAt: data.completedAt || null,
          sendingStartedAt: data.sendingStartedAt || null,
        });
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, [broadcastId]);

  // Subscribe to recipients
  useEffect(() => {
    const q = query(
      collection(db, "broadcasts", broadcastId, "recipients"),
      orderBy("phone")
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const items: RecipientRow[] = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        items.push({
          id: docSnap.id,
          phone: data.phone || "",
          name: data.name || null,
          variables: data.variables || null,
          status: data.status || "pending",
          deliveryStatus: data.deliveryStatus || null,
          deliveryStatusMessage: data.deliveryStatusMessage || null,
          response: data.response || null,
          errorMessage: data.errorMessage || null,
          conversationId: data.conversationId || null,
          sentAt: data.sentAt || null,
        });
      });
      setRecipients(items);
      setTestRecipientId((prev) => (prev && items.some((r) => r.id === prev)) ? prev : (items[0]?.id ?? ""));
    });

    return () => unsubscribe();
  }, [broadcastId]);

  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (broadcast?.status === "sending" && !sending && !autoStartedRef.current) {
      autoStartedRef.current = true;
      handleSend();
    }
  }, [broadcast?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSend() {
    if (!broadcast) return;
    if (broadcast.status !== "draft" && broadcast.status !== "sending") return;

    setSending(true);
    setSendError("");

    try {
      const token = await user?.getIdToken();
      const response = await fetch(`/api/broadcasts/${broadcastId}/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!response.ok) {
        setSendError(data.error || "Error al enviar");
      }
    } catch {
      setSendError("Error al enviar la campaña");
    } finally {
      setSending(false);
    }
  }

  async function handleTestSend() {
    if (!testPhone.trim()) return;
    setTestSending(true);
    setTestResult(null);
    setSendError("");
    try {
      const token = await user?.getIdToken();
      const response = await fetch(`/api/broadcasts/${broadcastId}/test-send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ testPhone: testPhone.trim(), recipientId: testRecipientId || undefined }),
      });
      const data = await response.json();
      if (!response.ok) {
        setSendError(data.error || "Error en envío de prueba");
      } else {
        setTestResult({ sent: data.sent, failed: data.failed, conversationId: data.conversationId ?? null, results: data.results || [] });
      }
    } catch {
      setSendError("Error al enviar prueba");
    } finally {
      setTestSending(false);
    }
  }

  async function handleRefresh() {
    if (!broadcast || broadcast.status === "sending") return;
    setRefreshing(true);
    setRefreshResult(null);
    setSendError("");
    try {
      const token = await user?.getIdToken();
      const response = await fetch(`/api/broadcasts/${broadcastId}/refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!response.ok) {
        setSendError(data.error || "Error al refrescar");
      } else {
        setRefreshResult({ recipients: data.recipients, preserved: data.preserved ?? 0, skipped: data.skipped, date: data.date, skippedDetails: data.skippedDetails });
        setCurrentPage(1);
      }
    } catch {
      setSendError("Error al refrescar los destinatarios");
    } finally {
      setRefreshing(false);
    }
  }

  async function handleRetry() {
    if (!broadcast || broadcast.status === "sending") return;
    setRetrying(true);
    setSendError("");
    try {
      const token = await user?.getIdToken();
      const response = await fetch(`/api/broadcasts/${broadcastId}/retry`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!response.ok) setSendError(data.error || "Error al reintentar");
    } catch {
      setSendError("Error al reintentar el envío");
    } finally {
      setRetrying(false);
    }
  }

  async function handleCheckStatus() {
    if (!broadcast) return;
    setCheckingStatus(true);
    setCheckStatusResult(null);
    setSendError("");
    try {
      const token = await user?.getIdToken();
      const response = await fetch(`/api/broadcasts/${broadcastId}/check-status`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!response.ok) {
        setSendError(data.error || "Error al verificar estatus");
      } else {
        setCheckStatusResult(data);
      }
    } catch {
      setSendError("Error al verificar estatus de entregas");
    } finally {
      setCheckingStatus(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!broadcast) {
    return (
      <div className="space-y-6">
        <Link href={modulePath(moduleId, "/campanas")}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <p className="text-muted-foreground">Campaña no encontrada.</p>
      </div>
    );
  }

  const config = statusConfig[broadcast.status] || statusConfig.draft;

  const sentCount = recipients.filter(r => ["sent", "delivered", "read"].includes(r.status)).length;
  const deliveredCount = recipients.filter(r => ["delivered", "read"].includes(r.deliveryStatus ?? r.status)).length;
  const failedCount = recipients.filter(r => r.status === "failed" || r.deliveryStatus === "failed").length;
  const skippedCount = recipients.filter(r => r.status === "skipped").length;

  const STATUS_ORDER: Record<string, number> = {
    pending: 0, skipped: 1, failed: 2, sent: 3, delivered: 4, read: 5,
  };

  // Unique appointment dates for filter (YYYY-MM-DD from variables.fechaCita), sorted descending
  const sentDates = Array.from(
    new Set(recipients.filter((r) => r.variables?.fechaCita).map((r) => r.variables!.fechaCita))
  ).sort((a, b) => b.localeCompare(a));

  const filteredRecipients = (sentDateFilter === "all"
    ? recipients
    : recipients.filter((r) => r.variables?.fechaCita === sentDateFilter)
  ).filter((r) => {
    if (responseFilter === "all") return true;
    if (responseFilter === "none") return !r.response;
    return r.response === responseFilter;
  }).filter((r) => {
    if (statusFilter === "all") return true;
    return r.status === statusFilter;
  }).filter((r) => {
    if (deliveryFilter === "all") return true;
    if (deliveryFilter === "none") return !r.deliveryStatus;
    return r.deliveryStatus === deliveryFilter;
  }).slice().sort((a, b) => {
    const tallerDiff = (a.variables?.taller ?? "").localeCompare(b.variables?.taller ?? "");
    if (tallerDiff !== 0) return tallerDiff;
    const timeDiff = (a.variables?.horaCita ?? "").localeCompare(b.variables?.horaCita ?? "");
    if (timeDiff !== 0) return timeDiff;
    return (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
  });

  function downloadCSV() {
    const RESPONSE_LABEL: Record<string, string> = {
      confirmar_cita: "Confirmó",
      cancelar_cita: "Canceló",
      reagendar_cita: "Reagendó",
    };
    const headers = ["Teléfono","Nombre","Fecha cita","Hora","Taller","Operación","VIN","ID Reservación","Recepcionista","Email","Observaciones","Estado","Entrega VT","Respuesta","Enviado"];
    const rows = filteredRecipients.map(r => [
      r.phone,
      r.name || "",
      r.variables?.fechaCita || "",
      r.variables?.horaCita || "",
      r.variables?.taller || "",
      r.variables?.operacion || "",
      r.variables?.vin || "",
      r.variables?.idReservacion || "",
      r.variables?.recepcionista || "",
      r.variables?.email || "",
      r.variables?.observaciones || "",
      r.status,
      r.deliveryStatus || "",
      r.response ? RESPONSE_LABEL[r.response] : "",
      r.sentAt ? r.sentAt.toDate().toLocaleString("es-MX") : "",
    ]);
    const csv = [headers, ...rows].map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${broadcast?.name || "broadcast"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href={modulePath(moduleId, "/campanas")}>
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold">{broadcast.name}</h1>
              <Badge variant={config.variant}>{config.label}</Badge>
            </div>
            <p className="text-muted-foreground">
              Template: {broadcast.templateName} ({broadcast.templateLanguage})
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {(broadcast.type === "appointment_reminder" || broadcast.type === "no_show") && broadcast.status !== "sending" && (
            <Button variant="outline" onClick={handleRefresh} disabled={refreshing}>
              {refreshing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Refrescar destinatarios
            </Button>
          )}
          {(broadcast.sentCount ?? 0) > 0 && broadcast.status !== "sending" && (
            <Button variant="outline" onClick={handleCheckStatus} disabled={checkingStatus}>
              {checkingStatus ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Verificar entregas
            </Button>
          )}
          {(failedCount > 0 || skippedCount > 0) && broadcast.status !== "sending" && (
            <Button variant="outline" onClick={handleRetry} disabled={retrying}>
              {retrying ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Reintentar ({failedCount + skippedCount})
            </Button>
          )}
          {(broadcast.status === "draft" || broadcast.status === "sending") && (
            <Button onClick={handleSend} disabled={sending}>
              {sending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              {broadcast.status === "sending" && !sending ? "Continuar envío" : "Enviar Campaña"}
            </Button>
          )}
        </div>
      </div>

      {sendError && (
        <p className="text-sm text-destructive">{sendError}</p>
      )}
      {refreshResult && (
        <div className="text-sm text-muted-foreground space-y-1">
          <p>
            Destinatarios actualizados: {refreshResult.recipients} nuevos pendientes
            {refreshResult.preserved > 0 && `, ${refreshResult.preserved} ya enviados (preservados)`}
            {refreshResult.skipped > 0 && `, ${refreshResult.skipped} omitidos`}
            {refreshResult.date && ` — fecha objetivo: ${refreshResult.date}`}
          </p>
          {refreshResult.skippedDetails && refreshResult.skippedDetails.length > 0 && (
            <div className="rounded-md border bg-muted/30 p-3 space-y-1">
              <p className="font-medium text-foreground">Omitidos:</p>
              {refreshResult.skippedDetails.map((s) => (
                <p key={s.id} className="text-xs font-mono">
                  {s.id} — {s.name || "sin nombre"} — {s.reason === "no_phone_field" ? "sin campo teléfono" : s.reason === "no_show_excluded_estado" ? "vehículo entregado o entrada inválida" : `teléfono inválido: ${s.rawPhone}`}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {checkStatusResult && (
        <p className="text-sm text-muted-foreground">
          Verificación: {checkStatusResult.checked} revisados — {checkStatusResult.delivered} entregados, {checkStatusResult.failed} fallidos
          {checkStatusResult.checked - checkStatusResult.delivered - checkStatusResult.failed > 0 &&
            `, ${checkStatusResult.checked - checkStatusResult.delivered - checkStatusResult.failed} aún procesando`}
        </p>
      )}

      {/* Test send */}
      {userData?.isSuperAdmin && (broadcast.status === "draft" || broadcast.status === "sending") && recipients.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Enviar prueba</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Se envía al número de prueba usando los datos del destinatario elegido. No marca al destinatario como enviado ni afecta su registro en Salesforce.
            </p>
            <div className="flex items-end gap-3 flex-wrap">
              <div className="space-y-2 max-w-xs">
                <Label htmlFor="testRecipient">Destinatario (datos a usar)</Label>
                <Select value={testRecipientId} onValueChange={setTestRecipientId}>
                  <SelectTrigger id="testRecipient" className="w-64">
                    <SelectValue placeholder="Seleccionar destinatario" />
                  </SelectTrigger>
                  <SelectContent>
                    {recipients.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {(r.name || r.phone) + (r.variables?.fechaCita ? ` · ${r.variables.fechaCita}` : "")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 max-w-xs">
                <Label htmlFor="testPhone">Tu número de WhatsApp</Label>
                <Input
                  id="testPhone"
                  placeholder="+521234567890"
                  value={testPhone}
                  onChange={(e) => setTestPhone(e.target.value)}
                />
              </div>
              <Button variant="outline" onClick={handleTestSend} disabled={testSending || !testPhone.trim() || !testRecipientId}>
                {testSending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-2 h-4 w-4" />
                )}
                Enviar prueba
              </Button>
            </div>
            {testResult && (
              <p className="text-sm text-muted-foreground">
                {testResult.sent > 0
                  ? `Prueba enviada correctamente${testResult.conversationId ? " — conversación creada/actualizada." : "."}`
                  : `No se pudo enviar la prueba: ${testResult.results[0]?.error || "error desconocido"}`}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Bot Instructions */}
      {broadcast.botInstructions && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Instrucciones para el bot</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">
              {broadcast.botInstructions}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold">{broadcast.totalRecipients}</p>
            <p className="text-sm text-muted-foreground">Total</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-blue-500">{sentCount}</p>
            <p className="text-sm text-muted-foreground">Enviados</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-green-500">{deliveredCount}</p>
            <p className="text-sm text-muted-foreground">Entregados</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-destructive">{failedCount}</p>
            <p className="text-sm text-muted-foreground">Fallidos</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-amber-500">{skippedCount}</p>
            <p className="text-sm text-muted-foreground">Omitidos</p>
          </CardContent>
        </Card>
      </div>

      {(broadcast.confirmedCount > 0 || broadcast.cancelledCount > 0 || broadcast.rescheduledCount > 0) && (
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-2xl font-bold text-emerald-500">{broadcast.confirmedCount}</p>
              <p className="text-sm text-muted-foreground">Confirmaron</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-2xl font-bold text-destructive">{broadcast.cancelledCount}</p>
              <p className="text-sm text-muted-foreground">Cancelaron</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-2xl font-bold text-blue-500">{broadcast.rescheduledCount}</p>
              <p className="text-sm text-muted-foreground">Reagendaron</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Recipients table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 flex-wrap">
          <CardTitle>Destinatarios ({filteredRecipients.length}{(sentDateFilter !== "all" || responseFilter !== "all" || statusFilter !== "all" || deliveryFilter !== "all") && ` de ${recipients.length}`})</CardTitle>
          <div className="flex items-center gap-3 flex-wrap">
            {sentDates.length > 0 && (
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground whitespace-nowrap">Fecha de cita</Label>
                <select
                  value={sentDateFilter}
                  onChange={(e) => { setSentDateFilter(e.target.value); setCurrentPage(1); }}
                  className="text-sm border rounded-md px-2 py-1 bg-background"
                >
                  <option value="all">Todos</option>
                  {sentDates.map((d) => (
                    <option key={d} value={d}>
                      {format(new Date(d + "T12:00:00"), "d MMM yyyy", { locale: es })}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground whitespace-nowrap">Estado</Label>
              <select
                value={statusFilter}
                onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
                className="text-sm border rounded-md px-2 py-1 bg-background"
              >
                <option value="all">Todos</option>
                <option value="sent">Enviado</option>
                <option value="delivered">Entregado</option>
                <option value="read">Leído</option>
                <option value="failed">Fallido</option>
                <option value="skipped">Omitido</option>
                <option value="pending">Pendiente</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground whitespace-nowrap">Entrega VT</Label>
              <select
                value={deliveryFilter}
                onChange={(e) => { setDeliveryFilter(e.target.value); setCurrentPage(1); }}
                className="text-sm border rounded-md px-2 py-1 bg-background"
              >
                <option value="all">Todos</option>
                <option value="delivered">Entregado</option>
                <option value="read">Leído</option>
                <option value="failed">Fallido</option>
                <option value="none">Sin verificar</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground whitespace-nowrap">Respuesta</Label>
              <select
                value={responseFilter}
                onChange={(e) => { setResponseFilter(e.target.value); setCurrentPage(1); }}
                className="text-sm border rounded-md px-2 py-1 bg-background"
              >
                <option value="all">Todas</option>
                <option value="confirmar_cita">Confirmó</option>
                <option value="cancelar_cita">Canceló</option>
                <option value="reagendar_cita">Reagendó</option>
                <option value="none">Sin respuesta</option>
              </select>
            </div>
            <Button variant="outline" size="sm" onClick={downloadCSV}>
              Descargar Excel
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-md border overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 sticky top-0">
                <tr>
                  <th className="text-left p-3 font-medium">Teléfono</th>
                  <th className="text-left p-3 font-medium">Nombre</th>
                  <th className="text-left p-3 font-medium">Fecha cita</th>
                  <th className="text-left p-3 font-medium">Hora</th>
                  <th className="text-left p-3 font-medium">Taller</th>
                  <th className="text-left p-3 font-medium">Operación</th>
                  <th className="text-left p-3 font-medium">VIN</th>
                  <th className="text-left p-3 font-medium">ID Reservación</th>
                  <th className="text-left p-3 font-medium">Tipo cita</th>
                  <th className="text-left p-3 font-medium">Recepcionista</th>
                  <th className="text-left p-3 font-medium">Email</th>
                  <th className="text-left p-3 font-medium">Observaciones</th>
                  <th className="text-left p-3 font-medium">Estado</th>
                  <th className="text-left p-3 font-medium">Entrega VT</th>
                  <th className="text-left p-3 font-medium">Respuesta</th>
                  <th className="text-left p-3 font-medium">Enviado</th>
                  <th className="text-left p-3 font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {filteredRecipients.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map((r) => {
                  const rc = recipientStatusConfig[r.status] || recipientStatusConfig.pending;
                  const StatusIcon = rc.icon;
                  return (
                    <tr key={r.id} className="border-t">
                      <td className="p-3 font-mono text-xs">{r.phone}</td>
                      <td className="p-3">{r.name || "—"}</td>
                      <td className="p-3 text-xs text-muted-foreground">{r.variables?.fechaCita || "—"}</td>
                      <td className="p-3 text-xs text-muted-foreground">{r.variables?.horaCita || "—"}</td>
                      <td className="p-3 text-xs text-muted-foreground">{r.variables?.taller || "—"}</td>
                      <td className="p-3 text-xs text-muted-foreground">{r.variables?.operacion || "—"}</td>
                      <td className="p-3 text-xs font-mono text-muted-foreground">{r.variables?.vin || "—"}</td>
                      <td className="p-3 text-xs font-mono text-muted-foreground">{r.variables?.idReservacion || "—"}</td>
                      <td className="p-3 text-xs text-muted-foreground">{r.variables?.tipoCita || "—"}</td>
                      <td className="p-3 text-xs text-muted-foreground">{r.variables?.recepcionista || "—"}</td>
                      <td className="p-3 text-xs text-muted-foreground">{r.variables?.email || "—"}</td>
                      <td className="p-3 text-xs text-muted-foreground max-w-[200px]">
                        <span title={r.variables?.observaciones || ""} className="line-clamp-2 cursor-default">
                          {r.variables?.observaciones || "—"}
                        </span>
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-1.5">
                          <StatusIcon className={`h-4 w-4 ${rc.color}`} />
                          <span className={rc.color}>{rc.label}</span>
                        </div>
                        {r.errorMessage && (
                          <p className="text-xs text-destructive mt-1">{r.errorMessage}</p>
                        )}
                      </td>
                      <td className="p-3 text-xs">
                        {!r.deliveryStatus && <span className="text-muted-foreground">—</span>}
                        {r.deliveryStatus === "delivered" && <span className="text-green-500 font-medium">Entregado</span>}
                        {r.deliveryStatus === "read" && <span className="text-green-600 font-medium">Leído</span>}
                        {r.deliveryStatus === "failed" && (
                          <span className="text-destructive font-medium" title={r.deliveryStatusMessage || ""}>Fallido</span>
                        )}
                        {r.deliveryStatus === "failed" && r.deliveryStatusMessage && (
                          <p className="text-xs text-destructive mt-0.5 max-w-[180px] line-clamp-2">{r.deliveryStatusMessage}</p>
                        )}
                      </td>
                      <td className="p-3 text-xs">
                        {r.response === "confirmar_cita" && <span className="text-emerald-600 font-medium">Confirmó</span>}
                        {r.response === "cancelar_cita" && <span className="text-destructive font-medium">Canceló</span>}
                        {r.response === "reagendar_cita" && <span className="text-blue-500 font-medium">Reagendó</span>}
                        {!r.response && <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="p-3 text-xs text-muted-foreground">
                        {r.sentAt
                          ? formatDistanceToNow(r.sentAt.toDate(), {
                              addSuffix: true,
                              locale: es,
                            })
                          : "—"}
                      </td>
                      <td className="p-3">
                        {r.conversationId && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              router.push(conversationPath(r.conversationId!, moduleId))
                            }
                          >
                            <MessageSquare className="h-4 w-4" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {filteredRecipients.length > PAGE_SIZE && (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filteredRecipients.length)} de {filteredRecipients.length}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  Anterior
                </Button>
                <span className="px-3">
                  {currentPage} / {Math.ceil(filteredRecipients.length / PAGE_SIZE)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => Math.min(Math.ceil(filteredRecipients.length / PAGE_SIZE), p + 1))}
                  disabled={currentPage === Math.ceil(filteredRecipients.length / PAGE_SIZE)}
                >
                  Siguiente
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
