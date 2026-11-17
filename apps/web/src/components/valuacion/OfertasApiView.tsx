"use client";

/**
 * Ofertas de valuación con datos reales (schema `valuacion` por el API Gateway, ruta /toma-unidades).
 * Reemplaza en el dashboard al prototipo (OfertasView + lib/valuacion/store.ts), que sigue en /demo/valuacion.
 *
 * Estado + detalle (lib/valuacion/tipos.ts): la pestaña ya dice el estado, así que la fila muestra el detalle.
 * Las acciones aparecen según `oferta.puede`, que calcula la base; la base vuelve a validar todo. Cada acción manda
 * la `version` de la oferta (bloqueo optimista): si otro usuario la cambió, la base responde VERSION_DESACTUALIZADA
 * con la oferta al día y se reemplaza en la tabla.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { signOut } from "next-auth/react";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowDown, ArrowUp, Ban, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Lock, MessageSquareReply,
  MessageSquare, Minus, MoreHorizontal, Pencil, RefreshCw, RotateCcw, Search, Send, X,
} from "lucide-react";
import { PageHead } from "@/components/shell/Shell";
import type { ModuleDef } from "@/lib/modules";
import type { ApiResponse } from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { addDays, fmtKm, fmtMoney, parseIso, todayIso } from "@/lib/valuacion/store";
import {
  ESTADOS, GRUPOS, MOTIVO_EVALUACION, detalleOferta, mensajeError, motivoNoVigente,
  type EstadoOferta, type Etiqueta, type EvaluacionCita, type Grupo, type Oferta,
} from "@/lib/valuacion/tipos";
import {
  calibraOferta, cierraOferta, consultaEtiquetas, consultaOferta, consultaOfertas, descartaOferta, enviaOferta, registraRespuesta, retomaOferta,
} from "@/lib/valuacion/acciones";

type Orden = { por: "hora" | "modelo"; asc: boolean };
type TipoDialogo = "descartar" | "retomar" | "cerrar" | "respuesta";
type Dialogo = { tipo: TipoDialogo; oferta: Oferta } | null;

const dinero = (n: number | null | undefined) => (n == null ? "—" : fmtMoney(Number(n)));
const modelo = (o: Oferta) => [o.vehiculo.marca, o.vehiculo.modelo].filter(Boolean).join(" ") || "Vehículo sin identificar";
const fechaHora = (s: string | null) => (s ? new Date(s).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" }) : "—");

/** "Hoy", "Ayer", "Mañana" o "mar 17 nov" (contra el día real, no contra la fecha elegida). */
function diaRelativo(s: string, hoy: string, conAnio = false) {
  if (s === hoy) return "Hoy";
  if (s === addDays(hoy, -1)) return "Ayer";
  if (s === addDays(hoy, 1)) return "Mañana";
  return parseIso(s).toLocaleDateString("es-MX", { weekday: "short", day: "numeric", month: "short", ...(conAnio ? { year: "numeric" } : {}) });
}

/** Respuesta fallida: sesión vencida → login; versión vieja → se reemplaza con la de la base; lo demás → aviso. */
function useManejaError(reemplaza: (o: Oferta) => void) {
  return useCallback((r: Extract<ApiResponse<unknown>, { successful: false }>) => {
    if (r.errorCode === "SESION_EXPIRADA") {
      toast.error(mensajeError(r));
      signOut({ redirectTo: "/login" });
      return;
    }
    const info = (r.info ?? {}) as { causa?: string; oferta?: Oferta };
    if (info.oferta) reemplaza(info.oferta);
    toast.error(info.causa === "VERSION_DESACTUALIZADA" ? "Otra persona cambió esta oferta; se actualizó con sus datos." : mensajeError(r));
  }, [reemplaza]);
}

