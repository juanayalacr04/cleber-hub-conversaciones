"use client";

/**
 * Configuración por agencia con datos reales (schema `valuacion`): criterios con los que el proceso de madrugada
 * selecciona unidades, descuentos de la oferta y meta de envío. Lee con `consultaConfiguracion` y guarda con
 * `guardaConfiguracion` (permiso `configurar`). El prototipo con datos inventados queda en ConfiguracionView (demo).
 */

import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import { signOut } from "next-auth/react";
import { ArrowLeft, ChevronRight, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHead } from "@/components/shell/Shell";
import { useAuth } from "@/contexts/AuthContext";
import type { ModuleDef } from "@/lib/modules";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { consultaConfiguracion, guardaConfiguracion } from "@/lib/valuacion/acciones";
import { SERVICE_TYPES } from "@/lib/valuacion/store";
import { mensajeError } from "@/lib/hub/errores";
import { type ConfiguracionAgencia } from "@/lib/valuacion/tipos";
import { consultaUsuarioActual } from "@/lib/hub/usuario";
import { Field } from "./ConfiguracionView";
import { NuevaAgencia } from "./NuevaAgencia";

/** Lo que se edita: los números planos (NaN = campo vacío) más el estado y los tipos de servicio. */
interface Borrador {
  minYear: number; maxYear: number; minKm: number; maxKm: number;
  minMantenimientos: number; aniosHistorial: number; minPublicaciones: number;
  pctDescuentoVenta: number; pctDescuentoVentaCompra: number; margenAjuste: number;
  citasEsperadasDia: number; pctMetaEnvio: number;
  tiposServicio: string[];
  esActivo: boolean;
}
type NumKey = Exclude<keyof Borrador, "tiposServicio" | "esActivo">;

const aBorrador = (a: ConfiguracionAgencia): Borrador => ({
  ...a.criterios, ...a.montos,
  // La base lo manda como numeric (texto en JSON si trae decimales): se normaliza a número
  margenAjuste: Number(a.montos.margenAjuste ?? 15000),
  citasEsperadasDia: a.meta.citasEsperadasDia, pctMetaEnvio: a.meta.pctMetaEnvio,
  tiposServicio: [...a.criterios.tiposServicio], esActivo: a.esActivo,
});

/** Campo de la base (info.campo de CAMPO_INVALIDO) → grupo de error del formulario. */
const CAMPO_A_GRUPO: Record<string, string> = {
  minYear: "year", maxYear: "year", minKm: "km", maxKm: "km",
  minMantenimientos: "services", aniosHistorial: "services", minPublicaciones: "listings",
  pctDescuentoVenta: "pctSale", pctDescuentoVentaCompra: "pctSaleBuy", margenAjuste: "margin", tiposServicio: "serviceTypes",
  citasEsperadasDia: "appts", pctMetaEnvio: "goalPct",
};

const fechaHora = (s: string) => new Date(s).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
const km = (n: number) => n.toLocaleString("es-MX");
/** Valor de `pendiente` para volver a la tabla (en lugar de cambiar a otra agencia). */
const A_LA_TABLA = "__tabla__";

