"use client";

/**
 * Conversaciones de Valuación. Sigue el mismo patrón que las conversaciones de
 * Ventas y Servicio (HubConversationsPage, KanbanBoard, ConverseView y ConversationChat).
 *
 * Las pestañas, el kanban y la bandeja usan el estatus de la CONVERSACIÓN
 * (Con Bot / Esperando / Con Agente / Cerrada), igual que en los otros módulos.
 * El estatus de la OFERTA es otro dato: se muestra aparte y tiene su propio filtro.
 */

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, Bot, Calendar, ChevronDown, ChevronRight, Columns, FileText, HelpCircle, History, List, MessageCircle,
  MessageSquare, Phone, Search, Send, SlidersHorizontal, Tag, User, UserCircle, Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  AGENCIES, STATUSES, VALUADORES, agencyName, conversationOf, fmtDate, fmtMoney, useValuacion,
  type ClosedReason, type Conversation, type ConvStatus, type Offer, type Status,
} from "@/lib/valuacion/store";
import { useValuacionHref } from "@/lib/valuacion/base";
import { OfferDetail, StatusPill } from "./common";

// ---------- Estatus de la conversación (mismos textos y colores que Ventas y Servicio) ----------

const statusLabels: Record<ConvStatus, string> = { bot: "Con Bot", waiting_agent: "Esperando", with_agent: "Con Agente", closed: "Cerrada" };
const shortLabels: Record<ConvStatus, string> = { ...statusLabels, bot: "Bot" };
const statusColors: Record<ConvStatus, string> = {
  bot: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  waiting_agent: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  with_agent: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  closed: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
};
const closedLabels: Record<ClosedReason, string> = { resolved: "Resuelto", not_interested: "No interesado", no_response: "Sin respuesta" };

/** Oferta enviada + su conversación. */
type Conv = Offer & { conv: Conversation };
const isPending = (c: Conv) => c.conv.status === "with_agent" && c.conv.lastSender === "customer";

type Tab = "all" | "pending" | "waiting" | "active" | "bot" | "closed";
const inTab = (t: Tab, c: Conv) => {
  const s = c.conv.status;
  if (t === "all") return s !== "closed";
  if (t === "pending") return isPending(c);
  if (t === "waiting") return s === "waiting_agent";
  if (t === "active") return s === "with_agent";
  if (t === "bot") return s === "bot";
  return s === "closed";
};

/** Enlace a la ficha (respeta la ruta base: HUB o demo). */
function useDetailPath() { const href = useValuacionHref(); return (id: string) => href(`/conversaciones/${id}`); }
const PAGE = 50;
const OFFER_STATUSES = STATUSES.filter((s) => !["pendiente", "guardada", "incompleto", "no_cumple"].includes(s.id));

function ConvBadge({ conv, short, className }: { conv: Conversation; short?: boolean; className?: string }) {
  return (
    <span className={cn("px-2 py-1 rounded-full text-[11px] md:text-xs font-medium whitespace-nowrap", statusColors[conv.status], className)}>
      {(short ? shortLabels : statusLabels)[conv.status]}
      {conv.status === "closed" && conv.closedReason && !short && <span> · {closedLabels[conv.closedReason]}</span>}
    </span>
  );
}

// ---------- Mensajes inventados ----------

type Msg = { who: "bot" | "client" | "agent" | "sys"; text: string; at: string };

