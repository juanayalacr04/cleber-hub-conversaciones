"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MessageSquare, Loader2, Bell, BellOff, Search, List, Columns, MessageCircle, Phone, Bot, UserCircle, Tag, Clock, Users, Calendar, SlidersHorizontal, CalendarCheck, ChevronDown, ChevronRight, Megaphone, ArrowDownToLine, ArrowUpFromLine, HelpCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { db } from "@/lib/firebase";
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  onSnapshot,
  getDocs,
  getCountFromServer,
  Timestamp,
  QueryConstraint,
  QueryDocumentSnapshot,
} from "firebase/firestore";
import { useAuth, isAdmin } from "@/contexts/AuthContext";
import { getModule } from "@/lib/modules";
import { conversationPath } from "@/lib/routes";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import { useNotifications } from "@/hooks/useNotifications";
import { useNotificationContext } from "@/contexts/NotificationContext";
import KanbanBoard from "@/components/conversations/KanbanBoard";
import ConverseView from "@/components/conversations/ConverseView";
import { useSemaphore } from "@/hooks/useSemaphore";
import {
  ConversationOutcome,
  OUTCOME_LABELS,
  OUTCOME_COLORS,
  OUTCOME_VALUES,
  TERMINAL_OUTCOMES,
  resolveDirection,
} from "@/lib/conversation-outcomes";

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
  teamId: string;
}

interface Conversation {
  id: string;
  customerPhone: string;
  customerName: string | null;
  status: "bot" | "waiting_agent" | "with_agent" | "closed";
  lastMessageAt: Timestamp;
  botId: string;
  organizationId: string;
  whatsappNumberId?: string;
  botName?: string;
  botBrand?: string;
  botCategory?: string;
  lastMessagePreview?: string;
  lastMessageSender?: "customer" | "bot" | "agent";
  channel?: "whatsapp" | "voice" | "web";
  assignedAgentId?: string | null;
  teamId?: string | null;
  closedReason?: string | null;
  labelIds?: string[];
  appointmentStatus?: "sin_cita" | "cita_bot" | "cita_agente";
  broadcastId?: string | null;
  broadcastName?: string | null;
  direction?: "inbound" | "outbound";
  conversationOutcome?: ConversationOutcome | null;
  conversationOutcomeHistory?: { outcome: ConversationOutcome; at: Timestamp }[];
}

interface WhatsAppNumberInfo {
  id: string;
  phoneNumber: string;
  displayName: string;
}

interface Team {
  id: string;
  name: string;
  vertical?: string | null;
}

type ViewMode = "list" | "kanban" | "converse";

function getStatusConstraints(tab: string): QueryConstraint[] {
  if (tab === "pending") return [where("status", "==", "with_agent"), where("lastMessageSender", "==", "customer")];
  if (tab === "waiting") return [where("status", "==", "waiting_agent")];
  if (tab === "active") return [where("status", "==", "with_agent")];
  if (tab === "bot") return [where("status", "==", "bot")];
  if (tab === "closed") return [where("status", "==", "closed")];
  return [];
}

// Si el término de búsqueda es un teléfono mexicano (10 dígitos, con o sin +52/+521),
// arma las variantes exactas de customerPhone tal como se guardan en Firestore.
// Necesario porque el caché de búsqueda (ver loadSearchCache) solo cubre las 2000
// conversaciones más recientes de la org y no alcanza a cubrir clientes antiguos.
function buildPhoneVariants(term: string): string[] | null {
  const digits = term.replace(/\D/g, "");
  let local10: string | null = null;
  if (digits.length === 10) local10 = digits;
  else if (digits.length === 12 && digits.startsWith("52")) local10 = digits.slice(2);
  else if (digits.length === 13 && digits.startsWith("521")) local10 = digits.slice(3);
  if (!local10) return null;
  return [
    `whatsapp:+52${local10}`,
    `whatsapp:+521${local10}`,
    `+52${local10}`,
    `+521${local10}`,
  ];
}

const CONV_FILTERS_KEY = "conv_filters_v2";