export function ConfiguracionApiView({ mod }: { mod: ModuleDef }) {
  // La base regresa la configuración de todas las agencias del usuario, de cualquier marca: aquí solo las de la marca activa
  const { userData } = useAuth();
  const idMarca = userData?.organizationId ?? null;
  const [todas, setTodas] = useState<ConfiguracionAgencia[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [idAgencia, setIdAgencia] = useState<string | null>(null);
  const [draft, setDraft] = useState<Borrador | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [errorServidor, setErrorServidor] = useState<{ grupo: string; mensaje: string } | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [pendiente, setPendiente] = useState<string | null>(null);
  // Alta de agencias: solo super admin (una agencia nueva aún no está en las agencias de nadie)
  const [soySuper, setSoySuper] = useState(false);
  const [nueva, setNueva] = useState(false);

  const sesionVencida = (r: { errorCode: string; errorMessage: string }) => {
    toast.error(mensajeError(r));
    signOut({ redirectTo: "/login" });
  };

  const carga = useCallback(async () => {
    setError(null);
    setTodas(null);
    const r = await consultaConfiguracion();
    if (r.successful) {
      setTodas(r.info.agencias);
      setIdAgencia((actual) => (actual && r.info.agencias.some((a) => a.idAgencia === actual) ? actual : null));
      return;
    }
    if (r.errorCode === "SESION_EXPIRADA") return sesionVencida(r);
    setError(mensajeError(r));
  }, []);

  useEffect(() => { carga(); }, [carga]);
  useEffect(() => { setIdAgencia(null); }, [idMarca]);

  const agencias = useMemo(
    () => todas?.filter((a) => !idMarca || a.idMarca === idMarca).sort((x, y) => x.nombreAgencia.localeCompare(y.nombreAgencia)) ?? null,
    [todas, idMarca]);
  const unica = agencias?.length === 1;
  // Con una sola agencia no hay tabla: se abre directo
  useEffect(() => { if (unica && agencias && !idAgencia) setIdAgencia(agencias[0].idAgencia); }, [unica, agencias, idAgencia]);
  useEffect(() => {
    consultaUsuarioActual().then((r) => { if (r.successful) setSoySuper(r.info.usuario.esSuperAdmin); }).catch(() => {});
  }, []);

  const creada = (a: ConfiguracionAgencia) => {
    setTodas((lista) => [...(lista ?? []), a]);
    setIdAgencia(a.idAgencia);
    toast.success(`Agencia ${a.nombreAgencia} creada en pausa: revisa sus criterios y actívala`);
  };
  const botonNueva = soySuper && <button type="button" className="btn" onClick={() => setNueva(true)}><Plus size={14} />Nueva agencia</button>;
  const dialogoNueva = soySuper && (
    <NuevaAgencia open={nueva} onOpenChange={setNueva} existentes={(todas ?? []).map((a) => a.idAgencia)} onCreada={creada} />
  );

  const actual = agencias?.find((a) => a.idAgencia === idAgencia) ?? null;
  // Al cambiar de agencia (o al recargarla) el borrador se reinicia con lo guardado
  const [cargadoDe, setCargadoDe] = useState<ConfiguracionAgencia | null>(null);
  if (actual !== cargadoDe) { setCargadoDe(actual); setDraft(actual ? aBorrador(actual) : null); setTouched({}); setErrorServidor(null); }

  const nombre = (id: string) => agencias?.find((a) => a.idAgencia === id)?.nombreAgencia ?? id;
  const elige = (id: string) => { if (id === idAgencia) return; if (dirty) setPendiente(id); else setIdAgencia(id); };
  const vuelve = () => { if (dirty) setPendiente(A_LA_TABLA); else setIdAgencia(null); };

  const header = <PageHead title="Configuración" subtitle="Criterios de selección de unidades y meta de envío por agencia" mod={mod} />;

  // Vista principal: todas las agencias de la marca a las que se tiene acceso
  if (!error && agencias && agencias.length > 1 && !actual) {
    return (
      <>
        {header}
        <div className="view"><div className="pad" style={{ maxWidth: 1100 }}>
          <div className="sect">
            <h2>{agencias.length} agencias</h2>
            <span className="spacer" />
            {botonNueva}
          </div>
          <div className="card">
            <div className="tbl-wrap">
              <table className="vtable">
                <thead><tr>
                  <th>Agencia</th><th>Proceso</th><th>Años</th><th>Kilometraje</th><th>Mantenimientos</th><th>Meta diaria</th><th>Última modificación</th>
                  <th aria-label="Abrir" style={{ width: 36 }} />
                </tr></thead>
                <tbody>
                  {agencias.map((a) => (
                    <tr key={a.idAgencia} className="vrow" tabIndex={0} onClick={() => setIdAgencia(a.idAgencia)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setIdAgencia(a.idAgencia); } }}
                      aria-label={`Configurar ${a.nombreAgencia}`} style={{ cursor: "pointer" }}>
                      <td><span className="vname">{a.nombreAgencia}</span><small className="vsub">Taller de Quiter {a.idTallerQuiter}</small></td>
                      <td><span className={`pill ${a.esActivo ? "agent" : "wait"}`}>{a.esActivo ? "Activa" : "Pausada"}</span></td>
                      <td className="num">{a.criterios.minYear}–{a.criterios.maxYear}</td>
                      <td className="num">{km(a.criterios.minKm)}–{km(a.criterios.maxKm)} km</td>
                      <td className="num">{a.criterios.minMantenimientos} en {a.criterios.aniosHistorial} años</td>
                      <td className="num">{a.meta.metaDiaria} ofertas</td>
                      <td><small className="vsub">{a.actualizadoPor ? `${a.actualizadoPor}, ` : ""}{fechaHora(a.actualizadoEn)}</small></td>
                      <td><ChevronRight size={16} aria-hidden="true" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div></div>
        {dialogoNueva}
      </>
    );
  }

  if (error || !agencias || agencias.length === 0 || !actual || !draft) {
    return (
      <>
        {header}
        <div className="view"><div className="pad" style={{ maxWidth: 1100 }}>
          <div className="card">
            {error ? (
              <div className="empty">
                <b style={{ color: "var(--fg)" }}>No se pudo cargar la configuración</b><br />{error}
                <br /><button type="button" className="btn" style={{ marginTop: 12 }} onClick={carga}>Reintentar</button>
              </div>
            ) : !agencias || agencias.length > 0 ? (
              <div className="empty">Cargando configuración…</div>
            ) : (
              <div className="empty">
                <b style={{ color: "var(--fg)" }}>Sin agencias para configurar</b><br />
                No tienes agencias de Valuación asignadas, o aún no se dan de alta.
                {botonNueva && <><br /><span style={{ display: "inline-block", marginTop: 12 }}>{botonNueva}</span></>}
              </div>
            )}
          </div>
        </div></div>
        {dialogoNueva}
      </>
    );
  }

  const original = aBorrador(actual);
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);
  const empty = (...vs: number[]) => vs.some((v) => Number.isNaN(v));
  const pctErr = (v: number) => (empty(v) ? "Captura un valor" : v < 0 || v > 100 ? "Debe estar entre 0 y 100" : undefined);
  const d = draft;
  const errors: Record<string, string | undefined> = {
    km: empty(d.minKm, d.maxKm) ? "Captura ambos valores" : d.minKm < 0 ? "No puede ser negativo" : d.minKm > d.maxKm ? "El mínimo es mayor que el máximo" : undefined,
    year: empty(d.minYear, d.maxYear) ? "Captura ambos valores" : d.minYear > d.maxYear ? "El año mínimo es mayor que el máximo" : undefined,
    services: empty(d.minMantenimientos, d.aniosHistorial) ? "Captura ambos valores" : d.minMantenimientos < 1 || d.aniosHistorial < 1 ? "Usa al menos 1 mantenimiento y 1 año" : undefined,
    listings: empty(d.minPublicaciones) ? "Captura un valor" : d.minPublicaciones < 1 ? "Debe ser al menos 1" : undefined,
    pctSale: pctErr(d.pctDescuentoVenta),
    pctSaleBuy: pctErr(d.pctDescuentoVentaCompra),
    margin: empty(d.margenAjuste) ? "Captura un valor" : d.margenAjuste < 0 ? "No puede ser negativo" : undefined,
    serviceTypes: d.tiposServicio.length === 0 ? "Selecciona al menos un tipo de servicio" : undefined,
    appts: empty(d.citasEsperadasDia) ? "Captura un valor" : d.citasEsperadasDia < 0 ? "No puede ser negativo" : undefined,
    goalPct: pctErr(d.pctMetaEnvio),
  };
  // El error que devolvió la base se muestra en su campo hasta que se vuelve a editar
  if (errorServidor && !errors[errorServidor.grupo]) errors[errorServidor.grupo] = errorServidor.mensaje;
  const hasErrors = Object.values(errors).some(Boolean);
  const touch = (k: string) => () => setTouched((t) => (t[k] ? t : { ...t, [k]: true }));
  const fieldProps = (k: string) => ({ id: `cfg-${k}`, error: errors[k], show: !!touched[k], onBlur: touch(k) });
  const edita = (cambio: Partial<Borrador>) => { setDraft({ ...d, ...cambio }); setErrorServidor(null); };
  const num = (k: NumKey, field: string) => ({
    className: "date num", type: "number", inputMode: "numeric" as const,
    value: Number.isNaN(d[k]) ? "" : d[k],
    onChange: (e: ChangeEvent<HTMLInputElement>) => edita({ [k]: e.target.value === "" ? NaN : Number(e.target.value) }),
    "aria-invalid": touched[field] && !!errors[field] ? true : undefined,
    "aria-describedby": `cfg-${field}-d`,
  });
  // Opciones: el catálogo conocido más lo que ya tenga guardado la agencia (el área aún no define el catálogo final)
  const servicios = [...SERVICE_TYPES, ...original.tiposServicio.filter((s) => !SERVICE_TYPES.includes(s))];
  const toggleService = (s: string) => edita({
    tiposServicio: d.tiposServicio.includes(s) ? d.tiposServicio.filter((x) => x !== s) : [...d.tiposServicio, s],
  });
  const meta = empty(d.citasEsperadasDia, d.pctMetaEnvio) ? NaN : Math.round((d.citasEsperadasDia * d.pctMetaEnvio) / 100);

  const guarda = async () => {
    if (hasErrors) {
      setTouched(Object.fromEntries(Object.keys(errors).map((k) => [k, true])));
      requestAnimationFrame(() => document.querySelector<HTMLElement>(".vfield.invalid input")?.focus());
      return;
    }
    setGuardando(true);
    const r = await guardaConfiguracion({
      idAgencia: actual.idAgencia, idTallerQuiter: actual.idTallerQuiter, nombreAgencia: actual.nombreAgencia,
      idMarca: actual.idMarca, esActivo: d.esActivo,
      criterios: {
        minYear: d.minYear, maxYear: d.maxYear, minKm: d.minKm, maxKm: d.maxKm,
        minMantenimientos: d.minMantenimientos, aniosHistorial: d.aniosHistorial,
        minPublicaciones: d.minPublicaciones, tiposServicio: d.tiposServicio,
      },
      montos: { pctDescuentoVenta: d.pctDescuentoVenta, pctDescuentoVentaCompra: d.pctDescuentoVentaCompra, margenAjuste: d.margenAjuste },
      meta: { citasEsperadasDia: d.citasEsperadasDia, pctMetaEnvio: d.pctMetaEnvio },
    });
    setGuardando(false);
    if (r.successful) {
      setTodas((lista) => lista?.map((a) => (a.idAgencia === r.info.idAgencia ? r.info : a)) ?? lista);
      toast.success(`Configuración de ${r.info.nombreAgencia} guardada`);
      return;
    }
    if (r.errorCode === "SESION_EXPIRADA") return sesionVencida(r);
    const campo = (r.info as { campo?: string } | undefined)?.campo;
    const grupo = campo ? CAMPO_A_GRUPO[campo] : undefined;
    if (grupo) {
      setErrorServidor({ grupo, mensaje: r.errorMessage });
      setTouched((t) => ({ ...t, [grupo]: true }));
    }
    toast.error(mensajeError(r));
  };

  return (
    <>
      {header}
      <div className="view">
        <div className="pad" style={{ maxWidth: 1100 }}>
          <div className="sect">
            {!unica && <button type="button" className="btn" onClick={vuelve}><ArrowLeft size={14} />Agencias</button>}
            {unica ? <h2>{actual.nombreAgencia}</h2> : (
              <select className="date" value={actual.idAgencia} onChange={(e) => elige(e.target.value)} aria-label="Agencia">
                {agencias.map((a) => <option key={a.idAgencia} value={a.idAgencia}>{a.nombreAgencia}{a.esActivo ? "" : " (pausada)"}</option>)}
              </select>
            )}
            {unica && botonNueva}
            <span className="spacer" />
            {dirty && <span className="pill wait">Cambios sin guardar</span>}
            <button type="button" className="btn" disabled={!dirty || guardando} onClick={() => { setDraft(original); setTouched({}); setErrorServidor(null); }}>Descartar</button>
            <button type="button" className="btn primary" disabled={!dirty || guardando} onClick={guarda}>
              {guardando && <Loader2 size={14} className="animate-spin" />}Guardar
            </button>
          </div>
          <p className="vapply">
            Los cambios aplican desde el próximo proceso de madrugada; las ofertas ya generadas no se recalculan.
            {actual.actualizadoPor && <> Última modificación: {actual.actualizadoPor}, {fechaHora(actual.actualizadoEn)}.</>}
          </p>

          <div className="card">
            <div className="card-h"><h2>Agencia</h2><span className="sub">Taller de Quiter {actual.idTallerQuiter}</span></div>
            <div className="vform">
              <Field label="Proceso de madrugada" hint={d.esActivo ? "Cada madrugada se generan ofertas para sus citas" : "Pausada: no se generan ofertas nuevas"} {...fieldProps("activo")}>
                <label className="vchecks" style={{ display: "flex" }}>
                  <span><input type="checkbox" checked={d.esActivo} onChange={(e) => edita({ esActivo: e.target.checked })} /> Agencia activa</span>
                </label>
              </Field>
            </div>
          </div>

          <div className="card">
            <div className="card-h"><h2>Criterios de selección de unidades</h2><span className="sub">El proceso de madrugada descarta las unidades que no los cumplen</span></div>
            <div className="vform">
              <Field label="Rango de kilometraje" {...fieldProps("km")}>
                <div className="vrange"><input {...num("minKm", "km")} aria-label="Kilometraje mínimo" /><span>a</span><input {...num("maxKm", "km")} aria-label="Kilometraje máximo" /><span>km</span></div>
              </Field>
              <Field label="Rango de años del modelo" {...fieldProps("year")}>
                <div className="vrange"><input {...num("minYear", "year")} aria-label="Año mínimo" /><span>a</span><input {...num("maxYear", "year")} aria-label="Año máximo" /></div>
              </Field>
              <Field label="Mantenimientos" hint="Mínimo de mantenimientos en el periodo indicado" {...fieldProps("services")}>
                <div className="vrange"><input {...num("minMantenimientos", "services")} aria-label="Mantenimientos mínimos" /><span>en los últimos</span><input {...num("aniosHistorial", "services")} aria-label="Años de historial" /><span>años</span></div>
              </Field>
              <Field label="Mínimo de ofertas en el mercado" hint="Publicaciones comparables para confiar en el precio" htmlFor="in-listings" {...fieldProps("listings")}>
                <input id="in-listings" {...num("minPublicaciones", "listings")} />
              </Field>
              <Field label="% de oferta sobre precio de venta" hint="Descuento al precio promedio de venta" htmlFor="in-pctSale" {...fieldProps("pctSale")}>
                <div className="vrange"><input id="in-pctSale" {...num("pctDescuentoVenta", "pctSale")} /><span aria-hidden="true">%</span></div>
              </Field>
              <Field label="% de oferta sobre venta y compra" hint="Descuento al promedio entre venta y compra" htmlFor="in-pctSaleBuy" {...fieldProps("pctSaleBuy")}>
                <div className="vrange"><input id="in-pctSaleBuy" {...num("pctDescuentoVentaCompra", "pctSaleBuy")} /><span aria-hidden="true">%</span></div>
              </Field>
              <Field label="Margen de ajuste sin VoBo" hint="Cuánto puede subir o bajar el valuador el monto sugerido; fuera de este rango lo autoriza un gerente. Aplica desde el siguiente ajuste" htmlFor="in-margin" {...fieldProps("margin")}>
                <div className="vrange"><span aria-hidden="true">± $</span><input id="in-margin" {...num("margenAjuste", "margin")} step={1000} /></div>
              </Field>
              <Field label="Tipos de servicio" hint="Solo se consideran citas con estos servicios" {...fieldProps("serviceTypes")} show>
                <div className="vchecks">
                  {servicios.map((s) => (
                    <label key={s}><input type="checkbox" checked={d.tiposServicio.includes(s)} onChange={() => toggleService(s)} />{s}</label>
                  ))}
                </div>
              </Field>
            </div>
          </div>

          <div className="card">
            <div className="card-h"><h2>Meta de envío de ofertas</h2><span className="sub">Se usa en el Dashboard</span></div>
            <div className="vform">
              <Field label="Citas esperadas por día" htmlFor="in-appts" {...fieldProps("appts")}>
                <input id="in-appts" {...num("citasEsperadasDia", "appts")} />
              </Field>
              <Field label="% de ofertas a enviar" hint="Sobre las citas esperadas" htmlFor="in-goalPct" {...fieldProps("goalPct")}>
                <div className="vrange"><input id="in-goalPct" {...num("pctMetaEnvio", "goalPct")} /><span aria-hidden="true">%</span></div>
              </Field>
              <Field label="Meta diaria resultante" {...fieldProps("goal")}>
                <strong className="num" style={{ fontSize: 26 }} aria-live="polite">{Number.isNaN(meta) ? "—" : `${meta} ofertas`}</strong>
              </Field>
            </div>
          </div>
        </div>
      </div>

      {dialogoNueva}

      <AlertDialog open={pendiente !== null} onOpenChange={(o) => !o && setPendiente(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Descartar los cambios de {actual.nombreAgencia}?</AlertDialogTitle>
            <AlertDialogDescription>
              Tienes cambios sin guardar. Si {pendiente === A_LA_TABLA ? "vuelves a la lista de agencias" : `cambias a ${pendiente ? nombre(pendiente) : "otra agencia"}`}, se perderán.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Seguir editando</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (pendiente) setIdAgencia(pendiente === A_LA_TABLA ? null : pendiente); setPendiente(null); }}>Descartar y salir</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
