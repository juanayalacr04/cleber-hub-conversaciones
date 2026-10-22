"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { conversationPath } from "@/lib/routes";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Bot, UserCircle, HelpCircle, Phone, Clock } from "lucide-react";
import { db } from "@/lib/firebase";
import {
  collection,
  query,
  where,
  onSnapshot,
  getDocs,
  Timestamp,
  QueryDocumentSnapshot,
  DocumentData
} from "firebase/firestore";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
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

interface Agent {
  id: string;
  name: string;
  email: string;
}

interface KanbanBoardProps {
  organizationId: string;
  teamId?: string;
}

interface Column {
  id: string;
  title: string;
  icon: React.ReactNode;
  conversations: Conversation[];
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

export default function KanbanBoard({ organizationId, teamId }: KanbanBoardProps) {
  const router = useRouter();
  const { module: moduleId } = useParams<{ module: string }>();
  const { getColor: getSemaphoreColor } = useSemaphore(teamId);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [agents, setAgents] = useState<Record<string, Agent>>({});
  const [waNumbers, setWaNumbers] = useState<Record<string, WhatsAppNumberInfo>>({});
  const [loading, setLoading] = useState(true);

  // Subscribe to conversations
  useEffect(() => {
    if (!organizationId) return;

    const constraints = [
      where("organizationId", "==", organizationId),
      where("status", "in", ["bot", "waiting_agent", "with_agent"]),
    ];

    if (teamId) {
      constraints.push(where("teamId", "==", teamId));
    }

    const q = query(collection(db, "conversations"), ...constraints);

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const convs: Conversation[] = [];
      snapshot.forEach((doc) => {
        convs.push({ id: doc.id, ...doc.data() } as Conversation);
      });
      // Sort by lastMessageAt desc
      convs.sort((a, b) => {
        const aTime = a.lastMessageAt?.toMillis?.() || 0;
        const bTime = b.lastMessageAt?.toMillis?.() || 0;
        return bTime - aTime;
      });
      setConversations(convs);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [organizationId, teamId]);

  // Subscribe to agents
 useEffect(() => {
    if (!organizationId) return;

    const usersRef = collection(db, "users");
    // q1: formato viejo (organizationId directo). q2: formato nuevo (organizationIds
    // array) — un agente multi-org puede tener otra org como organizationId
    // plano y solo aparecer en el array. Mismo patrón que ConversationChat.tsx.
    const q1 = query(usersRef, where("organizationId", "==", organizationId));
    const q2 = query(usersRef, where("organizationIds", "array-contains", organizationId));

    const toAgent = (d: QueryDocumentSnapshot<DocumentData>): Agent | null => {
      const data = d.data();
      if (data.role !== "admin" && data.role !== "agent") return null;
      return {
        id: d.id,
        name: data.name || data.email,
        email: data.email,
      };
    };

    let snap1Map = new Map<string, Agent>();
    let snap2Map = new Map<string, Agent>();
    const merge = () => {
      const merged = new Map<string, Agent>([...snap1Map, ...snap2Map]);
      setAgents(Object.fromEntries(merged));
    };

    const unsub1 = onSnapshot(q1, (snapshot) => {
      snap1Map = new Map();
      snapshot.forEach((d) => {
        const agent = toAgent(d);
        if (agent) snap1Map.set(d.id, agent);
      });
      merge();
    });

    const unsub2 = onSnapshot(q2, (snapshot) => {
      snap2Map = new Map();
      snapshot.forEach((d) => {
        const agent = toAgent(d);
        if (agent) snap2Map.set(d.id, agent);
      });
      merge();
    });

    return () => {
      unsub1();
      unsub2();
    };
  }, [organizationId]);

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

  // Build columns
  const buildColumns = (): Column[] => {
    const botConvs = conversations.filter((c) => c.status === "bot");
    const unassigned = conversations.filter(
      (c) => c.status === "waiting_agent" && !c.assignedAgentId
    );

    // Group by assigned agent
    const agentGroups: Record<string, Conversation[]> = {};
    conversations.forEach((c) => {
      if (c.assignedAgentId) {
        if (!agentGroups[c.assignedAgentId]) {
          agentGroups[c.assignedAgentId] = [];
        }
        agentGroups[c.assignedAgentId].push(c);
      }
    });

    const columns: Column[] = [];

    // Unassigned column
    if (unassigned.length > 0) {
      columns.push({
        id: "unassigned",
        title: "Sin asignar",
        icon: <HelpCircle className="h-4 w-4" />,
        conversations: unassigned,
      });
    }

    // Agent columns
    Object.entries(agentGroups).forEach(([agentId, convs]) => {
      const agent = agents[agentId];
      columns.push({
        id: agentId,
        title: agent?.name || "Agente desconocido",
        icon: <UserCircle className="h-4 w-4" />,
        conversations: convs,
      });
    });

    // Bot column
    if (botConvs.length > 0) {
      columns.push({
        id: "bot",
        title: "Bot",
        icon: <Bot className="h-4 w-4" />,
        conversations: botConvs,
      });
    }

    return columns;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  const columns = buildColumns();

  if (columns.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">No hay conversaciones activas</p>
      </div>
    );
  }

  return (
    <div className="flex gap-4 overflow-x-auto pb-4" style={{ minHeight: "calc(100vh - 280px)" }}>
      {columns.map((col) => (
        <div
          key={col.id}
          className="flex-shrink-0 w-80 bg-muted/50 rounded-lg p-3"
        >
          {/* Column header */}
          <div className="flex items-center gap-2 mb-3 px-1">
            {col.icon}
            <h3 className="font-medium text-sm">{col.title}</h3>
            <Badge variant="secondary" className="ml-auto">
              {col.conversations.length}
            </Badge>
          </div>

          {/* Cards */}
          <div className="space-y-2">
            {col.conversations.map((conv) => (
              <Card
                key={conv.id}
                className="cursor-pointer hover:bg-accent transition-colors"
                onClick={() => router.push(conversationPath(conv.id, moduleId))}
              >
                <CardContent className="p-3">
                  <div className="flex items-center justify-between mb-1">
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
                      className={`text-[10px] px-1.5 py-0 ml-1 flex-shrink-0 ${statusColors[conv.status]}`}
                      variant="secondary"
                    >
                      {statusLabels[conv.status]}
                    </Badge>
                  </div>
                  <p className="text-xs text-gray-500 flex items-center gap-1">
                    {conv.channel === "voice" && <Phone className="h-3 w-3 text-purple-500 flex-shrink-0" />}
                    {conv.customerPhone}
                    {conv.botCategory && <span className="text-gray-400"> · {conv.botCategory}</span>}
                  </p>
                  {conv.lastMessagePreview && (
                    <p className="text-xs text-gray-400 truncate mt-0.5">
                      &ldquo;{conv.lastMessagePreview}&rdquo;
                    </p>
                  )}
                  <div className="flex items-center gap-1 mt-1">
                    {(conv.status === "waiting_agent" || (conv.status === "with_agent" && conv.lastMessageSender === "customer")) && (() => {
                      const color = getSemaphoreColor(conv.lastMessageAt);
                      if (!color) return null;
                      const colorClass = color === "green" ? "text-green-500" : color === "yellow" ? "text-yellow-500" : "text-red-500";
                      return <Clock className={`h-3 w-3 flex-shrink-0 ${colorClass}`} />;
                    })()}
                    <p className="text-xs text-gray-400">
                      {formatTime(conv.lastMessageAt)}
                    </p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
