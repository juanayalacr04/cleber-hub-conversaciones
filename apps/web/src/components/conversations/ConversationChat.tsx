"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { modulePath } from "@/lib/routes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  Phone,
  Bot,
  User,
  UserCircle,
  RotateCcw,
  XCircle,
  RefreshCw,
  UserPlus,
  FileText,
  StickyNote,
  ArrowRightLeft,
  Pencil,
  Check,
  X,
  History,
  Tag,
  Paperclip,
  FileIcon,
  CalendarCheck,
  Clock,
  ChevronDown,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { db, storage } from "@/lib/firebase";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import {
  doc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  updateDoc,
  addDoc,
  getDocs,
  limit,
  serverTimestamp,
  deleteField,
  Timestamp,
  arrayUnion,
  arrayRemove,
  QueryDocumentSnapshot,
  DocumentData,
} from "firebase/firestore";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import LeadsPanel from "@/components/conversations/LeadsPanel";
import AccountsPanel from "@/components/conversations/AccountsPanel";
import VehiclesPanel from "@/components/conversations/VehiclesPanel";
import { ConversationOutcome, OUTCOME_LABELS, OUTCOME_COLORS } from "@/lib/conversation-outcomes";

const LABEL_COLORS: Record<string, { bg: string; text: string }> = {
  red:    { bg: "bg-red-100 dark:bg-red-900/30",       text: "text-red-800 dark:text-red-300" },
  orange: { bg: "bg-orange-100 dark:bg-orange-900/30", text: "text-orange-800 dark:text-orange-300" },
  yellow: { bg: "bg-yellow-100 dark:bg-yellow-900/30", text: "text-yellow-800 dark:text-yellow-300" },
  green:  { bg: "bg-green-100 dark:bg-green-900/30",   text: "text-green-800 dark:text-green-300" },
  blue:   { bg: "bg-blue-100 dark:bg-blue-900/30",     text: "text-blue-800 dark:text-blue-300" },
  purple: { bg: "bg-purple-100 dark:bg-purple-900/30", text: "text-purple-800 dark:text-purple-300" },
  pink:   { bg: "bg-pink-100 dark:bg-pink-900/30",     text: "text-pink-800 dark:text-pink-300" },
  gray:   { bg: "bg-gray-100 dark:bg-gray-800",        text: "text-gray-700 dark:text-gray-300" },
};

interface ConversationLabel {
  id: string;
  name: string;
  color: string;
}

interface Conversation {
  id: string;
  customerPhone: string;
  customerName: string | null;
  status: "bot" | "waiting_agent" | "with_agent" | "closed";
  botId: string;
  organizationId: string;
  assignedAgentId: string | null;
  lastMessageAt: Timestamp;
  closedReason?: string | null;
  whatsappNumberId?: string | null;
  teamId?: string | null;
  labelIds?: string[];
  appointmentStatus?: "sin_cita" | "cita_bot" | "cita_agente";
  aiOutcome?: "interes_cita" | "otro_motivo" | null;
  conversationOutcome?: ConversationOutcome | null;
  conversationOutcomeHistory?: { outcome: ConversationOutcome; at: Timestamp }[];
  lastCustomerMessageAt?: Timestamp | null;
}

interface Agent {
  id: string;
  name: string;
  email: string;
  role: string;
  isAvailable: boolean;
}

interface Template {
  id: string;
  name: string;
  content: string;
  category: string;
}

interface Note {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  createdAt: Timestamp;
}

interface Team {
  id: string;
  name: string;
}

interface Message {
  id: string;
  conversationId: string;
  sender: "customer" | "bot" | "agent";
  agentId: string | null;
  text: string;
  mediaUrl: string | null;
  createdAt: Timestamp;
}

interface ConversationChatProps {
  conversationId: string;
  showBackButton?: boolean;
  compact?: boolean;
}

