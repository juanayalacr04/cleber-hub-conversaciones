"use client";

/**
 * Conversaciones de Valuación con datos reales (hub_cleber), con el mismo diseño que el prototipo (ConversacionesView, que
 * queda en /demo) y que las conversaciones de Ventas y Servicio: vista lista, kanban y conversación, y las mismas pestañas
 * por estatus de la CONVERSACIÓN.
 *
 *   Lista:     Hub.consultaConversaciones (permisos por equipo en la base)
 *   Mensajes:  Hub.consultaMensajes
 * Lo de la oferta (vehículo, monto, agencia) sale de metadatos.contexto, que guardó el envío (contrato ①): sin consultas
 * extra. Sin tiempo real todavía: se refresca cada 15 s mientras la página está visible.
 *
 * `/valuacion/conversaciones?c=<id>` abre la vista conversación con esa conversación seleccionada (enlace desde Ofertas).
 * Cerrar: el botón "Cerrar conversación" abre DialogoCierreConversacion: el motivo del cierre (Hub.cierraConversacion, con los
 * permisos de la base) y, si viene de una oferta, el estatus de la oferta y si se cierra también.
 * Atender (como en Ventas y Servicio): asignar a un valuador, transferir de equipo y tomar (administradores del módulo), devolver
 * al bot (su valuador o un administrador) y reabrir. Responder va por el backend (Hub.enviaMensajeAgente): al escribirle al
 * cliente, el valuador toma la conversación si esperaba asesor o estaba con el bot. Los permisos los decide la base; la pantalla
 * solo oculta lo que el usuario no puede hacer.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  ArrowLeft, ArrowRightLeft, Bot, Columns, FileText, Hand, HelpCircle, List, Loader2, MessageCircle, MessageSquare, Phone, RefreshCw,
  RotateCcw, Search, Send, User, UserCircle, UserPlus, XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import type { ApiResponse } from "@/lib/api";
import { consultaConfiguracionModulo, type Equipo } from "@/lib/hub/configuracion";
import {
  asignaConversacion, consultaConversaciones, consultaMensajes, devuelveAlBot, enviaMensajeAgente, reabreConversacion,
  tomaConversacion, transfiereEquipo, type ConversacionHub, type EstadoConversacion, type MensajeHub,
} from "@/lib/hub/conversaciones";
import { consultaUsuarios, type UsuarioEnMarca } from "@/lib/hub/usuarios";
import { mensajeError } from "@/lib/valuacion/tipos";
import { DialogoCierreConversacion } from "@/components/valuacion/DialogoCierreConversacion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const REFRESCO_MS = 15_000;
const VENTANA_MS = 24 * 60 * 60 * 1000;
const BASE = "/valuacion/conversaciones";
const TODOS: EstadoConversacion[] = ["bot", "waiting_agent", "with_agent", "closed"];

// ---------- Estatus de la conversación (mismos textos y colores que Ventas y Servicio) ----------

const statusLabels: Record<EstadoConversacion, string> = { bot: "Con Bot", waiting_agent: "Esperando", with_agent: "Con Agente", closed: "Cerrada" };
const shortLabels: Record<EstadoConversacion, string> = { ...statusLabels, bot: "Bot" };
const statusColors: Record<EstadoConversacion, string> = {
  bot: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  waiting_agent: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  with_agent: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  closed: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
};

type Tab = "all" | "pending" | "waiting" | "active" | "bot" | "closed";
const isPending = (c: ConversacionHub) => c.estado === "with_agent" && c.ultimoRemitente === "customer";
const inTab = (t: Tab, c: ConversacionHub) => {
  const s = c.estado;
  if (t === "all") return s !== "closed";
  if (t === "pending") return isPending(c);
  if (t === "waiting") return s === "waiting_agent";
  if (t === "active") return s === "with_agent";
  if (t === "bot") return s === "bot";
  return s === "closed";
};

/** Datos de la oferta que guardó el envío (Valuacion.solicitaEnvio → contexto). */
interface Contexto { nombreCliente?: string; vehiculo?: string; kilometraje?: number; montoOferta?: number; agencia?: string; fechaCita?: string; horaCita?: string; telefonoOriginal?: string }
const contextoDe = (c: ConversacionHub) => (c.metadatos?.contexto ?? {}) as Contexto;
const cliente = (c: ConversacionHub) => c.nombreCliente || contextoDe(c).nombreCliente || c.telefonoCliente;
const dinero = (n?: number) => (typeof n === "number" ? n.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 }) : null);
const resumen = (c: ConversacionHub) => [contextoDe(c).vehiculo, dinero(contextoDe(c).montoOferta)].filter(Boolean).join(" · ");
const fecha = (s: string) => {
  const d = new Date(s);
  const hoy = new Date();
  return d.toDateString() === hoy.toDateString()
    ? d.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("es-MX", { day: "numeric", month: "short" });
};
const rutaFicha = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

