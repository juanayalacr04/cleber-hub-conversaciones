"use client";

/**
 * Conversaciones de Valuación con datos reales (hub_cleber), con el mismo diseño que el prototipo (ConversacionesView, que
 * queda en /demo) y que las conversaciones de Ventas y Servicio: vista lista, kanban y conversación, y las mismas pestañas
 * por estatus de la CONVERSACIÓN.
 *
 *   Lista:     Hub.consultaConversaciones (permisos por equipo en la base)
 *   Mensajes:  Hub.consultaMensajes
 * Lo de la oferta (vehículo, monto, agencia) sale de metadatos.contexto, que guardó el envío (contrato ①): sin consultas
 * extra. Tiempo real (useTiempoReal, AppSync Events): la bandeja escucha /hub/<marca>/valuacion y el chat abierto
 * /hub/<marca>/valuacion/<idConversacion>; un aviso vuelve a consultar (el chat, solo los mensajes nuevos). Como respaldo
 * se refresca cada 60 s con conexión y cada 15 s sin ella, mientras la página está visible.
 *
 * `/valuacion/conversaciones?c=<id>` abre la vista conversación con esa conversación seleccionada (enlace desde Ofertas).
 * Cerrar: el botón "Cerrar conversación" abre DialogoCierreConversacion: el motivo del cierre (Hub.cierraConversacion, con los
 * permisos de la base) y, si viene de una oferta, el estatus de la oferta y si se cierra también.
 * Atender (como en Ventas y Servicio): asignar a un valuador, transferir de equipo y tomar (administradores del módulo), devolver
 * al bot (su valuador o un administrador) y reabrir. Responder va por el backend (Hub.enviaMensajeAgente): al escribirle al
 * cliente, el valuador toma la conversación si esperaba asesor o estaba con el bot. Los permisos los decide la base; la pantalla
 * solo oculta lo que el usuario no puede hacer.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  ArrowDown, ArrowLeft, ArrowRightLeft, Bell, BellOff, Bot, Building2, Columns, FileText, Hand, HelpCircle, List, Loader2, MessageCircle, MessageSquare,
  MoreHorizontal, PanelRight, Paperclip, RefreshCw, RotateCcw, Search, Send, User, UserCircle, UserPlus, X, XCircle,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { useNotificationContext } from "@/contexts/NotificationContext";
import { useTiempoReal } from "@/hooks/useTiempoReal";
import type { ApiResponse } from "@/lib/api";
import { consultaConfiguracionModulo, type Equipo } from "@/lib/hub/configuracion";
import {
  asignaConversacion, consultaConversaciones, consultaMensajes, devuelveAlBot, enviaMensajeAgente, reabreConversacion,
  tomaConversacion, transfiereEquipo, type ConversacionHub, type EstadoConversacion, type MensajeHub,
} from "@/lib/hub/conversaciones";
import { consultaUsuarios, type UsuarioEnMarca } from "@/lib/hub/usuarios";
import { mensajeError } from "@/lib/hub/errores";
import { DialogoCierreConversacion } from "@/components/valuacion/DialogoCierreConversacion";
import { OfertaEnConversacion } from "@/components/valuacion/OfertasApiView";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const REFRESCO_MS = 15_000;            // respaldo sin tiempo real
const REFRESCO_EN_VIVO_MS = 60_000;    // respaldo con tiempo real (por si se perdió un aviso)
const VENTANA_MS = 24 * 60 * 60 * 1000;
const BASE = "/valuacion/conversaciones";
const TODOS: EstadoConversacion[] = ["bot", "waiting_agent", "with_agent", "closed"];

// ---------- Estatus de la conversación (mismos estatus que Ventas y Servicio; colores con los tokens del tema, como Ofertas) ----------

const statusLabels: Record<EstadoConversacion, string> = { bot: "Con bot", waiting_agent: "Esperando", with_agent: "Con valuador", closed: "Cerrada" };
const shortLabels: Record<EstadoConversacion, string> = { bot: "Bot", waiting_agent: "Esperando", with_agent: "Valuador", closed: "Cerrada" };
/** Clase de `.pill` (globals.css) por estatus: info, aviso, ok y apagado. */
const statusTono: Record<EstadoConversacion, string> = { bot: "bot", waiting_agent: "wait", with_agent: "agent", closed: "closed" };

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
    <span className={cn("pill", statusTono[c.estado], className)}>
      {(short ? shortLabels : statusLabels)[c.estado]}
      {c.estado === "closed" && c.motivoCierre && !short && <span> · {c.motivoCierre}</span>}
    </span>
  );
}

