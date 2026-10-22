"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, MessageSquare, Search, Phone, Clock } from "lucide-react";
import { db } from "@/lib/firebase";
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  getDocs,
  Timestamp,
} from "firebase/firestore";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import ConversationChat from "./ConversationChat";
import { useSemaphore } from "@/hooks/useSemaphore";

interface Conversation {
  id: string;
  customerPhone: string;
  customerName: string | null;
  status: "bot" | "waiting_agent" | "with_agent" | "closed";
  assignedAgentId: string | null;
  lastMessageAt: Timestamp;
  organizationId: string;
  teamId?: string;
  whatsappNumberId?: string;
  botBrand?: string;
  botCategory?: string;
  lastMessagePreview?: string;
  lastMessageSender?: "customer" | "bot" | "agent";
  channel?: "whatsapp" | "voice";
}

interface WhatsAppNumberInfo {
  id: string;
  phoneNumber: string;
  displayName: string;
}

interface ConverseViewProps {
  organizationId: string;
  teamId?: string;
  userId: string;
  userRole: string;
}

const statusColors = {
  bot: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  waiting_agent: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  with_agent: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  closed: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
};

const brandColors: Record<string, string> = {
  Honda: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  Nissan: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  Toyota: "bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-300",
};

const statusLabels = {
  bot: "Bot",
  waiting_agent: "Esperando",
  with_agent: "Con Agente",
  closed: "Cerrada",
};