function ConvBadge({ c, short, className }: { c: ConversacionHub; short?: boolean; className?: string }) {
  return (
    <span className={cn("px-2 py-1 rounded-full text-[11px] md:text-xs font-medium whitespace-nowrap", statusColors[c.estado], className)}>
      {(short ? shortLabels : statusLabels)[c.estado]}
      {c.estado === "closed" && c.motivoCierre && !short && <span> · {c.motivoCierre}</span>}
    </span>
  );
}

function Brand({ c }: { c: ConversacionHub }) {
  return <span className="px-1.5 py-0.5 rounded text-[11px] font-medium flex-shrink-0 bg-muted text-foreground">{c.idMarca}</span>;
}

function Avatar({ c, small }: { c: ConversacionHub; small?: boolean }) {
  return (
    <div className="relative flex-shrink-0">
      <div className={cn("rounded-full bg-muted flex items-center justify-center", small ? "h-8 w-8" : "h-9 w-9 md:h-10 md:w-10")} aria-hidden="true">
        <span className="text-xs md:text-sm font-medium">{cliente(c)[0]}</span>
      </div>
      {isPending(c) && <div className="absolute -top-0.5 -right-0.5 h-3 w-3 bg-orange-400 rounded-full border-2 border-background" title="Esperando respuesta del valuador" />}
    </div>
  );
}

/** Quién atiende: valuador o bot. */
function Handler({ c, agentes }: { c: ConversacionHub; agentes: Record<string, string> }) {
  if (c.estado === "with_agent") return <><UserCircle className="h-3 w-3" aria-hidden="true" />{(c.idAgente && agentes[c.idAgente]) || "Valuador"}</>;
  if (c.estado === "bot") return <><Bot className="h-3 w-3" aria-hidden="true" />Bot de valuación</>;
  return null;
}

const preview = (c: ConversacionHub) => c.ultimoMensajeTexto ?? "";

// ---------- Vista lista ----------

