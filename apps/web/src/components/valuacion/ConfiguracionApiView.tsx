"use client";

/**
 * Configuración por agencia con datos reales (schema `valuacion`): criterios con los que el proceso de madrugada
 * selecciona unidades, descuentos de la oferta y meta de envío. Lee con `consultaConfiguracion` y guarda con
 * `guardaConfiguracion` (permiso `configurar`). El prototipo con datos inventados queda en ConfiguracionView (demo).
 */

import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { signOut } from "next-auth/react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHead } from "@/components/shell/Shell";
import type { ModuleDef } from "@/lib/modules";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { consultaConfiguracion, guardaConfiguracion } from "@/lib/valuacion/acciones";
import { SERVICE_TYPES } from "@/lib/valuacion/store";
import { mensajeError, type ConfiguracionAgencia } from "@/lib/valuacion/tipos";
import { consultaUsuarioActual } from "@/lib/hub/usuario";
import { Field } from "./ConfiguracionView";
import { NuevaAgencia } from "./NuevaAgencia";

/** Lo que se edita: los números planos (NaN = campo vacío) más el estado y los tipos de servicio. */
interface Borrador {
  minYear: number; maxYear: number; minKm: number; maxKm: number;
  minMantenimientos: number; aniosHistorial: number; minPublicaciones: number;
  pctDescuentoVenta: number; pctDescuentoVentaCompra: number;
  citasEsperadasDia: number; pctMetaEnvio: number;
  tiposServicio: string[];
  esActivo: boolean;
}
type NumKey = Exclude<keyof Borrador, "tiposServicio" | "esActivo">;

const aBorrador = (a: ConfiguracionAgencia): Borrador => ({
  ...a.criterios, ...a.montos,
  citasEsperadasDia: a.meta.citasEsperadasDia, pctMetaEnvio: a.meta.pctMetaEnvio,
  tiposServicio: [...a.criterios.tiposServicio], esActivo: a.esActivo,
});

/** Campo de la base (info.campo de CAMPO_INVALIDO) → grupo de error del formulario. */
const CAMPO_A_GRUPO: Record<string, string> = {
  minYear: "year", maxYear: "year", minKm: "km", maxKm: "km",
  minMantenimientos: "services", aniosHistorial: "services", minPublicaciones: "listings",
  pctDescuentoVenta: "pctSale", pctDescuentoVentaCompra: "pctSaleBuy", tiposServicio: "serviceTypes",
  citasEsperadasDia: "appts", pctMetaEnvio: "goalPct",
};

const fechaHora = (s: string) => new Date(s).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });

export function ConfiguracionApiView({ mod }: { mod: ModuleDef }) {
  const [agencias, setAgencias] = useState<ConfiguracionAgencia[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [idAgencia, setIdAgencia] = useState<string | null>(null);
  const [draft, setDraft] = useState<Borrador | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [errorServidor, setErrorServidor] = useState<{ grupo: string; mensaje: string } | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [pendiente, setPendiente] = useState<string | null>(null);
  // Alta de agencias: solo super admin (una agencia nueva aún no está en las agencias de nadie)
  const [marcas, setMarcas] = useState<{ idMarca: string; nombre: string }[] | null>(null);
  const [nueva, setNueva] = useState(false);

  const sesionVencida = (r: { errorCode: string; errorMessage: string }) => {
    toast.error(mensajeError(r));
    signOut({ redirectTo: "/login" });
  };

  const carga = useCallback(async () => {
    setError(null);
    setAgencias(null);
    const r = await consultaConfiguracion();
    if (r.successful) {
      setAgencias(r.info.agencias);
      setIdAgencia((actual) => (actual && r.info.agencias.some((a) => a.idAgencia === actual) ? actual : r.info.agencias[0]?.idAgencia ?? null));
      return;
    }
    if (r.errorCode === "SESION_EXPIRADA") return sesionVencida(r);
    setError(mensajeError(r));
  }, []);

  useEffect(() => { carga(); }, [carga]);
  useEffect(() => {
    consultaUsuarioActual().then((r) => { if (r.successful && r.info.usuario.esSuperAdmin) setMarcas(r.info.marcasVisibles); }).catch(() => {});
  }, []);

  const creada = (a: ConfiguracionAgencia) => {
    setAgencias((lista) => [...(lista ?? []), a].sort((x, y) => x.nombreAgencia.localeCompare(y.nombreAgencia)));
    setIdAgencia(a.idAgencia);
    toast.success(`Agencia ${a.nombreAgencia} creada en pausa: revisa sus criterios y actívala`);
  };
  const botonNueva = marcas && <button type="button" className="btn" onClick={() => setNueva(true)}><Plus size={14} />Nueva agencia</button>;
  const dialogoNueva = marcas && (
    <NuevaAgencia open={nueva} onOpenChange={setNueva} marcas={marcas} existentes={(agencias ?? []).map((a) => a.idAgencia)} onCreada={creada} />
  );

  const actual = agencias?.find((a) => a.idAgencia === idAgencia) ?? null;
  // Al cambiar de agencia (o al recargarla) el borrador se reinicia con lo guardado
  const [cargadoDe, setCargadoDe] = useState<ConfiguracionAgencia | null>(null);
  if (actual !== cargadoDe) { setCargadoDe(actual); setDraft(actual ? aBorrador(actual) : null); setTouched({}); setErrorServidor(null); }

  const nombre = (id: string) => agencias?.find((a) => a.idAgencia === id)?.nombreAgencia ?? id;
  const elige = (id: string) => { if (id === idAgencia) return; if (dirty) setPendiente(id); else setIdAgencia(id); };

  const header = <PageHead title="Configuración" subtitle="Criterios de selección de unidades y meta de envío por agencia" mod={mod} />;

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
            ) : !agencias ? (
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
      montos: { pctDescuentoVenta: d.pctDescuentoVenta, pctDescuentoVentaCompra: d.pctDescuentoVentaCompra },
      meta: { citasEsperadasDia: d.citasEsperadasDia, pctMetaEnvio: d.pctMetaEnvio },
    });
    setGuardando(false);
    if (r.successful) {
      setAgencias((lista) => lista?.map((a) => (a.idAgencia === r.info.idAgencia ? r.info : a)) ?? lista);
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
            <select className="date" value={actual.idAgencia} onChange={(e) => elige(e.target.value)} aria-label="Agencia">
              {agencias.map((a) => <option key={a.idAgencia} value={a.idAgencia}>{a.nombreAgencia}{a.esActivo ? "" : " (pausada)"}</option>)}
            </select>
            {botonNueva}
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
              Tienes cambios sin guardar. Si cambias a {pendiente ? nombre(pendiente) : "otra agencia"}, se perderán.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Seguir editando</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (pendiente) setIdAgencia(pendiente); setPendiente(null); }}>Descartar y cambiar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