function messagesFor(o: Conv): Msg[] {
  const first = o.customer.split(" ")[0];
  const sent = fmtDate(o.sentAt!);
  const ms: Msg[] = [
    { who: "bot", at: "10:02", text: `Hola ${first}, te saluda ${agencyName(o.agencyId)}. Vimos que tienes cita de servicio el ${fmtDate(o.apptDate)} a las ${o.apptTime} para tu ${o.intelimotorModel.split(" ")[0]} ${o.year}.` },
    { who: "bot", at: "10:02", text: `Con base en el mercado, podríamos ofrecerte hasta ${fmtMoney(o.amount)} por tu unidad. ¿Te gustaría que un valuador la revise durante tu cita? Responde SÍ o NO.` },
  ];
  if (o.interestAt) {
    ms.push({ who: "client", at: `${fmtDate(o.interestAt)} 18:21`, text: "Sí, me interesa. ¿Tengo que llevar algo?" });
    if (o.conv.agent) ms.push({ who: "agent", at: `${fmtDate(o.interestAt)} 18:40`, text: `Hola ${first}, soy ${o.conv.agent}, valuador de ${agencyName(o.agencyId)}. Solo trae la factura y tu identificación; reviso tu unidad durante la cita.` });
    if (o.conv.lastSender === "customer" && o.conv.status !== "closed") ms.push({ who: "client", at: `${fmtDate(o.interestAt)} 19:05`, text: "Perfecto. ¿La revisión tarda mucho?" });
  }
  if (o.inspectedAt) ms.push({ who: "sys", at: "", text: `Inspección realizada el ${fmtDate(o.inspectedAt)}` });
  if (o.finalAmount !== null) ms.push({ who: "sys", at: "", text: `Oferta final registrada: ${fmtMoney(o.finalAmount)}` });
  if (o.acceptedAt) ms.push({ who: "sys", at: "", text: "El cliente aceptó la oferta" });
  if (o.status === "rechazada_cliente" && o.finalAmount === null) ms.push({ who: "client", at: `${sent} 19:12`, text: "No, gracias. Por ahora no pienso vender." });
  if (o.status === "seguimiento") ms.push({ who: "bot", at: `${sent} 18:00`, text: `${first}, ¿pudiste revisar nuestra propuesta? Con gusto te apoyamos en tu cita.` });
  if (o.conv.status === "closed") ms.push({ who: "sys", at: "", text: `Conversación cerrada · ${closedLabels[o.conv.closedReason ?? "resolved"]}` });
  return ms;
}
const lastPreview = (o: Conv) => [...messagesFor(o)].reverse().find((m) => m.who !== "sys")?.text ?? "";
const senderLabel = (o: Conv, who: Msg["who"]) => (who === "client" ? "Cliente" : who === "agent" ? o.conv.agent ?? "Valuador" : "Bot de valuación");

/** Etiqueta de marca, como en las tarjetas de los otros módulos. */
function Brand() {
  return <span className="px-1.5 py-0.5 rounded text-[11px] font-medium flex-shrink-0 bg-muted text-foreground">Toyota</span>;
}

function Avatar({ o, small }: { o: Conv; small?: boolean }) {
  return (
    <div className="relative flex-shrink-0">
      <div className={cn("rounded-full bg-muted flex items-center justify-center", small ? "h-8 w-8" : "h-9 w-9 md:h-10 md:w-10")} aria-hidden="true">
        <span className="text-xs md:text-sm font-medium">{o.customer[0]}</span>
      </div>
      {isPending(o) && <div className="absolute -top-0.5 -right-0.5 h-3 w-3 bg-orange-400 rounded-full border-2 border-background" title="Esperando respuesta del valuador" />}
    </div>
  );
}

/** Quién atiende: valuador o bot (como la línea del agente/bot en los otros módulos). */
function Handler({ o }: { o: Conv }) {
  if (o.conv.status === "with_agent" && o.conv.agent) return <><UserCircle className="h-3 w-3" aria-hidden="true" />{o.conv.agent}</>;
  if (o.conv.status === "bot") return <><Bot className="h-3 w-3" aria-hidden="true" />Bot de valuación</>;
  return null;
}

// ---------- Vista lista ----------