function ListView({ convs, agentes }: { convs: ConversacionHub[]; agentes: Record<string, string> }) {
  const [tab, setTab] = useState<Tab>("all");
  const shown = convs.filter((c) => inTab(tab, c));
  const count = (t: Tab) => convs.filter((c) => inTab(t, c)).length;
  const pendingCount = count("pending"), waitingCount = count("waiting"), activeCount = count("active"), botCount = count("bot"), closedCount = count("closed");

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="w-full">
      <TabsList className="w-full overflow-x-auto justify-start md:justify-center">
        <TabsTrigger value="all">Todas<Badge variant="secondary" className="ml-2">{convs.length - closedCount}</Badge></TabsTrigger>
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
            <p className="text-muted-foreground text-center">Aparecen aquí cuando se envía una oferta.</p>
          </CardContent></Card>
        ) : (
          <div className="space-y-2">
            {shown.map((c) => (
              <Link key={c.idConversacion} href={rutaFicha(c.idConversacion)} className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Card className={cn("cursor-pointer hover:bg-accent transition-colors py-0", isPending(c) && "border-l-4 border-l-orange-400")}>
                  <CardContent className="flex items-center justify-between py-3 md:py-4 gap-2">
                    <div className="flex items-center gap-3 md:gap-4 min-w-0">
                      <Avatar c={c} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2"><Brand c={c} /><p className="font-medium text-sm md:text-base truncate">{cliente(c)}</p></div>
                        <p className="text-xs md:text-sm text-muted-foreground truncate">{c.telefonoCliente}{resumen(c) && <span> · {resumen(c)}</span>}</p>
                        {preview(c) && <p className="text-xs text-muted-foreground truncate max-w-[200px] md:max-w-[300px]">&ldquo;{preview(c)}&rdquo;</p>}
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5"><Handler c={c} agentes={agentes} /></p>
                      </div>
                    </div>
                    <div className="flex flex-col md:flex-row items-end md:items-center gap-1 md:gap-4 flex-shrink-0">
                      {c.fuente === "valuacion" && <span className="text-xs text-muted-foreground">Oferta #{c.idExterno}</span>}
                      <ConvBadge c={c} />
                      <span className="text-xs md:text-sm text-muted-foreground whitespace-nowrap">{fecha(c.ultimoMensajeEn)}</span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </Tabs>
  );
}

// ---------- Vista kanban (columnas por quién atiende) ----------

function Kanban({ convs, agentes }: { convs: ConversacionHub[]; agentes: Record<string, string> }) {
  const router = useRouter();
  const open = convs.filter((c) => c.estado !== "closed");
  const porAgente = new Map<string, ConversacionHub[]>();
  open.forEach((c) => { if (c.estado === "with_agent") { const k = c.idAgente ?? "?"; porAgente.set(k, [...(porAgente.get(k) ?? []), c]); } });
  const columns: { id: string; title: string; icon: ReactNode; items: ConversacionHub[] }[] = [];
  const unassigned = open.filter((c) => c.estado === "waiting_agent");
  if (unassigned.length) columns.push({ id: "unassigned", title: "Sin asignar", icon: <HelpCircle className="h-4 w-4" aria-hidden="true" />, items: unassigned });
  porAgente.forEach((items, id) => columns.push({ id, title: agentes[id] ?? "Valuador", icon: <UserCircle className="h-4 w-4" aria-hidden="true" />, items }));
  const bot = open.filter((c) => c.estado === "bot");
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
            {col.items.map((c) => (
              <Card key={c.idConversacion} className="cursor-pointer hover:bg-accent transition-colors py-0" onClick={() => router.push(rutaFicha(c.idConversacion))}>
                <CardContent className="p-3">
                  <div className="flex items-center justify-between mb-1 gap-1">
                    <div className="flex items-center gap-1.5 min-w-0"><Brand c={c} /><span className="font-medium text-sm truncate">{cliente(c)}</span></div>
                    <ConvBadge c={c} short className="px-1.5 py-0 ml-1 flex-shrink-0" />
                  </div>
                  <p className="text-xs text-muted-foreground truncate">{c.telefonoCliente}{resumen(c) && <span> · {resumen(c)}</span>}</p>
                  {preview(c) && <p className="text-xs text-muted-foreground truncate mt-0.5">&ldquo;{preview(c)}&rdquo;</p>}
                  <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                    <span>{fecha(c.ultimoMensajeEn)}</span>
                    {c.fuente === "valuacion" && <span className="ml-auto">Oferta #{c.idExterno}</span>}
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

// ---------- Vista conversación (bandeja + chat) ----------

const CONVERSE_FILTERS: ("all" | EstadoConversacion)[] = ["all", "waiting_agent", "with_agent", "bot", "closed"];

function Converse({ convs, sel, onSel, agentes, onCambio }: {
  convs: ConversacionHub[]; sel: string | null; onSel: (id: string) => void; agentes: Record<string, string>; onCambio: () => void;
}) {
  const elegida = convs.find((c) => c.idConversacion === sel);
  // Si se abrió una conversación cerrada (p. ej. desde Ofertas), el filtro arranca en Cerradas para que se vea en la lista
  const [filter, setFilter] = useState<"all" | EstadoConversacion>(elegida?.estado === "closed" ? "closed" : "all");
  const list = convs.filter((c) => (filter === "all" ? c.estado !== "closed" : c.estado === filter));
  return (
    <div className="flex border rounded-lg overflow-hidden" style={{ height: "calc(100dvh - 280px)", minHeight: "500px" }}>
      <div className="w-[350px] max-w-[45%] flex-shrink-0 border-r flex flex-col bg-background">
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
          ) : list.map((c) => (
            <button
              key={c.idConversacion} type="button" onClick={() => onSel(c.idConversacion)} aria-current={sel === c.idConversacion ? "true" : undefined}
              className={cn("w-full text-left flex items-center gap-2 p-2.5 border-b hover:bg-accent transition-colors", sel === c.idConversacion && "bg-primary/10 border-l-2 border-l-primary")}
            >
              <Avatar c={c} small />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0"><Brand c={c} /><p className="font-medium text-sm truncate">{cliente(c)}</p></div>
                  <ConvBadge c={c} short className="px-1.5 py-0 ml-2 flex-shrink-0" />
                </div>
                <p className="text-xs text-muted-foreground truncate">{c.telefonoCliente}{resumen(c) && <span> · {resumen(c)}</span>}</p>
                {preview(c) && <p className="text-xs text-muted-foreground truncate">&ldquo;{preview(c)}&rdquo;</p>}
                <p className="text-xs text-muted-foreground">{fecha(c.ultimoMensajeEn)}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 min-w-0 flex flex-col bg-background">
        {sel ? (
          <div className="flex-1 p-3 overflow-hidden"><ConversacionChat key={sel} idConversacion={sel} compact agentes={agentes} onCambio={onCambio} /></div>
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

/** Nombres de los valuadores para mostrar quién atiende (solo los administradores pueden consultarlos; si no, "Valuador"). */
function useAgentes(idMarca: string | null) {
  const [agentes, setAgentes] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!idMarca) return;
    consultaUsuarios({ idMarca, modulo: "valuacion" })
      .then((r) => { if (r.successful) setAgentes(Object.fromEntries(r.info.usuarios.map((u) => [u.idUsuario, u.nombre || u.email]))); })
      .catch(() => {});
  }, [idMarca]);
  return agentes;
}

export function ConversacionesApiView() {
  const { userData } = useAuth();
  const idMarca = userData?.organizationId ?? null;
  const agentes = useAgentes(idMarca);
  const [convs, setConvs] = useState<ConversacionHub[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>("list");
  const [sel, setSel] = useState<string | null>(null);

  // ?c=<id>: abre la vista conversación con esa conversación (enlace desde Ofertas). Se lee al montar: el servidor no ve la URL
  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get("c");
    if (c) { setSel(c); setView("converse"); }
  }, []);

  const carga = useCallback(async () => {
    if (!idMarca) return;
    setCargando(true);
    const r = await consultaConversaciones({ idMarca, modulo: "valuacion", estados: TODOS, limite: 200 });
    setCargando(false);
    if (r.successful) { setConvs(r.info.conversaciones); setError(null); return; }
    if (r.errorCode === "SESION_EXPIRADA") { toast.error(mensajeError(r)); signOut({ redirectTo: "/login" }); return; }
    setError(mensajeError(r));
  }, [idMarca]);

  useEffect(() => { setConvs(null); carga(); }, [carga]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") carga(); }, REFRESCO_MS);
    return () => clearInterval(t);
  }, [carga]);

  const term = q.trim().toLowerCase();
  const filtradas = useMemo(() => (convs ?? []).filter((c) =>
    !term || `${cliente(c)} ${c.telefonoCliente} ${contextoDe(c).vehiculo ?? ""}`.toLowerCase().includes(term)), [convs, term]);

  const elige = (id: string) => {
    setSel(id);
    window.history.replaceState(null, "", `${BASE}?c=${encodeURIComponent(id)}`);
  };

  return (
    <div>
      <div className="flex flex-col gap-4 mb-6 md:mb-8">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-xl md:text-2xl font-bold">Conversaciones</h1>
            <p className="text-muted-foreground text-sm hidden md:block">Conversaciones de WhatsApp por las ofertas enviadas</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={carga} disabled={cargando} title="Actualizar" aria-label="Actualizar">
              <RefreshCw className={cn("h-4 w-4", cargando && "animate-spin")} aria-hidden="true" />
            </Button>
            <div className="flex border rounded-lg" role="group" aria-label="Vista">
              <Button variant={view === "list" ? "default" : "ghost"} size="icon" className="rounded-r-none" onClick={() => setView("list")} title="Vista lista" aria-label="Vista lista" aria-pressed={view === "list"}><List className="h-4 w-4" aria-hidden="true" /></Button>
              <Button variant={view === "kanban" ? "default" : "ghost"} size="icon" className="rounded-none border-x hidden md:flex" onClick={() => setView("kanban")} title="Vista kanban" aria-label="Vista kanban" aria-pressed={view === "kanban"}><Columns className="h-4 w-4" aria-hidden="true" /></Button>
              <Button variant={view === "converse" ? "default" : "ghost"} size="icon" className="rounded-l-none" onClick={() => setView("converse")} title="Vista conversación" aria-label="Vista conversación" aria-pressed={view === "converse"}><MessageCircle className="h-4 w-4" aria-hidden="true" /></Button>
            </div>
          </div>
        </div>
      </div>

      {error ? (
        <Card><CardContent className="py-8 text-center space-y-3">
          <p className="text-muted-foreground">No se pudieron cargar las conversaciones: {error}</p>
          <Button variant="outline" onClick={carga}>Reintentar</Button>
        </CardContent></Card>
      ) : !convs ? (
        <div className="flex items-center justify-center h-64"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {view !== "kanban" && (
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <Input type="search" aria-label="Buscar conversaciones por nombre, teléfono o vehículo" placeholder="Buscar por nombre, teléfono o vehículo..." value={q} onChange={(e) => setQ(e.target.value)} className="pl-10" />
            </div>
          )}
          {view === "kanban" && <Kanban convs={filtradas} agentes={agentes} />}
          {view === "converse" && <Converse convs={filtradas} sel={sel} onSel={elige} agentes={agentes} onCambio={carga} />}
          {view === "list" && <ListView convs={filtradas} agentes={agentes} />}
        </>
      )}
    </div>
  );
}

// ---------- Chat de una conversación (panel de la vista conversación y ficha /valuacion/conversaciones/[id]) ----------

/** Valuadores, equipos y si quien consulta administra Valuación en la marca (sin permiso, listas vacías y esAdmin = false). */
function useEquipoDeTrabajo(idMarca: string | null) {
  const [datos, setDatos] = useState<{ usuarios: UsuarioEnMarca[]; equipos: Equipo[]; esAdmin: boolean }>({ usuarios: [], equipos: [], esAdmin: false });
  useEffect(() => {
    if (!idMarca) return;
    let vigente = true;
    Promise.all([consultaUsuarios({ idMarca, modulo: "valuacion" }), consultaConfiguracionModulo({ idMarca, modulo: "valuacion" })])
      .then(([u, c]) => {
        if (!vigente) return;
        setDatos({
          usuarios: u.successful ? u.info.usuarios : [],
          esAdmin: u.successful && u.info.permisos.modulos.includes("valuacion"),
          equipos: c.successful ? c.info.equipos.filter((e) => e.esActivo) : [],
        });
      })
      .catch(() => {});
    return () => { vigente = false; };
  }, [idMarca]);
  return datos;
}

type DetailView = "messages" | "offer";

const QUIEN: Record<Exclude<MensajeHub["remitente"], "system">, string> = { customer: "Cliente", bot: "Bot de valuación", agent: "Valuador" };
const hora = (s: string) => new Date(s).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
const dia = (s: string) => new Date(s).toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });

export function ConversacionChat({ idConversacion, compact = false, agentes = {}, onCambio }: {
  idConversacion: string; compact?: boolean; agentes?: Record<string, string>; onCambio?: () => void;
}) {
  const [conv, setConv] = useState<ConversacionHub | null>(null);
  const [mensajes, setMensajes] = useState<MensajeHub[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [conContexto, setConContexto] = useState(false);
  const [view, setView] = useState<DetailView>("messages");
  const [dialogoCierre, setDialogoCierre] = useState(false);
  const { userData } = useAuth();
  const { usuarios, equipos, esAdmin } = useEquipoDeTrabajo(conv?.idMarca ?? null);
  const [trabajando, setTrabajando] = useState<string | null>(null);
  const [texto, setTexto] = useState("");

  const carga = useCallback(async () => {
    const r = await consultaMensajes({ idConversacion, incluyeSistema: conContexto, limite: 200 });
    if (r.successful) { setConv(r.info.conversacion); setMensajes(r.info.mensajes); setError(null); return; }
    if (r.errorCode === "SESION_EXPIRADA") { toast.error(mensajeError(r)); signOut({ redirectTo: "/login" }); return; }
    setError(r.errorCode === "CONVERSACION_NO_ENCONTRADA"
      ? "La conversación no existe o no la puedes ver (es de otro equipo o de otra marca)."
      : mensajeError(r));
  }, [idConversacion, conContexto]);

  useEffect(() => { carga(); }, [carga]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") carga(); }, REFRESCO_MS);
    return () => clearInterval(t);
  }, [carga]);

  if (error || !conv) {
    return (
      <div className="text-center py-12">
        {error ? <>
          <p className="text-muted-foreground mb-4">{error}</p>
          {!compact && <Button asChild variant="outline"><Link href={BASE}>Volver a conversaciones</Link></Button>}
        </> : <Loader2 className="h-6 w-6 animate-spin text-muted-foreground mx-auto" />}
      </div>
    );
  }

  const ctx = contextoDe(conv);
  let diaAnterior = "";
  const actual = conv;
  const esMia = !!userData?.idUsuario && conv.idAgente === userData.idUsuario;
  const abierta = conv.estado !== "closed";
  // Solo escribe quien tiene asignada la conversación. Un administrador que quiera escribir en la de otro la toma primero
  // WhatsApp solo deja escribir texto libre hasta 24 h después del último mensaje del cliente (sin plantillas por ahora)
  const enVentana = !!conv.ultimoMensajeClienteEn && Date.now() - new Date(conv.ultimoMensajeClienteEn).getTime() <= VENTANA_MS;
  const puedeEscribir = conv.estado === "with_agent" && esMia && enVentana;
  // Tomar: Hub.tomaConversacion solo acepta "Esperando"; con el bot o con otro valuador, el administrador se la asigna a sí mismo
  const puedeTomar = esAdmin && !!userData?.idUsuario && abierta && !esMia;
  const toma = () => conv.estado === "waiting_agent"
    ? tomaConversacion(version)
    : asignaConversacion({ ...version, idAgente: userData?.idUsuario ?? "" });
  // A quién se le puede asignar, con las mismas reglas que Hub.asignaConversacion: activo, con un rol que escribe (no CONSULTA)
  // y que vea la conversación (administrador del módulo, o de su equipo y, si tiene agencia, con esa agencia). Más quien ya la tiene.
  const asignables = usuarios.filter((u) => {
    const rol = u.modulos.valuacion;
    if (u.idUsuario === conv.idAgente) return true;
    return u.esActivo && u.esDisponible && !!rol && rol.rol !== "CONSULTA"
      && (u.esSuperAdmin || rol.rol === "ADMINISTRADOR"
        || (!!conv.idEquipo && rol.idEquipo === conv.idEquipo && (!conv.idAgencia || u.agencias.includes(conv.idAgencia))));
  });
  // Quien la atiende puede no estar en la lista (p. ej. un super admin que no es de la marca): se agrega para que se vea su nombre
  if (conv.idAgente && !asignables.some((u) => u.idUsuario === conv.idAgente)) {
    const nombre = esMia ? (userData?.name || "Tú") : (agentes[conv.idAgente] || "Valuador");
    asignables.unshift({ idUsuario: conv.idAgente, nombre, email: "" } as UsuarioEnMarca);
  }
  const otrosEquipos = equipos.filter((e) => e.idEquipo !== conv.idEquipo);
  const version = { idConversacion: actual.idConversacion, versionEsperada: actual.version };

  /** Corre una acción sobre la conversación y deja la pantalla con el resultado (o la vuelve a consultar si cambió). */
  async function ejecuta(nombre: string, accion: () => Promise<ApiResponse<{ conversacion: ConversacionHub }>>, exito: string) {
    setTrabajando(nombre);
    const r = await accion();
    setTrabajando(null);
    if (r.successful) { setConv(r.info.conversacion); toast.success(exito); onCambio?.(); carga(); return; }
    if (r.errorCode === "SESION_EXPIRADA") { toast.error(mensajeError(r)); signOut({ redirectTo: "/login" }); return; }
    const info = (r.info ?? {}) as { motivo?: string };
    if (r.errorCode === "CONFLICTO_VERSION" || (r.errorCode === "ESTADO_INVALIDO" && info.motivo === "ESTADO_ACTUAL")) {
      toast.error("La conversación cambió mientras tanto. Se actualizó: revisa e intenta de nuevo.");
      carga(); onCambio?.();
      return;
    }
    if (info.motivo === "CONVERSACION_ABIERTA") { toast.error("El cliente ya tiene otra conversación abierta en este número."); return; }
    toast.error(r.errorCode === "SIN_PERMISO" || r.errorCode === "CAMPO_INVALIDO" ? r.errorMessage : mensajeError(r));
  }

  async function envia() {
    const t = texto.trim();
    if (!t || trabajando) return;
    setTrabajando("enviar");
    const r = await enviaMensajeAgente({ idConversacion: actual.idConversacion, texto: t });
    setTrabajando(null);
    if (r.successful) {
      setTexto("");
      setConv(r.info.conversacion);
      setMensajes((ms) => (ms.some((m) => m.idMensaje === r.info.mensaje.idMensaje) ? ms : [...ms, r.info.mensaje]));
      onCambio?.();
      return;
    }
    if (r.errorCode === "SESION_EXPIRADA") { toast.error(mensajeError(r)); signOut({ redirectTo: "/login" }); return; }
    toast.error(["ERROR_PROVEEDOR", "SIN_PERMISO", "CAMPO_INVALIDO", "FUERA_DE_VENTANA"].includes(r.errorCode) ? r.errorMessage : mensajeError(r));
    if (r.errorCode === "ESTADO_INVALIDO") carga();
  }
  const aviso = puedeEscribir ? null
    : conv.estado === "with_agent" && esMia ? (conv.ultimoMensajeClienteEn
      ? "Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp no permite escribirle hasta que vuelva a escribir"
      : "El cliente todavía no ha escrito: WhatsApp no permite escribirle hasta que conteste")
    : conv.estado === "waiting_agent" ? "Toma la conversación para poder enviar mensajes"
    : conv.estado === "bot" ? "La está atendiendo el bot. Tómala para escribirle al cliente"
    : conv.estado === "closed" ? "La conversación está cerrada. Puedes reabrirla para continuar"
    : esAdmin ? "La atiende otro valuador. Tómala para escribirle al cliente"
    : "La atiende otro valuador";

  return (
    <div className="flex flex-col h-full">
      <div className={cn("flex flex-col gap-2 pb-3 border-b", !compact && "md:pb-4")}>
        <div className={cn("flex items-center gap-2", !compact && "md:gap-4")}>
          {!compact && (
            <Button asChild variant="ghost" size="icon" className="flex-shrink-0">
              <Link href={BASE} aria-label="Volver a conversaciones"><ArrowLeft className="h-5 w-5" aria-hidden="true" /></Link>
            </Button>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className={cn("text-base font-bold truncate", !compact && "md:text-xl")}>{cliente(conv)}</h1>
              <ConvBadge c={conv} />
            </div>
            <div className={cn("flex items-center gap-2 text-xs text-muted-foreground", !compact && "md:text-sm")}>
              <Phone className="h-3 w-3" aria-hidden="true" />
              <span className="truncate">{conv.telefonoCliente}{ctx.agencia ? ` · ${ctx.agencia}` : ""}</span>
            </div>
          </div>
        </div>
        {conv.fuente === "valuacion" && (
          <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
            <span>Oferta #{conv.idExterno}</span>
            {resumen(conv) && <span>{resumen(conv)}</span>}
            {conv.estado === "with_agent" && <span className="flex items-center gap-1"><UserCircle className="h-3 w-3" aria-hidden="true" />{(conv.idAgente && agentes[conv.idAgente]) || "Valuador"}</span>}
            {ctx.telefonoOriginal && <span>· Envío de prueba (cliente real: {ctx.telefonoOriginal})</span>}
          </div>
        )}
      </div>

      <div className="flex gap-1 py-2 border-b overflow-x-auto items-center" role="group" aria-label="Secciones de la conversación">
        <Button variant={view === "messages" ? "default" : "ghost"} size="sm" aria-pressed={view === "messages"} className={cn("flex-shrink-0", compact && "h-7 px-2 text-xs")} onClick={() => setView("messages")}>
          <MessageSquare className="mr-1 h-3 w-3" aria-hidden="true" />Mensajes
        </Button>
        {conv.fuente === "valuacion" && (
          <Button variant={view === "offer" ? "default" : "ghost"} size="sm" aria-pressed={view === "offer"} className={cn("flex-shrink-0", compact && "h-7 px-2 text-xs")} onClick={() => setView("offer")}>
            <FileText className="mr-1 h-3 w-3" aria-hidden="true" />Oferta
          </Button>
        )}
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground px-2">
          <input type="checkbox" checked={conContexto} onChange={(e) => setConContexto(e.target.checked)} />Contexto del bot
        </label>
        {conv.estado !== "closed" && (
          <Button variant="outline" size="sm" className={cn("flex-shrink-0", compact && "h-7 px-2 text-xs")} style={{ color: "var(--crit)" }}
            onClick={() => setDialogoCierre(true)}>
            <XCircle className="mr-1 h-3 w-3" aria-hidden="true" />Cerrar conversación
          </Button>
        )}
      </div>

      {/* Atender: mismas acciones que Ventas y Servicio */}
      <div className="flex gap-2 py-2 border-b overflow-x-auto items-center flex-wrap" role="group" aria-label="Atender la conversación">
        {abierta && esAdmin && asignables.length > 0 && (
          <div className="flex items-center gap-1.5">
            <UserPlus className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Select value={conv.idAgente ?? ""} disabled={!!trabajando}
              onValueChange={(id) => { if (id && id !== conv.idAgente) ejecuta("asignar", () => asignaConversacion({ ...version, idAgente: id }), "Conversación asignada"); }}>
              <SelectTrigger className={cn("h-8 text-xs", compact ? "w-[150px]" : "w-[200px]")} aria-label="Asignar a un valuador">
                <SelectValue placeholder="Asignar valuador..." />
              </SelectTrigger>
              <SelectContent>
                {asignables.map((u) => <SelectItem key={u.idUsuario} value={u.idUsuario}>{u.nombre || u.email}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
        {abierta && esAdmin && otrosEquipos.length > 0 && (
          <Select value="" disabled={!!trabajando}
            onValueChange={(id) => { if (id) ejecuta("transferir", () => transfiereEquipo({ ...version, idEquipo: id }), "Conversación transferida de equipo"); }}>
            <SelectTrigger className={cn("h-8 text-xs", compact ? "w-[150px]" : "w-[180px]")} aria-label="Transferir a otro equipo">
              <div className="flex items-center gap-1.5"><ArrowRightLeft className="h-3 w-3" aria-hidden="true" />Transferir equipo</div>
            </SelectTrigger>
            <SelectContent>
              {otrosEquipos.map((e) => <SelectItem key={e.idEquipo} value={e.idEquipo}>{e.nombre}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        {puedeTomar && (
          <Button size="sm" className="h-8" disabled={!!trabajando} onClick={() => ejecuta("tomar", toma, "Tomaste la conversación")}>
            {trabajando === "tomar" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" /> : <Hand className="mr-1 h-3 w-3" aria-hidden="true" />}
            Tomar conversación
          </Button>
        )}
        {conv.estado === "with_agent" && (esMia || esAdmin) && (
          <Button variant="outline" size="sm" className="h-8" disabled={!!trabajando}
            onClick={() => ejecuta("bot", () => devuelveAlBot(version), "La conversación volvió al bot")}>
            {trabajando === "bot" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" /> : <RotateCcw className="mr-1 h-3 w-3" aria-hidden="true" />}
            Devolver al bot
          </Button>
        )}
        {conv.estado === "closed" && (
          <Button variant="outline" size="sm" className="h-8" disabled={!!trabajando}
            onClick={() => ejecuta("reabrir", () => reabreConversacion(version), "Conversación reabierta: la atiende el bot")}>
            {trabajando === "reabrir" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" /> : <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" />}
            Reabrir
          </Button>
        )}
      </div>

      {view === "messages" && (
        <>
          <div className="flex-1 overflow-y-auto py-4 space-y-2">
            {mensajes.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">Sin mensajes todavía.</p>}
            {mensajes.map((m) => {
              const d = dia(m.creadoEn);
              const separador = d !== diaAnterior
                ? <div className="flex items-center justify-center my-4"><span className="bg-muted text-muted-foreground text-xs px-3 py-1 rounded-full">{d}</span></div>
                : null;
              diaAnterior = d;
              if (m.remitente === "system") {
                return (
                  <div key={m.idMensaje}>{separador}
                    <div className="flex justify-center my-2"><span className="bg-muted text-muted-foreground text-xs px-3 py-1 rounded-lg whitespace-pre-wrap max-w-[85%]">{m.texto}</span></div>
                  </div>
                );
              }
              const esCliente = m.remitente === "customer";
              return (
                <div key={m.idMensaje}>{separador}
                  <div className={cn("flex mb-2", esCliente ? "justify-start" : "justify-end")}>
                    {/* Mismos colores que los otros módulos: cliente gris, bot azul, agente verde */}
                    <div className={cn("max-w-[70%] rounded-lg px-4 py-2", esCliente ? "bg-muted text-foreground" : m.remitente === "bot" ? "bg-blue-600 text-white" : "bg-green-700 text-white")}>
                      <div className={cn("flex items-center gap-1 text-xs mb-1", esCliente ? "text-muted-foreground" : "text-white/85")}>
                        {esCliente ? <User className="h-3 w-3" aria-hidden="true" /> : m.remitente === "bot" ? <Bot className="h-3 w-3" aria-hidden="true" /> : <UserCircle className="h-3 w-3" aria-hidden="true" />}
                        <span>{m.remitente === "agent" ? (m.idAgente && agentes[m.idAgente]) || QUIEN.agent : QUIEN[m.remitente]}{m.esPlantilla ? " · plantilla" : ""}</span>
                      </div>
                      {m.texto && <p className="whitespace-pre-wrap break-words">{m.texto}</p>}
                      {m.mediaUrl && <a href={m.mediaUrl} target="_blank" rel="noreferrer" className="underline">📎 Archivo adjunto</a>}
                      <p className={cn("text-xs mt-1 text-right", esCliente ? "text-muted-foreground" : "text-white/85")}>{hora(m.creadoEn)}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="border-t pt-4">
            <Card className="p-2">
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); envia(); }}>
                <Input aria-label="Mensaje" placeholder="Escribe un mensaje..." className="flex-1" value={texto} maxLength={4096}
                  disabled={!puedeEscribir || trabajando === "enviar"} onChange={(e) => setTexto(e.target.value)} />
                <Button type="submit" aria-label="Enviar mensaje" disabled={!puedeEscribir || !texto.trim() || !!trabajando}>
                  {trabajando === "enviar" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
                </Button>
              </form>
              {aviso && <p className="text-xs text-muted-foreground mt-2 text-center">{aviso}</p>}
            </Card>
          </div>
        </>
      )}
      {view === "offer" && (
        <div className="flex-1 overflow-y-auto py-4">
          <Card className="py-0"><CardContent className="py-4 px-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Oferta</dt><dd>#{conv.idExterno}</dd>
              <dt className="text-muted-foreground">Cliente</dt><dd>{ctx.nombreCliente ?? "—"}</dd>
              <dt className="text-muted-foreground">Vehículo</dt><dd>{ctx.vehiculo ?? "—"}</dd>
              <dt className="text-muted-foreground">Kilometraje</dt><dd>{typeof ctx.kilometraje === "number" ? `${ctx.kilometraje.toLocaleString("es-MX")} km` : "—"}</dd>
              <dt className="text-muted-foreground">Monto ofrecido</dt><dd>{dinero(ctx.montoOferta) ?? "—"}</dd>
              <dt className="text-muted-foreground">Agencia</dt><dd>{ctx.agencia ?? "—"}</dd>
              <dt className="text-muted-foreground">Cita de servicio</dt><dd>{[ctx.fechaCita, ctx.horaCita].filter(Boolean).join(" ") || "—"}</dd>
            </dl>
            <p className="text-xs text-muted-foreground mt-3">Datos con los que se envió la oferta. El estado actual está en <Link href="/valuacion/ofertas" className="underline">Ofertas</Link>.</p>
          </CardContent></Card>
        </div>
      )}

      <DialogoCierreConversacion
        conv={conv} abierto={dialogoCierre} onCerrar={() => setDialogoCierre(false)}
        onCerrada={(cerrada) => { if (cerrada) setConv(cerrada); onCambio?.(); carga(); }}
      />
    </div>
  );
}