/** Agencia que atiende (la del envío de la oferta). */
const agenciaDe = (c: ConversacionHub) => contextoDe(c).agencia || c.idAgencia;

function Brand({ c }: { c: ConversacionHub }) {
  const agencia = agenciaDe(c);
  if (!agencia) return null;
  return (
    <span className="text-xs text-muted-foreground inline-flex items-center gap-1 whitespace-nowrap min-w-0" title={`Agencia: ${agencia}`}>
      <Building2 className="h-3 w-3 flex-shrink-0" aria-hidden="true" /><span className="truncate">{agencia}</span>
    </span>
  );
}

function Avatar({ c, small }: { c: ConversacionHub; small?: boolean }) {
  return (
    <div className="relative flex-shrink-0">
      <div className={cn("rounded-full bg-muted flex items-center justify-center", small ? "h-8 w-8" : "h-9 w-9 md:h-10 md:w-10")} aria-hidden="true">
        <span className="text-xs md:text-sm font-medium">{cliente(c)[0]}</span>
      </div>
      {isPending(c) && <div className="absolute -top-0.5 -right-0.5 h-3 w-3 bg-[var(--warn)] rounded-full border-2 border-background" title="Esperando respuesta del valuador" />}
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
        <TabsTrigger value="pending">Pendientes{pendingCount > 0 && <span className="pill wait ml-2">{pendingCount}</span>}</TabsTrigger>
        <TabsTrigger value="waiting">Esperando{waitingCount > 0 && <span className="pill crit ml-2">{waitingCount}</span>}</TabsTrigger>
        <TabsTrigger value="active">Con valuador{activeCount > 0 && <Badge variant="secondary" className="ml-2">{activeCount}</Badge>}</TabsTrigger>
        <TabsTrigger value="bot">Con bot{botCount > 0 && <Badge variant="secondary" className="ml-2">{botCount}</Badge>}</TabsTrigger>
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
                <Card className={cn("cursor-pointer hover:bg-accent transition-colors py-0", isPending(c) && "border-l-4 border-l-[var(--warn)]")}>
                  {/* Compacta: tres líneas a la izquierda (nombre, datos, último mensaje) y dos a la derecha (estatus, oferta y quién atiende) */}
                  <CardContent className="flex items-center justify-between py-2.5 gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar c={c} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-x-2 min-w-0"><p className="font-medium text-sm md:text-base truncate">{cliente(c)}</p><Brand c={c} /></div>
                        <p className="text-xs md:text-sm text-muted-foreground truncate">{c.telefonoCliente}{resumen(c) && <span> · {resumen(c)}</span>}</p>
                        {preview(c) && <p className="text-xs text-muted-foreground truncate max-w-[220px] md:max-w-[420px]">&ldquo;{preview(c)}&rdquo;</p>}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 flex-shrink-0 text-right">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground whitespace-nowrap">{fecha(c.ultimoMensajeEn)}</span>
                        <ConvBadge c={c} />
                      </div>
                      <span className="text-xs text-muted-foreground flex items-center gap-1 whitespace-nowrap">
                        {c.fuente === "valuacion" && <span>Oferta #{c.idExterno}</span>}
                        {c.estado !== "closed" && c.estado !== "waiting_agent" && <span className="hidden md:inline-flex items-center gap-1">· <Handler c={c} agentes={agentes} /></span>}
                      </span>
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
                    <div className="flex items-center gap-x-1.5 gap-y-1 min-w-0 flex-wrap"><span className="font-medium text-sm truncate">{cliente(c)}</span><Brand c={c} /></div>
                    <ConvBadge c={c} short className="flex-shrink-0" />
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
            <Button key={s} variant={filter === s ? "secondary" : "ghost"} size="sm" aria-pressed={filter === s} className={cn("px-2.5 flex-shrink-0", filter === s ? "font-semibold" : "text-muted-foreground")} onClick={() => setFilter(s)}>
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
              className={cn("w-full text-left flex items-start gap-3 px-3 py-3 border-b hover:bg-accent transition-colors", sel === c.idConversacion && "bg-accent shadow-[inset_3px_0_0_var(--mod)]")}
            >
              <Avatar c={c} small />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="font-medium text-sm truncate">{cliente(c)}</p>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{fecha(c.ultimoMensajeEn)}</span>
                </div>
                <p className="text-xs text-muted-foreground truncate">{resumen(c) || c.telefonoCliente}</p>
                <div className="flex items-center justify-between gap-2 mt-1">
                  <p className="text-xs text-muted-foreground truncate">{preview(c) ? <>&ldquo;{preview(c)}&rdquo;</> : agenciaDe(c)}</p>
                  <ConvBadge c={c} short className="flex-shrink-0" />
                </div>
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
const TODAS_AGENCIAS = "__todas__";
const SIN_AGENCIA = "__sin__";

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

/**
 * Activa o silencia los avisos de conversaciones asignadas y mensajes nuevos (NotificationContext; se recuerda en este
 * navegador). Solo dentro de la plataforma: toast y sonido.
 */
function BotonAvisos() {
  const { soundEnabled, setSoundEnabled } = useNotificationContext();
  const alterna = () => {
    const activa = !soundEnabled;
    setSoundEnabled(activa);
    toast.success(activa ? "Avisos activados: te sonará cuando se te asigne una conversación o te escriba un cliente" : "Avisos silenciados");
  };
  const titulo = soundEnabled ? "Avisos activados (clic para silenciar)" : "Avisos silenciados (clic para activar)";
  return (
    <Button variant={soundEnabled ? "default" : "outline"} size="icon" onClick={alterna} title={titulo} aria-label={titulo} aria-pressed={soundEnabled}>
      {soundEnabled ? <Bell className="h-4 w-4" aria-hidden="true" /> : <BellOff className="h-4 w-4" aria-hidden="true" />}
    </Button>
  );
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

  const consulta = useCallback(async (silencioso: boolean) => {
    if (!idMarca) return;
    if (!silencioso) setCargando(true);
    const r = await consultaConversaciones({ idMarca, modulo: "valuacion", estados: TODOS, limite: 200 });
    if (!silencioso) setCargando(false);
    if (r.successful) { setConvs(r.info.conversaciones); setError(null); return; }
    if (r.errorCode === "SESION_EXPIRADA") { toast.error(mensajeError(r)); signOut({ redirectTo: "/login" }); return; }
    if (!silencioso) setError(mensajeError(r));
  }, [idMarca]);
  const carga = useCallback(() => consulta(false), [consulta]);

  // Tiempo real: cualquier cambio de una conversación del módulo en la marca vuelve a consultar la bandeja (sin spinner).
  // El refresco periódico queda de respaldo: cada 15 s sin conexión de tiempo real, cada 60 s con ella.
  const enVivo = useTiempoReal(idMarca ? `/hub/${idMarca}/valuacion` : null, () => consulta(true));
  useEffect(() => { setConvs(null); carga(); }, [carga]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") consulta(true); }, enVivo ? REFRESCO_EN_VIVO_MS : REFRESCO_MS);
    return () => clearInterval(t);
  }, [consulta, enVivo]);

  // Filtro por agencia: las que aparecen en las conversaciones (más "Sin agencia" si alguna no trae)
  const [agencia, setAgencia] = useState<string>(TODAS_AGENCIAS);
  useEffect(() => { setAgencia(TODAS_AGENCIAS); }, [idMarca]);
  const agencias = useMemo(() => {
    const nombres = new Set<string>();
    let sinAgencia = false;
    (convs ?? []).forEach((c) => { const a = agenciaDe(c); if (a) nombres.add(a); else sinAgencia = true; });
    if (agencia !== TODAS_AGENCIAS && agencia !== SIN_AGENCIA) nombres.add(agencia);   // la elegida no desaparece del menú
    return { nombres: [...nombres].sort((a, b) => a.localeCompare(b)), sinAgencia };
  }, [convs, agencia]);

  const term = q.trim().toLowerCase();
  const filtradas = useMemo(() => (convs ?? []).filter((c) => {
    const a = agenciaDe(c);
    if (agencia === SIN_AGENCIA ? !!a : agencia !== TODAS_AGENCIAS && a !== agencia) return false;
    return !term || `${cliente(c)} ${c.telefonoCliente} ${contextoDe(c).vehiculo ?? ""} ${a ?? ""}`.toLowerCase().includes(term);
  }), [convs, term, agencia]);

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
            <BotonAvisos />
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
          <div className="flex gap-2 mb-3 flex-wrap">
            {view !== "kanban" && (
              <div className="relative flex-1 min-w-[220px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <Input type="search" aria-label="Buscar conversaciones por nombre, teléfono, vehículo o agencia" placeholder="Buscar por nombre, teléfono, vehículo o agencia..." value={q} onChange={(e) => setQ(e.target.value)} className="pl-10" />
              </div>
            )}
            <Select value={agencia} onValueChange={setAgencia}>
              <SelectTrigger className="w-fit min-w-[260px] max-w-full" aria-label="Filtrar por agencia">
                <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TODAS_AGENCIAS}>Todas las agencias</SelectItem>
                {agencias.nombres.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                {agencias.sinAgencia && <SelectItem value={SIN_AGENCIA}>Sin agencia</SelectItem>}
              </SelectContent>
            </Select>
          </div>
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
  // Panel lateral con el contexto del bot (mensajes de sistema y datos del envío); el chat no los muestra
  const [panel, setPanel] = useState(false);
  const [view, setView] = useState<DetailView>("messages");
  const [dialogoCierre, setDialogoCierre] = useState(false);
  const { userData } = useAuth();
  const { usuarios, equipos, esAdmin } = useEquipoDeTrabajo(conv?.idMarca ?? null);
  const [trabajando, setTrabajando] = useState<string | null>(null);
  const [texto, setTexto] = useState("");

  const carga = useCallback(async () => {
    const r = await consultaMensajes({ idConversacion, incluyeSistema: true, limite: 200 });
    if (r.successful) { setConv(r.info.conversacion); setMensajes(r.info.mensajes); setError(null); return; }
    if (r.errorCode === "SESION_EXPIRADA") { toast.error(mensajeError(r)); signOut({ redirectTo: "/login" }); return; }
    setError(r.errorCode === "CONVERSACION_NO_ENCONTRADA"
      ? "La conversación no existe o no la puedes ver (es de otro equipo o de otra marca)."
      : mensajeError(r));
  }, [idConversacion]);

  // Con un aviso basta pedir lo posterior al último mensaje que ya se tiene (con la conversación al día)
  const ultimoId = useRef<string | null>(null);
  ultimoId.current = mensajes.length ? mensajes[mensajes.length - 1].idMensaje : null;
  const cargaNuevos = useCallback(async () => {
    const desde = ultimoId.current;
    if (!desde) { carga(); return; }
    const r = await consultaMensajes({ idConversacion, incluyeSistema: true, desdeIdMensaje: desde, limite: 200 });
    if (!r.successful) return;          // el refresco de respaldo lo vuelve a intentar
    if (r.info.hayMas) { carga(); return; }
    setConv(r.info.conversacion);
    setMensajes((ms) => {
      const ya = new Set(ms.map((m) => m.idMensaje));
      const nuevos = r.info.mensajes.filter((m) => !ya.has(m.idMensaje));
      return nuevos.length ? [...ms, ...nuevos] : ms;
    });
  }, [idConversacion, carga]);

  const enVivo = useTiempoReal(conv ? `/hub/${conv.idMarca}/${conv.modulo}/${idConversacion}` : null, cargaNuevos);
  useEffect(() => { carga(); }, [carga]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") carga(); }, enVivo ? REFRESCO_EN_VIVO_MS : REFRESCO_MS);
    return () => clearInterval(t);
  }, [carga, enVivo]);

  // Scroll: al abrir (o volver a Mensajes) baja al último mensaje; con cada mensaje nuevo baja solo si ya estaba abajo.
  // Si subió a leer, no se le mueve: aparece "Mensajes nuevos" para bajar.
  const chat = useMemo(() => mensajes.filter((m) => m.remitente !== "system"), [mensajes]);
  const sistema = useMemo(() => mensajes.filter((m) => m.remitente === "system"), [mensajes]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abajo = useRef(true);
  const [hayNuevos, setHayNuevos] = useState(false);
  const ultimoChat = chat.length ? chat[chat.length - 1].idMensaje : null;
  const bajar = useCallback((suave = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: suave ? "smooth" : "auto" });
    abajo.current = true;
    setHayNuevos(false);
  }, []);
  useEffect(() => { abajo.current = true; }, [view, idConversacion]);
  useEffect(() => {
    if (view !== "messages" || !ultimoChat) return;
    if (abajo.current) bajar();
    else setHayNuevos(true);
  }, [ultimoChat, view, bajar]);
  const alHacerScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    abajo.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (abajo.current) setHayNuevos(false);
  };

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
      abajo.current = true;   // lo que uno escribe siempre se ve
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

  // Acciones para atender (mismas que Ventas y Servicio): una principal a la vista y el resto en el menú "Más acciones"
  const puedeAsignar = abierta && esAdmin && asignables.length > 0;
  const puedeTransferir = abierta && esAdmin && otrosEquipos.length > 0;
  const puedeDevolver = conv.estado === "with_agent" && (esMia || esAdmin);
  const principal: "tomar" | "bot" | "reabrir" | null =
    puedeTomar ? "tomar" : puedeDevolver ? "bot" : conv.estado === "closed" ? "reabrir" : null;
  const tomar = () => ejecuta("tomar", toma, "Tomaste la conversación");
  const devolver = () => ejecuta("bot", () => devuelveAlBot(version), "La conversación volvió al bot");
  const reabrir = () => ejecuta("reabrir", () => reabreConversacion(version), "Conversación reabierta: la atiende el bot");
  const hayMenu = puedeAsignar || puedeTransferir || (puedeDevolver && principal !== "bot") || abierta;
  const atiende = conv.estado === "with_agent" ? (esMia ? "Tú" : (conv.idAgente && agentes[conv.idAgente]) || "Valuador") : null;
  const giro = (accion: string) => trabajando === accion ? <Loader2 className="animate-spin" aria-hidden="true" /> : null;

  return (
    <div className="flex flex-col h-full">
      {/* Encabezado: quién es, en qué estatus está y qué se puede hacer, en una sola barra */}
      <div className="flex items-start gap-3 pb-3 border-b">
        {!compact && (
          <Button asChild variant="ghost" size="icon" className="flex-shrink-0 -ml-2">
            <Link href={BASE} aria-label="Volver a conversaciones"><ArrowLeft className="h-5 w-5" aria-hidden="true" /></Link>
          </Button>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <h1 className={cn("text-base font-semibold truncate", !compact && "md:text-lg")}>{cliente(conv)}</h1>
            <ConvBadge c={conv} />
          </div>
          <p className="text-sm text-muted-foreground truncate">
            {[conv.telefonoCliente, ctx.agencia, conv.fuente === "valuacion" ? `Oferta #${conv.idExterno}` : null, resumen(conv) || null, atiende ? `Atiende: ${atiende}` : null]
              .filter(Boolean).join(" · ")}
          </p>
          {ctx.telefonoOriginal && <p className="text-xs text-[var(--warn)]">Envío de prueba · cliente real: {ctx.telefonoOriginal}</p>}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {principal === "tomar" && <Button size="sm" disabled={!!trabajando} onClick={tomar}>{giro("tomar") ?? <Hand aria-hidden="true" />}Tomar</Button>}
          {principal === "bot" && <Button variant="outline" size="sm" disabled={!!trabajando} onClick={devolver}>{giro("bot") ?? <RotateCcw aria-hidden="true" />}Devolver al bot</Button>}
          {principal === "reabrir" && <Button variant="outline" size="sm" disabled={!!trabajando} onClick={reabrir}>{giro("reabrir") ?? <RefreshCw aria-hidden="true" />}Reabrir</Button>}
          {hayMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-sm" disabled={!!trabajando} aria-label="Más acciones" title="Más acciones">
                  {trabajando && !["tomar", "bot", "reabrir"].includes(trabajando) ? <Loader2 className="animate-spin" aria-hidden="true" /> : <MoreHorizontal aria-hidden="true" />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {puedeAsignar && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger><UserPlus aria-hidden="true" />Asignar a un valuador</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                      <DropdownMenuRadioGroup value={conv.idAgente ?? ""}
                        onValueChange={(id) => { if (id && id !== conv.idAgente) ejecuta("asignar", () => asignaConversacion({ ...version, idAgente: id }), "Conversación asignada"); }}>
                        {asignables.map((u) => <DropdownMenuRadioItem key={u.idUsuario} value={u.idUsuario}>{u.nombre || u.email}</DropdownMenuRadioItem>)}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                {puedeTransferir && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger><ArrowRightLeft aria-hidden="true" />Transferir a otro equipo</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                      {otrosEquipos.map((e) => (
                        <DropdownMenuItem key={e.idEquipo} onSelect={() => ejecuta("transferir", () => transfiereEquipo({ ...version, idEquipo: e.idEquipo }), "Conversación transferida de equipo")}>
                          {e.nombre}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                {puedeDevolver && principal !== "bot" && <DropdownMenuItem onSelect={devolver}><RotateCcw aria-hidden="true" />Devolver al bot</DropdownMenuItem>}
                {abierta && (
                  <>
                    {(puedeAsignar || puedeTransferir || (puedeDevolver && principal !== "bot")) && <DropdownMenuSeparator />}
                    <DropdownMenuItem variant="destructive" onSelect={() => setDialogoCierre(true)}><XCircle aria-hidden="true" />Cerrar conversación</DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Secciones: mensajes u oferta; el contexto del bot se abre a un lado */}
      <div className="flex items-center gap-2 border-b">
        <div className="flex" role="tablist" aria-label="Secciones de la conversación">
          {([["messages", "Mensajes", MessageSquare], ...(conv.fuente === "valuacion" ? [["offer", "Oferta", FileText] as const] : [])] as const).map(([id, label, Ico]) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}
              className={cn("inline-flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px transition-colors",
                view === id ? "border-[var(--mod)] text-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}>
              <Ico className="h-4 w-4" aria-hidden="true" />{label}
            </button>
          ))}
        </div>
        <Button variant={panel ? "secondary" : "ghost"} size="sm" aria-pressed={panel} aria-controls="panel-contexto"
          className="ml-auto text-muted-foreground" onClick={() => setPanel((p) => !p)} aria-label="Contexto del bot"
          title={panel ? "Ocultar el contexto del bot" : "Ver el contexto del bot"}>
          <PanelRight aria-hidden="true" />{!compact && "Contexto del bot"}
          {sistema.length > 0 && <span className="pill">{sistema.length}</span>}
        </Button>
      </div>

      <div className="flex-1 min-h-0 flex">
      <div className="flex-1 min-w-0 flex flex-col">
      {view === "messages" && (
        <>
          <div className="relative flex-1 min-h-0">
          <div ref={scrollRef} onScroll={alHacerScroll} className="h-full overflow-y-auto py-4 space-y-2">
            {chat.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">Sin mensajes todavía.</p>}
            {chat.map((m) => {
              const d = dia(m.creadoEn);
              const separador = d !== diaAnterior
                ? <div className="flex items-center justify-center my-4"><span className="bg-muted text-muted-foreground text-xs px-3 py-1 rounded-full">{d}</span></div>
                : null;
              diaAnterior = d;
              if (m.remitente === "system") return null;
              const esCliente = m.remitente === "customer";
              return (
                <div key={m.idMensaje}>{separador}
                  <div className={cn("flex mb-2", esCliente ? "justify-start" : "justify-end")}>
                    {/* Colores del tema: cliente en blanco con borde, bot en azul tenue, valuador en el color principal */}
                    <div className={cn("max-w-[70%] rounded-xl px-3.5 py-2 text-sm",
                      esCliente ? "bg-card border text-foreground rounded-bl-sm"
                        : m.remitente === "bot" ? "bg-[var(--info-bg)] text-foreground rounded-br-sm"
                          : "bg-[var(--bubble-out)] text-[var(--bubble-out-fg)] rounded-br-sm")}>
                      <div className="flex items-center gap-1 text-xs mb-0.5 opacity-75">
                        {esCliente ? <User className="h-3 w-3" aria-hidden="true" /> : m.remitente === "bot" ? <Bot className="h-3 w-3" aria-hidden="true" /> : <UserCircle className="h-3 w-3" aria-hidden="true" />}
                        <span>{m.remitente === "agent" ? (m.idAgente && agentes[m.idAgente]) || QUIEN.agent : QUIEN[m.remitente]}{m.esPlantilla ? " · plantilla" : ""}</span>
                      </div>
                      {m.texto && <p className="whitespace-pre-wrap break-words">{m.texto}</p>}
                      {m.mediaUrl && <a href={m.mediaUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline"><Paperclip className="h-3.5 w-3.5" aria-hidden="true" />Archivo adjunto</a>}
                      <p className="text-xs mt-0.5 text-right opacity-75">{hora(m.creadoEn)}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {hayNuevos && (
            <Button size="sm" className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md rounded-full h-8" onClick={() => bajar(true)}>
              <ArrowDown className="mr-1 h-3 w-3" aria-hidden="true" />Mensajes nuevos
            </Button>
          )}
          </div>
          <div className="border-t pt-3">
            {/* Si no se puede escribir, se dice por qué en lugar del campo deshabilitado */}
            {aviso ? (
              <p className="rounded-md bg-muted px-3 py-2.5 text-sm text-muted-foreground">{aviso}</p>
            ) : (
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); envia(); }}>
                <Input aria-label="Mensaje" placeholder="Escribe un mensaje…" className="flex-1" value={texto} maxLength={4096}
                  disabled={trabajando === "enviar"} onChange={(e) => setTexto(e.target.value)} />
                <Button type="submit" aria-label="Enviar mensaje" disabled={!texto.trim() || !!trabajando}>
                  {trabajando === "enviar" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}Enviar
                </Button>
              </form>
            )}
          </div>
        </>
      )}
      {view === "offer" && (
        <div className="flex-1 min-h-0 overflow-y-auto py-4 pr-1">
          {conv.idExterno && Number.isFinite(Number(conv.idExterno))
            ? <OfertaEnConversacion idOferta={Number(conv.idExterno)} />
            : <p className="text-center text-sm text-muted-foreground py-8">Esta conversación no tiene una oferta ligada.</p>}
        </div>
      )}
      </div>

      {/* Contexto del bot: lo que el bot sabe de la oferta y sus notas de sistema, a un lado del chat */}
      {panel && (
        <aside id="panel-contexto" aria-label="Contexto del bot"
          className={cn("flex-shrink-0 border-l pl-3 ml-3 py-3 overflow-y-auto flex flex-col gap-4", compact ? "w-64" : "w-80")}>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold flex items-center gap-1.5"><Bot className="h-4 w-4" aria-hidden="true" />Contexto del bot</h2>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPanel(false)} aria-label="Cerrar el contexto del bot"><X className="h-4 w-4" /></Button>
          </div>
          {conv.fuente === "valuacion" && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Datos del envío</h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">Oferta</dt><dd>#{conv.idExterno}</dd>
                <dt className="text-muted-foreground">Cliente</dt><dd className="break-words">{ctx.nombreCliente ?? "—"}</dd>
                <dt className="text-muted-foreground">Vehículo</dt><dd className="break-words">{ctx.vehiculo ?? "—"}</dd>
                <dt className="text-muted-foreground">Kilometraje</dt><dd>{typeof ctx.kilometraje === "number" ? `${ctx.kilometraje.toLocaleString("es-MX")} km` : "—"}</dd>
                <dt className="text-muted-foreground">Monto</dt><dd>{dinero(ctx.montoOferta) ?? "—"}</dd>
                <dt className="text-muted-foreground">Agencia</dt><dd className="break-words">{ctx.agencia ?? "—"}</dd>
                <dt className="text-muted-foreground">Cita</dt><dd>{[ctx.fechaCita, ctx.horaCita].filter(Boolean).join(" ") || "—"}</dd>
              </dl>
              <p className="text-xs text-muted-foreground">Con estos datos se envió la oferta. Su estado actual está en la pestaña Oferta.</p>
            </section>
          )}
          <section className="space-y-2">
            <h3 className="text-sm font-medium">Notas del sistema</h3>
            {sistema.length === 0 ? <p className="text-sm text-muted-foreground">Sin notas todavía.</p> : (
              <ol className="space-y-2">
                {sistema.map((m) => (
                  <li key={m.idMensaje} className="rounded-md bg-muted px-3 py-2 text-xs">
                    <p className="whitespace-pre-wrap break-words">{m.texto}</p>
                    <p className="mt-1 text-muted-foreground">{new Date(m.creadoEn).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" })}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </aside>
      )}
      </div>

      <DialogoCierreConversacion
        conv={conv} abierto={dialogoCierre} onCerrar={() => setDialogoCierre(false)}
        onCerrada={(cerrada) => { if (cerrada) setConv(cerrada); onCambio?.(); carga(); }}
      />
    </div>
  );
}