function ConversationList({ convs }: { convs: Conv[] }) {
  const detailPath = useDetailPath();
  return (
    <div className="space-y-2">
      {convs.map((o) => (
        <Link key={o.id} href={detailPath(o.id)} className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Card className={cn("cursor-pointer hover:bg-accent transition-colors py-0", isPending(o) && "border-l-4 border-l-orange-400")}>
            <CardContent className="flex items-center justify-between py-3 md:py-4 gap-2">
              <div className="flex items-center gap-3 md:gap-4 min-w-0">
                <Avatar o={o} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Brand />
                    <p className="font-medium text-sm md:text-base truncate">{o.customer}</p>
                  </div>
                  <p className="text-xs md:text-sm text-muted-foreground truncate">{o.phone}<span> · {o.intelimotorModel} · {fmtMoney(o.amount)}</span></p>
                  <p className="text-xs text-muted-foreground truncate max-w-[200px] md:max-w-[300px]">&ldquo;{lastPreview(o)}&rdquo;</p>
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5"><Handler o={o} /></p>
                </div>
              </div>
              <div className="flex flex-col md:flex-row items-end md:items-center gap-1 md:gap-4 flex-shrink-0">
                {/* El estatus de la oferta va aparte, como la etiqueta de cita/resultado en los otros módulos */}
                <span className="flex items-center gap-1 text-xs text-muted-foreground"><span className="hidden lg:inline">Oferta:</span><StatusPill status={o.status} /></span>
                <ConvBadge conv={o.conv} />
                <span className="text-xs md:text-sm text-muted-foreground whitespace-nowrap">{fmtDate(o.sentAt!)}</span>
              </div>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}

/** Sección plegable del panel de filtros, igual que en los otros módulos. */
function FilterSection({ id, icon, label, count, open, onToggle, children }: {
  id: string; icon: ReactNode; label: string; count: number; open: boolean; onToggle: () => void; children: ReactNode;
}) {
  return (
    <div className="px-4">
      <button
        type="button" onClick={onToggle} aria-expanded={open} aria-controls={`vf-${id}`}
        className="w-full flex items-center justify-between py-2 min-h-9 text-xs font-medium text-foreground hover:text-foreground/80 transition-colors"
      >
        <span className="flex items-center gap-1.5">
          {icon}{label}
          {count > 0 && <span className="ml-1 bg-primary text-primary-foreground text-[11px] font-bold rounded-full h-4 min-w-4 px-1 flex items-center justify-center">{count}</span>}
        </span>
        {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />}
      </button>
      {open && <div id={`vf-${id}`} className="pb-3">{children}</div>}
    </div>
  );
}

function chipClass(active: boolean) {
  return `flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-all bg-muted text-muted-foreground ${active ? "ring-2 ring-offset-1 ring-ring opacity-100 text-foreground" : "opacity-70 hover:opacity-100"}`;
}

function ListView({ convs, agency }: { convs: Conv[]; agency: string }) {
  const [tab, setTab] = useState<Tab>("all");
  const [q, setQ] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [section, setSection] = useState<string | null>(null);
  const [offerStatuses, setOfferStatuses] = useState<Status[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const agentOptions = agency === "all" ? Object.values(VALUADORES).flat() : VALUADORES[agency] ?? [];
  // Todos los filtros menos la pestaña: sirve para la lista y para los contadores
  const preTab = useMemo(() => {
    const term = q.trim().toLowerCase();
    return convs
      .filter((o) => !offerStatuses.length || offerStatuses.includes(o.status))
      .filter((o) => !agents.length || (o.conv.agent !== null && agents.includes(o.conv.agent)))
      .filter((o) => (!from || o.sentAt! >= from) && (!to || o.sentAt! <= to))
      .filter((o) => !term || `${o.customer} ${o.phone} ${o.intelimotorModel}`.toLowerCase().includes(term));
  }, [convs, offerStatuses, agents, from, to, q]);
  const shown = preTab.filter((o) => inTab(tab, o));
  const count = (t: Tab) => preTab.filter((o) => inTab(t, o)).length;
  const pendingCount = count("pending"), waitingCount = count("waiting"), activeCount = count("active"), botCount = count("bot"), closedCount = count("closed");
  const activeFilters = offerStatuses.length + agents.length + (from || to ? 1 : 0);
  const toggle = <T,>(set: (f: (x: T[]) => T[]) => void, v: T) => set((x) => (x.includes(v) ? x.filter((y) => y !== v) : [...x, v]));
  const clearFilters = () => { setOfferStatuses([]); setAgents([]); setFrom(""); setTo(""); };
  const toggleSection = (s: string) => setSection((p) => (p === s ? null : s));

  return (
    <>
      <div className="flex gap-2 mb-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input type="search" aria-label="Buscar conversaciones por nombre, teléfono o modelo" placeholder="Buscar por nombre, teléfono o modelo..." value={q} onChange={(e) => setQ(e.target.value)} className="pl-10" />
        </div>
        <Button variant={activeFilters ? "default" : "outline"} onClick={() => setFiltersOpen((v) => !v)} aria-expanded={filtersOpen} className="flex items-center gap-1.5 flex-shrink-0">
          <SlidersHorizontal className="h-4 w-4" aria-hidden="true" /><span className="hidden md:inline">Filtros</span>
          {activeFilters > 0 && <span className="ml-0.5 bg-primary-foreground text-primary text-[11px] font-bold rounded-full h-4 min-w-4 px-1 flex items-center justify-center" aria-label={`${activeFilters} filtros activos`}>{activeFilters}</span>}
        </Button>
      </div>

      {filtersOpen && (
        <div className="mb-4 border rounded-lg bg-card divide-y">
          <FilterSection id="offer" icon={<Tag className="h-3.5 w-3.5" aria-hidden="true" />} label="Estatus de la oferta" count={offerStatuses.length} open={section === "offer"} onToggle={() => toggleSection("offer")}>
            <div className="flex flex-wrap gap-1.5">
              {OFFER_STATUSES.map((s) => (
                <button key={s.id} type="button" aria-pressed={offerStatuses.includes(s.id)} onClick={() => toggle(setOfferStatuses, s.id)} className={chipClass(offerStatuses.includes(s.id))}>{s.label}</button>
              ))}
            </div>
          </FilterSection>
          <FilterSection id="agents" icon={<Users className="h-3.5 w-3.5" aria-hidden="true" />} label="Valuadores" count={agents.length} open={section === "agents"} onToggle={() => toggleSection("agents")}>
            <div className="flex flex-wrap gap-1.5">
              {agentOptions.map((a) => (
                <button key={a} type="button" aria-pressed={agents.includes(a)} onClick={() => toggle(setAgents, a)} className={chipClass(agents.includes(a))}><UserCircle className="h-3 w-3" aria-hidden="true" />{a}</button>
              ))}
            </div>
          </FilterSection>
          <FilterSection id="date" icon={<Calendar className="h-3.5 w-3.5" aria-hidden="true" />} label="Fecha de envío" count={from || to ? 1 : 0} open={section === "date"} onToggle={() => toggleSection("date")}>
            <div className="flex flex-wrap gap-1.5 items-center">
              <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="Desde" className="text-xs border rounded px-2 py-1 bg-background text-foreground" />
              <span className="text-xs text-muted-foreground" aria-hidden="true">—</span>
              <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="Hasta" className="text-xs border rounded px-2 py-1 bg-background text-foreground" />
            </div>
          </FilterSection>
          <div className="px-4 py-2">
            <button type="button" onClick={clearFilters} className="text-xs text-muted-foreground hover:text-foreground underline">Limpiar todos los filtros</button>
          </div>
        </div>
      )}

      {/* Mismas pestañas, contadores y colores que Ventas y Servicio */}
      <Tabs value={tab} onValueChange={(v) => { setTab(v as Tab); setLimit(PAGE); }} className="w-full">
        <TabsList className="w-full overflow-x-auto justify-start md:justify-center">
          <TabsTrigger value="all">Todas<Badge variant="secondary" className="ml-2">{preTab.length - closedCount}</Badge></TabsTrigger>
          <TabsTrigger value="pending">Pendientes{pendingCount > 0 && <Badge className="ml-2 bg-orange-400 hover:bg-orange-400">{pendingCount}</Badge>}</TabsTrigger>
          <TabsTrigger value="waiting">Esperando{waitingCount > 0 && <Badge variant="destructive" className="ml-2">{waitingCount}</Badge>}</TabsTrigger>
          <TabsTrigger value="active">Con Agente{activeCount > 0 && <Badge variant="secondary" className="ml-2">{activeCount}</Badge>}</TabsTrigger>
          <TabsTrigger value="bot">Con Bot{botCount > 0 && <Badge variant="secondary" className="ml-2">{botCount}</Badge>}</TabsTrigger>
          <TabsTrigger value="closed">Cerradas{closedCount > 0 && <Badge variant="secondary" className="ml-2">{closedCount}</Badge>}</TabsTrigger>
        </TabsList>
        <div className="mt-4">
          {shown.length === 0 ? (
            <Card><CardContent className="flex flex-col items-center justify-center py-12">
              <div className="rounded-full bg-muted p-4 mb-4"><MessageSquare className="h-8 w-8 text-muted-foreground" aria-hidden="true" /></div>
              <h3 className="text-lg font-medium mb-2">No hay conversaciones</h3>
              {activeFilters > 0 || q.trim() ? (
                <Button variant="outline" onClick={() => { clearFilters(); setQ(""); }}>Limpiar filtros</Button>
              ) : <p className="text-muted-foreground text-center">Aparecen aquí cuando se envía una oferta.</p>}
            </CardContent></Card>
          ) : <ConversationList convs={shown.slice(0, limit)} />}
        </div>
      </Tabs>
      {shown.length > limit && (
        <div className="flex justify-center mt-4">
          <Button variant="outline" onClick={() => setLimit((l) => l + PAGE)}>Cargar más</Button>
        </div>
      )}
    </>
  );
}

// ---------- Vista kanban (columnas por quién atiende, como en los otros módulos) ----------

function Kanban({ convs }: { convs: Conv[] }) {
  const router = useRouter();
  const detailPath = useDetailPath();
  const open = convs.filter((o) => o.conv.status !== "closed");
  const byAgent = new Map<string, Conv[]>();
  open.forEach((o) => { if (o.conv.status === "with_agent" && o.conv.agent) byAgent.set(o.conv.agent, [...(byAgent.get(o.conv.agent) ?? []), o]); });
  const columns: { id: string; title: string; icon: ReactNode; items: Conv[] }[] = [];
  const unassigned = open.filter((o) => o.conv.status === "waiting_agent");
  if (unassigned.length) columns.push({ id: "unassigned", title: "Sin asignar", icon: <HelpCircle className="h-4 w-4" aria-hidden="true" />, items: unassigned });
  byAgent.forEach((items, name) => columns.push({ id: name, title: name, icon: <UserCircle className="h-4 w-4" aria-hidden="true" />, items }));
  const bot = open.filter((o) => o.conv.status === "bot");
  if (bot.length) columns.push({ id: "bot", title: "Bot", icon: <Bot className="h-4 w-4" aria-hidden="true" />, items: bot });

  if (columns.length === 0) return <div className="text-center py-12"><p className="text-muted-foreground">No hay conversaciones activas</p></div>;
  return (
    <div className="flex gap-4 overflow-x-auto pb-4" style={{ minHeight: "calc(100dvh - 280px)" }}>
      {columns.map((col) => (
        <section key={col.id} className="flex-shrink-0 w-80 bg-muted/50 rounded-lg p-3" aria-label={`${col.title}: ${col.items.length}`}>
          <div className="flex items-center gap-2 mb-3 px-1">
            {col.icon}<h3 className="font-medium text-sm">{col.title}</h3>
            <Badge variant="secondary" className="ml-auto">{col.items.length}</Badge>
          </div>
          <div className="space-y-2">
            {col.items.map((o) => (
              <Card key={o.id} className="cursor-pointer hover:bg-accent transition-colors py-0" onClick={() => router.push(detailPath(o.id))}>
                <CardContent className="p-3">
                  <div className="flex items-center justify-between mb-1 gap-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Brand />
                      <Link href={detailPath(o.id)} className="font-medium text-sm truncate hover:underline" onClick={(e) => e.stopPropagation()}>{o.customer}</Link>
                    </div>
                    <ConvBadge conv={o.conv} short className="px-1.5 py-0 ml-1 flex-shrink-0" />
                  </div>
                  <p className="text-xs text-muted-foreground">{o.phone}<span> · {o.intelimotorModel}</span></p>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">&ldquo;{lastPreview(o)}&rdquo;</p>
                  <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                    <span>{fmtDate(o.sentAt!)}</span><span className="ml-auto"><StatusPill status={o.status} /></span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ---------- Vista conversación ----------

const CONVERSE_FILTERS: ("all" | ConvStatus)[] = ["all", "waiting_agent", "with_agent", "bot", "closed"];

function Converse({ convs }: { convs: Conv[] }) {
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | ConvStatus>("all");
  const term = q.trim().toLowerCase();
  const list = convs
    .filter((o) => (filter === "all" ? o.conv.status !== "closed" : o.conv.status === filter))
    .filter((o) => !term || `${o.customer} ${o.phone}`.toLowerCase().includes(term));
  return (
    <div className="flex border rounded-lg overflow-hidden" style={{ height: "calc(100dvh - 280px)", minHeight: "500px" }}>
      <div className="w-[350px] max-w-[45%] flex-shrink-0 border-r flex flex-col bg-background">
        <div className="p-2 border-b">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            <Input type="search" aria-label="Buscar conversación" placeholder="Buscar..." value={q} onChange={(e) => setQ(e.target.value)} className="pl-8 h-8 text-sm" />
          </div>
        </div>
        <div className="flex gap-1 p-1.5 border-b overflow-x-auto" role="group" aria-label="Filtrar por estatus de la conversación">
          {CONVERSE_FILTERS.map((s) => (
            <Button key={s} variant={filter === s ? "default" : "ghost"} size="sm" aria-pressed={filter === s} className="text-xs px-2 h-7 flex-shrink-0" onClick={() => setFilter(s)}>
              {s === "all" ? "Todas" : shortLabels[s]}
            </Button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto">
          {list.length === 0 ? (
            <div className="text-center py-8">
              <MessageSquare className="h-8 w-8 text-muted-foreground mx-auto mb-2" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">Sin conversaciones</p>
            </div>
          ) : list.map((o) => (
            <button
              key={o.id} type="button" onClick={() => setSel(o.id)} aria-current={sel === o.id ? "true" : undefined}
              className={cn("w-full text-left flex items-center gap-2 p-2.5 border-b hover:bg-accent transition-colors", sel === o.id && "bg-primary/10 border-l-2 border-l-primary")}
            >
              <Avatar o={o} small />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0"><Brand /><p className="font-medium text-sm truncate">{o.customer}</p></div>
                  <ConvBadge conv={o.conv} short className="px-1.5 py-0 ml-2 flex-shrink-0" />
                </div>
                <p className="text-xs text-muted-foreground truncate">{o.phone}<span> · {o.intelimotorModel}</span></p>
                <p className="text-xs text-muted-foreground truncate">&ldquo;{lastPreview(o)}&rdquo;</p>
                <p className="text-xs text-muted-foreground">{fmtDate(o.sentAt!)}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 min-w-0 flex flex-col bg-background">
        {sel && convs.some((o) => o.id === sel) ? (
          <div className="flex-1 p-3 overflow-hidden"><ConversacionDetalle id={sel} compact /></div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <MessageSquare className="h-12 w-12 text-muted-foreground mx-auto mb-3" aria-hidden="true" />
              <p className="text-muted-foreground">Selecciona una conversación</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Listado (/valuacion/conversaciones) ----------

type View = "list" | "kanban" | "converse";

function useConversations(agency = "all"): Conv[] {
  const { offers } = useValuacion();
  return useMemo(
    () => offers
      .filter((o) => agency === "all" || o.agencyId === agency)
      .flatMap((o) => { const conv = conversationOf(o); return conv ? [{ ...o, conv }] : []; })
      .sort((a, b) => (b.sentAt! + b.id).localeCompare(a.sentAt! + a.id)),
    [offers, agency],
  );
}

export function ConversacionesView() {
  const [view, setView] = useState<View>("list");
  const [agency, setAgency] = useState("all");
  const convs = useConversations(agency);

  return (
    <div>
      <div className="flex flex-col gap-4 mb-6 md:mb-8">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-xl md:text-2xl font-bold">Conversaciones</h1>
            <p className="text-muted-foreground text-sm hidden md:block">Conversaciones de WhatsApp por las ofertas enviadas · prototipo con datos inventados</p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={agency} onValueChange={setAgency}>
              <SelectTrigger className="w-[140px] md:w-[180px]" aria-label="Agencia"><SelectValue placeholder="Todas las agencias" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas las agencias</SelectItem>
                {AGENCIES.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <div className="flex border rounded-lg" role="group" aria-label="Vista">
              <Button variant={view === "list" ? "default" : "ghost"} size="icon" className="rounded-r-none" onClick={() => setView("list")} title="Vista lista" aria-label="Vista lista" aria-pressed={view === "list"}><List className="h-4 w-4" aria-hidden="true" /></Button>
              <Button variant={view === "kanban" ? "default" : "ghost"} size="icon" className="rounded-none border-x hidden md:flex" onClick={() => setView("kanban")} title="Vista kanban" aria-label="Vista kanban" aria-pressed={view === "kanban"}><Columns className="h-4 w-4" aria-hidden="true" /></Button>
              <Button variant={view === "converse" ? "default" : "ghost"} size="icon" className="rounded-l-none" onClick={() => setView("converse")} title="Vista conversación" aria-label="Vista conversación" aria-pressed={view === "converse"}><MessageCircle className="h-4 w-4" aria-hidden="true" /></Button>
            </div>
          </div>
        </div>
      </div>

      {view === "kanban" && <Kanban convs={convs} />}
      {view === "converse" && <Converse convs={convs} />}
      {view === "list" && <ListView key={agency} convs={convs} agency={agency} />}
    </div>
  );
}

// ---------- Ficha de conversación (/valuacion/conversaciones/[id]) ----------

type DetailView = "messages" | "offer" | "history";
const DETAIL_TABS: { id: DetailView; label: string; icon: typeof FileText }[] = [
  { id: "messages", label: "Mensajes", icon: MessageSquare },
  { id: "offer", label: "Oferta", icon: FileText },
  { id: "history", label: "Historial", icon: History },
];

/** Mismo esquema que ConversationChat: encabezado, botones de vista, mensajes y caja de texto. */
export function ConversacionDetalle({ id, compact = false }: { id: string; compact?: boolean }) {
  const offer = useConversations().find((o) => o.id === id);
  const listHref = useValuacionHref()("/conversaciones");
  const [view, setView] = useState<DetailView>("messages");

  if (!offer) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground mb-4">No se encontró la conversación.</p>
        <Button asChild variant="outline"><Link href={listHref}>Volver a conversaciones</Link></Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className={cn("flex flex-col gap-2 pb-3 border-b", !compact && "md:pb-4")}>
        <div className={cn("flex items-center gap-2", !compact && "md:gap-4")}>
          {!compact && (
            <Button asChild variant="ghost" size="icon" className="flex-shrink-0">
              <Link href={listHref} aria-label="Volver a conversaciones"><ArrowLeft className="h-5 w-5" aria-hidden="true" /></Link>
            </Button>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className={cn("text-base font-bold truncate", !compact && "md:text-xl")}>{offer.customer}</h1>
              <ConvBadge conv={offer.conv} />
            </div>
            <div className={cn("flex items-center gap-2 text-xs text-muted-foreground", !compact && "md:text-sm")}>
              <Phone className="h-3 w-3" aria-hidden="true" /><span className="truncate">{offer.phone} · {agencyName(offer.agencyId)}</span>
            </div>
          </div>
        </div>
        {/* Contexto de la oferta: dato aparte del estatus de la conversación */}
        <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
          <span>Oferta</span><StatusPill status={offer.status} />
          <span>{offer.intelimotorModel} · {fmtMoney(offer.amount)}</span>
          {offer.conv.agent && <span className="flex items-center gap-1"><UserCircle className="h-3 w-3" aria-hidden="true" />{offer.conv.agent}</span>}
        </div>
      </div>

      <div className="flex gap-1 py-2 border-b overflow-x-auto" role="group" aria-label="Secciones de la conversación">
        {DETAIL_TABS.map((t) => (
          <Button key={t.id} variant={view === t.id ? "default" : "ghost"} size="sm" aria-pressed={view === t.id} className={cn("flex-shrink-0", compact && "h-7 px-2 text-xs")} onClick={() => setView(t.id)}>
            <t.icon className="mr-1 h-3 w-3" aria-hidden="true" />{t.label}
          </Button>
        ))}
      </div>

      {view === "messages" && (
        <>
          <div className="flex-1 overflow-y-auto py-4 space-y-2">
            <div className="flex items-center justify-center my-4">
              <span className="bg-muted text-muted-foreground text-xs px-3 py-1 rounded-full">Oferta enviada el {fmtDate(offer.sentAt!)}</span>
            </div>
            {messagesFor(offer).map((m, i) => m.who === "sys" ? (
              <div key={i} className="flex justify-center my-2"><span className="bg-muted text-muted-foreground text-xs px-3 py-1 rounded-full">{m.text}</span></div>
            ) : (
              <div key={i} className={cn("flex mb-2", m.who === "client" ? "justify-start" : "justify-end")}>
                {/* Mismos colores que los otros módulos: cliente gris, bot azul, agente verde */}
                <div className={cn("max-w-[70%] rounded-lg px-4 py-2", m.who === "client" ? "bg-muted text-foreground" : m.who === "bot" ? "bg-blue-600 text-white" : "bg-green-700 text-white")}>
                  <div className={cn("flex items-center gap-1 text-xs mb-1", m.who === "client" ? "text-muted-foreground" : "text-white/85")}>
                    {m.who === "client" ? <User className="h-3 w-3" aria-hidden="true" /> : m.who === "bot" ? <Bot className="h-3 w-3" aria-hidden="true" /> : <UserCircle className="h-3 w-3" aria-hidden="true" />}
                    <span>{senderLabel(offer, m.who)}</span>
                  </div>
                  <p className="whitespace-pre-wrap break-words">{m.text}</p>
                  <p className={cn("text-xs mt-1 text-right", m.who === "client" ? "text-muted-foreground" : "text-white/85")}>{m.at}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="border-t pt-4">
            <Card className="p-2">
              <div className="flex gap-2">
                <Input disabled aria-label="Mensaje" placeholder="En el prototipo la conversación es de solo lectura" className="flex-1" />
                <Button disabled aria-label="Enviar mensaje"><Send className="h-4 w-4" aria-hidden="true" /></Button>
              </div>
            </Card>
          </div>
        </>
      )}
      {view === "offer" && <div className="flex-1 overflow-y-auto py-4"><OfferDetail offer={offer} /></div>}
      {view === "history" && (
        <div className="flex-1 overflow-y-auto py-4 space-y-2">
          {[...offer.history].reverse().map((h, i) => (
            <Card key={i} className="py-0"><CardContent className="py-3 px-4">
              <p className="text-sm">{h.text}</p>
              <p className="text-xs text-muted-foreground mt-1">{h.at}</p>
            </CardContent></Card>
          ))}
        </div>
      )}
    </div>
  );
}
