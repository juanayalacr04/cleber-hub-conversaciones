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
  ArrowDown, ArrowUp, Ban, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Lock,
  Loader2, MessageSquare, Minus, MoreHorizontal, Pencil, RefreshCw, RotateCcw, Search, Send, ShieldCheck, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { PageHead } from "@/components/shell/Shell";
import { useAuth } from "@/contexts/AuthContext";
import type { ModuleDef } from "@/lib/modules";
import type { ApiResponse } from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { addDays, fmtKm, fmtMoney, parseIso, todayIso } from "@/lib/valuacion/store";
import { diezDigitos, formatoDiez, telefonoMx } from "@/lib/valuacion/telefono";
import { esProduccion } from "@/lib/ambiente";
import {
  ESTADOS, GRUPOS, MOTIVO_EVALUACION, detalleOferta, mensajeError, montoRequiereVobo, motivoNoVigente, puedeAutorizarVobo,
  type EstadoOferta, type Etiqueta, type EvaluacionCita, type Grupo, type Oferta,
} from "@/lib/valuacion/tipos";
import {
  calibraOferta, cierraOferta, consultaEtiquetas, consultaOferta, consultaOfertas, descartaOferta, enviaOferta, notificaVobo,
  registraRespuesta, resuelveVobo, retomaOferta,
  type DestinoEnvio,
} from "@/lib/valuacion/acciones";

type Orden = { por: "hora" | "modelo"; asc: boolean };
type TipoDialogo = "descartar" | "retomar" | "cerrar" | "respuesta" | "enviar" | "vobo";
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

type Fallo = Extract<ApiResponse<unknown>, { successful: false }>;

/**
 * Ajuste del monto y VoBo, igual en la tabla de Ofertas y dentro de la conversación.
 *   - guardaMonto: si el monto sale del margen y el usuario no puede autorizar, primero pide el motivo (DialogoAjuste);
 *     si la base deja el VoBo pendiente, avisa por correo a quienes autorizan (TomaUnidades.notificaVobo).
 *   - abreVobo: GERENTE / ADMINISTRADOR autoriza o rechaza (DialogoVobo).
 * La base vuelve a validar todo (margen vigente, permiso y agencia).
 */
function useMontoYVobo({ aplica, manejaError, marca }: {
  aplica: (o: Oferta) => void; manejaError: (r: Fallo) => void; marca: (o: Oferta, enCurso: boolean) => void;
}) {
  const { usuarioHub } = useAuth();
  const [ajuste, setAjuste] = useState<{ oferta: Oferta; monto: number } | null>(null);
  const [vobo, setVobo] = useState<Oferta | null>(null);
  const autoriza = useCallback((o: Oferta) => puedeAutorizarVobo(usuarioHub, o.idMarca), [usuarioHub]);

  const guardaMonto = async (o: Oferta, monto: number, motivo?: string): Promise<boolean> => {
    if (motivo === undefined && montoRequiereVobo(o, monto) && !autoriza(o)) {
      setAjuste({ oferta: o, monto });
      return false;
    }
    marca(o, true);
    const r = await calibraOferta({ idOferta: o.idOferta, version: o.version, montoOferta: monto, ...(motivo ? { motivo } : {}) });
    marca(o, false);
    if (!r.successful) {
      // El margen cambió desde que se cargó la oferta: la base pide el motivo
      if ((r.info as { causa?: string } | undefined)?.causa === "REQUIERE_VOBO" && motivo === undefined) {
        setAjuste({ oferta: o, monto });
        return false;
      }
      manejaError(r);
      return false;
    }
    aplica(r.info.oferta);
    if (r.info.voboPendiente) {
      toast.success("Monto guardado. La oferta se podrá enviar cuando el gerente dé su VoBo.");
      const aviso = await notificaVobo({ idOferta: o.idOferta, origen: window.location.origin });
      if (!aviso.successful) toast.warning(mensajeError(aviso));
      else if (aviso.info.notificados.length) toast.info(`Se avisó por correo a ${aviso.info.notificados.join(", ")}`);
    } else {
      toast.success(r.info.oferta.vobo?.estado === "AUTORIZADO" ? "Monto guardado y autorizado con tu rol" : "Monto guardado");
    }
    return true;
  };

  /**
   * Rechazar: solo resuelve. Autorizar: resuelve y envía la oferta en el mismo paso (con la versión nueva) al destino
   * elegido (fuera de producción, teléfono de prueba o el cliente). Si el envío falla, el VoBo ya quedó autorizado y
   * la oferta en FALLIDO: se reintenta con Enviar.
   */
  const resuelve = async (o: Oferta, autorizado: boolean, motivo: string, destino: DestinoEnvio | null) => {
    marca(o, true);
    try {
      const r = await resuelveVobo({ idOferta: o.idOferta, version: o.version, autoriza: autorizado, ...(motivo ? { motivo } : {}) });
      if (!r.successful) { manejaError(r); return false; }
      aplica(r.info.oferta);
      if (!autorizado || !destino) {
        toast.success(autorizado ? "VoBo autorizado: la oferta ya se puede enviar" : "VoBo rechazado: el monto regresó al anterior");
        return true;
      }
      const autorizada = r.info.oferta;
      const e = await enviaOferta({ idOferta: autorizada.idOferta, version: autorizada.version, ...destino });
      if (!e.successful) {
        if (e.errorCode === "SESION_EXPIRADA") { manejaError(e); return true; }
        const enviada = (e.info as { oferta?: Oferta } | undefined)?.oferta;
        if (enviada) aplica(enviada);
        toast.error(`VoBo autorizado, pero la oferta no se envió: ${mensajeError(e)} Reintenta con Enviar.`);
        return true;
      }
      aplica(e.info.oferta);
      toast.success(destino.alCliente ? "VoBo autorizado y oferta enviada al cliente por WhatsApp"
        : "VoBo autorizado y oferta enviada a tu número de prueba");
      return true;
    } finally {
      marca(o, false);
    }
  };

  const dialogos = (
    <>
      {ajuste && (
        <DialogoAjuste oferta={ajuste.oferta} monto={ajuste.monto} onCerrar={() => setAjuste(null)}
          onConfirmar={async (motivo) => { if (await guardaMonto(ajuste.oferta, ajuste.monto, motivo)) setAjuste(null); }} />
      )}
      {vobo && (
        <DialogoVobo oferta={vobo} onCerrar={() => setVobo(null)}
          onConfirmar={async (autorizado, motivo, destino) => { if (await resuelve(vobo, autorizado, motivo, destino)) setVobo(null); }} />
      )}
    </>
  );

  return { autoriza, guardaMonto, abreVobo: setVobo, dialogos };
}