function getStoredFilters() {
  if (typeof window === "undefined") return null;
  try {
    const s = sessionStorage.getItem(CONV_FILTERS_KEY);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}

// Filtros llegados por URL (ej. click en una tarjeta del dashboard) — mismo
// formato que sessionStorage, pero tienen prioridad (igual que ?tab=).
function parseListParam<T extends string>(value: string | null, valid: readonly T[]): T[] {
  if (!value) return [];
  return value.split(",").filter((v): v is T => (valid as readonly string[]).includes(v));
}

export default function ConversationsPage() {
  const { userData, user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Módulo activo (URL): acota los equipos que se ven. `general` no acota.
  const { module: moduleId } = useParams<{ module: string }>();
  const vertical = getModule(moduleId)?.vertical ?? null;
  const searchQueryRef = useRef("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [waNumbers, setWaNumbers] = useState<Record<string, WhatsAppNumberInfo>>({});
  const [loading, setLoading] = useState(true);
  const validTabs = ["all", "pending", "waiting", "active", "bot", "closed"];
  const [activeTab, setActiveTab] = useState(() => {
    const t = searchParams.get("tab");
    if (t && validTabs.includes(t)) return t;
    const saved = getStoredFilters();
    return (saved?.activeTab && validTabs.includes(saved.activeTab)) ? saved.activeTab : "all";
  });
  const [conversationsLimit, setConversationsLimit] = useState(200);
  const [searchQuery, setSearchQuery] = useState("");
  const { showNotification, playSound } = useNotifications();
  const { soundEnabled, setSoundEnabled } = useNotificationContext();
  const prevWaitingCountRef = useRef<number>(0);
  const isInitialLoadRef = useRef<boolean>(true);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const v = searchParams.get("view");
    if (v === "kanban" || v === "converse") return v;
    if (v === "list") return "list";
    const saved = getStoredFilters()?.viewMode;
    return (saved === "kanban" || saved === "converse") ? saved : "list";
  });
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const [agentNames, setAgentNames] = useState<Record<string, string>>({});
  const [searchResults, setSearchResults] = useState<Conversation[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchCacheRef = useRef<Conversation[] | null>(null);
  const searchCacheTimeRef = useRef<number>(0);
  const searchCacheKeyRef = useRef<string>("");
  const searchCacheCursorRef = useRef<QueryDocumentSnapshot | null>(null);
  const searchCacheExhaustedRef = useRef(false);
  const searchCacheAutoLoadsRef = useRef(0);
  const filterFromCacheRef = useRef<(term: string) => void>(() => {});
  useEffect(() => { searchQueryRef.current = searchQuery; }, [searchQuery]);
  const lastDateDocRef = useRef<QueryDocumentSnapshot | null>(null);
  const lastStatusDocRef = useRef<QueryDocumentSnapshot | null>(null);
  const lastStatusDateDocRef = useRef<QueryDocumentSnapshot | null>(null);
  const [statusLoadMoreConvs, setStatusLoadMoreConvs] = useState<Conversation[]>([]);
  const [loadingMoreByStatus, setLoadingMoreByStatus] = useState(false);
  const [hasMoreByStatus, setHasMoreByStatus] = useState(true);
  const [orgLabels, setOrgLabels] = useState<Record<string, ConversationLabel>>({});
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>(() => getStoredFilters()?.selectedLabelIds ?? []);
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>(() => getStoredFilters()?.selectedAgentIds ?? []);
  const [selectedDatePreset, setSelectedDatePreset] = useState<string | null>(() => getStoredFilters()?.selectedDatePreset ?? null);
  const [dateFrom, setDateFrom] = useState<string>(() => searchParams.get("dateFrom") ?? getStoredFilters()?.dateFrom ?? "");
  const [dateTo, setDateTo] = useState<string>(() => searchParams.get("dateTo") ?? getStoredFilters()?.dateTo ?? "");
  const [dateSearchResults, setDateSearchResults] = useState<Conversation[] | null>(null);
  const [dateSearching, setDateSearching] = useState(false);
  const [selectedAppointmentStatuses, setSelectedAppointmentStatuses] = useState<("sin_cita" | "cita_bot" | "cita_agente")[]>(() => {
    const fromUrl = parseListParam(searchParams.get("appointmentStatus"), ["sin_cita", "cita_bot", "cita_agente"] as const);
    return fromUrl.length > 0 ? fromUrl : (getStoredFilters()?.selectedAppointmentStatuses ?? []);
  });
  const [selectedCampaigns, setSelectedCampaigns] = useState<string[]>(() => getStoredFilters()?.selectedCampaigns ?? []);
  const [selectedDirections, setSelectedDirections] = useState<("inbound" | "outbound")[]>(() => {
    const fromUrl = parseListParam(searchParams.get("direction"), ["inbound", "outbound"] as const);
    return fromUrl.length > 0 ? fromUrl : (getStoredFilters()?.selectedDirections ?? []);
  });
  const [selectedOutcomes, setSelectedOutcomes] = useState<(ConversationOutcome | "sin_clasificar")[]>(() => {
    const fromUrl = parseListParam(searchParams.get("outcome"), [...OUTCOME_VALUES, "sin_clasificar"] as const);
    return fromUrl.length > 0 ? fromUrl : (getStoredFilters()?.selectedOutcomes ?? []);
  });
  const [outcomeFilterMode, setOutcomeFilterMode] = useState<"current" | "everContained">(() => getStoredFilters()?.outcomeFilterMode ?? "current");
  const [filtersOpen, setFiltersOpen] = useState(() =>
    Boolean(searchParams.get("direction") || searchParams.get("outcome") || searchParams.get("appointmentStatus"))
  );
  const [openFilterSection, setOpenFilterSection] = useState<string | null>(null);
  const [statusCounts, setStatusCounts] = useState<{
    bot: number; waiting: number; withAgent: number; closed: number; pending: number;
  } | null>(null);

  // Reset team selection and search cache when org changes
  const orgId = userData?.organizationId;
  useEffect(() => {
    setSelectedTeamId("");
    setTeams([]);
    searchCacheRef.current = null;
    searchCacheTimeRef.current = 0;
    searchCacheKeyRef.current = "";
    searchCacheCursorRef.current = null;
    searchCacheExhaustedRef.current = false;
    searchCacheAutoLoadsRef.current = 0;
  }, [orgId]);

  // Reset status-load-more state when tab changes
  useEffect(() => {
    lastStatusDocRef.current = null;
    lastStatusDateDocRef.current = null;
    setStatusLoadMoreConvs([]);
    setHasMoreByStatus(true);
  }, [activeTab]);

  // Team access control
  // Admin y superadmin eligen equipo (dentro del módulo activo); el resto queda fijo en el suyo
  const canChooseTeam = isAdmin(userData);
  const userTeamId = (userData as any)?.teamId as string | undefined;
  const hasNoTeamAccess = !canChooseTeam && !userTeamId;
  const effectiveTeamId = canChooseTeam ? selectedTeamId : (userTeamId ?? "");
  // El selector aparece si hay más de un equipo que elegir
  const canSwitchTeams = canChooseTeam && teams.length > 1;

  // Semaphore: use effective team
  const semaphoreTeamId = (effectiveTeamId && effectiveTeamId !== "all") ? effectiveTeamId : undefined;
  const { getColor: getSemaphoreColor, thresholds: semaphoreThresholds } = useSemaphore(semaphoreTeamId);
  const [selectedSemaphoreColors, setSelectedSemaphoreColors] = useState<("green" | "yellow" | "red")[]>(() => getStoredFilters()?.selectedSemaphoreColors ?? []);

  // Persist filters to sessionStorage
  useEffect(() => {
    try {
      sessionStorage.setItem(CONV_FILTERS_KEY, JSON.stringify({
        activeTab,
        selectedLabelIds,
        selectedAgentIds,
        selectedDatePreset,
        dateFrom,
        dateTo,
        selectedAppointmentStatuses,
        selectedSemaphoreColors,
        selectedCampaigns,
        selectedDirections,
        selectedOutcomes,
        outcomeFilterMode,
        viewMode,
      }));
    } catch {}
  }, [activeTab, selectedLabelIds, selectedAgentIds, selectedDatePreset, dateFrom, dateTo, selectedAppointmentStatuses, selectedSemaphoreColors, selectedCampaigns, selectedDirections, selectedOutcomes, outcomeFilterMode, viewMode]);

  // Fetch real counts from Firestore without loading all conversations
  useEffect(() => {
    if (!userData?.organizationId || hasNoTeamAccess) return;
    const conversationsRef = collection(db, "conversations");
    const base: QueryConstraint[] = [where("organizationId", "==", userData.organizationId)];
    const teamFilter = effectiveTeamId && effectiveTeamId !== "all" ? effectiveTeamId : null;
    if (teamFilter) base.push(where("teamId", "==", teamFilter));

    const fetchCounts = async () => {
      try {
        const since96h = Timestamp.fromDate(new Date(Date.now() - 96 * 60 * 60 * 1000));
        const baseWithDate = [...base, where("lastMessageAt", ">=", since96h)];
        const [botSnap, waitingSnap, withAgentSnap, closedSnap, pendingSnap] = await Promise.all([
          getCountFromServer(query(conversationsRef, ...baseWithDate, where("status", "==", "bot"))),
          getCountFromServer(query(conversationsRef, ...baseWithDate, where("status", "==", "waiting_agent"))),
          getCountFromServer(query(conversationsRef, ...baseWithDate, where("status", "==", "with_agent"))),
          getCountFromServer(query(conversationsRef, ...baseWithDate, where("status", "==", "closed"))),
          getCountFromServer(query(conversationsRef, ...baseWithDate, where("status", "==", "with_agent"), where("lastMessageSender", "==", "customer"))),
        ]);
        setStatusCounts({
          bot: botSnap.data().count,
          waiting: waitingSnap.data().count,
          withAgent: withAgentSnap.data().count,
          closed: closedSnap.data().count,
          pending: pendingSnap.data().count,
        });
      } catch (e) {
        console.error("Error fetching status counts:", e);
      }
    };

    fetchCounts();
  }, [userData?.organizationId, hasNoTeamAccess, effectiveTeamId]);

  useEffect(() => {
    if (!userData?.organizationId) {
      setLoading(false);
      return;
    }

    // Non-superAdmin without a team sees nothing
    if (hasNoTeamAccess) {
      setConversations([]);
      setLoading(false);
      return;
    }

    const conversationsRef = collection(db, "conversations");
    const constraints: QueryConstraint[] = [
      where("organizationId", "==", userData.organizationId),
    ];
    const teamFilter = effectiveTeamId && effectiveTeamId !== "all" ? effectiveTeamId : null;
    if (teamFilter) {
      constraints.push(where("teamId", "==", teamFilter));
    }
    constraints.push(orderBy("lastMessageAt", "desc"), limit(conversationsLimit));
    const q = query(conversationsRef, ...constraints);

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const convs: Conversation[] = [];
        snapshot.forEach((doc) => {
          convs.push({ id: doc.id, ...doc.data() } as Conversation);
        });
        console.log("conversations loaded:", convs.length, convs.map(c => ({ id: c.id, waId: c.whatsappNumberId })));
        setConversations(convs);
        setLoading(false);

        // Check for new waiting conversations (after initial load)
        if (!isInitialLoadRef.current) {
          const newWaitingCount = convs.filter(c => c.status === "waiting_agent").length;
          if (newWaitingCount > prevWaitingCountRef.current) {
            playSound();
            showNotification("Nueva conversacion esperando", "Un cliente solicita hablar con un agente");
          }
          prevWaitingCountRef.current = newWaitingCount;
        } else {
          prevWaitingCountRef.current = convs.filter(c => c.status === "waiting_agent").length;
          isInitialLoadRef.current = false;
        }
      },
      (error) => {
        console.error("Error fetching conversations:", error);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [userData?.organizationId, conversationsLimit, playSound, showNotification, hasNoTeamAccess, effectiveTeamId]);

  // Load WhatsApp numbers for display names
  useEffect(() => {
    if (!userData?.organizationId) return;

    const q = query(
      collection(db, "whatsappNumbers"),
      where("organizationId", "==", userData.organizationId)
    );
    const unsubscribe = onSnapshot(q, (snap) => {
      const map: Record<string, WhatsAppNumberInfo> = {};
      snap.forEach((doc) => {
        const data = doc.data();
        map[doc.id] = {
          id: doc.id,
          phoneNumber: data.phoneNumber || "",
          displayName: data.displayName || "",
        };
      });
      console.log("waNumbers loaded:", Object.keys(map).length, map);
      setWaNumbers(map);
    });

    return () => unsubscribe();
  }, [userData?.organizationId]);

  // Load agent names
  useEffect(() => {
      if (!userData?.organizationId) return;

      const orgId = userData.organizationId;
      const usersRef = collection(db, "users");
      // q1: formato viejo (organizationId directo). q2: formato nuevo (organizationIds
      // array) — un agente multi-org puede tener otra org como organizationId
      // plano y solo aparecer en el array. Mismo patrón que ConversationChat.tsx.
      const q1 = query(usersRef, where("organizationId", "==", orgId));
      const q2 = query(usersRef, where("organizationIds", "array-contains", orgId));

      const toName = (doc: QueryDocumentSnapshot) => {
        const data = doc.data();
        return data.name || data.email?.split("@")[0] || "Agente";
      };

      let snap1Map: Record<string, string> = {};
      let snap2Map: Record<string, string> = {};
      const merge = () => setAgentNames({ ...snap1Map, ...snap2Map });

      const unsub1 = onSnapshot(q1, (snapshot) => {
        snap1Map = {};
        snapshot.forEach((doc) => { snap1Map[doc.id] = toName(doc); });
        merge();
      });
      const unsub2 = onSnapshot(q2, (snapshot) => {
        snap2Map = {};
        snapshot.forEach((doc) => { snap2Map[doc.id] = toName(doc); });
        merge();
      });

      return () => {
        unsub1();
        unsub2();
      };
    }, [userData?.organizationId]);

  // Load teams for filter
  useEffect(() => {
    if (!userData?.organizationId) return;

    const q = query(
      collection(db, "teams"),
      where("organizationId", "==", userData.organizationId)
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const t: Team[] = [];
      snapshot.forEach((doc) => {
        t.push({ id: doc.id, ...doc.data() } as Team);
      });
      const scoped = vertical ? t.filter((x) => x.vertical === vertical) : t;
      setTeams(scoped);
      if (vertical && scoped.length > 0) {
        // En un módulo siempre hay un equipo elegido: "todos" mezclaría los módulos
        setSelectedTeamId((prev) => (prev && scoped.some((x) => x.id === prev) ? prev : scoped[0].id));
      } else if (scoped.length === 1) {
        // Auto-select the only team so semaphore and filters work even without the selector
        setSelectedTeamId((prev) => prev || scoped[0].id);
      }
    });
    return () => unsubscribe();
  }, [userData?.organizationId, vertical]);

  // Load all org labels
  useEffect(() => {
    if (!userData?.organizationId) return;
    const q = query(
      collection(db, "labels"),
      where("organizationId", "==", userData.organizationId)
    );
    const unsub = onSnapshot(q, (snap) => {
      const map: Record<string, ConversationLabel> = {};
      snap.forEach((d) => { map[d.id] = { id: d.id, ...d.data() } as ConversationLabel; });
      setOrgLabels(map);
    });
    return unsub;
  }, [userData?.organizationId]);

  const SEARCH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // Load up to 500 conversations into cache (respects team filter, fetches only if stale)
  const loadSearchCache = useCallback(async () => {
    if (!userData?.organizationId) return;

    const cacheKey = `${userData.organizationId}:${effectiveTeamId}`;
    const now = Date.now();

    if (
      searchCacheRef.current !== null &&
      searchCacheKeyRef.current === cacheKey &&
      now - searchCacheTimeRef.current < SEARCH_CACHE_TTL
    ) return;

    setSearching(true);
    try {
      const constraints: QueryConstraint[] = [
        where("organizationId", "==", userData.organizationId),
      ];
      if (effectiveTeamId && effectiveTeamId !== "all") {
        constraints.push(where("teamId", "==", effectiveTeamId));
      }
      constraints.push(orderBy("lastMessageAt", "desc"), limit(2000));

      const snap = await getDocs(query(collection(db, "conversations"), ...constraints));
      const convs: Conversation[] = [];
      snap.forEach((d) => convs.push({ id: d.id, ...d.data() } as Conversation));

      searchCacheRef.current = convs;
      searchCacheTimeRef.current = now;
      searchCacheKeyRef.current = cacheKey;
      searchCacheCursorRef.current = snap.docs[snap.docs.length - 1] ?? null;
      searchCacheExhaustedRef.current = snap.docs.length < 2000;
      searchCacheAutoLoadsRef.current = 0;
    } catch (error) {
      console.error("Error loading search cache:", error);
    } finally {
      setSearching(false);
    }
  }, [userData?.organizationId, effectiveTeamId]);

  const loadMoreSearchCache = useCallback(async (term: string) => {
    if (!userData?.organizationId || searchCacheExhaustedRef.current || !searchCacheCursorRef.current) return;
    if (searchCacheAutoLoadsRef.current >= 2) return; // ponytail: max 2 auto-loads (~15 days total coverage)

    setSearching(true);
    try {
      const constraints: QueryConstraint[] = [
        where("organizationId", "==", userData.organizationId),
      ];
      if (effectiveTeamId && effectiveTeamId !== "all") {
        constraints.push(where("teamId", "==", effectiveTeamId));
      }
      constraints.push(orderBy("lastMessageAt", "desc"), startAfter(searchCacheCursorRef.current), limit(2000));

      const snap = await getDocs(query(collection(db, "conversations"), ...constraints));
      const newConvs: Conversation[] = [];
      snap.forEach((d) => newConvs.push({ id: d.id, ...d.data() } as Conversation));

      searchCacheCursorRef.current = snap.docs[snap.docs.length - 1] ?? null;
      searchCacheExhaustedRef.current = snap.docs.length < 2000;
      searchCacheAutoLoadsRef.current += 1;
      if (searchCacheRef.current) searchCacheRef.current = [...searchCacheRef.current, ...newConvs];

      filterFromCacheRef.current(term);
    } catch (error) {
      console.error("Error loading more search cache:", error);
    } finally {
      setSearching(false);
    }
  }, [userData?.organizationId, effectiveTeamId]);

  // Filter from cache in memory (instant, no Firestore reads)
  const filterFromCache = useCallback((term: string) => {
    if (!term.trim() || !searchCacheRef.current) {
      setSearchResults(null);
      return;
    }
    const t = term.trim().toLowerCase();
    const results = searchCacheRef.current.filter((conv) => {
      const phone = (conv.customerPhone || "").toLowerCase();
      const name = (conv.customerName || "").toLowerCase();
      return phone.includes(t) || name.includes(t);
    });
    setSearchResults(results);
    if (results.length === 0 && !searchCacheExhaustedRef.current && searchCacheAutoLoadsRef.current < 2) {
      loadMoreSearchCache(term);
    }
  }, [loadMoreSearchCache]);

  useEffect(() => {
    filterFromCacheRef.current = filterFromCache;
  }, [filterFromCache]);

  // Búsqueda exacta por teléfono directo a Firestore (sin límite de antigüedad),
  // complementa el caché de 2000 que solo cubre las conversaciones más recientes.
  const searchPhoneInFirestore = useCallback(async (term: string) => {
    if (!userData?.organizationId) return;
    const variants = buildPhoneVariants(term);
    if (!variants) return;

    try {
      const constraints: QueryConstraint[] = [
        where("organizationId", "==", userData.organizationId),
        where("customerPhone", "in", variants),
      ];
      const teamFilter = effectiveTeamId && effectiveTeamId !== "all" ? effectiveTeamId : null;
      if (teamFilter) constraints.push(where("teamId", "==", teamFilter));

      const snap = await getDocs(query(collection(db, "conversations"), ...constraints));
      const found: Conversation[] = [];
      snap.forEach((d) => found.push({ id: d.id, ...d.data() } as Conversation));
      if (found.length === 0) return;
      // Descartar resultado obsoleto si el usuario ya cambió el término de búsqueda
      if (searchQueryRef.current !== term) return;

      setSearchResults((prev) => {
        const base = prev ?? [];
        const ids = new Set(base.map((c) => c.id));
        const extra = found.filter((c) => !ids.has(c.id));
        if (extra.length === 0) return base;
        return [...base, ...extra];
      });
    } catch (error) {
      console.error("Error searching phone in Firestore:", error);
    }
  }, [userData?.organizationId, effectiveTeamId]);


  const searchByDate = useCallback(async (append = false) => {
    if (!userData?.organizationId) return;
    if (!selectedDatePreset && !dateFrom && !dateTo) return;

    setDateSearching(true);
    try {
      const now = new Date();
      const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

      let fromDate: Date | null = null;
      let toDate: Date | null = null;

      if (selectedDatePreset === "today") {
        fromDate = startOfDay(now);
      } else if (selectedDatePreset === "yesterday") {
        fromDate = startOfDay(new Date(now.getTime() - 86400000));
        toDate = startOfDay(now);
      } else if (selectedDatePreset === "week") {
        const day = now.getDay();
        const diff = day === 0 ? -6 : 1 - day;
        fromDate = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff));
      } else if (selectedDatePreset === "month") {
        fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
      } else {
        if (dateFrom) fromDate = new Date(dateFrom + "T00:00:00");
        if (dateTo) toDate = new Date(dateTo + "T23:59:59");
      }

      // When appending on a specific tab, filter by status with its own cursor
      const appendWithStatus = append && activeTab !== "all";

      const constraints: QueryConstraint[] = [
        where("organizationId", "==", userData.organizationId),
      ];
      if (effectiveTeamId && effectiveTeamId !== "all") {
        constraints.push(where("teamId", "==", effectiveTeamId));
      }
      if (appendWithStatus) {
        constraints.push(...getStatusConstraints(activeTab));
      }
      if (fromDate) constraints.push(where("lastMessageAt", ">=", Timestamp.fromDate(fromDate)));
      if (toDate) constraints.push(where("lastMessageAt", "<", Timestamp.fromDate(toDate)));

      constraints.push(orderBy("lastMessageAt", "desc"));

      if (append) {
        const cursor = appendWithStatus ? lastStatusDateDocRef.current : lastDateDocRef.current;
        if (cursor) constraints.push(startAfter(cursor));
      }

      constraints.push(limit(500));

      const snap = await getDocs(query(collection(db, "conversations"), ...constraints));

      const lastDoc = snap.docs[snap.docs.length - 1] ?? null;
      if (appendWithStatus) {
        lastStatusDateDocRef.current = lastDoc;
      } else {
        lastDateDocRef.current = lastDoc;
      }

      const convs: Conversation[] = [];
      snap.forEach((d) => convs.push({ id: d.id, ...d.data() } as Conversation));

      if (append) {
        setHasMoreByStatus(convs.length >= 500);
        setDateSearchResults((prev) => {
          const existingIds = new Set((prev ?? []).map((c) => c.id));
          return [...(prev ?? []), ...convs.filter((c) => !existingIds.has(c.id))];
        });
      } else {
        lastStatusDateDocRef.current = null;
        setHasMoreByStatus(true);
        setDateSearchResults(convs);
      }
    } catch (error) {
      console.error("Error searching by date:", error);
    } finally {
      setDateSearching(false);
    }
  }, [userData?.organizationId, effectiveTeamId, selectedDatePreset, dateFrom, dateTo, activeTab]);

  // Auto-re-run date search on mount when restoring filters from sessionStorage
  // or llegando por URL desde una tarjeta del dashboard (dateFrom/dateTo)
  const hasAutoSearchedRef = useRef(false);
  useEffect(() => {
    if (hasAutoSearchedRef.current) return;
    if (!userData?.organizationId) return;
    if (selectedDatePreset || dateFrom || dateTo) {
      hasAutoSearchedRef.current = true;
      searchByDate();
    }
  }, [userData?.organizationId, searchByDate, selectedDatePreset, dateFrom, dateTo]);

  const loadMoreByStatus = useCallback(async () => {
    if (!userData?.organizationId || loadingMoreByStatus) return;
    setLoadingMoreByStatus(true);
    try {
      const constraints: QueryConstraint[] = [
        where("organizationId", "==", userData.organizationId),
      ];
      if (effectiveTeamId && effectiveTeamId !== "all") {
        constraints.push(where("teamId", "==", effectiveTeamId));
      }
      constraints.push(...getStatusConstraints(activeTab));
      constraints.push(orderBy("lastMessageAt", "desc"));
      if (lastStatusDocRef.current) {
        constraints.push(startAfter(lastStatusDocRef.current));
      }
      constraints.push(limit(50));

      const snap = await getDocs(query(collection(db, "conversations"), ...constraints));
      lastStatusDocRef.current = snap.docs[snap.docs.length - 1] ?? null;
      const convs: Conversation[] = [];
      snap.forEach((d) => convs.push({ id: d.id, ...d.data() } as Conversation));
      setHasMoreByStatus(convs.length >= 50);
      setStatusLoadMoreConvs((prev) => [...prev, ...convs]);
    } catch (e) {
      console.error("Error loading more by status:", e);
    } finally {
      setLoadingMoreByStatus(false);
    }
  }, [userData?.organizationId, effectiveTeamId, activeTab, loadingMoreByStatus]);

  // Debounced search: when date filter active → filter within those results; otherwise load global cache
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);

    if (!searchQuery.trim()) {
      setSearchResults(null);
      setSearching(false);
      return;
    }

    // Con filtro de fecha activo: filtrar client-side sobre dateSearchResults (sin Firestore)
    if (dateSearchResults !== null) {
      const t = searchQuery.trim().toLowerCase();
      const results = dateSearchResults.filter((conv) => {
        const phone = (conv.customerPhone || "").toLowerCase();
        const name = (conv.customerName || "").toLowerCase();
        return phone.includes(t) || name.includes(t);
      });
      setSearchResults(results);
      return;
    }

    // Sin filtro de fecha: usar caché global (2000 más recientes) + query exacta
    // por teléfono a Firestore (cubre clientes fuera del caché)
    searchDebounceRef.current = setTimeout(async () => {
      await loadSearchCache();
      filterFromCache(searchQuery);
      searchPhoneInFirestore(searchQuery);
    }, 300);

    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [searchQuery, dateSearchResults, loadSearchCache, filterFromCache, searchPhoneInFirestore]);

  // Sync view mode to URL
  const handleViewChange = (mode: ViewMode) => {
    setViewMode(mode);
    const url = new URL(window.location.href);
    if (mode === "list") {
      url.searchParams.delete("view");
    } else {
      url.searchParams.set("view", mode);
    }
    window.history.replaceState({}, "", url.toString());
  };

  const statusLabels = {
    bot: "Con Bot",
    waiting_agent: "Esperando",
    with_agent: "Con Agente",
    closed: "Cerrada",
  };

  const statusColors = {
    bot: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    waiting_agent: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
    with_agent: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    closed: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
  };

  // Merge real-time conversations with extra status-filtered results (deduped)
  const mergedConversations = useMemo(() => {
    if (statusLoadMoreConvs.length === 0) return conversations;
    const ids = new Set(conversations.map((c) => c.id));
    const extra = statusLoadMoreConvs.filter((c) => !ids.has(c.id));
    return [...conversations, ...extra];
  }, [conversations, statusLoadMoreConvs]);

  const baseConversations = dateSearchResults ?? mergedConversations;

  // Distinct campaign names among loaded conversations, for the "Campaña" filter options
  const availableCampaigns = useMemo(() => {
    const names = new Set<string>();
    mergedConversations.forEach((c) => { if (c.broadcastName) names.add(c.broadcastName); });
    return Array.from(names).sort();
  }, [mergedConversations]);

  // True when any filter (other than tab/team) is active — counts should reflect filtered data
  const hasActiveFilters =
    dateSearchResults !== null ||
    selectedLabelIds.length > 0 ||
    selectedAgentIds.length > 0 ||
    selectedSemaphoreColors.length > 0 ||
    selectedAppointmentStatuses.length > 0 ||
    selectedCampaigns.length > 0 ||
    selectedDirections.length > 0 ||
    selectedOutcomes.length > 0;

  // All filters except tab — used both for filteredConversations and for badge counts
  const preTabFiltered = useMemo(() => baseConversations.filter((conv) => {
    if (selectedTeamId && selectedTeamId !== "all" && conv.teamId !== selectedTeamId) return false;
    if (selectedLabelIds.length > 0) {
      if (!selectedLabelIds.every((lid) => conv.labelIds?.includes(lid))) return false;
    }
    if (selectedSemaphoreColors.length > 0) {
      const isSemaphoreEligible = conv.status === "waiting_agent" || (conv.status === "with_agent" && conv.lastMessageSender === "customer");
      if (!isSemaphoreEligible) return false;
      const color = getSemaphoreColor(conv.lastMessageAt);
      if (!color || !selectedSemaphoreColors.includes(color)) return false;
    }
    if (selectedAgentIds.length > 0) {
      if (!conv.assignedAgentId || !selectedAgentIds.includes(conv.assignedAgentId)) return false;
    }
    if (selectedAppointmentStatuses.length > 0) {
      const appt = conv.appointmentStatus ?? "sin_cita";
      if (!selectedAppointmentStatuses.includes(appt)) return false;
    }
    if (selectedCampaigns.length > 0) {
      if (!conv.broadcastName || !selectedCampaigns.includes(conv.broadcastName)) return false;
    }
    if (selectedDirections.length > 0) {
      if (!selectedDirections.includes(resolveDirection(conv))) return false;
    }
    if (selectedOutcomes.length > 0) {
      if (outcomeFilterMode === "everContained") {
        const history = conv.conversationOutcomeHistory ?? [];
        if (!history.some((h) => selectedOutcomes.includes(h.outcome))) return false;
      } else {
        const current = conv.conversationOutcome ?? "sin_clasificar";
        if (!selectedOutcomes.includes(current)) return false;
      }
    }
    return true;
  }), [baseConversations, selectedTeamId, selectedLabelIds, selectedSemaphoreColors, selectedAgentIds, selectedAppointmentStatuses, selectedCampaigns, selectedDirections, selectedOutcomes, outcomeFilterMode, getSemaphoreColor]);

  // Tab filter applied on top
  const filteredConversations = useMemo(() => preTabFiltered.filter((conv) => {
    if (activeTab === "all" && conv.status === "closed") return false;
    if (activeTab === "pending" && !(conv.status === "with_agent" && conv.lastMessageSender === "customer")) return false;
    if (activeTab === "waiting" && conv.status !== "waiting_agent") return false;
    if (activeTab === "active" && conv.status !== "with_agent") return false;
    if (activeTab === "bot" && conv.status !== "bot") return false;
    if (activeTab === "closed" && conv.status !== "closed") return false;
    return true;
  }), [preTabFiltered, activeTab]);

  // Counts for badges — filtered data when filters active, Firestore counts otherwise
  const teamFiltered = selectedTeamId && selectedTeamId !== "all"
    ? conversations.filter((c) => c.teamId === selectedTeamId)
    : conversations;
  const waitingCount = hasActiveFilters
    ? preTabFiltered.filter((c) => c.status === "waiting_agent").length
    : (statusCounts?.waiting ?? teamFiltered.filter((c) => c.status === "waiting_agent").length);
  const activeCount = hasActiveFilters
    ? preTabFiltered.filter((c) => c.status === "with_agent").length
    : (statusCounts?.withAgent ?? teamFiltered.filter((c) => c.status === "with_agent").length);
  const botCount = hasActiveFilters
    ? preTabFiltered.filter((c) => c.status === "bot").length
    : (statusCounts?.bot ?? teamFiltered.filter((c) => c.status === "bot").length);
  const closedCount = hasActiveFilters
    ? preTabFiltered.filter((c) => c.status === "closed").length
    : (statusCounts?.closed ?? teamFiltered.filter((c) => c.status === "closed").length);
  const pendingReplyCount = hasActiveFilters
    ? preTabFiltered.filter((c) => c.status === "with_agent" && c.lastMessageSender === "customer").length
    : (statusCounts?.pending ?? teamFiltered.filter((c) => c.status === "with_agent" && c.lastMessageSender === "customer").length);
  const totalActiveCount = hasActiveFilters
    ? preTabFiltered.filter((c) => c.status !== "closed").length
    : (statusCounts ? (statusCounts.bot + statusCounts.waiting + statusCounts.withAgent) : (teamFiltered.length - closedCount));

  const formatTime = (timestamp: Timestamp) => {
    if (!timestamp) return "";
    const date = timestamp.toDate();
    return formatDistanceToNow(date, { addSuffix: true, locale: es });
  };

  const ConversationList = ({ convs }: { convs: Conversation[] }) => {
    if (convs.length === 0) {
      return (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="rounded-full bg-muted p-4 mb-4">
              <MessageSquare className="h-8 w-8 text-gray-400" />
            </div>
            <h3 className="text-lg font-medium mb-2">No hay conversaciones</h3>
            <p className="text-gray-500 text-center">
              Las conversaciones aparecerán aquí cuando los clientes envíen
              mensajes a tus bots.
            </p>
          </CardContent>
        </Card>
      );
    }

    const brandColors: Record<string, string> = {
      Honda: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
      Nissan: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
      Toyota: "bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-300",
    };

    return (
      <div className="space-y-2">
        {convs.map((conv) => (
          <Card
            key={conv.id}
            className={`cursor-pointer hover:bg-accent transition-colors ${
              conv.status === "with_agent" && conv.lastMessageSender === "customer"
                ? "border-l-4 border-l-orange-400"
                : ""
            }`}
            onClick={() => router.push(conversationPath(conv.id, moduleId))}
          >
            <CardContent className="flex items-center justify-between py-3 md:py-4 gap-2">
              <div className="flex items-center gap-3 md:gap-4 min-w-0">
                <div className="relative flex-shrink-0">
                  <div className="h-9 w-9 md:h-10 md:w-10 rounded-full bg-muted flex items-center justify-center">
                    <span className="text-xs md:text-sm font-medium">
                      {conv.customerName?.[0] || conv.customerPhone?.slice(-2) || "?"}
                    </span>
                  </div>
                  {conv.channel === "voice" && (
                    <div className="absolute -bottom-0.5 -right-0.5 bg-purple-500 rounded-full p-0.5" title="Llamada de voz">
                      <Phone className="h-2.5 w-2.5 text-white" />
                    </div>
                  )}
                  {conv.channel === "web" && (
                    <div className="absolute -bottom-0.5 -right-0.5 bg-blue-500 rounded-full p-0.5" title="Chat web">
                      <MessageCircle className="h-2.5 w-2.5 text-white" />
                    </div>
                  )}
                  {conv.status === "with_agent" && conv.lastMessageSender === "customer" && (
                    <div className="absolute -top-0.5 -right-0.5 h-3 w-3 bg-orange-400 rounded-full border-2 border-background" title="Esperando respuesta del agente" />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {conv.botBrand && (
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${brandColors[conv.botBrand] || "bg-muted text-muted-foreground"}`}>
                        {conv.botBrand}
                      </span>
                    )}
                    <p className="font-medium text-sm md:text-base truncate">
                      {conv.customerName || conv.customerPhone}
                    </p>
                  </div>
                  <p className="text-xs md:text-sm text-gray-500 truncate">
                    {conv.customerPhone}
                    {conv.botCategory && <span className="text-gray-400"> · {conv.botCategory}</span>}
                  </p>
                  {conv.lastMessagePreview && (
                    <p className="text-xs text-gray-400 truncate max-w-[200px] md:max-w-[300px]">
                      &ldquo;{conv.lastMessagePreview}&rdquo;
                    </p>
                  )}
                  <p className="text-[10px] md:text-xs text-gray-400 flex items-center gap-1 mt-0.5">
                    {conv.status === "with_agent" && conv.assignedAgentId ? (
                      <><UserCircle className="h-3 w-3" />{agentNames[conv.assignedAgentId] || "Agente"}</>
                    ) : conv.status === "bot" && conv.botName ? (
                      <><Bot className="h-3 w-3" />{conv.botName}</>
                    ) : null}
                  </p>
                  {(
                    <div className="flex flex-wrap gap-1 mt-1">
                      {resolveDirection(conv) === "outbound" ? (
                        <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/30 dark:text-fuchsia-300" title="Outbound">
                          <ArrowUpFromLine className="h-2.5 w-2.5" />
                        </span>
                      ) : (
                        <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300" title="Inbound">
                          <ArrowDownToLine className="h-2.5 w-2.5" />
                        </span>
                      )}
                      {conv.broadcastName && (
                        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300">
                          <Megaphone className="h-2.5 w-2.5" />
                          {conv.broadcastName}
                        </span>
                      )}
                      {conv.labelIds?.map((lid) => {
                        const label = orgLabels[lid];
                        if (!label) return null;
                        const colors = LABEL_COLORS[label.color] || LABEL_COLORS.gray;
                        return (
                          <span key={lid} className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${colors.bg} ${colors.text}`}>
                            {label.name}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex flex-col md:flex-row items-end md:items-center gap-1 md:gap-4 flex-shrink-0">
                {(() => {
                  const outcome = conv.conversationOutcome;
                  // Cuando el outcome ya es una cita, reemplaza al badge de appointmentStatus
                  // en vez de duplicarlo (dirían lo mismo).
                  if (outcome && TERMINAL_OUTCOMES.includes(outcome)) {
                    return (
                      <span className={`px-2 py-1 rounded-full text-[10px] md:text-xs font-medium whitespace-nowrap ${OUTCOME_COLORS[outcome]}`}>
                        {OUTCOME_LABELS[outcome]}
                      </span>
                    );
                  }
                  const appt = conv.appointmentStatus;
                  return (
                    <>
                      {(!appt || appt === "sin_cita") ? (
                        <span className="px-2 py-1 rounded-full text-[10px] md:text-xs font-medium whitespace-nowrap bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                          Sin Cita
                        </span>
                      ) : appt === "cita_bot" ? (
                        <span className="px-2 py-1 rounded-full text-[10px] md:text-xs font-medium whitespace-nowrap bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300">
                          Cita con Bot
                        </span>
                      ) : (
                        <span className="px-2 py-1 rounded-full text-[10px] md:text-xs font-medium whitespace-nowrap bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300">
                          Cita con Agente
                        </span>
                      )}
                      {outcome && (
                        <span className={`px-2 py-1 rounded-full text-[10px] md:text-xs font-medium whitespace-nowrap ${OUTCOME_COLORS[outcome]}`}>
                          {OUTCOME_LABELS[outcome]}
                        </span>
                      )}
                    </>
                  );
                })()}
                <span
                  className={`px-2 py-1 rounded-full text-[10px] md:text-xs font-medium whitespace-nowrap ${
                    statusColors[conv.status]
                  }`}
                >
                  {statusLabels[conv.status]}
                  {conv.status === "closed" && conv.closedReason && (
                    <span> · {
                      conv.closedReason === "resolved" ? "Resuelto" :
                      conv.closedReason === "not_interested" ? "No interesado" :
                      conv.closedReason === "duplicate" ? "Duplicado" :
                      conv.closedReason === "no_response" ? "Sin respuesta" :
                      conv.closedReason === "inactivity" ? "Inactividad" :
                      conv.closedReason
                    }</span>
                  )}
                </span>
                <div className="flex items-center gap-1.5">
                  {(conv.status === "waiting_agent" || (conv.status === "with_agent" && conv.lastMessageSender === "customer")) && (() => {
                    const color = getSemaphoreColor(conv.lastMessageAt);
                    if (!color) return null;
                    const colorClass = color === "green" ? "text-green-500" : color === "yellow" ? "text-yellow-500" : "text-red-500";
                    return <Clock className={`h-3.5 w-3.5 flex-shrink-0 ${colorClass}`} />;
                  })()}
                  <span className="text-[10px] md:text-sm text-gray-500 whitespace-nowrap">
                    {formatTime(conv.lastMessageAt)}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  };

  if (!userData?.organizationId) {
    return (
      <div>
        <div className="mb-8">
          <h1 className="text-2xl font-bold">Conversaciones</h1>
          <p className="text-gray-500">
            Gestiona las conversaciones de WhatsApp
          </p>
        </div>
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-gray-500">
              Necesitas pertenecer a una organización para ver conversaciones.
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
      <div className="flex flex-col gap-4 mb-6 md:mb-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl md:text-2xl font-bold">Conversaciones</h1>
            <p className="text-gray-500 text-sm hidden md:block">
              Gestiona las conversaciones de WhatsApp
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Team filter - only for SuperAdmin with multiple teams */}
            {canSwitchTeams && (
              <Select value={selectedTeamId} onValueChange={setSelectedTeamId}>
                <SelectTrigger className="w-[140px] md:w-[180px]">
                  <SelectValue placeholder="Todos los equipos" />
                </SelectTrigger>
                <SelectContent>
                  {!vertical && <SelectItem value="all">Todos los equipos</SelectItem>}
                  {teams.map((team) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {/* View switcher */}
            <div className="flex border rounded-lg">
              <Button
                variant={viewMode === "list" ? "default" : "ghost"}
                size="icon"
                className="rounded-r-none"
                onClick={() => handleViewChange("list")}
                title="Vista lista"
              >
                <List className="h-4 w-4" />
              </Button>
              <Button
                variant={viewMode === "kanban" ? "default" : "ghost"}
                size="icon"
                className="rounded-none border-x hidden md:flex"
                onClick={() => handleViewChange("kanban")}
                title="Vista kanban"
              >
                <Columns className="h-4 w-4" />
              </Button>
              <Button
                variant={viewMode === "converse" ? "default" : "ghost"}
                size="icon"
                className="rounded-l-none"
                onClick={() => handleViewChange("converse")}
                title="Vista conversacion"
              >
                <MessageCircle className="h-4 w-4" />
              </Button>
            </div>
            {/* Sound toggle */}
            <Button
              variant={soundEnabled ? "default" : "outline"}
              onClick={() => setSoundEnabled(!soundEnabled)}
              title={soundEnabled ? "Notificaciones activadas" : "Notificaciones desactivadas"}
            >
              {soundEnabled ? (
                <Bell className="h-4 w-4" />
              ) : (
                <BellOff className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Kanban view */}
      {viewMode === "kanban" && userData.organizationId && (
        hasNoTeamAccess ? (
          <div className="text-center py-12 text-muted-foreground text-sm">
            No tienes un equipo asignado. Contacta a tu administrador.
          </div>
        ) : (
          <KanbanBoard
            organizationId={userData.organizationId}
            teamId={effectiveTeamId && effectiveTeamId !== "all" ? effectiveTeamId : undefined}
          />
        )
      )}

      {/* Converse view */}
      {viewMode === "converse" && userData.organizationId && user && (
        hasNoTeamAccess ? (
          <div className="text-center py-12 text-muted-foreground text-sm">
            No tienes un equipo asignado. Contacta a tu administrador.
          </div>
        ) : (
          <ConverseView
            organizationId={userData.organizationId}
            teamId={effectiveTeamId && effectiveTeamId !== "all" ? effectiveTeamId : undefined}
            userId={user.uid}
            userRole={userData.role}
          />
        )
      )}

      {/* List view (original) */}
      {viewMode === "list" && (
      <>
      {hasNoTeamAccess ? (
        <div className="text-center py-12 text-muted-foreground text-sm">
          No tienes un equipo asignado. Contacta a tu administrador.
        </div>
      ) : <>
      {/* Search + Filters button */}
      {(() => {
        const activeFilterCount =
          selectedLabelIds.length +
          selectedSemaphoreColors.length +
          selectedAgentIds.length +
          (selectedDatePreset || dateFrom || dateTo || dateSearchResults ? 1 : 0) +
          selectedAppointmentStatuses.length +
          selectedCampaigns.length +
          selectedDirections.length +
          selectedOutcomes.length;
        return (
          <div className="flex gap-2 mb-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Buscar por nombre o telefono..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => loadSearchCache()}
                className="pl-10"
              />
            </div>
            <Button
              variant={activeFilterCount > 0 ? "default" : "outline"}
              onClick={() => setFiltersOpen((v) => !v)}
              className="flex items-center gap-1.5 flex-shrink-0"
            >
              <SlidersHorizontal className="h-4 w-4" />
              <span className="hidden md:inline">Filtros</span>
              {activeFilterCount > 0 && (
                <span className="ml-0.5 bg-white text-black text-[10px] font-bold rounded-full h-4 w-4 flex items-center justify-center">
                  {activeFilterCount}
                </span>
              )}
            </Button>
          </div>
        );
      })()}

      {/* Unified filter panel */}
      {filtersOpen && (() => {
        const toggleSection = (s: string) => setOpenFilterSection((prev) => prev === s ? null : s);
        const SectionHeader = ({ id, icon, label, activeCount }: { id: string; icon: React.ReactNode; label: string; activeCount: number }) => (
          <button
            onClick={() => toggleSection(id)}
            className="w-full flex items-center justify-between py-2 text-xs font-medium text-foreground hover:text-foreground/80 transition-colors"
          >
            <span className="flex items-center gap-1.5">
              {icon}
              {label}
              {activeCount > 0 && (
                <span className="ml-1 bg-primary text-primary-foreground text-[10px] font-bold rounded-full h-4 w-4 flex items-center justify-center">
                  {activeCount}
                </span>
              )}
            </span>
            {openFilterSection === id ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
          </button>
        );

        return (
          <div className="mb-4 border rounded-lg bg-card divide-y">

            {/* Etiquetas */}
            {Object.keys(orgLabels).length > 0 && (
              <div className="px-4">
                <SectionHeader id="labels" icon={<Tag className="h-3.5 w-3.5" />} label="Etiquetas" activeCount={selectedLabelIds.length} />
                {openFilterSection === "labels" && (
                  <div className="flex flex-wrap gap-1.5 pb-3">
                    {Object.values(orgLabels)
                      .filter((l) => !effectiveTeamId || effectiveTeamId === "all" || l.teamId === effectiveTeamId)
                      .map((label) => {
                        const colors = LABEL_COLORS[label.color] || LABEL_COLORS.gray;
                        const active = selectedLabelIds.includes(label.id);
                        return (
                          <button key={label.id} onClick={() => setSelectedLabelIds((prev) => active ? prev.filter((id) => id !== label.id) : [...prev, label.id])}
                            className={`px-2 py-0.5 rounded-full text-xs font-medium border transition-all ${colors.bg} ${colors.text} ${active ? "ring-2 ring-offset-1 ring-gray-400" : "opacity-60 hover:opacity-100"}`}>
                            {label.name}
                          </button>
                        );
                      })}
                  </div>
                )}
              </div>
            )}

            {/* Campaña */}
            {availableCampaigns.length > 0 && (
              <div className="px-4">
                <SectionHeader id="campaigns" icon={<Megaphone className="h-3.5 w-3.5" />} label="Campaña" activeCount={selectedCampaigns.length} />
                {openFilterSection === "campaigns" && (
                  <div className="flex flex-wrap gap-1.5 pb-3">
                    {availableCampaigns.map((name) => {
                      const active = selectedCampaigns.includes(name);
                      return (
                        <button key={name} onClick={() => setSelectedCampaigns((prev) => active ? prev.filter((n) => n !== name) : [...prev, name])}
                          className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border transition-all bg-indigo-50 text-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800 ${active ? "ring-2 ring-offset-1 ring-gray-400 opacity-100" : "opacity-60 hover:opacity-100"}`}>
                          <Megaphone className="h-3 w-3" />
                          {name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Origen */}
            <div className="px-4">
              <SectionHeader id="direction" icon={<ArrowDownToLine className="h-3.5 w-3.5" />} label="Origen" activeCount={selectedDirections.length} />
              {openFilterSection === "direction" && (
                <div className="flex flex-wrap gap-1.5 pb-3">
                  {([
                    { value: "inbound" as const, label: "Inbound", icon: ArrowDownToLine, cls: "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-900/20 dark:text-sky-300" },
                    { value: "outbound" as const, label: "Outbound", icon: ArrowUpFromLine, cls: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-900/20 dark:text-fuchsia-300" },
                  ]).map(({ value, label, icon: Icon, cls }) => {
                    const active = selectedDirections.includes(value);
                    return (
                      <button key={value} onClick={() => setSelectedDirections((prev) => active ? prev.filter((d) => d !== value) : [...prev, value])}
                        className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border transition-all ${cls} ${active ? "ring-2 ring-offset-1 ring-gray-400 opacity-100" : "opacity-60 hover:opacity-100"}`}>
                        <Icon className="h-3 w-3" />
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Etiqueta de conversación */}
            <div className="px-4">
              <SectionHeader id="outcome" icon={<Tag className="h-3.5 w-3.5" />} label="Etiqueta de conversación" activeCount={selectedOutcomes.length} />
              {openFilterSection === "outcome" && (
                <div className="pb-3 space-y-2">
                  <div className="flex gap-1">
                    {([
                      { value: "current" as const, label: "Etiqueta actual" },
                      { value: "everContained" as const, label: "En algún momento" },
                    ]).map(({ value, label }) => {
                      const active = outcomeFilterMode === value;
                      return (
                        <button key={value} onClick={() => setOutcomeFilterMode(value)}
                          className={`px-2 py-0.5 rounded-full text-[11px] font-medium border transition-all ${active ? "bg-primary text-primary-foreground border-primary" : "bg-muted text-muted-foreground border-transparent opacity-70 hover:opacity-100"}`}>
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {OUTCOME_VALUES.map((value) => {
                      const active = selectedOutcomes.includes(value);
                      return (
                        <button key={value} onClick={() => setSelectedOutcomes((prev) => active ? prev.filter((s) => s !== value) : [...prev, value])}
                          className={`px-2 py-0.5 rounded-full text-xs font-medium border transition-all ${OUTCOME_COLORS[value]} ${active ? "ring-2 ring-offset-1 ring-gray-400 opacity-100" : "opacity-60 hover:opacity-100"}`}>
                          {OUTCOME_LABELS[value]}
                        </button>
                      );
                    })}
                    {/* "Sin clasificar" solo aplica al modo "actual" — en "en algún momento" la ausencia de historial ya cubre ese caso */}
                    {outcomeFilterMode === "current" && (() => {
                      const value = "sin_clasificar" as const;
                      const active = selectedOutcomes.includes(value);
                      return (
                        <button onClick={() => setSelectedOutcomes((prev) => active ? prev.filter((s) => s !== value) : [...prev, value])}
                          className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border transition-all bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-300 ${active ? "ring-2 ring-offset-1 ring-gray-400 opacity-100" : "opacity-60 hover:opacity-100"}`}>
                          <HelpCircle className="h-3 w-3" />
                          Sin clasificar
                        </button>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>

            {/* Urgencia */}
            {semaphoreThresholds && (
              <div className="px-4">
                <SectionHeader id="urgency" icon={<Clock className="h-3.5 w-3.5" />} label="Urgencia" activeCount={selectedSemaphoreColors.length} />
                {openFilterSection === "urgency" && (
                  <div className="flex flex-wrap gap-1.5 pb-3">
                    {(["green", "yellow", "red"] as const).map((color) => {
                      const active = selectedSemaphoreColors.includes(color);
                      const label = color === "green" ? "Verde" : color === "yellow" ? "Amarillo" : "Rojo";
                      const colorClass = color === "green"
                        ? "text-green-600 border-green-300 bg-green-50 dark:bg-green-900/20 dark:text-green-400"
                        : color === "yellow"
                        ? "text-yellow-600 border-yellow-300 bg-yellow-50 dark:bg-yellow-900/20 dark:text-yellow-400"
                        : "text-red-600 border-red-300 bg-red-50 dark:bg-red-900/20 dark:text-red-400";
                      return (
                        <button key={color} onClick={() => setSelectedSemaphoreColors((prev) => active ? prev.filter((c) => c !== color) : [...prev, color])}
                          className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border transition-all ${colorClass} ${active ? "ring-2 ring-offset-1 ring-gray-400" : "opacity-60 hover:opacity-100"}`}>
                          <Clock className={`h-3 w-3 ${color === "green" ? "text-green-500" : color === "yellow" ? "text-yellow-500" : "text-red-500"}`} />
                          {label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Agentes */}
            {Object.keys(agentNames).length > 0 && (
              <div className="px-4">
                <SectionHeader id="agents" icon={<Users className="h-3.5 w-3.5" />} label="Agentes" activeCount={selectedAgentIds.length} />
                {openFilterSection === "agents" && (
                  <div className="flex flex-wrap gap-1.5 pb-3">
                    {Object.entries(agentNames).map(([uid, name]) => {
                      const active = selectedAgentIds.includes(uid);
                      return (
                        <button key={uid} onClick={() => setSelectedAgentIds((prev) => active ? prev.filter((id) => id !== uid) : [...prev, uid])}
                          className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border transition-all bg-muted text-muted-foreground ${active ? "ring-2 ring-offset-1 ring-gray-400 opacity-100" : "opacity-60 hover:opacity-100"}`}>
                          <UserCircle className="h-3 w-3" />
                          {name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Fecha */}
            <div className="px-4">
              <SectionHeader id="date" icon={<Calendar className="h-3.5 w-3.5" />} label="Fecha" activeCount={selectedDatePreset || dateFrom || dateTo || dateSearchResults ? 1 : 0} />
              {openFilterSection === "date" && (
                <div className="flex flex-wrap gap-1.5 items-center pb-3">
                  {(["today", "yesterday", "week", "month"] as const).map((preset) => {
                    const labels = { today: "Hoy", yesterday: "Ayer", week: "Esta semana", month: "Este mes" };
                    const active = selectedDatePreset === preset;
                    return (
                      <button key={preset} onClick={() => { setSelectedDatePreset(active ? null : preset); setDateFrom(""); setDateTo(""); setDateSearchResults(null); lastDateDocRef.current = null; }}
                        className={`px-2 py-0.5 rounded-full text-xs font-medium border transition-all bg-muted text-muted-foreground ${active ? "ring-2 ring-offset-1 ring-gray-400 opacity-100" : "opacity-60 hover:opacity-100"}`}>
                        {labels[preset]}
                      </button>
                    );
                  })}
                  <input type="date" value={dateFrom}
                    onChange={(e) => { setDateFrom(e.target.value); setSelectedDatePreset(null); setDateSearchResults(null); lastDateDocRef.current = null; }}
                    className="text-xs border rounded px-2 py-0.5 bg-background text-foreground" title="Desde" />
                  <span className="text-xs text-gray-400">—</span>
                  <input type="date" value={dateTo}
                    onChange={(e) => { setDateTo(e.target.value); setSelectedDatePreset(null); setDateSearchResults(null); lastDateDocRef.current = null; }}
                    className="text-xs border rounded px-2 py-0.5 bg-background text-foreground" title="Hasta" />
                  <button onClick={() => searchByDate()} disabled={dateSearching || (!selectedDatePreset && !dateFrom && !dateTo)}
                    className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 border-blue-200 hover:opacity-90 disabled:opacity-40 transition-all">
                    {dateSearching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
                    Buscar
                  </button>
                  {dateSearchResults && <span className="text-[10px] text-muted-foreground">{dateSearchResults.length} resultados</span>}
                </div>
              )}
            </div>

            {/* Estatus de cita */}
            <div className="px-4">
              <SectionHeader id="appointment" icon={<CalendarCheck className="h-3.5 w-3.5" />} label="Estatus de cita" activeCount={selectedAppointmentStatuses.length} />
              {openFilterSection === "appointment" && (
                <div className="flex flex-wrap gap-1.5 pb-3">
                  {([
                    { value: "sin_cita", label: "Sin Cita", cls: "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-300" },
                    { value: "cita_bot", label: "Cita con Bot", cls: "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/20 dark:text-purple-300" },
                    { value: "cita_agente", label: "Cita con Agente", cls: "bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-900/20 dark:text-teal-300" },
                  ] as const).map(({ value, label, cls }) => {
                    const active = selectedAppointmentStatuses.includes(value);
                    return (
                      <button key={value} onClick={() => setSelectedAppointmentStatuses((prev) => active ? prev.filter((s) => s !== value) : [...prev, value])}
                        className={`px-2 py-0.5 rounded-full text-xs font-medium border transition-all ${cls} ${active ? "ring-2 ring-offset-1 ring-gray-400 opacity-100" : "opacity-60 hover:opacity-100"}`}>
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Limpiar todo */}
            <div className="px-4 py-2">
              <button
                onClick={() => { setSelectedLabelIds([]); setSelectedSemaphoreColors([]); setSelectedAgentIds([]); setSelectedDatePreset(null); setDateFrom(""); setDateTo(""); setDateSearchResults(null); setSelectedAppointmentStatuses([]); setSelectedCampaigns([]); setSelectedDirections([]); setSelectedOutcomes([]); setOutcomeFilterMode("current"); lastDateDocRef.current = null; }}
                className="text-xs text-gray-400 hover:text-gray-600 underline"
              >
                Limpiar todos los filtros
              </button>
            </div>
          </div>
        );
      })()}

      {/* Search results or normal tabs */}
      {searchQuery.trim() ? (
        <div className="mt-4">
          {searching ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-gray-400 mr-2" />
              <span className="text-gray-500 text-sm">Buscando...</span>
            </div>
          ) : searchResults && searchResults.length > 0 ? (
            <>
              <p className="text-sm text-gray-500 mb-3">
                {searchResults.length} resultado{searchResults.length !== 1 ? "s" : ""}
              </p>
              <ConversationList convs={searchResults} />
            </>
          ) : searchResults !== null ? (
            <div className="text-center py-8">
              <p className="text-gray-500">No se encontraron conversaciones para &ldquo;{searchQuery}&rdquo;</p>
              <p className="text-xs text-gray-400 mt-2">¿Buscas algo más antiguo? Usa el filtro de fecha para buscar en más historial.</p>
            </div>
          ) : null}
        </div>
      ) : (
      <>
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="w-full overflow-x-auto justify-start md:justify-center">
          <TabsTrigger value="all">
            Todas
            <Badge variant="secondary" className="ml-2">
              {totalActiveCount}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="pending">
            Pendientes
            {pendingReplyCount > 0 && (
              <Badge className="ml-2 bg-orange-400 hover:bg-orange-400">
                {pendingReplyCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="waiting">
            Esperando
            {waitingCount > 0 && (
              <Badge variant="destructive" className="ml-2">
                {waitingCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="active">
            Con Agente
            {activeCount > 0 && (
              <Badge variant="secondary" className="ml-2">
                {activeCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="bot">
            Con Bot
            {botCount > 0 && (
              <Badge variant="secondary" className="ml-2">
                {botCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="closed">
            Cerradas
            {closedCount > 0 && (
              <Badge variant="secondary" className="ml-2">
                {closedCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="mt-4">
          <ConversationList convs={filteredConversations} />
        </TabsContent>

        <TabsContent value="pending" className="mt-4">
          <ConversationList convs={filteredConversations} />
        </TabsContent>

        <TabsContent value="waiting" className="mt-4">
          <ConversationList convs={filteredConversations} />
        </TabsContent>

        <TabsContent value="active" className="mt-4">
          <ConversationList convs={filteredConversations} />
        </TabsContent>

        <TabsContent value="bot" className="mt-4">
          <ConversationList convs={filteredConversations} />
        </TabsContent>

        <TabsContent value="closed" className="mt-4">
          <ConversationList convs={filteredConversations} />
        </TabsContent>
      </Tabs>

      {/* Load more — respeta el tab de estatus activo */}
      {dateSearchResults !== null ? (
        hasMoreByStatus && activeTab !== "all"
          ? (
            <div className="flex justify-center mt-4">
              <Button variant="outline" onClick={() => searchByDate(true)} disabled={dateSearching}>
                {dateSearching && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Cargar más
              </Button>
            </div>
          )
          : activeTab === "all" && dateSearchResults.length >= 50 && (
            <div className="flex justify-center mt-4">
              <Button variant="outline" onClick={() => searchByDate(true)} disabled={dateSearching}>
                {dateSearching && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Cargar más
              </Button>
            </div>
          )
      ) : activeTab === "all" ? (
        conversations.length >= conversationsLimit && (
          <div className="flex justify-center mt-4">
            <Button variant="outline" onClick={() => setConversationsLimit((prev) => prev + 50)}>
              Cargar más
            </Button>
          </div>
        )
      ) : (
        hasMoreByStatus && (
          <div className="flex justify-center mt-4">
            <Button variant="outline" onClick={loadMoreByStatus} disabled={loadingMoreByStatus}>
              {loadingMoreByStatus && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Cargar más
            </Button>
          </div>
        )
      )}
      </>
      )}
      </>}
      </>
      )}
    </div>
  );
}
