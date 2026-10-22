"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Megaphone, Plus, Loader2, Bell } from "lucide-react";
import { db } from "@/lib/firebase";
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  getCountFromServer,
  getDocs,
  Timestamp,
} from "firebase/firestore";
import { useAuth } from "@/contexts/AuthContext";
import { getModule } from "@/lib/modules";
import { modulePath } from "@/lib/routes";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";

interface BroadcastRow {
  id: string;
  name: string;
  templateName: string;
  status: "draft" | "sending" | "completed" | "failed";
  vertical: string | null;
  botId: string;
  whatsappNumberId: string;
  type: "manual" | "appointment_reminder" | null;
  reminderConfig: { daysBefore: number } | null;
  totalRecipients: number;
  createdAt: Timestamp | null;
}

interface BroadcastCounts {
  sent: number;
  delivered: number;
  failed: number;
}

const statusConfig: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  draft: { label: "Borrador", variant: "secondary" },
  sending: { label: "Enviando", variant: "default" },
  completed: { label: "Completado", variant: "outline" },
  failed: { label: "Fallido", variant: "destructive" },
};

export default function BroadcastsPage() {
  const { userData } = useAuth();
  const router = useRouter();
  const { module: moduleId } = useParams<{ module: string }>();
  const moduleVertical = getModule(moduleId)?.vertical ?? null;
  // Referencias para deducir el módulo de campañas antiguas sin `vertical`
  const [botVerticals, setBotVerticals] = useState<Record<string, string>>({});
  const [numberVerticals, setNumberVerticals] = useState<Record<string, string>>({});
  const [broadcasts, setBroadcasts] = useState<BroadcastRow[]>([]);
  const [counts, setCounts] = useState<Record<string, BroadcastCounts>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userData?.organizationId) return;

    const q = query(
      collection(db, "broadcasts"),
      where("organizationId", "==", userData.organizationId),
      orderBy("createdAt", "desc")
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const items: BroadcastRow[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        items.push({
          id: doc.id,
          name: data.name || "",
          templateName: data.templateName || "",
          status: data.status || "draft",
          vertical: data.vertical || null,
          botId: data.botId || "",
          whatsappNumberId: data.whatsappNumberId || "",
          type: data.type || null,
          reminderConfig: data.reminderConfig || null,
          totalRecipients: data.totalRecipients || 0,
          createdAt: data.createdAt || null,
        });
      });
      setBroadcasts(items);
      setLoading(false);

      // Fetch accurate counts from recipients subcollection for each broadcast
      items.forEach(async (b) => {
        if (b.status === "draft") return;
        const recipientsRef = collection(db, "broadcasts", b.id, "recipients");
        const [sentSnap, deliveredSnap, failedSnap] = await Promise.all([
          getCountFromServer(query(recipientsRef, where("status", "in", ["sent", "delivered", "read"]))),
          getCountFromServer(query(recipientsRef, where("status", "in", ["delivered", "read"]))),
          getCountFromServer(query(recipientsRef, where("status", "==", "failed"))),
        ]);
        setCounts((prev) => ({
          ...prev,
          [b.id]: {
            sent: sentSnap.data().count,
            delivered: deliveredSnap.data().count,
            failed: failedSnap.data().count,
          },
        }));
      });
    });

    return () => unsubscribe();
  }, [userData?.organizationId]);

  // Vertical de bots y números (por su equipo) de la organización
  useEffect(() => {
    const orgId = userData?.organizationId;
    if (!orgId) return;
    (async () => {
      try {
        const [botsSnap, teamsSnap, numsSnap] = await Promise.all([
          getDocs(query(collection(db, "bots"), where("organizationId", "==", orgId))),
          getDocs(query(collection(db, "teams"), where("organizationId", "==", orgId))),
          getDocs(query(collection(db, "whatsappNumbers"), where("organizationId", "==", orgId))),
        ]);
        const bv: Record<string, string> = {};
        botsSnap.forEach((d) => {
          const data = d.data();
          const cat = typeof data.category === "string" ? data.category.toLowerCase() : "";
          const v = data.vertical || (cat === "servicio" || cat === "ventas" ? cat : "");
          if (v) bv[d.id] = v;
        });
        const tv: Record<string, string> = {};
        teamsSnap.forEach((d) => {
          if (d.data().vertical) tv[d.id] = d.data().vertical;
        });
        const nv: Record<string, string> = {};
        numsSnap.forEach((d) => {
          const v = tv[d.data().teamId];
          if (v) nv[d.id] = v;
        });
        setBotVerticals(bv);
        setNumberVerticals(nv);
      } catch {
        // sin referencias: solo se acota por la vertical guardada en la campaña
      }
    })();
  }, [userData?.organizationId]);

  const visibleBroadcasts = moduleVertical
    ? broadcasts.filter(
        (b) => (b.vertical || botVerticals[b.botId] || numberVerticals[b.whatsappNumberId]) === moduleVertical
      )
    : broadcasts;

  if (!userData?.organizationId) {
    return (
      <div className="flex items-center justify-center h-96">
        <Card><CardContent className="p-6">Necesitas pertenecer a una organización.</CardContent></Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Campañas</h1>
          <p className="text-muted-foreground">Envía mensajes masivos por WhatsApp</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => router.push(modulePath(moduleId, "/campanas/new"))}>
            <Plus className="mr-2 h-4 w-4" />
            Nueva Campaña
          </Button>
        </div>
      </div>

      {visibleBroadcasts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Megaphone className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No hay campañas</h3>
            <p className="text-muted-foreground mb-4">
              Crea tu primera campaña para enviar mensajes masivos por WhatsApp.
            </p>
            <Button onClick={() => router.push(modulePath(moduleId, "/campanas/new"))}>
              <Plus className="mr-2 h-4 w-4" />
              Nueva Campaña
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {visibleBroadcasts.map((broadcast) => {
            const config = statusConfig[broadcast.status] || statusConfig.draft;
            return (
              <Card
                key={broadcast.id}
                className="cursor-pointer hover:bg-muted/50 transition-colors"
                onClick={() => router.push(modulePath(moduleId, `/campanas/${broadcast.id}`))}
              >
                <CardContent className="flex items-center justify-between p-6">
                  <div className="space-y-1">
                    <div className="flex items-center gap-3">
                      <h3 className="font-semibold text-lg">{broadcast.name}</h3>
                      <Badge variant={config.variant}>{config.label}</Badge>
                      {broadcast.type === "appointment_reminder" && (
                        <Badge variant="outline" className="gap-1">
                          <Bell className="h-3 w-3" />
                          {broadcast.reminderConfig?.daysBefore === 0
                            ? "Mismo día"
                            : `${broadcast.reminderConfig?.daysBefore}d antes`}
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Template: {broadcast.templateName} &middot;{" "}
                      {broadcast.totalRecipients} destinatarios
                    </p>
                    {broadcast.createdAt && (
                      <p className="text-xs text-muted-foreground">
                        {formatDistanceToNow(broadcast.createdAt.toDate(), {
                          addSuffix: true,
                          locale: es,
                        })}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-6 text-sm text-muted-foreground">
                    {broadcast.status !== "draft" && (() => {
                      const c = counts[broadcast.id];
                      return (
                        <>
                          <div className="text-center">
                            <p className="text-lg font-semibold text-foreground">{c?.sent ?? "—"}</p>
                            <p>Enviados</p>
                          </div>
                          <div className="text-center">
                            <p className="text-lg font-semibold text-foreground">{c?.delivered ?? "—"}</p>
                            <p>Entregados</p>
                          </div>
                          {(c?.failed ?? 0) > 0 && (
                            <div className="text-center">
                              <p className="text-lg font-semibold text-destructive">{c.failed}</p>
                              <p>Fallidos</p>
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