export function OfertasApiView({ mod }: { mod: ModuleDef }) {
  const hoy = todayIso();
  // Solo las ofertas de la marca activa (Valuacion.consultaOfertas recibe idMarca)
  const { userData } = useAuth();
  const idMarca = userData?.organizationId ?? null;
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
    // La base filtra por la marca activa; el filtro de abajo (deMarca) queda de respaldo
    const r = await consultaOfertas({ fechaGeneracion: f, ...(idMarca ? { idMarca } : {}) });
    setCargando(false);
    if (r.successful) {
      setOfertas(r.info.ofertas);
      return;
    }
    if (r.errorCode === "SESION_EXPIRADA") return manejaError(r);
    setOfertas(null);
    setError(mensajeError(r));
  }, [manejaError, idMarca]);

  useEffect(() => { carga(fecha); }, [fecha, carga]);
  // Otra marca: otras agencias
  useEffect(() => { setAgencia("all"); setAbierta(null); }, [idMarca]);

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
  const { autoriza, guardaMonto, abreVobo, dialogos: dialogosVobo } = useMontoYVobo({
    aplica: reemplaza, manejaError, marca: (o, enCurso) => setOcupada(enCurso ? o.idOferta : null),
  });
  const calibra = (o: Oferta, monto: number) => guardaMonto(o, monto);
  // Si el hub no pudo enviar, la respuesta trae la oferta ya en FALLIDO (se reemplaza en la tabla) y el motivo
  const envia = (o: Oferta, destino: DestinoEnvio) =>
    ejecuta(o, () => enviaOferta({ idOferta: o.idOferta, version: o.version, ...destino }),
      destino.alCliente ? "Oferta enviada al cliente por WhatsApp" : "Oferta enviada por WhatsApp a tu número de prueba");

  const deMarca = useMemo(() => (ofertas ?? []).filter((o) => !idMarca || o.idMarca === idMarca), [ofertas, idMarca]);
  const agencias = useMemo(() => {
    const m = new Map<string, string>();
    deMarca.forEach((o) => m.set(o.idAgencia, o.nombreAgencia ?? o.idAgencia));
    // La agencia elegida se queda en la lista aunque ese día no tenga ofertas
    if (agencia !== "all" && !m.has(agencia)) m.set(agencia, agencia);
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [deMarca, agencia]);
  const nombresAgencia = useMemo(() => new Map(agencias), [agencias]);
  const deAgencia = useMemo(() => deMarca.filter((o) => agencia === "all" || o.idAgencia === agencia), [deMarca, agencia]);
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
              <select className="date" value={agencia} onChange={(e) => { setAgencia(e.target.value); setAbierta(null); }} aria-label="Agencia" disabled={agencias.length === 0}>
                <option value="all">Todas mis agencias</option>
                {agencias.map(([id, nombre]) => <option key={id} value={id}>{nombre}</option>)}
              </select>
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
                            {/* Con varias agencias a la vista, la agencia va bajo el nombre; el teléfono está en la ficha */}
                            <td>
                              <span className="vname">{o.contacto.nombre ?? "Sin nombre"}</span>
                              <small className="vsub">{agencia === "all" && agencias.length > 1
                                ? o.nombreAgencia ?? nombresAgencia.get(o.idAgencia) ?? o.idAgencia
                                : <span className="num">{o.contacto.telefono ?? "Sin teléfono"}</span>}</small>
                            </td>
                            <td><span className="vname">{modelo(o)}</span><small className="vsub">{[o.vehiculo.anio, o.vehiculo.kilometraje != null ? fmtKm(o.vehiculo.kilometraje) : null].filter(Boolean).join(" · ")}</small></td>
                            {tab === "NO_VIGENTE" ? (
                              <td className="vwrap">{motivoNoVigente(o)}</td>
                            ) : (
                              <td onClick={(e) => e.stopPropagation()}>
                                {o.puede.calibrar
                                  ? <MontoEditable oferta={o} autoriza={autoriza(o)} deshabilitado={enCurso} onGuardar={(m) => calibra(o, m)} />
                                  : <><b className="num">{dinero(o.montoOferta)}</b><small className="vsub">Sugerido {dinero(o.montoSugeridoVenta)}</small></>}
                              </td>
                            )}
                            <td><span className={`pill ${det.tono}`}>{det.texto}</span></td>
                            <td onClick={(e) => e.stopPropagation()}>
                              <AccionesFila oferta={o} deshabilitado={enCurso} enviando={ocupada === o.idOferta} autorizaVobo={autoriza(o)}
                                onEnvia={() => esProduccion ? envia(o, { alCliente: true }) : setDialogo({ tipo: "enviar", oferta: o })}
                                onAbre={(tipo) => (tipo === "vobo" ? abreVobo(o) : setDialogo({ tipo, oferta: o }))} />
                            </td>
                          </tr>
                          {abiertaFila && (
                            <tr className="vexp"><td colSpan={7}>
                              <FichaOferta oferta={o} deshabilitado={enCurso} autoriza={autoriza(o)} onCalibra={(m) => calibra(o, m)} />
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

      {dialogo?.tipo === "enviar" && (
        <DialogoEnvio
          oferta={dialogo.oferta}
          onCerrar={() => setDialogo(null)}
          onConfirmar={async (destino) => {
            // Si el hub no pudo enviar, la oferta queda en FALLIDO y el motivo se avisa; el diálogo se cierra igual
            await envia(dialogo.oferta, destino);
            setDialogo(null);
          }}
        />
      )}
      {dialogosVobo}
      {dialogo && (dialogo.tipo === "descartar" || dialogo.tipo === "retomar" || dialogo.tipo === "cerrar") && (
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
            const ok = await ejecuta(o, () => registraRespuesta({ idOferta: o.idOferta, version: o.version, idEtiqueta, motivo: motivo || undefined }), "Estatus actualizado");
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

function AccionesFila({ oferta: o, deshabilitado, enviando, autorizaVobo, onEnvia, onAbre }: {
  oferta: Oferta; deshabilitado: boolean; enviando: boolean; autorizaVobo: boolean; onEnvia: () => void; onAbre: (t: TipoDialogo) => void;
}) {
  // Con el VoBo pendiente, quien autoriza lo tiene como acción principal (Enviar está bloqueado hasta resolverlo)
  const principal: "vobo" | "enviar" | "respuesta" | "retomar" | null =
    o.puede.resolverVobo && autorizaVobo ? "vobo"
      : o.puede.enviar ? "enviar" : o.puede.registrarRespuesta ? "respuesta" : o.puede.retomar ? "retomar" : null;
  const menu = [
    o.puede.registrarRespuesta && principal !== "respuesta" && { tipo: "respuesta" as const, label: "Editar estatus", icono: <Pencil size={14} /> },
    o.puede.retomar && principal !== "retomar" && { tipo: "retomar" as const, label: "Retomar", icono: <RotateCcw size={14} /> },
    o.puede.descartar && { tipo: "descartar" as const, label: "Descartar", icono: <Ban size={14} /> },
    o.puede.cerrar && { tipo: "cerrar" as const, label: "Cerrar oferta", icono: <Lock size={14} /> },
  ].filter(Boolean) as { tipo: TipoDialogo; label: string; icono: React.ReactNode }[];
  const conversacion = o.envio.idConversacion;
  // Una sola acción a la vista: la principal o, si no hay, la conversación. Lo demás va en el menú
  const conversacionEnMenu = !!conversacion && principal !== null;

  return (
    <div className="vacts">
      {conversacion && !conversacionEnMenu && (
        <Link href={rutaConversacion(conversacion)} className="btn" title="Abrir la conversación de WhatsApp de esta oferta">
          <MessageSquare size={14} />Ver conversación
        </Link>
      )}
      {principal === "vobo" && (
        <button type="button" className="btn" disabled={deshabilitado} onClick={() => onAbre("vobo")} title="Autorizar o rechazar el monto fuera del margen">
          <ShieldCheck size={14} />Revisar VoBo
        </button>
      )}
      {principal === "enviar" && (
        <button type="button" className="btn" disabled={deshabilitado} onClick={onEnvia} title="Enviar la oferta al cliente por WhatsApp">
          <Send size={14} />{enviando ? "Enviando…" : "Enviar"}
        </button>
      )}
      {principal === "respuesta" && <button type="button" className="btn" disabled={deshabilitado} onClick={() => onAbre("respuesta")}><Pencil size={14} />Editar estatus</button>}
      {principal === "retomar" && <button type="button" className="btn" disabled={deshabilitado} onClick={() => onAbre("retomar")}><RotateCcw size={14} />Retomar</button>}
      {(menu.length > 0 || conversacionEnMenu) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="btn oicon" disabled={deshabilitado} aria-label="Más acciones" title="Más acciones"><MoreHorizontal size={16} /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {conversacionEnMenu && conversacion && (
              <>
                <DropdownMenuItem asChild><Link href={rutaConversacion(conversacion)}><MessageSquare size={14} />Ver conversación</Link></DropdownMenuItem>
                {menu.length > 0 && <DropdownMenuSeparator />}
              </>
            )}
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

function MontoEditable({ oferta, deshabilitado, onGuardar, autoriza = false, grande = false }: {
  oferta: Oferta; deshabilitado: boolean; onGuardar: (monto: number) => Promise<boolean | void>;
  /** El usuario puede autorizar VoBo en esta marca: su ajuste fuera del margen queda autorizado */
  autoriza?: boolean; grande?: boolean;
}) {
  const actual = oferta.montoOferta != null ? Number(oferta.montoOferta) : null;
  const formatea = (n: number | null) => (n != null ? n.toLocaleString("es-MX") : "");
  const [texto, setTexto] = useState(formatea(actual));
  useEffect(() => { setTexto(formatea(actual)); }, [actual]);
  const monto = Number(texto.replace(/[^\d]/g, ""));
  const cambio = monto > 0 && monto !== actual;
  const descarta = () => setTexto(formatea(actual));
  const idAyuda = `monto-ayuda-${oferta.idOferta}${grande ? "-f" : ""}`;
  const fueraDeMargen = cambio && montoRequiereVobo(oferta, monto);
  const margen = oferta.vobo?.margen != null ? `±${dinero(oferta.vobo.margen)}` : "";
  const ayuda = !cambio
    ? `Sugerido ${dinero(oferta.montoSugeridoVenta)}`
    : fueraDeMargen
      ? `Fuera del margen ${margen}: ${autoriza ? "queda autorizado con tu rol" : "pedirá VoBo del gerente"} · Enter para guardar`
      : "Enter para guardar · Esc para descartar";

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
      <small className="vsub" id={idAyuda} style={fueraDeMargen ? { color: "var(--warn)" } : undefined}>{ayuda}</small>
    </div>
  );
}

// ---------- Ficha de la oferta ----------

function FichaOferta({ oferta: o, deshabilitado, onCalibra, autoriza = false, compacta = false }: {
  oferta: Oferta; deshabilitado: boolean; onCalibra: (monto: number) => Promise<boolean | void>; autoriza?: boolean;
  /** Una columna y sin enlace a la conversación (se muestra dentro de ella) */
  compacta?: boolean;
}) {
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
    <div className={`vdetail ficha${compacta ? " compacta" : ""}`}>
      <section className="ficha-oferta">
        <h3>Oferta</h3>
        {o.puede.calibrar
          ? <MontoEditable oferta={o} autoriza={autoriza} deshabilitado={deshabilitado} onGuardar={onCalibra} grande />
          : <b className="num ficha-monto">{dinero(o.montoOferta)}</b>}
        <EstadoVobo oferta={o} />
        <dl className="dl">
          <dt>Sugerido venta</dt><dd className="num">{dinero(o.montoSugeridoVenta)}</dd>
          <dt>Sin VoBo</dt>
          <dd className="num">{o.vobo?.montoMinimo != null && o.vobo.montoMaximo != null
            ? `${dinero(o.vobo.montoMinimo)} a ${dinero(o.vobo.montoMaximo)}`
            : "Sin sugerido: todo monto pide VoBo"}</dd>
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
            {o.etiqueta && <><dt>Estatus</dt><dd>{o.etiqueta.nombre}</dd></>}
            {o.etiqueta?.motivo && <><dt>Motivo</dt><dd>{o.etiqueta.motivo}</dd></>}
            {o.envio.enviadaEn && <><dt>Enviada</dt><dd>{fechaHora(o.envio.enviadaEn)}</dd></>}
            {o.envio.idConversacion && !compacta && (
              <><dt>Conversación</dt><dd><Link href={rutaConversacion(o.envio.idConversacion)} className="vlink">Ver conversación</Link></dd></>
            )}
            {o.cierre && <><dt>Cerrada</dt><dd>{fechaHora(o.cierre.cerradaEn)}</dd></>}
          </dl>
        </section>
      )}
    </div>
  );
}

/** Aviso del VoBo del monto bajo el monto (pendiente, autorizado o rechazado); nada si el monto no lo requiere. */
function EstadoVobo({ oferta: o }: { oferta: Oferta }) {
  const v = o.vobo;
  if (!v?.estado) return null;
  const quien = (email: string | null) => email ?? "—";
  if (v.estado === "PENDIENTE") {
    return (
      <p className="vreason" style={{ margin: "8px 0" }}>
        <b>Pendiente de VoBo.</b> {quien(v.solicitadoPor)} lo dejó fuera del margen{v.motivoSolicitud ? `: “${v.motivoSolicitud}”` : ""}.
        {" "}Si se rechaza regresa a {dinero(v.montoPrevio)}.{v.notificadoEn ? " Se avisó por correo." : ""}
      </p>
    );
  }
  if (v.estado === "AUTORIZADO") {
    return <p className="vsub" style={{ margin: "8px 0" }}>VoBo autorizado por {quien(v.resueltoPor)}{v.resueltoEn ? ` · ${fechaHora(v.resueltoEn)}` : ""}</p>;
  }
  return (
    <p className="vreason" style={{ margin: "8px 0" }}>
      <b>VoBo rechazado</b> por {quien(v.resueltoPor)}{v.motivoResolucion ? `: “${v.motivoResolucion}”` : ""}. El monto regresó al anterior.
    </p>
  );
}

// ---------- La oferta dentro de su conversación ----------

/**
 * La oferta de una conversación tal como está hoy (Valuacion.consultaOferta), no la foto del envío: estado, detalle,
 * monto (calibrable si la base lo permite) y las mismas acciones que en Ofertas, salvo enviar (ya se envió).
 * Los permisos los vuelve a validar la base; si alguien más cambió la oferta, se reemplaza con la de la base.
 */
export function OfertaEnConversacion({ idOferta }: { idOferta: number }) {
  const [oferta, setOferta] = useState<Oferta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupada, setOcupada] = useState(false);
  const [dialogo, setDialogo] = useState<Exclude<TipoDialogo, "enviar" | "vobo"> | null>(null);
  const manejaError = useManejaError(setOferta);
  const { autoriza, guardaMonto, abreVobo, dialogos: dialogosVobo } = useMontoYVobo({
    aplica: setOferta, manejaError, marca: (_o, enCurso) => setOcupada(enCurso),
  });

  const carga = useCallback(async () => {
    const r = await consultaOferta(idOferta);
    if (r.successful) { setOferta(r.info.oferta); setError(null); return; }
    if (r.errorCode === "SESION_EXPIRADA") return manejaError(r);
    setError(mensajeError(r));
  }, [idOferta, manejaError]);
  useEffect(() => { carga(); }, [carga]);

  if (error) {
    return (
      <div className="empty">
        <b style={{ color: "var(--fg)" }}>No se pudo cargar la oferta #{idOferta}</b><br />{error}
        <br /><button type="button" className="btn" style={{ marginTop: 12 }} onClick={carga}>Reintentar</button>
      </div>
    );
  }
  if (!oferta) return <div className="empty">Cargando oferta…</div>;

  const o = oferta;
  const ejecuta = async (accion: () => Promise<ApiResponse<{ oferta: Oferta }>>, exito: string) => {
    setOcupada(true);
    const r = await accion();
    setOcupada(false);
    if (!r.successful) return manejaError(r), false;
    setOferta(r.info.oferta);
    toast.success(exito);
    return true;
  };
  const ref = { idOferta: o.idOferta, version: o.version };
  const det = detalleOferta(o);
  const estado = ESTADOS.find((e) => e.id === o.estado);
  const acciones = [
    o.puede.resolverVobo && autoriza(o) && { tipo: "vobo" as const, label: "Revisar VoBo", icono: <ShieldCheck size={14} /> },
    o.puede.registrarRespuesta && { tipo: "respuesta" as const, label: "Editar estatus", icono: <Pencil size={14} /> },
    o.puede.retomar && { tipo: "retomar" as const, label: "Retomar", icono: <RotateCcw size={14} /> },
    o.puede.descartar && { tipo: "descartar" as const, label: "Descartar", icono: <Ban size={14} /> },
    o.puede.cerrar && { tipo: "cerrar" as const, label: "Cerrar oferta", icono: <Lock size={14} /> },
  ].filter(Boolean) as { tipo: Exclude<TipoDialogo, "enviar">; label: string; icono: React.ReactNode }[];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <b>Oferta #{o.idOferta}</b>
        {estado && <span className={`pill ${estado.tono}`}>{estado.label}</span>}
        <span className={`pill ${det.tono}`}>{det.texto}</span>
        <span className="vsub">Cita {diaRelativo(o.fechaCita, todayIso(), true)}{o.horaCita ? ` · ${o.horaCita}` : ""}</span>
        <button type="button" className="btn oicon" style={{ marginLeft: "auto" }} onClick={carga} disabled={ocupada} aria-label="Actualizar oferta" title="Actualizar oferta">
          <RefreshCw size={14} />
        </button>
      </div>
      {acciones.length > 0 && (
        <div className="vacts" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
          {acciones.map((a) => (
            <button key={a.tipo} type="button" className="btn" disabled={ocupada} onClick={() => (a.tipo === "vobo" ? abreVobo(o) : setDialogo(a.tipo))}
              style={a.tipo === "descartar" ? { color: "var(--crit)" } : undefined}>
              {a.icono}{a.label}
            </button>
          ))}
        </div>
      )}
      {o.estado === "NO_VIGENTE" && <p className="vreason" style={{ margin: 0 }}><b>Motivo:</b> {motivoNoVigente(o)}</p>}
      <FichaOferta oferta={o} deshabilitado={ocupada} compacta autoriza={autoriza(o)} onCalibra={(m) => guardaMonto(o, m)} />
      {dialogosVobo}

      {dialogo && dialogo !== "respuesta" && (
        <DialogoMotivo tipo={dialogo} oferta={o} onCerrar={() => setDialogo(null)}
          onConfirmar={async (motivo) => {
            const ok = dialogo === "descartar"
              ? await ejecuta(() => descartaOferta({ ...ref, motivo }), "Oferta descartada")
              : dialogo === "retomar"
                ? await ejecuta(() => retomaOferta({ ...ref, motivo: motivo || undefined }), "Oferta retomada")
                : await ejecuta(() => cierraOferta({ ...ref, motivo: motivo || undefined }), "Oferta cerrada");
            if (ok) setDialogo(null);
          }} />
      )}
      {dialogo === "respuesta" && (
        <DialogoRespuesta oferta={o} onCerrar={() => setDialogo(null)}
          onConfirmar={async (idEtiqueta, motivo) => {
            const ok = await ejecuta(() => registraRespuesta({ ...ref, idEtiqueta, motivo: motivo || undefined }), "Estatus actualizado");
            if (ok) setDialogo(null);
          }} />
      )}
    </div>
  );
}

/** Conversación de WhatsApp de la oferta (la abrió el envío): Conversaciones, vista conversación, con ella seleccionada. */
const rutaConversacion = (id: string) => `/valuacion/conversaciones/${encodeURIComponent(id)}`;

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
        <div className="grid gap-2">
          <Label htmlFor="motivo-oferta">{t.motivo}</Label>
          <Textarea id="motivo-oferta" rows={3} value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCerrar} disabled={enviando}>Cancelar</Button>
          <Button variant={tipo === "descartar" ? "destructive" : "default"} disabled={!valido || enviando}
            onClick={async () => { setEnviando(true); await onConfirmar(motivo.trim()); setEnviando(false); }}>
            {enviando && <Loader2 className="animate-spin" aria-hidden="true" />}{enviando ? "Guardando…" : t.boton}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Montos de la oferta frente al sugerido: lo que leen el valuador al pedir el VoBo y el gerente al resolverlo. */
function ResumenAjuste({ oferta: o, monto }: { oferta: Oferta; monto: number }) {
  const sugerido = o.montoSugeridoVenta != null ? Number(o.montoSugeridoVenta) : null;
  const diferencia = sugerido != null ? monto - sugerido : null;
  return (
    <dl className="dl">
      <dt>Sugerido venta</dt><dd className="num">{dinero(sugerido)}</dd>
      <dt>Monto propuesto</dt><dd className="num"><b>{dinero(monto)}</b></dd>
      {diferencia != null && <><dt>Diferencia</dt><dd className="num">{diferencia > 0 ? "+" : ""}{dinero(diferencia)}</dd></>}
      <dt>Margen sin VoBo</dt><dd className="num">{o.vobo?.margen != null ? `±${dinero(o.vobo.margen)}` : "—"}</dd>
    </dl>
  );
}

/** El valuador deja el monto fuera del margen: explica por qué (lo lee el gerente) y la oferta queda pendiente de VoBo. */
function DialogoAjuste({ oferta, monto, onCerrar, onConfirmar }: {
  oferta: Oferta; monto: number; onCerrar: () => void; onConfirmar: (motivo: string) => Promise<void>;
}) {
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const valido = motivo.trim().length > 0;
  return (
    <Dialog open onOpenChange={(abierto) => !abierto && !enviando && onCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pedir VoBo del monto</DialogTitle>
          <DialogDescription>
            {oferta.contacto.nombre ?? "Cliente"} · {modelo(oferta)}. El monto sale del margen de ajuste: se guarda, pero la
            oferta no se podrá enviar hasta que un gerente lo autorice. Se le avisa por correo.
          </DialogDescription>
        </DialogHeader>
        <ResumenAjuste oferta={oferta} monto={monto} />
        <div className="grid gap-2">
          <Label htmlFor="motivo-ajuste">Motivo (obligatorio)</Label>
          <Textarea id="motivo-ajuste" rows={3} value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus
            placeholder="Ej. la unidad trae equipo adicional, el cliente pidió más…" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCerrar} disabled={enviando}>Cancelar</Button>
          <Button disabled={!valido || enviando} onClick={async () => { setEnviando(true); await onConfirmar(motivo.trim()); setEnviando(false); }}>
            {enviando && <Loader2 className="animate-spin" aria-hidden="true" />}{enviando ? "Guardando…" : "Guardar y pedir VoBo"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * GERENTE / ADMINISTRADOR resuelve el VoBo. Autorizar también envía la oferta, al destino de useDestinoEnvio (fuera
 * de producción, teléfono de prueba o cliente). Sin teléfono del cliente la oferta no se puede enviar: solo se
 * autoriza. Rechazar pide motivo y regresa el monto al anterior.
 */
function DialogoVobo({ oferta: o, onCerrar, onConfirmar }: {
  oferta: Oferta; onCerrar: () => void;
  onConfirmar: (autoriza: boolean, motivo: string, destino: DestinoEnvio | null) => Promise<void>;
}) {
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState<"autoriza" | "rechaza" | null>(null);
  const conEnvio = !!o.contacto.telefono;
  const { campos, destino, recuerda } = useDestinoEnvio(o, !!enviando, () => { if (destino) resuelve(true); });
  const resuelve = async (autoriza: boolean) => {
    setEnviando(autoriza ? "autoriza" : "rechaza");
    if (autoriza && conEnvio) recuerda();
    await onConfirmar(autoriza, motivo.trim(), autoriza && conEnvio ? destino : null);
    setEnviando(null);
  };
  // Corto: el destino ya se ve en los campos de arriba (un texto largo ensancha el pie y saca el contenido del modal)
  const etiquetaAutoriza = conEnvio ? "Autorizar y enviar" : "Autorizar";
  return (
    <Dialog open onOpenChange={(abierto) => !abierto && !enviando && onCerrar()}>
      {/* min-w-0: que ningún hijo ensanche la columna del grid más allá del modal */}
      <DialogContent className="[&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>VoBo del monto</DialogTitle>
          <DialogDescription>
            {o.contacto.nombre ?? "Cliente"} · {modelo(o)} · {o.nombreAgencia ?? o.idAgencia}.
            {" "}{o.vobo.solicitadoPor ?? "El valuador"} dejó el monto fuera del margen de ajuste.
          </DialogDescription>
        </DialogHeader>
        <ResumenAjuste oferta={o} monto={Number(o.montoOferta)} />
        {o.vobo.motivoSolicitud && <p className="vreason" style={{ margin: 0 }}><b>Motivo del valuador:</b> {o.vobo.motivoSolicitud}</p>}
        <div className="grid gap-2">
          <Label htmlFor="motivo-vobo">Comentario (obligatorio para rechazar)</Label>
          <Textarea id="motivo-vobo" rows={3} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
          <p className="text-xs text-muted-foreground">
            Si rechazas, el monto regresa a {dinero(o.vobo.montoPrevio)}.{" "}
            {conEnvio
              ? `Si autorizas, la oferta se envía por WhatsApp con ${dinero(o.montoOferta)}${esProduccion ? " al cliente" : ""}.`
              : "La cita no tiene teléfono: al autorizar no se envía."}
          </p>
        </div>
        {conEnvio && campos}
        <DialogFooter className="sm:flex-wrap">
          <Button variant="outline" onClick={onCerrar} disabled={!!enviando}>Cancelar</Button>
          <Button variant="destructive" disabled={!!enviando || motivo.trim().length === 0} onClick={() => resuelve(false)}>
            {enviando === "rechaza" && <Loader2 className="animate-spin" aria-hidden="true" />}Rechazar
          </Button>
          <Button disabled={!!enviando || (conEnvio && !destino)} onClick={() => resuelve(true)}>
            {enviando === "autoriza" ? <Loader2 className="animate-spin" aria-hidden="true" /> : conEnvio && <Send aria-hidden="true" />}
            {enviando === "autoriza" ? "Enviando…" : etiquetaAutoriza}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const LLAVE_TELEFONO_PRUEBA = "valuacion.telefonoPrueba";

/**
 * A quién se envía fuera de producción: a un teléfono de prueba (10 dígitos, el +52 se agrega solo) o, marcando la
 * casilla, al cliente. En producción no hay campos: siempre al cliente. Lo usan Enviar y "Autorizar y enviar".
 * `destino` es null mientras el teléfono no es válido; `recuerda` guarda el número de prueba en este navegador.
 */
function useDestinoEnvio(oferta: Oferta, deshabilitado: boolean, onEnter: () => void) {
  const [alCliente, setAlCliente] = useState(false);
  // El último número de prueba se recuerda en este navegador (si el almacenamiento no está disponible, no pasa nada)
  const [digitos, setDigitos] = useState(() => {
    try { return diezDigitos(localStorage.getItem(LLAVE_TELEFONO_PRUEBA) ?? ""); } catch { return ""; }
  });
  const [tocado, setTocado] = useState(false);
  const telefono = telefonoMx(digitos);
  const alClienteFinal = esProduccion || alCliente;
  const destino: DestinoEnvio | null = alClienteFinal ? { alCliente: true } : telefono ? { telefonoDestino: telefono } : null;
  const telefonoCliente = oferta.contacto.telefono;

  const recuerda = () => {
    if (!alClienteFinal && telefono) {
      try { localStorage.setItem(LLAVE_TELEFONO_PRUEBA, digitos); } catch { /* sin almacenamiento */ }
    }
  };

  const campos = esProduccion ? null : (
    <>
      <div className={cn("grid gap-2", alCliente && "opacity-50")}>
        <Label htmlFor="telefono-prueba">Teléfono de prueba (10 dígitos)</Label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground" aria-hidden>+52</span>
          <Input
            id="telefono-prueba" className="flex-1" inputMode="numeric" autoComplete="tel-national" placeholder="81 1234 5678"
            value={formatoDiez(digitos)} disabled={alCliente || deshabilitado}
            onChange={(e) => { setDigitos(diezDigitos(e.target.value)); setTocado(true); }}
            onBlur={() => setTocado(true)} aria-invalid={!alCliente && tocado && !telefono}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onEnter(); } }}
          />
        </div>
        {!alCliente && tocado && !telefono && (
          <p role="alert" className="text-sm text-[var(--crit)]">Escribe los 10 dígitos del número, sin el +52.</p>
        )}
      </div>

      <label className={cn("flex items-start gap-3 rounded-md border p-3 cursor-pointer", alCliente && "border-[var(--crit)] bg-[var(--crit-bg)]")}>
        <input type="checkbox" className="mt-0.5 size-4 accent-[var(--crit)]" checked={alCliente} onChange={(e) => setAlCliente(e.target.checked)} disabled={deshabilitado} />
        <span className="text-sm">
          <span className="font-medium">Enviar al cliente real</span>
          <span className="block text-muted-foreground">
            {telefonoCliente ? `Se enviará a ${telefonoCliente}. El teléfono de prueba no se usa.` : "Esta oferta no tiene teléfono del cliente."}
          </span>
        </span>
      </label>
    </>
  );

  return { campos, destino, recuerda };
}

/** Pide a quién se envía la oferta (fuera de producción; en producción se envía sin preguntar). */
function DialogoEnvio({ oferta, onCerrar, onConfirmar }: {
  oferta: Oferta; onCerrar: () => void; onConfirmar: (destino: DestinoEnvio) => Promise<void>;
}) {
  const [enviando, setEnviando] = useState(false);
  const { campos, destino, recuerda } = useDestinoEnvio(oferta, enviando, () => { envia(); });
  const alCliente = !!destino?.alCliente;
  const envia = async () => {
    if (!destino) return;
    setEnviando(true);
    recuerda();
    await onConfirmar(destino);
    setEnviando(false);
  };

  return (
    <Dialog open onOpenChange={(abierto) => !abierto && !enviando && onCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enviar oferta por WhatsApp</DialogTitle>
          <DialogDescription>{oferta.contacto.nombre ?? "Cliente"} · {modelo(oferta)}.</DialogDescription>
        </DialogHeader>

        {campos}

        <DialogFooter>
          <Button variant="outline" onClick={onCerrar} disabled={enviando}>Cancelar</Button>
          <Button variant={alCliente ? "destructive" : "default"} disabled={!destino || enviando} onClick={envia}>
            {enviando ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
            {enviando ? "Enviando…" : alCliente ? "Enviar al cliente" : "Enviar a mi número de prueba"}
          </Button>
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
          <DialogTitle>Editar estatus de la oferta</DialogTitle>
          <DialogDescription>{oferta.contacto.nombre ?? "Cliente"} · {modelo(oferta)}</DialogDescription>
        </DialogHeader>
        {error ? <div className="alert" role="alert">{error}</div> : !etiquetas ? <span className="vsub">Cargando etiquetas…</span> : (
          <>
            <div className="grid gap-2">
              <Label htmlFor="estatus-oferta">Estatus</Label>
              <Select value={id} onValueChange={setId}>
                <SelectTrigger id="estatus-oferta" className="w-full"><SelectValue placeholder="Elige una opción…" /></SelectTrigger>
                <SelectContent>
                  {grupos.map((g) => {
                    const del = opciones.filter((e) => e.tipo === g.tipo);
                    return del.length ? (
                      <SelectGroup key={g.tipo}>
                        <SelectLabel>{g.label}</SelectLabel>
                        {del.map((e) => <SelectItem key={e.idEtiqueta} value={e.idEtiqueta}>{e.nombre}</SelectItem>)}
                      </SelectGroup>
                    ) : null;
                  })}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="motivo-estatus">Motivo {elegida?.esRequiereMotivo ? "(obligatorio)" : "(opcional)"}</Label>
              <Textarea id="motivo-estatus" rows={3} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
            </div>
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCerrar} disabled={enviando}>Cancelar</Button>
          <Button disabled={!valido || enviando}
            onClick={async () => { setEnviando(true); await onConfirmar(id, motivo.trim()); setEnviando(false); }}>
            {enviando && <Loader2 className="animate-spin" aria-hidden="true" />}{enviando ? "Guardando…" : "Guardar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