export function OfertasApiView({ mod }: { mod: ModuleDef }) {
  const hoy = todayIso();
  const [fecha, setFecha] = useState(hoy);
  const [ofertas, setOfertas] = useState<Oferta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [tab, setTab] = useState<EstadoOferta>("VIGENTE");
  const [grupo, setGrupo] = useState<Grupo | "all">("all");
  const [agencia, setAgencia] = useState("all");
  const [q, setQ] = useState("");
  const [orden, setOrden] = useState<Orden>({ por: "hora", asc: true });
  const [abierta, setAbierta] = useState<number | null>(null);
  const [ocupada, setOcupada] = useState<number | null>(null);
  const [dialogo, setDialogo] = useState<Dialogo>(null);

  const reemplaza = useCallback((o: Oferta) => {
    setOfertas((lista) => lista?.map((x) => (x.idOferta === o.idOferta ? o : x)) ?? lista);
  }, []);
  const manejaError = useManejaError(reemplaza);

  const carga = useCallback(async (f: string) => {
    setCargando(true);
    setError(null);
    const r = await consultaOfertas({ fechaGeneracion: f });
    setCargando(false);
    if (r.successful) {
      setOfertas(r.info.ofertas);
      return;
    }
    if (r.errorCode === "SESION_EXPIRADA") return manejaError(r);
    setOfertas(null);
    setError(mensajeError(r));
  }, [manejaError]);

  useEffect(() => { carga(fecha); }, [fecha, carga]);

  // Una acción sobre una oferta: marca la fila ocupada, aplica la respuesta y avisa
  const ejecuta = async (o: Oferta, accion: () => Promise<ApiResponse<{ oferta: Oferta }>>, exito: string) => {
    setOcupada(o.idOferta);
    const r = await accion();
    setOcupada(null);
    if (!r.successful) return manejaError(r), false;
    reemplaza(r.info.oferta);
    toast.success(exito);
    return true;
  };
  const calibra = (o: Oferta, monto: number) =>
    ejecuta(o, () => calibraOferta({ idOferta: o.idOferta, version: o.version, montoOferta: monto }), "Monto guardado");
  // Si el hub no pudo enviar, la respuesta trae la oferta ya en FALLIDO (se reemplaza en la tabla) y el motivo
  const envia = (o: Oferta) =>
    ejecuta(o, () => enviaOferta({ idOferta: o.idOferta, version: o.version }), "Oferta enviada por WhatsApp");

  const agencias = useMemo(() => {
    const m = new Map<string, string>();
    (ofertas ?? []).forEach((o) => m.set(o.idAgencia, o.nombreAgencia ?? o.idAgencia));
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [ofertas]);
  const deAgencia = useMemo(() => (ofertas ?? []).filter((o) => agencia === "all" || o.idAgencia === agencia), [ofertas, agencia]);
  const enTab = deAgencia.filter((o) => o.estado === tab);
  const filas = useMemo(() => {
    const term = q.trim().toLowerCase();
    const dir = orden.asc ? 1 : -1;
    return enTab
      .filter((o) => (grupo === "all" || detalleOferta(o).grupo === grupo)
        && (!term || `${o.contacto.nombre ?? ""} ${modelo(o)} ${o.contacto.telefono ?? ""}`.toLowerCase().includes(term)))
      .sort((a, b) => dir * (orden.por === "hora"
        ? `${a.fechaCita} ${a.horaCita ?? ""}`.localeCompare(`${b.fechaCita} ${b.horaCita ?? ""}`)
        : modelo(a).localeCompare(modelo(b)))
        || (a.contacto.nombre ?? "").localeCompare(b.contacto.nombre ?? ""));
  }, [enTab, grupo, q, orden]);
  const filtrado = grupo !== "all" || q.trim() !== "";
  const variasAgencias = agencias.length > 1;

  const cambiaTab = (t: EstadoOferta) => { setTab(t); setGrupo("all"); setAbierta(null); };
  const alterna = (id: number) => setAbierta((a) => (a === id ? null : id));
  const ordena = (por: Orden["por"]) => setOrden((o) => (o.por === por ? { por, asc: !o.asc } : { por, asc: true }));

  return (
    <>
      <PageHead title="Ofertas" subtitle="Resultado del proceso de madrugada: una propuesta por cita" mod={mod} />
      <div className="toolbar">
        <div className="tabs" role="tablist">
          {ESTADOS.map((e) => (
            <button key={e.id} type="button" role="tab" className="tab" aria-selected={tab === e.id} onClick={() => cambiaTab(e.id)}>
              {e.id === "VIGENTE" ? "Vigentes" : e.id === "NO_VIGENTE" ? "No vigentes" : "Cerradas"}
              <span className="n">{deAgencia.filter((o) => o.estado === e.id).length}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="view">
        <div className="pad" style={{ maxWidth: "none", gap: 16 }}>
          {/* Fila 1: qué día (izquierda) · buscar y acotar (derecha) */}
          <div className="obar">
            <SelectorFecha fecha={fecha} hoy={hoy} onCambia={(f) => { setFecha(f); setAbierta(null); }} />
            <div className="obar-r">
              <label className="search vsearch"><Search size={15} aria-hidden="true" /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar cliente, modelo o teléfono" aria-label="Buscar ofertas" /></label>
              {variasAgencias && (
                <select className="date" value={agencia} onChange={(e) => setAgencia(e.target.value)} aria-label="Agencia">
                  <option value="all">Todas mis agencias</option>
                  {agencias.map(([id, nombre]) => <option key={id} value={id}>{nombre}</option>)}
                </select>
              )}
              <button type="button" className="btn oicon" onClick={() => carga(fecha)} disabled={cargando} aria-label="Actualizar" title="Actualizar">
                <RefreshCw size={15} className={cargando ? "ospin" : undefined} />
              </button>
            </div>
          </div>

          {/* Fila 2: filtros rápidos del detalle */}
          {GRUPOS[tab].length > 1 && enTab.length > 0 && (
            <div className="vchips" role="group" aria-label="Filtrar por detalle">
              <button type="button" className="vqchip" aria-pressed={grupo === "all"} onClick={() => setGrupo("all")}>Todas<b>{enTab.length}</b></button>
              {GRUPOS[tab].map((g) => {
                const n = enTab.filter((o) => detalleOferta(o).grupo === g.id).length;
                return (
                  <button key={g.id} type="button" className="vqchip" aria-pressed={grupo === g.id} disabled={n === 0 && grupo !== g.id} onClick={() => setGrupo(grupo === g.id ? "all" : g.id)}>
                    {g.label}<b>{n}</b>
                  </button>
                );
              })}
            </div>
          )}

          <div className="card">
            <div className="tbl-wrap">
              {error ? (
                <div className="empty">
                  <b style={{ color: "var(--fg)" }}>No se pudieron cargar las ofertas</b><br />{error}
                  <br /><button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => carga(fecha)}>Reintentar</button>
                </div>
              ) : ofertas === null ? (
                <div className="empty">Cargando ofertas…</div>
              ) : deAgencia.length === 0 ? (
                <div className="empty">
                  <b style={{ color: "var(--fg)" }}>Sin ofertas generadas {fecha === hoy ? "hoy" : `el ${diaRelativo(fecha, hoy, true)}`}</b><br />
                  El proceso de madrugada no generó ofertas para esa fecha en tus agencias.
                  {fecha !== hoy && <><br /><button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => setFecha(hoy)}>Ver las de hoy</button></>}
                </div>
              ) : filas.length === 0 ? (
                <div className="empty">
                  {enTab.length === 0 ? "No hay ofertas en esta pestaña." : "Ninguna oferta coincide con los filtros."}
                  {filtrado && enTab.length > 0 && <><br /><button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => { setGrupo("all"); setQ(""); }}>Limpiar filtros</button></>}
                </div>
              ) : (
                <table className="vtable otable">
                  <thead><tr>
                    <th aria-label="Desplegar" style={{ width: 36 }} />
                    <th aria-sort={orden.por === "hora" ? (orden.asc ? "ascending" : "descending") : "none"}>
                      <ColOrden activa={orden.por === "hora"} asc={orden.asc} onClick={() => ordena("hora")}>Cita</ColOrden>
                    </th>
                    <th>Cliente</th>
                    <th aria-sort={orden.por === "modelo" ? (orden.asc ? "ascending" : "descending") : "none"}>
                      <ColOrden activa={orden.por === "modelo"} asc={orden.asc} onClick={() => ordena("modelo")}>Vehículo</ColOrden>
                    </th>
                    <th>{tab === "NO_VIGENTE" ? "Motivo" : "Oferta"}</th>
                    <th>Detalle</th>
                    <th aria-label="Acciones" />
                  </tr></thead>
                  <tbody>
                    {filas.map((o) => {
                      const abiertaFila = abierta === o.idOferta;
                      const enCurso = ocupada === o.idOferta;
                      const det = detalleOferta(o);
                      return (
                        <Fragment key={o.idOferta}>
                          <tr className={`vrow${abiertaFila ? " open" : ""}`} onClick={() => alterna(o.idOferta)}>
                            <td>
                              <button type="button" className="vchev" aria-expanded={abiertaFila} aria-label={abiertaFila ? "Ocultar ficha" : "Ver ficha"} onClick={(e) => { e.stopPropagation(); alterna(o.idOferta); }}>
                                {abiertaFila ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                              </button>
                            </td>
                            <td><b className="num">{o.horaCita ?? "—"}</b><small className="vsub">{diaRelativo(o.fechaCita, hoy)}</small></td>
                            <td><span className="vname">{o.contacto.nombre ?? "Sin nombre"}</span>{variasAgencias && agencia === "all" && <small className="vsub">{o.nombreAgencia ?? o.idAgencia}</small>}</td>
                            <td><span className="vname">{modelo(o)}</span><small className="vsub">{[o.vehiculo.anio, o.vehiculo.kilometraje != null ? fmtKm(o.vehiculo.kilometraje) : null].filter(Boolean).join(" · ")}</small></td>
                            {tab === "NO_VIGENTE" ? (
                              <td className="vwrap">{motivoNoVigente(o)}</td>
                            ) : (
                              <td onClick={(e) => e.stopPropagation()}>
                                {o.puede.calibrar
                                  ? <MontoEditable oferta={o} deshabilitado={enCurso} onGuardar={(m) => calibra(o, m)} />
                                  : <><b className="num">{dinero(o.montoOferta)}</b><small className="vsub">Sugerido {dinero(o.montoSugeridoVenta)}</small></>}
                              </td>
                            )}
                            <td><span className={`pill ${det.tono}`}>{det.texto}</span></td>
                            <td onClick={(e) => e.stopPropagation()}>
                              <AccionesFila oferta={o} deshabilitado={enCurso} enviando={ocupada === o.idOferta} onEnvia={() => envia(o)}
                                onAbre={(tipo) => setDialogo({ tipo, oferta: o })} />
                            </td>
                          </tr>
                          {abiertaFila && (
                            <tr className="vexp"><td colSpan={7}>
                              <FichaOferta oferta={o} deshabilitado={enCurso} onCalibra={(m) => calibra(o, m)} />
                            </td></tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>

      {dialogo && dialogo.tipo !== "respuesta" && (
        <DialogoMotivo
          tipo={dialogo.tipo}
          oferta={dialogo.oferta}
          onCerrar={() => setDialogo(null)}
          onConfirmar={async (motivo) => {
            const o = dialogo.oferta;
            const ref = { idOferta: o.idOferta, version: o.version };
            const ok = dialogo.tipo === "descartar"
              ? await ejecuta(o, () => descartaOferta({ ...ref, motivo }), "Oferta descartada")
              : dialogo.tipo === "retomar"
                ? await ejecuta(o, () => retomaOferta({ ...ref, motivo: motivo || undefined }), "Oferta retomada")
                : await ejecuta(o, () => cierraOferta({ ...ref, motivo: motivo || undefined }), "Oferta cerrada");
            if (ok) setDialogo(null);
          }}
        />
      )}
      {dialogo?.tipo === "respuesta" && (
        <DialogoRespuesta
          oferta={dialogo.oferta}
          onCerrar={() => setDialogo(null)}
          onConfirmar={async (idEtiqueta, motivo) => {
            const o = dialogo.oferta;
            const ok = await ejecuta(o, () => registraRespuesta({ idOferta: o.idOferta, version: o.version, idEtiqueta, motivo: motivo || undefined }), "Respuesta registrada");
            if (ok) setDialogo(null);
          }}
        />
      )}
    </>
  );
}

// ---------- Selector de fecha: un solo control (‹ fecha ›) ----------

function SelectorFecha({ fecha, hoy, onCambia }: { fecha: string; hoy: string; onCambia: (f: string) => void }) {
  const texto = parseIso(fecha).toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long", ...(fecha.slice(0, 4) !== hoy.slice(0, 4) ? { year: "numeric" } : {}) });
  const relativo = fecha === hoy ? "Hoy" : fecha === addDays(hoy, -1) ? "Ayer" : null;
  return (
    <div className="ofecha" role="group" aria-label="Fecha de generación de las ofertas">
      <span className="ofecha-l">Generadas</span>
      <div className="ofecha-c">
        <button type="button" className="oicon-b" onClick={() => onCambia(addDays(fecha, -1))} aria-label="Día anterior" title="Día anterior"><ChevronLeft size={16} /></button>
        <label className="ofecha-d">
          <CalendarDays size={15} aria-hidden="true" />
          <span>{relativo && <b>{relativo} · </b>}{texto}</span>
          <input type="date" value={fecha} max={hoy} aria-label="Elegir fecha de generación"
            onClick={(e) => { try { e.currentTarget.showPicker(); } catch { /* el navegador abre su propio selector */ } }}
            onChange={(e) => e.target.value && onCambia(e.target.value)} />
        </label>
        <button type="button" className="oicon-b" onClick={() => onCambia(addDays(fecha, 1))} disabled={fecha >= hoy} aria-label="Día siguiente" title="Día siguiente"><ChevronRight size={16} /></button>
      </div>
      {fecha !== hoy && <button type="button" className="btn ohoy" onClick={() => onCambia(hoy)}>Ir a hoy</button>}
    </div>
  );
}

function ColOrden({ activa, asc, onClick, children }: { activa: boolean; asc: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={`ocol${activa ? " on" : ""}`} onClick={onClick}>
      {children}{activa && (asc ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />)}
    </button>
  );
}

// ---------- Acciones de la fila: una principal a la vista, el resto en el menú ----------

function AccionesFila({ oferta: o, deshabilitado, enviando, onEnvia, onAbre }: {
  oferta: Oferta; deshabilitado: boolean; enviando: boolean; onEnvia: () => void; onAbre: (t: TipoDialogo) => void;
}) {
  const principal: "enviar" | "respuesta" | "retomar" | null =
    o.puede.enviar ? "enviar" : o.puede.registrarRespuesta ? "respuesta" : o.puede.retomar ? "retomar" : null;
  const menu = [
    o.puede.registrarRespuesta && principal !== "respuesta" && { tipo: "respuesta" as const, label: "Registrar respuesta", icono: <MessageSquareReply size={14} /> },
    o.puede.retomar && principal !== "retomar" && { tipo: "retomar" as const, label: "Retomar", icono: <RotateCcw size={14} /> },
    o.puede.descartar && { tipo: "descartar" as const, label: "Descartar", icono: <Ban size={14} /> },
    o.puede.cerrar && { tipo: "cerrar" as const, label: "Cerrar oferta", icono: <Lock size={14} /> },
  ].filter(Boolean) as { tipo: TipoDialogo; label: string; icono: React.ReactNode }[];
  const conversacion = o.envio.idConversacion;

  return (
    <div className="vacts">
      {principal === "enviar" && (
        <button type="button" className="btn" disabled={deshabilitado} onClick={onEnvia} title="Enviar la oferta al cliente por WhatsApp">
          <Send size={14} />{enviando ? "Enviando…" : "Enviar"}
        </button>
      )}
      {principal === "respuesta" && <button type="button" className="btn" disabled={deshabilitado} onClick={() => onAbre("respuesta")}><MessageSquareReply size={14} />Respuesta</button>}
      {principal === "retomar" && <button type="button" className="btn" disabled={deshabilitado} onClick={() => onAbre("retomar")}><RotateCcw size={14} />Retomar</button>}
      {(menu.length > 0 || conversacion) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="btn oicon" disabled={deshabilitado} aria-label="Más acciones" title="Más acciones"><MoreHorizontal size={16} /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {conversacion && (
              <DropdownMenuItem asChild>
                <Link href={rutaConversacion(conversacion)}><MessageSquare size={14} />Ver conversación</Link>
              </DropdownMenuItem>
            )}
            {conversacion && menu.length > 0 && <DropdownMenuSeparator />}
            {menu.map((m, i) => (
              <Fragment key={m.tipo}>
                {m.tipo === "cerrar" && i > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem onSelect={() => onAbre(m.tipo)} variant={m.tipo === "descartar" ? "destructive" : undefined}>{m.icono}{m.label}</DropdownMenuItem>
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

// ---------- Monto editable (calibrar) ----------

function MontoEditable({ oferta, deshabilitado, onGuardar, grande = false }: {
  oferta: Oferta; deshabilitado: boolean; onGuardar: (monto: number) => Promise<boolean | void>; grande?: boolean;
}) {
  const actual = oferta.montoOferta != null ? Number(oferta.montoOferta) : null;
  const formatea = (n: number | null) => (n != null ? n.toLocaleString("es-MX") : "");
  const [texto, setTexto] = useState(formatea(actual));
  useEffect(() => { setTexto(formatea(actual)); }, [actual]);
  const monto = Number(texto.replace(/[^\d]/g, ""));
  const cambio = monto > 0 && monto !== actual;
  const descarta = () => setTexto(formatea(actual));
  const idAyuda = `monto-ayuda-${oferta.idOferta}${grande ? "-f" : ""}`;

  return (
    <div className={`oamt${grande ? " lg" : ""}`}>
      <div className="oamt-row">
        <span className={`oamt-in${cambio ? " dirty" : ""}`}>
          <span aria-hidden="true">$</span>
          <input inputMode="numeric" value={texto} disabled={deshabilitado} aria-describedby={idAyuda}
            aria-label={`Monto de la oferta de ${oferta.contacto.nombre ?? "cliente"}`}
            onChange={(e) => setTexto(e.target.value)}
            onBlur={(e) => { const n = Number(e.target.value.replace(/[^\d]/g, "")); if (n > 0) setTexto(formatea(n)); }}
            onKeyDown={(e) => { if (e.key === "Enter" && cambio) onGuardar(monto); if (e.key === "Escape") descarta(); }} />
          {!cambio && <Pencil size={13} aria-hidden="true" className="oamt-ico" />}
        </span>
        {cambio && (
          <>
            <button type="button" className="btn primary oicon" disabled={deshabilitado} onClick={() => onGuardar(monto)} aria-label="Guardar monto" title="Guardar (Enter)"><Check size={15} /></button>
            <button type="button" className="btn oicon" disabled={deshabilitado} onClick={descarta} aria-label="Descartar cambio" title="Descartar (Esc)"><X size={15} /></button>
          </>
        )}
      </div>
      <small className="vsub" id={idAyuda}>{cambio ? "Enter para guardar · Esc para descartar" : `Sugerido ${dinero(oferta.montoSugeridoVenta)}`}</small>
    </div>
  );
}

// ---------- Ficha de la oferta ----------

function FichaOferta({ oferta: o, deshabilitado, onCalibra }: { oferta: Oferta; deshabilitado: boolean; onCalibra: (monto: number) => Promise<boolean | void> }) {
  // La evaluación de la Lambda (criterios y su detalle) solo viene en consultaOferta; no cambia con las acciones
  const [evaluacion, setEvaluacion] = useState<EvaluacionCita | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let vigente = true;
    consultaOferta(o.idOferta).then((r) => {
      if (!vigente) return;
      if (r.successful) setEvaluacion((r.info.evaluacion?.evaluacion as EvaluacionCita | undefined) ?? null);
      else setError(mensajeError(r));
    });
    return () => { vigente = false; };
  }, [o.idOferta]);

  return (
    <div className="vdetail ficha">
      <section className="ficha-oferta">
        <h3>Oferta</h3>
        {o.puede.calibrar
          ? <MontoEditable oferta={o} deshabilitado={deshabilitado} onGuardar={onCalibra} grande />
          : <b className="num ficha-monto">{dinero(o.montoOferta)}</b>}
        <dl className="dl">
          <dt>Sugerido venta</dt><dd className="num">{dinero(o.montoSugeridoVenta)}</dd>
          <dt>Sugerido venta-compra</dt><dd className="num">{dinero(o.montoSugeridoVentaCompra)}</dd>
          <dt>Mercado venta</dt><dd className="num">{dinero(o.mercado.valorVenta)}</dd>
          <dt>Mercado compra</dt><dd className="num">{dinero(o.mercado.valorCompra)}</dd>
        </dl>
      </section>
      <section>
        <h3>Criterios de selección</h3>
        <Criterios oferta={o} evaluacion={evaluacion} error={error} />
      </section>
      <section>
        <h3>Cliente y vehículo</h3>
        <dl className="dl">
          <dt>Teléfono</dt><dd className="num">{o.contacto.telefono ?? "—"}</dd>
          <dt>Correo</dt><dd>{o.contacto.email ?? "—"}</dd>
          <dt>Agencia</dt><dd>{o.nombreAgencia ?? o.idAgencia}</dd>
          <dt>Servicio</dt><dd>{o.tipoServicio ?? "—"}</dd>
          <dt>Placa</dt><dd className="num">{o.vehiculo.placa ?? "—"}</dd>
          <dt>VIN</dt><dd className="num">{o.vehiculo.vin ?? "—"}</dd>
        </dl>
      </section>
      {(o.etiqueta?.motivo || o.envio.enviadaEn || o.cierre) && (
        <section>
          <h3>Seguimiento</h3>
          <dl className="dl">
            {o.etiqueta && <><dt>Respuesta</dt><dd>{o.etiqueta.nombre}</dd></>}
            {o.etiqueta?.motivo && <><dt>Motivo</dt><dd>{o.etiqueta.motivo}</dd></>}
            {o.envio.enviadaEn && <><dt>Enviada</dt><dd>{fechaHora(o.envio.enviadaEn)}</dd></>}
            {o.envio.idConversacion && (
              <><dt>Conversación</dt><dd><Link href={rutaConversacion(o.envio.idConversacion)} className="vlink">Ver conversación</Link></dd></>
            )}
            {o.cierre && <><dt>Cerrada</dt><dd>{fechaHora(o.cierre.cerradaEn)}</dd></>}
          </dl>
        </section>
      )}
    </div>
  );
}

/** Conversación de WhatsApp de la oferta en hub_cleber (la abrió el envío). */
const rutaConversacion = (id: string) => `/valuacion/conversacion/${encodeURIComponent(id)}`;

const km = (n: number | null | undefined) => (n == null ? "—" : fmtKm(Number(n)));

/** Cada criterio con lo que se buscaba y el valor del vehículo; arriba, lo que impidió cotizar (si algo). */
function Criterios({ oferta: o, evaluacion, error }: { oferta: Oferta; evaluacion: EvaluacionCita | null | undefined; error: string | null }) {
  if (error) return <span className="vsub">{error}</span>;
  if (evaluacion === undefined) return <span className="vsub">Cargando criterios…</span>;
  const c = evaluacion?.criterios;
  // Lo que impidió cotizar no es un criterio: se explica aparte (sin vehículo, traducción, Intelimotor)
  const sinCotizar = !["COTIZADA", "FUERA_DE_CRITERIOS", "SIN_MANTENIMIENTOS_SUFICIENTES", "MERCADO_INSUFICIENTE"].includes(o.motivoEvaluacion);
  const filas = c ? [
    { id: "anio", label: "Año", cumple: c.anio?.cumple, valor: c.anio?.valor ?? "—", regla: `Entre ${c.anio?.min} y ${c.anio?.max}` },
    { id: "km", label: "Kilometraje", cumple: c.kilometraje?.cumple, valor: km(c.kilometraje?.valor), regla: `Entre ${km(c.kilometraje?.min)} y ${km(c.kilometraje?.max)}` },
    { id: "mant", label: "Mantenimientos", cumple: c.mantenimientos?.cumple, valor: c.mantenimientos?.valor ?? "—",
      regla: `Mínimo ${c.mantenimientos?.minimo} en los últimos ${c.mantenimientos?.aniosHistorial} años` },
    ...(c.publicaciones?.minimo != null ? [{ id: "pub", label: "Publicaciones en el mercado", cumple: c.publicaciones.cumple, valor: c.publicaciones.valor ?? "—",
      regla: `Mínimo ${c.publicaciones.minimo}` }] : []),
  ] : [];

  return (
    <>
      {sinCotizar && (
        <p className="vreason"><b>{MOTIVO_EVALUACION[o.motivoEvaluacion] ?? o.motivoEvaluacion}.</b>{evaluacion?.detalle && !c ? ` ${evaluacion.detalle}` : ""}</p>
      )}
      {filas.length > 0 ? (
        <ul className="vcrit">
          {filas.map((f) => (
            <li key={f.id} className={f.cumple === true ? "ok" : f.cumple === false ? "bad" : "na"}>
              {f.cumple === true ? <Check size={14} aria-label="Cumple" /> : f.cumple === false ? <X size={14} aria-label="No cumple" /> : <Minus size={14} aria-label="No evaluado" />}
              <span><b>{f.label}:</b> {f.valor}<small>{f.regla}{f.cumple == null ? " · no evaluado" : ""}</small></span>
            </li>
          ))}
        </ul>
      ) : !sinCotizar && <span className="vsub">La evaluación no trae criterios.</span>}
    </>
  );
}

// ---------- Diálogos ----------

const TEXTOS = {
  descartar: { titulo: "Descartar oferta", desc: "La oferta queda No vigente con la etiqueta \"Descartada por valuador\". Se puede retomar solo hoy.", boton: "Descartar", motivo: "Motivo (obligatorio)", requerido: true },
  retomar: { titulo: "Retomar oferta", desc: "La oferta vuelve a estar vigente. Solo se permite el día de generación.", boton: "Retomar", motivo: "Motivo (opcional)", requerido: false },
  cerrar: { titulo: "Cerrar oferta", desc: "Termina el flujo de nuestro lado y la oferta pasa a comercial. Es definitivo: ya no cambia ni se puede retomar.", boton: "Cerrar oferta", motivo: "Motivo (opcional)", requerido: false },
} as const;

function DialogoMotivo({ tipo, oferta, onCerrar, onConfirmar }: {
  tipo: "descartar" | "retomar" | "cerrar"; oferta: Oferta; onCerrar: () => void; onConfirmar: (motivo: string) => Promise<void>;
}) {
  const t = TEXTOS[tipo];
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const valido = !t.requerido || motivo.trim().length > 0;
  return (
    <Dialog open onOpenChange={(abierto) => !abierto && !enviando && onCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.titulo}</DialogTitle>
          <DialogDescription>{oferta.contacto.nombre ?? "Cliente"} · {modelo(oferta)}. {t.desc}</DialogDescription>
        </DialogHeader>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
          {t.motivo}
          <textarea className="date" style={{ minHeight: 80, padding: 8, resize: "vertical" }} value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus />
        </label>
        <DialogFooter>
          <button type="button" className="btn" onClick={onCerrar} disabled={enviando}>Cancelar</button>
          <button type="button" className="btn primary" disabled={!valido || enviando}
            onClick={async () => { setEnviando(true); await onConfirmar(motivo.trim()); setEnviando(false); }}>
            {enviando ? "Guardando…" : t.boton}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

let etiquetasCache: Etiqueta[] | null = null;

function DialogoRespuesta({ oferta, onCerrar, onConfirmar }: {
  oferta: Oferta; onCerrar: () => void; onConfirmar: (idEtiqueta: string, motivo: string) => Promise<void>;
}) {
  const [etiquetas, setEtiquetas] = useState<Etiqueta[] | null>(etiquetasCache);
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState("");
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    if (etiquetasCache) return;
    consultaEtiquetas().then((r) => {
      if (r.successful) { etiquetasCache = r.info.etiquetas; setEtiquetas(r.info.etiquetas); }
      else setError(mensajeError(r));
    });
  }, []);

  // Las que el valuador registra después del envío (la base las vuelve a validar)
  const opciones = (etiquetas ?? []).filter((e) => e.momento === "DESPUES_DE_ENVIO" && e.origenes.includes("VALUADOR") && e.idEtiqueta !== "DESCARTADA_POR_VALUADOR");
  const elegida = opciones.find((e) => e.idEtiqueta === id);
  const valido = !!elegida && (!elegida.esRequiereMotivo || motivo.trim().length > 0);
  const grupos: { tipo: Etiqueta["tipo"]; label: string }[] = [
    { tipo: "VIGENTE", label: "Sigue vigente" }, { tipo: "NO_VIGENTE", label: "Rechazo (queda no vigente)" }, { tipo: "CIERRE", label: "Cierra la oferta" },
  ];

  return (
    <Dialog open onOpenChange={(abierto) => !abierto && !enviando && onCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar respuesta del cliente</DialogTitle>
          <DialogDescription>{oferta.contacto.nombre ?? "Cliente"} · {modelo(oferta)}</DialogDescription>
        </DialogHeader>
        {error ? <div className="alert" role="alert">{error}</div> : !etiquetas ? <span className="vsub">Cargando etiquetas…</span> : (
          <>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
              Respuesta
              <select className="date" value={id} onChange={(e) => setId(e.target.value)} autoFocus>
                <option value="">Elige una opción…</option>
                {grupos.map((g) => {
                  const del = opciones.filter((e) => e.tipo === g.tipo);
                  return del.length ? <optgroup key={g.tipo} label={g.label}>{del.map((e) => <option key={e.idEtiqueta} value={e.idEtiqueta}>{e.nombre}</option>)}</optgroup> : null;
                })}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
              Motivo {elegida?.esRequiereMotivo ? "(obligatorio)" : "(opcional)"}
              <textarea className="date" style={{ minHeight: 70, padding: 8, resize: "vertical" }} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
            </label>
          </>
        )}
        <DialogFooter>
          <button type="button" className="btn" onClick={onCerrar} disabled={enviando}>Cancelar</button>
          <button type="button" className="btn primary" disabled={!valido || enviando}
            onClick={async () => { setEnviando(true); await onConfirmar(id, motivo.trim()); setEnviando(false); }}>
            {enviando ? "Guardando…" : "Registrar"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