export default function ConversationChat({ conversationId, showBackButton = true, compact = false }: ConversationChatProps) {
  const { user, userData } = useAuth();
  const { module: moduleId } = useParams<{ module: string }>();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [newMessage, setNewMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [returningToBot, setReturningToBot] = useState(false);
  const [closing, setClosing] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [assigning, setAssigning] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateSheetOpen, setTemplateSheetOpen] = useState(false);
  const [cannedIndex, setCannedIndex] = useState(0);
  const [activeView, setActiveView] = useState<"messages" | "notes" | "leads" | "accounts" | "vehicles" | "history">("messages");
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [teams, setTeams] = useState<Team[]>([]);
  const [transferring, setTransferring] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState("");
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [closeReason, setCloseReason] = useState<string>("");
  const [pastConversations, setPastConversations] = useState<{ id: string; lastMessageAt: Timestamp | null; closedReason: string | null; lastMessagePreview: string | null; botName: string | null }[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [teamLabels, setTeamLabels] = useState<ConversationLabel[]>([]);
  const [labelDropdownOpen, setLabelDropdownOpen] = useState(false);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load labels for conversation's team
  useEffect(() => {
    if (!conversation?.teamId || !userData?.organizationId) {
      setTeamLabels([]);
      return;
    }
    const q = query(
      collection(db, "labels"),
      where("teamId", "==", conversation.teamId),
      where("organizationId", "==", userData.organizationId)
    );
    const unsub = onSnapshot(q, (snap) => {
      const data: ConversationLabel[] = [];
      snap.forEach((d) => data.push({ id: d.id, ...d.data() } as ConversationLabel));
      setTeamLabels(data);
    });
    return unsub;
  }, [conversation?.teamId, userData?.organizationId]);

  const handleToggleLabel = async (labelId: string) => {
    if (!conversation) return;
    const hasLabel = conversation.labelIds?.includes(labelId);
    await updateDoc(doc(db, "conversations", conversation.id), {
      labelIds: hasLabel ? arrayRemove(labelId) : arrayUnion(labelId),
    });
  };

  const statusLabels = {
    bot: "Con Bot",
    waiting_agent: "Esperando Agente",
    with_agent: "Con Agente",
    closed: "Cerrada",
  };

  const statusColors = {
    bot: "bg-blue-100 text-blue-800",
    waiting_agent: "bg-yellow-100 text-yellow-800",
    with_agent: "bg-green-100 text-green-800",
    closed: "bg-gray-100 text-gray-800",
  };

  useEffect(() => {
    if (!conversationId) return;

    setLoading(true);
    setConversation(null);
    setMessages([]);

    const convUnsub = onSnapshot(
      doc(db, "conversations", conversationId),
      (convDoc) => {
        if (convDoc.exists()) {
          setConversation({ id: convDoc.id, ...convDoc.data() } as Conversation);
        }
        setLoading(false);
      }
    );

    const messagesRef = collection(db, "conversations", conversationId, "messages");
    const q = query(messagesRef, orderBy("createdAt", "asc"));

    const msgsUnsub = onSnapshot(q, (snapshot) => {
      const msgs: Message[] = [];
      snapshot.forEach((doc) => {
        msgs.push({ id: doc.id, ...doc.data() } as Message);
      });
      setMessages(msgs);
    });

    return () => {
      convUnsub();
      msgsUnsub();
    };
  }, [conversationId]);

  useEffect(() => {
    if (!conversation?.organizationId) return;

    const orgId = conversation.organizationId;
    const usersRef = collection(db, "users");
    // q1: formato viejo (organizationId directo). q2: formato nuevo (organizationIds
    // array) — un agente multi-org puede tener otra org como organizationId
    // plano y solo aparecer en el array. Mismo patrón que team/page.tsx.
    const q1 = query(usersRef, where("organizationId", "==", orgId));
    const q2 = query(usersRef, where("organizationIds", "array-contains", orgId));

    const toAgent = (d: QueryDocumentSnapshot<DocumentData>): Agent | null => {
      const data = d.data();
      if (data.role !== "admin" && data.role !== "agent") return null;
      return {
        id: d.id,
        name: data.name || data.email,
        email: data.email,
        role: data.role,
        isAvailable: data.isAvailable ?? true,
      };
    };

    let snap1Map = new Map<string, Agent>();
    let snap2Map = new Map<string, Agent>();
    const merge = () => {
      const merged = new Map<string, Agent>([...snap1Map, ...snap2Map]);
      setAgents(Array.from(merged.values()));
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
  }, [conversation?.organizationId]);

  useEffect(() => {
    if (!conversation?.organizationId) return;

    const q = query(
      collection(db, "templates"),
      where("organizationId", "==", conversation.organizationId)
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const tmps: Template[] = [];
      snapshot.forEach((d) => tmps.push({ id: d.id, ...d.data() } as Template));
      setTemplates(tmps);
    });
    return () => unsubscribe();
  }, [conversation?.organizationId]);

  useEffect(() => {
    if (!conversationId) return;

    const notesRef = collection(db, "conversations", conversationId, "notes");
    const q = query(notesRef, orderBy("createdAt", "asc"));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const n: Note[] = [];
      snapshot.forEach((d) => n.push({ id: d.id, ...d.data() } as Note));
      setNotes(n);
    });
    return () => unsubscribe();
  }, [conversationId]);

  useEffect(() => {
    if (!conversation?.organizationId) return;

    const q = query(
      collection(db, "teams"),
      where("organizationId", "==", conversation.organizationId)
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const t: Team[] = [];
      snapshot.forEach((d) => t.push({ id: d.id, ...d.data() } as Team));
      setTeams(t);
    });
    return () => unsubscribe();
  }, [conversation?.organizationId]);

  // Load past closed conversations for same phone (lazy, on tab click)
  useEffect(() => {
    if (activeView !== "history" || historyLoaded || !conversation?.customerPhone) return;

    setLoadingHistory(true);
    const q = query(
      collection(db, "conversations"),
      where("customerPhone", "==", conversation.customerPhone),
      where("status", "==", "closed"),
      orderBy("lastMessageAt", "desc"),
      limit(20)
    );
    getDocs(q).then((snapshot) => {
      const convs: typeof pastConversations = [];
      snapshot.forEach((d) => {
        if (d.id === conversationId) return; // exclude current
        const data = d.data();
        convs.push({
          id: d.id,
          lastMessageAt: data.lastMessageAt || null,
          closedReason: data.closedReason || null,
          lastMessagePreview: data.lastMessagePreview || null,
          botName: data.botName || null,
        });
      });
      setPastConversations(convs);
      setHistoryLoaded(true);
    }).catch((err) => {
      console.error("Error loading past conversations:", err);
    }).finally(() => {
      setLoadingHistory(false);
    });
  }, [activeView, historyLoaded, conversation?.customerPhone, conversationId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const formatMessageTime = (timestamp: Timestamp) => {
    if (!timestamp) return "";
    const date = timestamp.toDate();
    return format(date, "HH:mm", { locale: es });
  };

  const formatMessageDate = (timestamp: Timestamp) => {
    if (!timestamp) return "";
    const date = timestamp.toDate();
    return format(date, "d 'de' MMMM, yyyy", { locale: es });
  };

  const getSenderIcon = (sender: string) => {
    switch (sender) {
      case "customer":
        return <User className="h-4 w-4" />;
      case "bot":
        return <Bot className="h-4 w-4" />;
      case "agent":
        return <UserCircle className="h-4 w-4" />;
      default:
        return <User className="h-4 w-4" />;
    }
  };

  const getSenderLabel = (sender: string) => {
    switch (sender) {
      case "customer":
        return "Cliente";
      case "bot":
        return "Bot";
      case "agent":
        return "Agente";
      default:
        return sender;
    }
  };

  const groupedMessages: { date: string; messages: Message[] }[] = [];
  let currentDate = "";

  messages.forEach((msg) => {
    const msgDate = msg.createdAt
      ? formatMessageDate(msg.createdAt)
      : "Sin fecha";

    if (msgDate !== currentDate) {
      currentDate = msgDate;
      groupedMessages.push({ date: msgDate, messages: [msg] });
    } else {
      groupedMessages[groupedMessages.length - 1].messages.push(msg);
    }
  });

  const canSendMessage =
    conversation?.status === "with_agent" &&
    (conversation.assignedAgentId === user?.uid || userData?.role === "admin");

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingFile(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleSendMessage = async () => {
    if ((!newMessage.trim() && !pendingFile) || !user || !conversation || sending) return;

    setSending(true);
    try {
      let mediaUrl: string | undefined;

      if (pendingFile) {
        setUploadingMedia(true);
        const storageRef = ref(storage, `conversations/${conversationId}/${Date.now()}-${pendingFile.name}`);
        const uploadPromise = uploadBytes(storageRef, pendingFile);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Upload timeout — verifica que Firebase Storage esté activado y las reglas permitan escritura")), 15000)
        );
        await Promise.race([uploadPromise, timeoutPromise]);
        mediaUrl = await getDownloadURL(storageRef);
        setUploadingMedia(false);
        setPendingFile(null);
      }

      const token = await user.getIdToken();
      const response = await fetch("/api/send-message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          conversationId,
          text: newMessage.trim(),
          agentId: user.uid,
          ...(mediaUrl && { mediaUrl }),
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to send message");
      }

      setNewMessage("");
    } catch (error) {
      console.error("Error sending message:", error);
      const msg = error instanceof Error ? error.message : "Error al enviar mensaje";
      alert(msg);
      setUploadingMedia(false);
    } finally {
      setSending(false);
    }
  };

  const handleTakeConversation = async () => {
    if (!user || !conversation) return;

    try {
      await updateDoc(doc(db, "conversations", conversationId), {
        status: "with_agent",
        assignedAgentId: user.uid,
        assignedAt: new Date(),
        waitingStartedAt: conversation.lastMessageAt,
      });
    } catch (error) {
      console.error("Error taking conversation:", error);
      alert("Error al tomar conversacion");
    }
  };

  const handleAssignAgent = async (agentId: string) => {
    if (!conversation || assigning) return;

    setAssigning(true);
    try {
      await updateDoc(doc(db, "conversations", conversationId), {
        status: "with_agent",
        assignedAgentId: agentId,
        assignedAt: new Date(),
      });
    } catch (error) {
      console.error("Error assigning agent:", error);
      alert("Error al asignar agente");
    } finally {
      setAssigning(false);
    }
  };

  const handleMarkAppointment = async () => {
    if (!conversation) return;
    const next = conversation.appointmentStatus === "cita_agente" ? "sin_cita" : "cita_agente";
    try {
      const updates: Record<string, unknown> = { appointmentStatus: next };
      if (next === "cita_agente") {
        updates.appointmentDate = serverTimestamp();
        updates.conversationOutcome = "cita_agente_bdc";
        updates.conversationOutcomeAt = serverTimestamp();
        updates.conversationOutcomeHistory = arrayUnion({ outcome: "cita_agente_bdc", at: Timestamp.now() });
      } else {
        updates.appointmentDate = deleteField();
        // Al desmarcar, rompe el candado de estado terminal a propósito: vuelve
        // a la última clasificación del bot (o null si nunca hubo una).
        const reverted = conversation.aiOutcome ?? null;
        updates.conversationOutcome = reverted;
        updates.conversationOutcomeAt = serverTimestamp();
        if (reverted) {
          updates.conversationOutcomeHistory = arrayUnion({ outcome: reverted, at: Timestamp.now() });
        }
      }
      await updateDoc(doc(db, "conversations", conversationId), updates);
    } catch (error) {
      console.error("Error updating appointment status:", error);
    }
  };

  const handleReturnToBot = async () => {
    if (!conversation || returningToBot) return;

    setReturningToBot(true);
    try {
      await updateDoc(doc(db, "conversations", conversationId), {
        status: "bot",
        assignedAgentId: null,
        assignedAt: null,
        waitingStartedAt: null,
        firstAgentResponseAt: null,
        responseTimeSecs: null,
        // responseTimes array is kept for historical record
      });
    } catch (error) {
      console.error("Error returning to bot:", error);
      alert("Error al devolver a bot");
    } finally {
      setReturningToBot(false);
    }
  };

  const handleCloseConversation = async () => {
    if (!conversation || !user || closing || !closeReason) return;

    setClosing(true);
    try {
      const closeToken = await user.getIdToken();
      // La despedida solo se manda dentro de la ventana de 24 h de WhatsApp: fuera de ella el proveedor la rechaza
      const lastCustMsg = conversation.lastCustomerMessageAt;
      const withinWhatsApp24h = lastCustMsg && (Date.now() - lastCustMsg.toMillis()) < 24 * 60 * 60 * 1000;
      if (withinWhatsApp24h) {
        await fetch("/api/send-message", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${closeToken}`,
          },
          body: JSON.stringify({
            conversationId,
            text: "Esta conversacion ha sido cerrada. Si necesitas ayuda nuevamente, no dudes en escribirnos. ¡Gracias!",
            agentId: user.uid,
          }),
        });
      }

      await updateDoc(doc(db, "conversations", conversationId), {
        status: "closed",
        assignedAgentId: null,
        assignedAt: null,
        waitingStartedAt: null,
        firstAgentResponseAt: null,
        responseTimeSecs: null,
        // responseTimes array is kept for historical record
        closedAt: new Date(),
        closedReason: closeReason,
        manualClose: true,
      });

      // Fire close webhook if configured
      fetch("/api/conversations/close-webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${closeToken}`,
        },
        body: JSON.stringify({
          conversationId,
          closedBy: "agent",
        }),
      }).catch((err) => console.error("Error firing close webhook:", err));

      setCloseDialogOpen(false);
      setCloseReason("");
    } catch (error) {
      console.error("Error closing conversation:", error);
      alert("Error al cerrar la conversacion");
    } finally {
      setClosing(false);
    }
  };

  const handleReopenConversation = async () => {
    if (!conversation || reopening) return;

    setReopening(true);
    try {
      await updateDoc(doc(db, "conversations", conversationId), {
        status: "bot",
        assignedAgentId: null,
        assignedAt: null,
        closedAt: null,
      });
    } catch (error) {
      console.error("Error reopening conversation:", error);
      alert("Error al reabrir la conversacion");
    } finally {
      setReopening(false);
    }
  };

  const handleAddNote = async () => {
    if (!newNote.trim() || !user || addingNote) return;

    setAddingNote(true);
    try {
      const notesRef = collection(db, "conversations", conversationId, "notes");
      await addDoc(notesRef, {
        authorId: user.uid,
        authorName: userData?.name || user.email || "Agente",
        text: newNote.trim(),
        createdAt: serverTimestamp(),
      });
      setNewNote("");
    } catch (error) {
      console.error("Error adding note:", error);
    } finally {
      setAddingNote(false);
    }
  };

  const handleSaveName = async () => {
    if (!conversation) return;
    const trimmed = editNameValue.trim();
    try {
      await updateDoc(doc(db, "conversations", conversationId), {
        customerName: trimmed || null,
      });
      setEditingName(false);
    } catch (error) {
      console.error("Error saving name:", error);
    }
  };

  const handleTransferTeam = async (teamId: string) => {
    if (!conversation || transferring) return;

    setTransferring(true);
    try {
      await updateDoc(doc(db, "conversations", conversationId), {
        teamId,
        status: "waiting_agent",
        assignedAgentId: null,
        assignedAt: null,
      });
    } catch (error) {
      console.error("Error transferring team:", error);
      alert("Error al transferir equipo");
    } finally {
      setTransferring(false);
    }
  };

  const cannedFilter = newMessage.startsWith("/") ? newMessage.slice(1).toLowerCase() : null;
  const filteredTemplates = cannedFilter !== null
    ? templates.filter(
        (t) =>
          t.name.toLowerCase().includes(cannedFilter) ||
          t.content.toLowerCase().includes(cannedFilter)
      )
    : [];
  const showCannedMenu = cannedFilter !== null && filteredTemplates.length > 0;

  const selectCannedTemplate = (template: Template) => {
    setNewMessage(template.content);
    setCannedIndex(0);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (showCannedMenu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCannedIndex((prev) => (prev + 1) % filteredTemplates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCannedIndex((prev) => (prev - 1 + filteredTemplates.length) % filteredTemplates.length);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        selectCannedTemplate(filteredTemplates[cannedIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setNewMessage("");
        setCannedIndex(0);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!conversation) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Conversacion no encontrada</p>
        <Link href={modulePath(moduleId, "/conversaciones")}>
          <Button variant="link">Volver a Conversaciones</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className={cn("flex flex-col gap-2 pb-3 border-b", !compact && "md:pb-4")}>
        <div className={cn("flex items-center gap-2", !compact && "md:gap-4")}>
          {showBackButton && (
            <Link href={modulePath(moduleId, "/conversaciones")}>
              <Button variant="ghost" size="icon" className="flex-shrink-0">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              {editingName ? (
                <div className="flex items-center gap-1">
                  <Input
                    value={editNameValue}
                    onChange={(e) => setEditNameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSaveName();
                      if (e.key === "Escape") setEditingName(false);
                    }}
                    className={cn("h-8 w-32", !compact && "md:w-48")}
                    placeholder="Nombre del cliente"
                    autoFocus
                  />
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleSaveName}>
                    <Check className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditingName(false)}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-1 group">
                  <h1 className={cn("text-base font-bold truncate", !compact && "md:text-xl")}>
                    {conversation.customerName || conversation.customerPhone}
                  </h1>
                  <button
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1"
                    onClick={() => {
                      setEditNameValue(conversation.customerName || "");
                      setEditingName(true);
                    }}
                    title="Editar nombre"
                  >
                    <Pencil className="h-3.5 w-3.5 text-gray-400" />
                  </button>
                </div>
              )}
              <Badge
                className={statusColors[conversation.status]}
                variant="secondary"
              >
                {statusLabels[conversation.status]}
                {conversation.status === "closed" && conversation.closedReason && (
                  <span> · {
                    conversation.closedReason === "resolved" ? "Resuelto" :
                    conversation.closedReason === "not_interested" ? "No interesado" :
                    conversation.closedReason === "duplicate" ? "Duplicado" :
                    conversation.closedReason === "no_response" ? "Sin respuesta" :
                    conversation.closedReason === "inactivity" ? "Inactividad" :
                    conversation.closedReason
                  }</span>
                )}
              </Badge>
              {conversation.conversationOutcome && (
                <Dialog>
                  <DialogTrigger asChild>
                    <button
                      className={cn(
                        "px-2 py-0.5 rounded-full text-[10px] font-medium whitespace-nowrap flex items-center gap-1 border border-dashed border-current/40 hover:opacity-80 hover:border-current transition-all",
                        OUTCOME_COLORS[conversation.conversationOutcome]
                      )}
                      title="Ver cuándo se asignó cada etiqueta"
                    >
                      <Clock className="h-3 w-3" />
                      {OUTCOME_LABELS[conversation.conversationOutcome]}
                      <ChevronDown className="h-3 w-3" />
                    </button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Etiquetas de la conversación</DialogTitle>
                      <DialogDescription>Cuándo se asignó cada etiqueta, de la más reciente a la más antigua.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3">
                      {(conversation.conversationOutcomeHistory ?? []).length === 0 ? (
                        <p className="text-sm text-muted-foreground">Sin historial disponible.</p>
                      ) : (
                        [...conversation.conversationOutcomeHistory!].reverse().map((entry, i) => {
                          const date = entry.at?.toDate();
                          return (
                            <div key={i} className="flex items-center justify-between gap-2">
                              <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium", OUTCOME_COLORS[entry.outcome])}>
                                {OUTCOME_LABELS[entry.outcome]}
                              </span>
                              <span className="text-xs text-muted-foreground whitespace-nowrap text-right">
                                {date ? (
                                  <>
                                    {date.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" })}
                                    {" · "}
                                    {date.toLocaleTimeString("es-MX", { hour: "numeric", minute: "2-digit", hour12: true })}
                                  </>
                                ) : ""}
                              </span>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </DialogContent>
                </Dialog>
              )}
            </div>
            <div className={cn("flex items-center gap-2 text-xs text-gray-500", !compact && "md:text-sm")}>
              <Phone className="h-3 w-3" />
              <span className="truncate">{conversation.customerPhone}</span>
            </div>
          </div>
        </div>
        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-wrap overflow-x-auto">
          {conversation.status !== "closed" &&
            agents.length > 0 &&
            // Solo un admin puede tomar/asignar/reasignar conversaciones — el Agente
            // BDC ya asignado no puede reasignarla ni transferirla a otro compañero.
            userData?.role === "admin" && (
              <div className="flex items-center gap-2">
                <UserPlus className="h-4 w-4 text-gray-500" />
                <Select
                  value={conversation.assignedAgentId || ""}
                  onValueChange={handleAssignAgent}
                  disabled={assigning}
                >
                  <SelectTrigger className={cn("w-[140px]", !compact && "md:w-[200px]")}>
                    <SelectValue placeholder="Asignar agente..." />
                  </SelectTrigger>
                  <SelectContent>
                    {agents
                      .filter((agent) => agent.isAvailable || agent.id === conversation.assignedAgentId)
                      .map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          {conversation.status !== "closed" && teams.length > 0 && userData?.role === "admin" && (
            <Select
              value=""
              onValueChange={handleTransferTeam}
              disabled={transferring}
            >
              <SelectTrigger
                className={cn(compact ? "w-9 px-2 justify-center" : "w-[140px]", !compact && "md:w-[180px]")}
                title="Transferir equipo">
                <div className="flex items-center gap-2">
                  <ArrowRightLeft className="h-3 w-3" />
                  <span className={cn("hidden", !compact && "md:inline")}>Transferir equipo</span>
                  <span className={cn(compact && "hidden", !compact && "md:hidden")}>Transferir</span>
                </div>
              </SelectTrigger>
              <SelectContent>
                {teams.map((team) => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {conversation.status === "waiting_agent" && userData?.role === "admin" && (
            <Button onClick={handleTakeConversation}>
              Tomar conversacion
            </Button>
          )}
          {conversation.status === "with_agent" &&
            // Ya asignada: solo el agente dueño o un admin pueden editarla (Firestore
            // rules rechaza el write de cualquier otro agente).
            (conversation.assignedAgentId === user?.uid || userData?.role === "admin") && (
            <>
              <Button
                variant={conversation.appointmentStatus === "cita_agente" ? "default" : "outline"}
                onClick={handleMarkAppointment}
                title={conversation.appointmentStatus === "cita_agente" ? "Quitar cita con agente" : "Marcar cita con agente"}
                className={conversation.appointmentStatus === "cita_agente" ? "bg-teal-600 hover:bg-teal-700 text-white" : ""}
              >
                <CalendarCheck className="mr-2 h-4 w-4" />
                <span>
                  {conversation.appointmentStatus === "cita_agente" ? "Cita Agendada" : "Marcar Cita"}
                </span>
              </Button>
              <Button
                variant="outline"
                onClick={handleReturnToBot}
                disabled={returningToBot}
              >
                {returningToBot ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="mr-2 h-4 w-4" />
                )}
                <span className={cn("hidden", !compact && "md:inline")}>Devolver a Bot</span>
                <span className={cn(!compact && "md:hidden")}>Bot</span>
              </Button>
              <Button
                variant="outline"
                onClick={() => { setCloseReason(""); setCloseDialogOpen(true); }}
                className="text-red-600 hover:text-red-700"
              >
                <XCircle className="mr-2 h-4 w-4" />
                Cerrar
              </Button>
            </>
          )}
          {conversation.status === "closed" && (
            <Button
              variant="outline"
              onClick={handleReopenConversation}
              disabled={reopening}
            >
              {reopening ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Reabrir
            </Button>
          )}
        </div>
      </div>

      {/* Labels row */}
      {teamLabels.length > 0 && (
        <div className="flex items-center gap-2 py-2 flex-wrap">
          {(conversation?.labelIds || []).map((lid) => {
            const label = teamLabels.find((l) => l.id === lid);
            if (!label) return null;
            const colors = LABEL_COLORS[label.color] || LABEL_COLORS.gray;
            return (
              <span
                key={lid}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${colors.bg} ${colors.text}`}
              >
                {label.name}
                {userData?.role !== "viewer" &&
                  // Ya asignada: solo el agente dueño o un admin pueden editar etiquetas.
                  (conversation.status !== "with_agent" || conversation.assignedAgentId === user?.uid || userData?.role === "admin") && (
                  <button
                    onClick={() => handleToggleLabel(lid)}
                    className="ml-0.5 hover:opacity-70"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </span>
            );
          })}
          {userData?.role !== "viewer" &&
            // Ya asignada: solo el agente dueño o un admin pueden editar etiquetas.
            (conversation.status !== "with_agent" || conversation.assignedAgentId === user?.uid || userData?.role === "admin") && (
            <div className="relative">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-gray-500"
                onClick={() => setLabelDropdownOpen((v) => !v)}
              >
                <Tag className="h-3 w-3 mr-1" />
                Etiqueta
              </Button>
              {labelDropdownOpen && (
                <div className="absolute top-8 left-0 z-50 bg-popover border rounded-lg shadow-lg py-1 min-w-[160px]">
                  {teamLabels.map((label) => {
                    const colors = LABEL_COLORS[label.color] || LABEL_COLORS.gray;
                    const active = conversation?.labelIds?.includes(label.id);
                    return (
                      <button
                        key={label.id}
                        onClick={() => { handleToggleLabel(label.id); setLabelDropdownOpen(false); }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent"
                      >
                        <span className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${colors.bg} border ${active ? "ring-2 ring-offset-1 ring-gray-400" : ""}`} style={{ backgroundColor: undefined }} />
                        <span className={`flex-1 text-left ${active ? "font-medium" : ""}`}>{label.name}</span>
                        {active && <Check className="h-3 w-3 text-gray-500" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* View tabs: Messages | Notes */}
      <div className="flex gap-2 py-2 border-b overflow-x-auto">
        <Button
          variant={activeView === "messages" ? "default" : "ghost"}
          size="sm"
          className={cn("flex-shrink-0", compact && "h-7 px-2 text-xs")}
          onClick={() => setActiveView("messages")}
        >
          Mensajes
        </Button>
        <Button
          variant={activeView === "notes" ? "default" : "ghost"}
          size="sm"
          className={cn("flex-shrink-0", compact && "h-7 px-2 text-xs")}
          onClick={() => setActiveView("notes")}
        >
          <StickyNote className="mr-1 h-3 w-3" />
          Notas {notes.length > 0 && `(${notes.length})`}
        </Button>
        <Button
          variant={activeView === "leads" ? "default" : "ghost"}
          size="sm"
          className={cn("flex-shrink-0", compact && "h-7 px-2 text-xs")}
          onClick={() => setActiveView("leads")}
        >
          <UserCircle className="mr-1 h-3 w-3" />
          Leads
        </Button>
        <Button
          variant={activeView === "accounts" ? "default" : "ghost"}
          size="sm"
          className={cn("flex-shrink-0", compact && "h-7 px-2 text-xs")}
          onClick={() => setActiveView("accounts")}
        >
          <UserCircle className="mr-1 h-3 w-3" />
          Cuentas
        </Button>
        <Button
          variant={activeView === "vehicles" ? "default" : "ghost"}
          size="sm"
          className={cn("flex-shrink-0", compact && "h-7 px-2 text-xs")}
          onClick={() => setActiveView("vehicles")}
        >
          <UserCircle className="mr-1 h-3 w-3" />
          Vehiculos
        </Button>
        <Button
          variant={activeView === "history" ? "default" : "ghost"}
          size="sm"
          className={cn("flex-shrink-0", compact && "h-7 px-2 text-xs")}
          onClick={() => setActiveView("history")}
        >
          <History className="mr-1 h-3 w-3" />
          Historial
        </Button>
      </div>

      {activeView === "history" ? (
        <div className="flex-1 overflow-y-auto py-4 space-y-2">
          {loadingHistory ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
            </div>
          ) : pastConversations.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">
              No hay conversaciones cerradas anteriores con este numero.
            </p>
          ) : (
            pastConversations.map((conv) => (
              <Link key={conv.id} href={`/conversations/${conv.id}`}>
                <Card className="cursor-pointer hover:bg-gray-50 transition-colors">
                  <CardContent className="py-3 px-4">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        {conv.lastMessagePreview && (
                          <p className="text-sm text-gray-700 truncate">
                            &ldquo;{conv.lastMessagePreview}&rdquo;
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="secondary" className="text-[10px]">
                            {conv.closedReason === "resolved" ? "Resuelto" :
                              conv.closedReason === "not_interested" ? "No interesado" :
                              conv.closedReason === "duplicate" ? "Duplicado" :
                              conv.closedReason === "no_response" ? "Sin respuesta" :
                              conv.closedReason === "inactivity" ? "Inactividad" :
                              conv.closedReason || "Cerrada"}
                          </Badge>
                          {conv.botName && (
                            <span className="text-[10px] text-gray-400">{conv.botName}</span>
                          )}
                        </div>
                      </div>
                      <span className="text-xs text-gray-400 whitespace-nowrap ml-2">
                        {conv.lastMessageAt ? format(conv.lastMessageAt.toDate(), "d MMM yyyy", { locale: es }) : ""}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))
          )}
        </div>
      ) : activeView === "leads" ? (
        conversation ? (
          <LeadsPanel customerPhone={conversation.customerPhone} />
        ) : null
      ) : activeView === "accounts" ? (
        conversation ? (
          <AccountsPanel
            customerPhone={conversation.customerPhone}
            onAccountsLoaded={setAccountIds}
          />
        ) : null
      ) : activeView === "vehicles" ? (
        <VehiclesPanel accountIds={accountIds} />
      ) : activeView === "messages" ? (
        <>
          {/* Messages */}
          <div className="flex-1 overflow-y-auto py-4 space-y-4">
            {groupedMessages.map((group, groupIndex) => (
              <div key={groupIndex}>
                <div className="flex items-center justify-center my-4">
                  <span className="bg-gray-100 text-gray-500 text-xs px-3 py-1 rounded-full">
                    {group.date}
                  </span>
                </div>

                {group.messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${
                      msg.sender === "customer" ? "justify-start" : "justify-end"
                    } mb-2`}
                  >
                    <div
                      className={`max-w-[70%] rounded-lg px-4 py-2 ${
                        msg.sender === "customer"
                          ? "bg-gray-100 text-gray-900"
                          : msg.sender === "bot"
                          ? "bg-blue-500 text-white"
                          : "bg-green-500 text-white"
                      }`}
                    >
                      <div
                        className={`flex items-center gap-1 text-xs mb-1 ${
                          msg.sender === "customer"
                            ? "text-gray-500"
                            : "text-white/80"
                        }`}
                      >
                        {getSenderIcon(msg.sender)}
                        <span>{getSenderLabel(msg.sender)}</span>
                      </div>

                      {msg.mediaUrl && (
                        /\.(jpg|jpeg|png|gif|webp)/i.test(msg.mediaUrl) ? (
                          <img
                            src={msg.mediaUrl}
                            alt="imagen"
                            className="rounded-md max-w-full mb-1 cursor-pointer"
                            onClick={() => window.open(msg.mediaUrl!, "_blank")}
                          />
                        ) : (
                          <a
                            href={msg.mediaUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2 underline text-sm mb-1"
                          >
                            <FileIcon className="h-4 w-4 flex-shrink-0" />
                            <span>Ver archivo</span>
                          </a>
                        )
                      )}
                      {msg.text && <p className="whitespace-pre-wrap break-words">{msg.text}</p>}

                      <div
                        className={`text-xs mt-1 text-right ${
                          msg.sender === "customer"
                            ? "text-gray-400"
                            : "text-white/70"
                        }`}
                      >
                        {formatMessageTime(msg.createdAt)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Message input */}
          <div className="border-t pt-4">
            <Card className="p-2">
              {canSendMessage ? (
                <div className="relative">
                  {/* Canned responses dropdown */}
                  {showCannedMenu && (
                    <div className="absolute bottom-full left-0 right-0 mb-1 bg-popover border rounded-md shadow-md z-50 max-h-[200px] overflow-y-auto">
                      {filteredTemplates.map((tpl, index) => (
                        <button
                          key={tpl.id}
                          type="button"
                          className={`w-full text-left px-3 py-2 text-sm hover:bg-accent cursor-pointer ${
                            index === cannedIndex ? "bg-accent" : ""
                          }`}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            selectCannedTemplate(tpl);
                          }}
                        >
                          <span className="font-medium">{tpl.name}</span>
                          <span className="text-muted-foreground ml-2 text-xs line-clamp-1">
                            {tpl.content}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  {pendingFile && (
                    <div className="flex items-center gap-2 px-2 py-1.5 mb-1 bg-muted rounded-md text-sm">
                      <Paperclip className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                      <span className="truncate flex-1 text-xs">{pendingFile.name}</span>
                      <button
                        onClick={() => setPendingFile(null)}
                        className="text-muted-foreground hover:text-foreground flex-shrink-0"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Sheet open={templateSheetOpen} onOpenChange={setTemplateSheetOpen}>
                      <SheetTrigger asChild>
                        <Button variant="outline" size="icon" title="Plantillas">
                          <FileText className="h-4 w-4" />
                        </Button>
                      </SheetTrigger>
                      <SheetContent>
                        <SheetHeader>
                          <SheetTitle>Plantillas</SheetTitle>
                        </SheetHeader>
                        <div className="space-y-2 mt-4 overflow-y-auto max-h-[calc(100vh-120px)]">
                          {templates.length === 0 ? (
                            <p className="text-sm text-gray-500 text-center py-4">
                              Sin plantillas disponibles
                            </p>
                          ) : (
                            templates.map((tpl) => (
                              <Card
                                key={tpl.id}
                                className="cursor-pointer hover:bg-gray-50 transition-colors"
                                onClick={() => {
                                  setNewMessage(tpl.content);
                                  setTemplateSheetOpen(false);
                                }}
                              >
                                <CardContent className="py-3 px-4">
                                  <p className="text-sm font-medium">{tpl.name}</p>
                                  <p className="text-xs text-gray-500 mt-1 line-clamp-2">
                                    {tpl.content}
                                  </p>
                                </CardContent>
                              </Card>
                            ))
                          )}
                        </div>
                      </SheetContent>
                    </Sheet>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*,application/pdf"
                      className="hidden"
                      onChange={handleFileSelect}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploadingMedia || sending}
                      title="Adjuntar imagen o PDF"
                    >
                      {uploadingMedia ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Paperclip className="h-4 w-4" />
                      )}
                    </Button>
                    <Textarea
                      placeholder='Escribe un mensaje... (/ para plantillas)'
                      value={newMessage}
                      rows={1}
                      onChange={(e) => {
                        setNewMessage(e.target.value);
                        setCannedIndex(0);
                        const el = e.target;
                        el.style.height = "auto";
                        el.style.height = el.scrollHeight + "px";
                      }}
                      onKeyDown={handleKeyPress}
                      disabled={sending}
                      className="flex-1 self-end"
                    />
                    <Button onClick={handleSendMessage} disabled={sending || (!newMessage.trim() && !pendingFile)}>
                      {sending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Escribe un mensaje..."
                      disabled
                      className="flex-1"
                    />
                    <Button disabled>
                      <Send className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-gray-400 mt-2 text-center">
                    {conversation?.status === "waiting_agent"
                      ? "Toma la conversacion para poder enviar mensajes"
                      : conversation?.status === "bot"
                      ? "Esta conversacion esta siendo atendida por el bot"
                      : conversation?.status === "closed"
                      ? "Esta conversacion esta cerrada. Puedes reabrirla para continuar."
                      : "No puedes enviar mensajes en esta conversacion"}
                  </p>
                </>
              )}
            </Card>
          </div>
        </>
      ) : (
        <>
          {/* Notes view */}
          <div className="flex-1 overflow-y-auto py-4 space-y-3">
            {notes.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">
                Sin notas internas. Agrega una nota visible solo para tu equipo.
              </p>
            ) : (
              notes.map((note) => (
                <div key={note.id} className="bg-yellow-50 border border-yellow-200 rounded-lg px-4 py-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-yellow-800">
                      {note.authorName}
                    </span>
                    <span className="text-xs text-yellow-600">
                      {note.createdAt ? formatMessageTime(note.createdAt) : ""}
                    </span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{note.text}</p>
                </div>
              ))
            )}
          </div>

          {/* Note input */}
          <div className="border-t pt-4">
            <Card className="p-2">
              <div className="flex gap-2">
                <Input
                  placeholder="Agregar nota interna..."
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  onKeyPress={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleAddNote();
                    }
                  }}
                  disabled={addingNote}
                  className="flex-1"
                />
                <Button onClick={handleAddNote} disabled={addingNote || !newNote.trim()}>
                  {addingNote ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <StickyNote className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </Card>
          </div>
        </>
      )}

      {/* Close conversation dialog */}
      <Dialog open={closeDialogOpen} onOpenChange={setCloseDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Cerrar conversacion</DialogTitle>
            <DialogDescription>
              Selecciona el motivo de cierre.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4">
            <Label>Motivo de cierre</Label>
            <Select value={closeReason} onValueChange={setCloseReason}>
              <SelectTrigger>
                <SelectValue placeholder="Seleccionar motivo..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="resolved">Resuelto</SelectItem>
                <SelectItem value="not_interested">No interesado</SelectItem>
                <SelectItem value="duplicate">Duplicado</SelectItem>
                <SelectItem value="no_response">Sin respuesta del cliente</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCloseDialogOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={handleCloseConversation}
              disabled={closing || !closeReason}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {closing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Cerrar conversacion
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
