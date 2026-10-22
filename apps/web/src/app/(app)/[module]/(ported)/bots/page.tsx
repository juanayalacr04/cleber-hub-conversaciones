"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Bot, MoreVertical, Loader2, Phone, MessageSquare } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { db } from "@/lib/firebase";
import {
  collection,
  query,
  where,
  onSnapshot,
  doc,
} from "firebase/firestore";
import { useAuth } from "@/contexts/AuthContext";
import { callHubAction } from "@/lib/hub-actions";
import { getModule } from "@/lib/modules";
import { modulePath } from "@/lib/routes";

interface BotData {
  id: string;
  name: string;
  description: string;
  status: "active" | "paused" | "draft";
  organizationId: string;
  vertical?: string;
  category?: string | null;
  twilioConfig: {
    phoneNumber: string;
    accountSid: string;
    authToken: string;
  };
  abacusConfig: {
    apiUrl: string;
    deploymentId: string;
    deploymentToken: string;
  };
  handoffConfig: {
    enabled: boolean;
    triggerKeywords: string[];
  };
}

/** Vertical efectiva de un bot: `vertical` y, de respaldo, `category`. Sin ninguna, solo se ve en `general`. */
function botVertical(bot: { vertical?: string; category?: string | null }): string | null {
  if (bot.vertical === "servicio" || bot.vertical === "ventas") return bot.vertical;
  const cat = (bot.category || "").toLowerCase();
  return cat === "servicio" || cat === "ventas" ? cat : null;
}

export default function BotsPage() {
  const { module: moduleId } = useParams<{ module: string }>();
  const vertical = getModule(moduleId)?.vertical ?? null;
  const { userData, user } = useAuth();
  const [bots, setBots] = useState<BotData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userData?.organizationId) {
      setLoading(false);
      return;
    }

    const botsRef = collection(db, "bots");
    const q = query(
      botsRef,
      where("organizationId", "==", userData.organizationId)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const botsData: BotData[] = [];
        snapshot.forEach((doc) => {
          botsData.push({ id: doc.id, ...doc.data() } as BotData);
        });
        setBots(botsData);
        setLoading(false);
      },
      (error) => {
        console.error("Error fetching bots:", error);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [userData?.organizationId]);

  const toggleBotStatus = async (botId: string, currentStatus: string) => {
    const newStatus = currentStatus === "active" ? "paused" : "active";
    try {
      await callHubAction(user, "bot.update", { id: botId, set: { status: newStatus } });
    } catch (error) {
      console.error("Error updating bot status:", error);
      alert(error instanceof Error ? error.message : "Error al cambiar el estado del bot");
    }
  };

  const formatPhoneNumber = (phone: string) => {
    // Formato: whatsapp:+528120854452 -> +52 812 085 4452
    const cleaned = phone.replace("whatsapp:", "");
    return cleaned;
  };

  const visibleBots = vertical ? bots.filter((b) => botVertical(b) === vertical) : bots;

  if (!userData?.organizationId) {
    return (
      <div>
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold">Bots</h1>
            <p className="text-gray-500">Gestiona tus chatbots de WhatsApp</p>
          </div>
        </div>
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-gray-500">
              Necesitas pertenecer a una organizacion para ver bots.
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

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Bots</h1>
          <p className="text-gray-500">Gestiona tus chatbots de WhatsApp</p>
        </div>
        <Link href={modulePath(moduleId, "/bots/new")}>
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            Crear Bot
          </Button>
        </Link>
      </div>

      {visibleBots.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="rounded-full bg-gray-100 p-4 mb-4">
              <Bot className="h-8 w-8 text-gray-400" />
            </div>
            <h3 className="text-lg font-medium mb-2">No tienes bots</h3>
            <p className="text-gray-500 text-center mb-4">
              Crea tu primer bot para empezar a responder mensajes de WhatsApp
              automaticamente.
            </p>
            <Link href={modulePath(moduleId, "/bots/new")}>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Crear Bot
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {visibleBots.map((bot) => (
            <Card key={bot.id} className="relative">
              <CardHeader className="flex flex-row items-start justify-between pb-2">
                <div className="flex items-start gap-3">
                  <div className="rounded-lg bg-blue-100 p-2">
                    <Bot className="h-5 w-5 text-blue-600" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">{bot.name}</CardTitle>
                    <CardDescription className="mt-1">
                      {bot.description}
                    </CardDescription>
                  </div>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem asChild>
                      <Link href={modulePath(moduleId, `/bots/${bot.id}`)}>Editar</Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => toggleBotStatus(bot.id, bot.status)}
                    >
                      {bot.status === "active" ? "Pausar" : "Activar"}
                    </DropdownMenuItem>
                    <DropdownMenuItem className="text-red-600">
                      Eliminar
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="space-y-3">
                  {/* Phone Number */}
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <Phone className="h-4 w-4" />
                    <span>{formatPhoneNumber(bot.twilioConfig?.phoneNumber || "")}</span>
                  </div>

                  {/* Handoff Status */}
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <MessageSquare className="h-4 w-4" />
                    <span>
                      Handoff:{" "}
                      {bot.handoffConfig?.enabled ? "Habilitado" : "Deshabilitado"}
                    </span>
                  </div>

                  {/* Status Badge */}
                  <div className="flex items-center justify-between pt-2 border-t">
                    <span className="text-xs text-gray-500">Estado</span>
                    <Badge
                      variant={bot.status === "active" ? "default" : "secondary"}
                      className={
                        bot.status === "active"
                          ? "bg-green-100 text-green-800 hover:bg-green-100"
                          : ""
                      }
                    >
                      {bot.status === "active"
                        ? "Activo"
                        : bot.status === "paused"
                        ? "Pausado"
                        : "Borrador"}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
