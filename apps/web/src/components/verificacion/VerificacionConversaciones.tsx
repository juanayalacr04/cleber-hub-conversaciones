"use client";

/**
 * Verificaciones de datos del cliente con datos reales (hub_cleber). Módulo de solo consulta: las verificaciones las
 * resuelve el bot por WhatsApp y el resultado se entrega a Salesforce; aquí no se responde, no se cambia el resultado,
 * no se transfiere ni se cierra nada.
 *
 *   Lista:     Hub.consultaVerificaciones (permisos del módulo verificacion en la base)
 *   Mensajes:  Hub.consultaMensajes (el chat se muestra sin caja de respuesta)
 * El detalle busca su verificación por el ID de Salesforce de la conversación (Hub.consultaVerificaciones con busqueda).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signOut } from "next-auth/react";
import { ArrowLeft, Loader2, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { PageHead } from "@/components/shell/Shell";
import { useAuth } from "@/contexts/AuthContext";
import type { ModuleDef } from "@/lib/modules";
import { consultaMensajes, type ConversacionHub, type MensajeHub } from "@/lib/hub/conversaciones";
import {
  consultaVerificaciones, type EstadoCallback, type EstadoVerificacion, type Verificacion,
} from "@/lib/hub/verificaciones";
import { mensajeError } from "@/lib/hub/errores";
import { cn } from "@/lib/utils";

const BASE = "/verificacion/conversaciones";
const LIMITE = 50;
const TODOS = "__todos__";

const ESTADOS: { id: EstadoVerificacion; label: string; tono: string }[] = [
  { id: "pendiente", label: "Pendiente", tono: "wait" },
  { id: "valido", label: "Válido", tono: "agent" },
  { id: "no_valido", label: "No válido", tono: "crit" },
];
const CALLBACKS: { id: EstadoCallback; label: string; tono: string }[] = [
  { id: "enviado", label: "Enviado", tono: "agent" },
  { id: "fallido", label: "Fallido", tono: "crit" },
  { id: "pendiente", label: "Pendiente", tono: "wait" },
];

const estadoInfo = (e: EstadoVerificacion) => ESTADOS.find((x) => x.id === e) ?? { id: e, label: e, tono: "" };
const callbackInfo = (e: EstadoCallback | null) => CALLBACKS.find((x) => x.id === e) ?? { id: e, label: "Sin intento", tono: "closed" };
const fechaHora = (s: string) => new Date(s).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
const hora = (s: string) => new Date(s).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
const dia = (s: string) => new Date(s).toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });

function EstadoBadge({ estado }: { estado: EstadoVerificacion }) {
  const info = estadoInfo(estado);
  return <span className={`pill ${info.tono}`}>{info.label}</span>;
}

function CallbackBadge({ v }: { v: Verificacion }) {
  const info = callbackInfo(v.callback.estado);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`pill ${info.tono}`}>{info.label}</span>
      {v.callbackSimulado && <span className="tag">simulado</span>}
    </span>
  );
}

// ---------- Listado (/verificacion/conversaciones) ----------

export function VerificacionConversaciones() {
  const { userData } = useAuth();
  const idMarca = userData?.organizationId ?? null;
  const router = useRouter();
  const searchParams = useSearchParams();
  const [estado, setEstado] = useState<EstadoVerificacion | null>(() => ESTADOS.find((e) => e.id === searchParams.get("estado"))?.id ?? null);
  const [callback, setCallback] = useState<EstadoCallback | null>(() => CALLBACKS.find((c) => c.id === searchParams.get("callback"))?.id ?? null);
  const [q, setQ] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [lista, setLista] = useState<Verificacion[] | null>(null);
  const [hayMas, setHayMas] = useState(false);
  const [cargando, setCargando] = useState(false);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // La búsqueda espera a que se deje de escribir: cada consulta va a la base
  useEffect(() => {
    const t = setTimeout(() => setBusqueda(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const consulta = useCallback(async (antesDe?: string) => {
    if (!idMarca) return;
    const p = {
      idMarca, limite: LIMITE,
      ...(estado ? { estados: [estado] } : {}),
      ...(callback ? { callbackEstados: [callback] } : {}),
      ...(busqueda ? { busqueda } : {}),
      ...(antesDe ? { antesDe } : {}),
    };
    if (antesDe) setCargandoMas(true); else { setCargando(true); setError(null); }
    const r = await consultaVerificaciones(p);
    if (antesDe) setCargandoMas(false); else setCargando(false);
    if (!r.successful) {
      if (r.errorCode === "SESION_EXPIRADA") { toast.error(mensajeError(r, "Verificación")); signOut({ redirectTo: "/login" }); return; }
      if (!antesDe) { setLista(null); setHayMas(false); setError(mensajeError(r, "Verificación")); }
      return;
    }
    setLista((prev) => (antesDe && prev ? [...prev, ...r.info.verificaciones] : r.info.verificaciones));
    setHayMas(r.info.hayMas);
  }, [idMarca, estado, callback, busqueda]);

  useEffect(() => { setLista(null); setHayMas(false); consulta(); }, [consulta]);

  const cargaMas = () => {
    const ultima = lista?.[lista.length - 1];
    if (ultima) consulta(ultima.creadoEn);
  };

  const abre = (v: Verificacion) => {
    if (v.idConversacion) router.push(`${BASE}/${encodeURIComponent(v.idConversacion)}`);
  };

  return (
    <div>
      <div className="flex flex-col gap-4 mb-6 md:mb-8">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-xl md:text-2xl font-bold">Conversaciones</h1>
            <p className="text-muted-foreground text-sm hidden md:block">Verificaciones de datos del cliente por WhatsApp</p>
          </div>
          <button type="button" className="btn" onClick={() => consulta()} disabled={cargando}>
            <RefreshCw size={14} className={cn(cargando && "ospin")} aria-hidden="true" />Actualizar
          </button>
        </div>
      </div>

      {error ? (
        <div className="card">
          <div className="empty">
            <p>No se pudieron cargar las verificaciones: {error}</p>
            <button type="button" className="btn" onClick={() => consulta()} disabled={cargando}>Reintentar</button>
          </div>
        </div>
      ) : !lista ? (
        <div className="empty"><Loader2 size={20} className="ospin" aria-hidden="true" /><span className="vsub">Cargando...</span></div>
      ) : (
        <>
          <div className="vfilters mb-3">
            <label className="search vsearch">
              <Search size={16} aria-hidden="true" />
              <input
                type="search" value={q} onChange={(e) => setQ(e.target.value)}
                placeholder="Buscar por ID de Salesforce o teléfono..." aria-label="Buscar por ID de Salesforce o teléfono"
              />
            </label>
            <select
              className="date" value={estado ?? TODOS} aria-label="Filtrar por estado de la verificación"
              onChange={(e) => setEstado(ESTADOS.find((x) => x.id === e.target.value)?.id ?? null)}
            >
              <option value={TODOS}>Todos los estados</option>
              {ESTADOS.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
            </select>
            <select
              className="date" value={callback ?? TODOS} aria-label="Filtrar por estado del callback"
              onChange={(e) => setCallback(CALLBACKS.find((x) => x.id === e.target.value)?.id ?? null)}
            >
              <option value={TODOS}>Todos los callbacks</option>
              {CALLBACKS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>

          {lista.length === 0 ? (
            <div className="card"><div className="empty">No hay verificaciones con estos filtros.</div></div>
          ) : (
            <div className="card">
              <div className="tbl-wrap">
                <table className="vtable">
                  <thead><tr>
                    <th>ID de Salesforce</th><th>Teléfono verificado</th><th>Estado</th><th>Callback</th><th>Fecha</th>
                  </tr></thead>
                  <tbody>
                    {lista.map((v) => (
                      <tr
                        key={v.idVerificacion}
                        className={v.idConversacion ? "vrow" : undefined}
                        tabIndex={v.idConversacion ? 0 : undefined}
                        onClick={() => abre(v)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); abre(v); } }}
                        aria-label={v.idConversacion ? `Ver la conversación de la verificación ${v.idExterno}` : undefined}
                      >
                        <td className="mono">{v.idExterno}</td>
                        <td className="num">{v.valor}</td>
                        <td><EstadoBadge estado={v.estado} /></td>
                        <td><CallbackBadge v={v} /></td>
                        <td><span className="vsub">{fechaHora(v.creadoEn)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {hayMas && (
                <div className="row" style={{ justifyContent: "center" }}>
                  <button type="button" className="btn" onClick={cargaMas} disabled={cargandoMas}>
                    {cargandoMas && <Loader2 size={14} className="ospin" aria-hidden="true" />}Cargar más
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------- Detalle (/verificacion/conversaciones/[id]) ----------

const QUIEN: Record<Exclude<MensajeHub["remitente"], "system">, string> = { customer: "Cliente", bot: "Bot de verificación", agent: "Asesor" };

export function VerificacionConversacion({ idConversacion }: { idConversacion: string }) {
  const [conv, setConv] = useState<ConversacionHub | null>(null);
  const [mensajes, setMensajes] = useState<MensajeHub[]>([]);
  const [verificacion, setVerificacion] = useState<Verificacion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  const carga = useCallback(async () => {
    setCargando(true);
    const r = await consultaMensajes({ idConversacion, incluyeSistema: true, limite: 200 });
    setCargando(false);
    if (!r.successful) {
      if (r.errorCode === "SESION_EXPIRADA") { toast.error(mensajeError(r, "Verificación")); signOut({ redirectTo: "/login" }); return; }
      setError(r.errorCode === "CONVERSACION_NO_ENCONTRADA"
        ? "La conversación no existe o no la puedes ver (es de otra marca)."
        : mensajeError(r, "Verificación"));
      return;
    }
    setConv(r.info.conversacion);
    setMensajes(r.info.mensajes);
    setError(null);
    // La verificación se busca por el ID de Salesforce que trae la conversación
    if (!r.info.conversacion.idExterno) return;
    const v = await consultaVerificaciones({ idMarca: r.info.conversacion.idMarca, busqueda: r.info.conversacion.idExterno, limite: 50 });
    if (v.successful) setVerificacion(v.info.verificaciones.find((x) => x.idConversacion === idConversacion) ?? null);
  }, [idConversacion]);

  useEffect(() => { carga(); }, [carga]);

  const chat = useMemo(() => mensajes.filter((m) => m.remitente !== "system"), [mensajes]);
  const sistema = useMemo(() => mensajes.filter((m) => m.remitente === "system"), [mensajes]);

  const volver = (
    <Link href={BASE} className="btn" aria-label="Volver a conversaciones">
      <ArrowLeft size={14} aria-hidden="true" />Volver
    </Link>
  );

  if (error || !conv) {
    return (
      <>
        <PageHead title="Conversación" subtitle="Verificación de datos del cliente" actions={volver} />
        <div className="view">
          <div className="pad">
            <div className="card">
              <div className="empty">
                {error ? <>
                  <p>{error}</p>
                  <button type="button" className="btn" onClick={carga} disabled={cargando}>Reintentar</button>
                </> : <><Loader2 size={20} className="ospin" aria-hidden="true" /><span className="vsub">Cargando...</span></>}
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  let diaAnterior = "";
  return (
    <>
      <PageHead title={conv.telefonoCliente} subtitle="Verificación de datos del cliente · solo consulta" actions={volver} />
      <div className="view">
        <div className="pad">
          <div className="two">
            <div className="card">
              <div className="card-h">
                <h2>Mensajes</h2>
                <span className="sub">{chat.length} mensaje{chat.length === 1 ? "" : "s"}</span>
              </div>
              <div className="msgs" style={{ maxHeight: 560 }}>
                {chat.length === 0 && <p className="vsub">Sin mensajes todavía.</p>}
                {chat.map((m) => {
                  const d = dia(m.creadoEn);
                  const separador = d !== diaAnterior ? <span className="day">{d}</span> : null;
                  diaAnterior = d;
                  const esCliente = m.remitente === "customer";
                  return (
                    <div key={m.idMensaje}>
                      {separador}
                      <div className={cn("msg", m.remitente === "bot" && "bot", m.remitente === "agent" && "agent")}>
                        <span className="who">{esCliente ? QUIEN.customer : m.remitente === "bot" ? QUIEN.bot : QUIEN.agent}{m.esPlantilla ? " · plantilla" : ""}</span>
                        {m.texto && <p style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{m.texto}</p>}
                        {m.mediaUrl && <a href={m.mediaUrl} target="_blank" rel="noreferrer">Archivo adjunto</a>}
                        <small>{hora(m.creadoEn)}</small>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="card">
              <div className="card-h"><h2>Verificación</h2></div>
              <div className="info">
                <section>
                  <h3>Datos</h3>
                  <dl className="dl">
                    <dt>ID de Salesforce</dt><dd className="mono">{verificacion?.idExterno ?? conv.idExterno ?? "—"}</dd>
                    <dt>Teléfono verificado</dt><dd>{verificacion?.valor ?? conv.telefonoCliente}</dd>
                    <dt>Estado</dt><dd>{verificacion ? <EstadoBadge estado={verificacion.estado} /> : "—"}</dd>
                    <dt>Resultado de la conversación</dt><dd>{conv.resultado ?? verificacion?.conversacion?.resultado ?? "—"}</dd>
                    <dt>Resuelta</dt><dd>{verificacion?.resueltoEn ? fechaHora(verificacion.resueltoEn) : "—"}</dd>
                    <dt>Solicitada</dt><dd>{fechaHora(verificacion?.creadoEn ?? conv.creadoEn)}</dd>
                  </dl>
                </section>

                <section>
                  <h3>Callback a Salesforce</h3>
                  <dl className="dl">
                    <dt>Estado</dt><dd>{verificacion ? <CallbackBadge v={verificacion} /> : "—"}</dd>
                    <dt>Intentos</dt><dd className="num">{verificacion?.callback.intentos ?? 0}</dd>
                    <dt>Último intento</dt><dd>{verificacion?.callback.ultimoIntentoEn ? fechaHora(verificacion.callback.ultimoIntentoEn) : "—"}</dd>
                    <dt>Entregado</dt><dd>{verificacion?.callback.enviadoEn ? fechaHora(verificacion.callback.enviadoEn) : "—"}</dd>
                  </dl>
                  {verificacion?.callback.ultimoError && <p className="vreason">Último error: {verificacion.callback.ultimoError}</p>}
                  {verificacion?.simularCallback && <p className="vhint">La marca tiene encendida la simulación del callback: los intentos no salen a Salesforce.</p>}
                </section>

                {sistema.length > 0 && (
                  <section>
                    <h3>Notas del sistema</h3>
                    <ol className="vhist">
                      {sistema.map((m) => (
                        <li key={m.idMensaje}>
                          <span>{m.texto}</span>
                          <small>{fechaHora(m.creadoEn)}</small>
                        </li>
                      ))}
                    </ol>
                  </section>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
