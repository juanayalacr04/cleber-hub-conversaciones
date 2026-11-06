"use client";

import { useState, type ChangeEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { X } from "lucide-react";
import { PageHead } from "@/components/shell/Shell";
import type { ModuleDef } from "@/lib/modules";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AGENCIES, SERVICE_TYPES, agencyName, dailyGoal, saveConfig, useValuacion, type AgencyConfig } from "@/lib/valuacion/store";
import { AgencySelect, ProtoNote } from "./common";

type NumKey = { [K in keyof AgencyConfig]: AgencyConfig[K] extends number ? K : never }[keyof AgencyConfig];

/**
 * Campo del formulario. Con `htmlFor` la etiqueta es un <label> del input;
 * sin él, agrupa varios controles (rangos, casillas) bajo la etiqueta.
 * El error se muestra al salir del campo y queda ligado con aria-describedby.
 */
function Field({ id, label, hint, error, show, htmlFor, onBlur, children }: {
  id: string; label: string; hint?: string; error?: string; show: boolean; htmlFor?: string; onBlur: () => void; children: ReactNode;
}) {
  const visible = show && error;
  return (
    <div
      className={`vfield${visible ? " invalid" : ""}`} onBlur={onBlur}
      role={htmlFor ? undefined : "group"} aria-labelledby={htmlFor ? undefined : `${id}-l`}
    >
      {htmlFor ? <label className="vfl-l" id={`${id}-l`} htmlFor={htmlFor}>{label}</label> : <span className="vfl-l" id={`${id}-l`}>{label}</span>}
      {children}
      <div aria-live="polite">
        {visible ? <small className="verr" id={`${id}-d`}>{error}</small> : hint && <small className="vhint" id={`${id}-d`}>{hint}</small>}
      </div>
    </div>
  );
}