export default function ConverseView({ organizationId, teamId, userId, userRole }: ConverseViewProps) {
  const { getColor: getSemaphoreColor } = useSemaphore(teamId);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [waNumbers, setWaNumbers] = useState<Record<string, WhatsAppNumberInfo>>({});
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "waiting_agent" | "with_agent" | "bot" | "closed">("all");

  useEffect(() => {
    if (!organizationId) return;

    const constraints: ReturnType<typeof where>[] = [
      where("organizationId", "==", organizationId),
    ];

    // Agent only sees their own conversations
    if (userRole === "agent") {
      constraints.push(where("assignedAgentId", "==", userId));
    }

    if (teamId) {
      constraints.push(where("teamId", "==", teamId));
    }

    const q = query(
      collection(db, "conversations"),
      ...constraints,
      orderBy("lastMessageAt", "desc")
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const convs: Conversation[] = [];
      snapshot.forEach((doc) => {
        convs.push({ id: doc.id, ...doc.data() } as Conversation);
      });
      setConversations(convs);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [organizationId, teamId, userId, userRole]);

  // Load WhatsApp numbers
  useEffect(() => {
    if (!organizationId) return;

    const loadWaNumbers = async () => {
      const q = query(
        collection(db, "whatsappNumbers"),
        where("organizationId", "==", organizationId)
      );
      const snap = await getDocs(q);
      const map: Record<string, WhatsAppNumberInfo> = {};
      snap.forEach((doc) => {
        const data = doc.data();
        map[doc.id] = {
          id: doc.id,
          phoneNumber: data.phoneNumber || "",
          displayName: data.displayName || "",
        };
      });
      setWaNumbers(map);
    };

    loadWaNumbers();
  }, [organizationId]);

  const formatTime = (timestamp: Timestamp) => {
    if (!timestamp) return "";
    const date = timestamp.toDate();
    return formatDistanceToNow(date, { addSuffix: true, locale: es });
  };

  const filteredConversations = conversations.filter((conv) => {
    // Status filter
    if (statusFilter === "all" && conv.status === "closed") return false;
    if (statusFilter !== "all" && conv.status !== statusFilter) return false;

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchesPhone = conv.customerPhone?.toLowerCase().includes(q);
      const matchesName = conv.customerName?.toLowerCase().includes(q);
      const waNum = conv.whatsappNumberId ? waNumbers[conv.whatsappNumberId] : null;
      const matchesWaName = waNum?.displayName?.toLowerCase().includes(q);
      const matchesBrand = conv.botBrand?.toLowerCase().includes(q);
      const matchesCategory = conv.botCategory?.toLowerCase().includes(q);
      if (!matchesPhone && !matchesName && !matchesWaName && !matchesBrand && !matchesCategory) return false;
    }

    return true;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="flex border rounded-lg overflow-hidden" style={{ height: "calc(100vh - 280px)", minHeight: "500px" }}>
      {/* Sidebar */}
      <div className="w-[350px] flex-shrink-0 border-r flex flex-col bg-background">
        {/* Search */}
        <div className="p-2 border-b">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
            <Input
              placeholder="Buscar..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 h-8 text-sm"
            />
          </div>
        </div>

        {/* Status tabs */}
        <div className="flex gap-1 p-1.5 border-b overflow-x-auto">
          {(["all", "waiting_agent", "with_agent", "bot", "closed"] as const).map((status) => (
            <Button
              key={status}
              variant={statusFilter === status ? "default" : "ghost"}
              size="sm"
              className="text-[11px] px-1.5 h-6 flex-shrink-0"
              onClick={() => setStatusFilter(status)}
            >
              {status === "all" ? "Todas" : statusLabels[status]}
            </Button>
          ))}
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">
          {filteredConversations.length === 0 ? (
            <div className="text-center py-8">
              <MessageSquare className="h-8 w-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-500">Sin conversaciones</p>
            </div>
          ) : (
            filteredConversations.map((conv) => (
              <div
                key={conv.id}
                className={`flex items-center gap-2 p-2.5 cursor-pointer border-b hover:bg-accent transition-colors ${
                  selectedId === conv.id ? "bg-primary/10 border-l-2 border-l-primary" : ""
                }`}
                onClick={() => setSelectedId(conv.id)}
              >
                <div className="relative flex-shrink-0">
                  <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
                    <span className="text-xs font-medium">
                      {conv.customerName?.[0] || conv.customerPhone?.slice(-2) || "?"}
                    </span>
                  </div>
                  {conv.channel === "voice" && (
                    <div className="absolute -bottom-0.5 -right-0.5 bg-purple-500 rounded-full p-0.5" title="Llamada de voz">
                      <Phone className="h-2.5 w-2.5 text-white" />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {conv.botBrand && (
                        <span className={`px-1 py-0 rounded text-[10px] font-medium flex-shrink-0 ${brandColors[conv.botBrand] || "bg-muted text-muted-foreground"}`}>
                          {conv.botBrand}
                        </span>
                      )}
                      <p className="font-medium text-sm truncate">
                        {conv.customerName || conv.customerPhone}
                      </p>
                    </div>
                    <Badge
                      className={`text-[10px] px-1.5 py-0 ml-2 flex-shrink-0 ${statusColors[conv.status]}`}
                      variant="secondary"
                    >
                      {statusLabels[conv.status]}
                    </Badge>
                  </div>
                  <p className="text-xs text-gray-500 truncate">
                    {conv.customerPhone}
                    {conv.botCategory && <span className="text-gray-400"> · {conv.botCategory}</span>}
                  </p>
                  {conv.lastMessagePreview && (
                    <p className="text-xs text-gray-400 truncate">
                      &ldquo;{conv.lastMessagePreview}&rdquo;
                    </p>
                  )}
                  <div className="flex items-center gap-1">
                    {(conv.status === "waiting_agent" || (conv.status === "with_agent" && conv.lastMessageSender === "customer")) && (() => {
                      const color = getSemaphoreColor(conv.lastMessageAt);
                      if (!color) return null;
                      const colorClass = color === "green" ? "text-green-500" : color === "yellow" ? "text-yellow-500" : "text-red-500";
                      return <Clock className={`h-3 w-3 flex-shrink-0 ${colorClass}`} />;
                    })()}
                    <p className="text-xs text-gray-400">{formatTime(conv.lastMessageAt)}</p>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Chat panel */}
      <div className="flex-1 flex flex-col bg-background">
        {selectedId ? (
          <div className="flex-1 p-3 overflow-hidden">
            <ConversationChat conversationId={selectedId} showBackButton={false} compact />
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <MessageSquare className="h-12 w-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500">Selecciona una conversacion</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