export function ConfiguracionView({ mod }: { mod: ModuleDef }) {
  const { config } = useValuacion();
  const [agency, setAgency] = useState(AGENCIES[0].id);
  const [draft, setDraft] = useState<AgencyConfig>(config[agency]);
  const [loadedFor, setLoadedFor] = useState(agency);
  const [model, setModel] = useState("");
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [pendingAgency, setPendingAgency] = useState<string | null>(null);
  if (loadedFor !== agency) { setLoadedFor(agency); setDraft(config[agency]); setTouched({}); }

  const dirty = JSON.stringify(draft) !== JSON.stringify(config[agency]);
  const empty = (...vs: number[]) => vs.some((v) => Number.isNaN(v));
  const pctErr = (v: number) => (empty(v) ? "Captura un valor" : v < 0 || v > 100 ? "Debe estar entre 0 y 100" : undefined);
  const errors: Record<string, string | undefined> = {
    km: empty(draft.kmMin, draft.kmMax) ? "Captura ambos valores" : draft.kmMin < 0 ? "No puede ser negativo" : draft.kmMin > draft.kmMax ? "El mínimo es mayor que el máximo" : undefined,
    year: empty(draft.yearMin, draft.yearMax) ? "Captura ambos valores" : draft.yearMin > draft.yearMax ? "El año mínimo es mayor que el máximo" : undefined,
    services: empty(draft.servicesMin, draft.servicesMonths) ? "Captura ambos valores" : draft.servicesMin < 0 || draft.servicesMonths < 1 ? "Usa al menos 1 mes y no números negativos" : undefined,
    listings: empty(draft.minMarketListings) ? "Captura un valor" : draft.minMarketListings < 1 ? "Debe ser al menos 1" : undefined,
    pctSale: pctErr(draft.pctSale),
    pctSaleBuy: pctErr(draft.pctSaleBuy),
    serviceTypes: draft.serviceTypes.length === 0 ? "Selecciona al menos un tipo de servicio" : undefined,
    appts: empty(draft.expectedAppointments) ? "Captura un valor" : draft.expectedAppointments < 0 ? "No puede ser negativo" : undefined,
    goalPct: pctErr(draft.goalPct),
  };
  const hasErrors = Object.values(errors).some(Boolean);
  const touch = (k: string) => () => setTouched((t) => (t[k] ? t : { ...t, [k]: true }));
  const fieldProps = (k: string) => ({ id: `cfg-${k}`, error: errors[k], show: !!touched[k], onBlur: touch(k) });
  // Un campo vacío queda como NaN (no como 0) para no inventar valores mientras se escribe
  const num = (k: NumKey, field: string) => ({
    className: "date num", type: "number", inputMode: "numeric" as const,
    value: Number.isNaN(draft[k]) ? "" : draft[k],
    onChange: (e: ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [k]: e.target.value === "" ? NaN : Number(e.target.value) }),
    "aria-invalid": touched[field] && !!errors[field] ? true : undefined,
    "aria-describedby": `cfg-${field}-d`,
  });
  const addModel = () => {
    const m = model.trim();
    if (m && !draft.excludedModels.some((x) => x.toLowerCase() === m.toLowerCase())) setDraft({ ...draft, excludedModels: [...draft.excludedModels, m] });
    setModel("");
  };
  const toggleService = (s: string) => setDraft({
    ...draft, serviceTypes: draft.serviceTypes.includes(s) ? draft.serviceTypes.filter((x) => x !== s) : [...draft.serviceTypes, s],
  });
  const save = () => {
    if (hasErrors) {
      // Muestra todos los errores y lleva el foco al primer campo inválido
      setTouched(Object.fromEntries(Object.keys(errors).map((k) => [k, true])));
      requestAnimationFrame(() => document.querySelector<HTMLElement>(".vfield.invalid input")?.focus());
      return;
    }
    saveConfig(agency, draft);
    toast.success(`Configuración de ${agencyName(agency)} guardada`);
  };
  // Cambiar de agencia con cambios sin guardar pide confirmación en vez de descartarlos en silencio
  const pickAgency = (id: string) => { if (id === agency) return; if (dirty) setPendingAgency(id); else setAgency(id); };
  const goal = dailyGoal(draft);

  return (
    <>
      <ProtoNote />
      <PageHead title="Configuración" subtitle="Criterios de selección de unidades y meta de envío por agencia" mod={mod} />
      <div className="view">
        <div className="pad" style={{ maxWidth: 1100 }}>
          <div className="sect">
            <AgencySelect value={agency} onChange={pickAgency} all={false} />
            <span className="spacer" />
            {dirty && <span className="pill wait">Cambios sin guardar</span>}
            <button type="button" className="btn" disabled={!dirty} onClick={() => { setDraft(config[agency]); setTouched({}); }}>Descartar</button>
            <button type="button" className="btn primary" disabled={!dirty} onClick={save}>Guardar</button>
          </div>
          <p className="vapply">Los cambios aplican desde el próximo proceso de madrugada; las ofertas ya generadas no se recalculan.</p>

          <div className="card">
            <div className="card-h"><h2>Criterios de selección de unidades</h2><span className="sub">El proceso de madrugada descarta las unidades que no los cumplen</span></div>
            <div className="vform">
              <Field label="Rango de kilometraje" {...fieldProps("km")}>
                <div className="vrange"><input {...num("kmMin", "km")} aria-label="Kilometraje mínimo" /><span>a</span><input {...num("kmMax", "km")} aria-label="Kilometraje máximo" /><span>km</span></div>
              </Field>
              <Field label="Rango de años del modelo" {...fieldProps("year")}>
                <div className="vrange"><input {...num("yearMin", "year")} aria-label="Año mínimo" /><span>a</span><input {...num("yearMax", "year")} aria-label="Año máximo" /></div>
              </Field>
              <Field label="Mantenimientos" hint="Mínimo de mantenimientos en el periodo indicado" {...fieldProps("services")}>
                <div className="vrange"><input {...num("servicesMin", "services")} aria-label="Mantenimientos mínimos" /><span>en los últimos</span><input {...num("servicesMonths", "services")} aria-label="Meses" /><span>meses</span></div>
              </Field>
              <Field label="Mínimo de ofertas en el mercado" hint="Publicaciones comparables para confiar en el precio" htmlFor="in-listings" {...fieldProps("listings")}>
                <input id="in-listings" {...num("minMarketListings", "listings")} />
              </Field>
              <Field label="% de oferta sobre precio de venta" hint="Descuento al precio promedio de venta" htmlFor="in-pctSale" {...fieldProps("pctSale")}>
                <div className="vrange"><input id="in-pctSale" {...num("pctSale", "pctSale")} /><span aria-hidden="true">%</span></div>
              </Field>
              <Field label="% de oferta sobre venta y compra" hint="Descuento al promedio entre venta y compra" htmlFor="in-pctSaleBuy" {...fieldProps("pctSaleBuy")}>
                <div className="vrange"><input id="in-pctSaleBuy" {...num("pctSaleBuy", "pctSaleBuy")} /><span aria-hidden="true">%</span></div>
              </Field>
              <Field label="Modelos a descartar" htmlFor="in-model" {...fieldProps("models")}>
                <div className="chips">
                  {draft.excludedModels.map((m) => (
                    <span key={m} className="vchip">{m}
                      <button type="button" aria-label={`Quitar ${m}`} onClick={() => setDraft({ ...draft, excludedModels: draft.excludedModels.filter((x) => x !== m) })}><X size={14} /></button>
                    </span>
                  ))}
                </div>
                <div className="vrange">
                  <input id="in-model" className="date" value={model} onChange={(e) => setModel(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addModel(); } }} placeholder="Ej. Sienna" style={{ flex: 1 }} />
                  <button type="button" className="btn" onClick={addModel}>Agregar</button>
                </div>
              </Field>
              <Field label="Tipos de servicio" hint="Solo se consideran citas con estos servicios" {...fieldProps("serviceTypes")} show>
                <div className="vchecks">
                  {SERVICE_TYPES.map((s) => (
                    <label key={s}><input type="checkbox" checked={draft.serviceTypes.includes(s)} onChange={() => toggleService(s)} />{s}</label>
                  ))}
                </div>
              </Field>
            </div>
          </div>

          <div className="card">
            <div className="card-h"><h2>Meta de envío de ofertas</h2><span className="sub">Se usa en el Dashboard</span></div>
            <div className="vform">
              <Field label="Citas esperadas por día" htmlFor="in-appts" {...fieldProps("appts")}>
                <input id="in-appts" {...num("expectedAppointments", "appts")} />
              </Field>
              <Field label="% de ofertas a enviar" hint="Sobre las citas esperadas" htmlFor="in-goalPct" {...fieldProps("goalPct")}>
                <div className="vrange"><input id="in-goalPct" {...num("goalPct", "goalPct")} /><span aria-hidden="true">%</span></div>
              </Field>
              <Field label="Meta diaria resultante" {...fieldProps("goal")}>
                <strong className="num" style={{ fontSize: 26 }} aria-live="polite">{Number.isNaN(goal) ? "—" : `${goal} ofertas`}</strong>
              </Field>
            </div>
          </div>
        </div>
      </div>

      <AlertDialog open={pendingAgency !== null} onOpenChange={(o) => !o && setPendingAgency(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Descartar los cambios de {agencyName(agency)}?</AlertDialogTitle>
            <AlertDialogDescription>
              Tienes cambios sin guardar. Si cambias a {pendingAgency ? agencyName(pendingAgency) : "otra agencia"}, se perderán.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Seguir editando</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (pendingAgency) setAgency(pendingAgency); setPendingAgency(null); }}>Descartar y cambiar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
