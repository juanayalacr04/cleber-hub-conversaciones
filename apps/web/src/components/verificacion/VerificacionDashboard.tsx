"use client";

/**
 * Dashboard del módulo de Verificación con datos reales (hub_cleber): cuántas solicitudes llegaron, cuántas esperan
 * respuesta del cliente, cuántas quedaron válidas o no válidas y cómo va la entrega del resultado a Salesforce.
 *   Resumen:   Hub.resumenVerificaciones (conteos del período)
 *   Fallidos:  Hub.consultaVerificaciones con callbackEstados = fallido
 * Sin datos sensibles: aquí no se listan teléfonos; el detalle está en Conversaciones.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { PageHead } from "@/components/shell/Shell";
import { Icon } from "@/components/shell/icons";
import { useAuth } from "@/contexts/AuthContext";
import type { ModuleDef } from "@/lib/modules";
import { conversationPath, modulePath } from "@/lib/routes";
import {
  consultaVerificaciones, resumenVerificaciones, type ResumenVerificaciones, type Verificacion,
} from "@/lib/hub/verificaciones";
import { mensajeError } from "@/lib/hub/errores";

type Rango = "hoy" | "7d" | "30d" | "todo";

const RANGOS: { id: Rango; label: string }[] = [
  { id: "hoy", label: "Hoy" },
  { id: "7d", label: "7 días" },
  { id: "30d", label: "30 días" },
  { id: "todo", label: "Todo" },
];

/** Ventana del rango elegido, en ISO. "Todo" no manda fechas. */
function rangoFechas(r: Rango): { desde?: string; hasta?: string } {
  if (r === "todo") return {};
  const hasta = new Date();
  const desde = new Date();
  if (r === "hoy") desde.setHours(0, 0, 0, 0);
  else desde.setDate(desde.getDate() - (r === "7d" ? 7 : 30));
  return { desde: desde.toISOString(), hasta: hasta.toISOString() };
}

const n = (v: number | undefined) => (v === undefined ? "—" : v.toLocaleString("es-MX"));
const fechaHora = (s: string) => new Date(s).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });

function Stat({ label, value, note, icon, hot, href }: { label: string; value: string; note: string; icon: string; hot?: boolean; href?: string }) {
  const body = (
    <>
      <div className="top">{label}<span className="chipi"><Icon name={icon} /></span></div>
      <strong className="num">{value}</strong>
      <em>{note}</em>
    </>
  );
  const cls = `card stat${hot ? " hot" : ""}`;
  return href ? <Link href={href} className={cls} style={{ textDecoration: "none", color: "inherit" }}>{body}</Link> : <div className={cls}>{body}</div>;
}

export function VerificacionDashboard({ mod }: { mod: ModuleDef }) {
  const { userData } = useAuth();
  const idMarca = userData?.organizationId ?? null;
  const [rango, setRango] = useState<Rango>("7d");
  const [resumen, setResumen] = useState<ResumenVerificaciones | null>(null);
  const [fallidos, setFallidos] = useState<Verificacion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  const carga = useCallback(async () => {
    if (!idMarca) return;
    setCargando(true);
    setError(null);
    const { desde, hasta } = rangoFechas(rango);
    const [r, f] = await Promise.all([
      resumenVerificaciones({ idMarca, ...(desde ? { desde } : {}), ...(hasta ? { hasta } : {}) }),
      consultaVerificaciones({ idMarca, callbackEstados: ["fallido"], limite: 10 }),
    ]);
    setCargando(false);
    if (!r.successful) {
      if (r.errorCode === "SESION_EXPIRADA") { toast.error(mensajeError(r, "Verificación")); signOut({ redirectTo: "/login" }); return; }
      setResumen(null);
      setFallidos(null);
      setError(mensajeError(r, "Verificación"));
      return;
    }
    setResumen(r.info);
    setFallidos(f.successful ? f.info.verificaciones : []);
  }, [idMarca, rango]);

  useEffect(() => { setResumen(null); setFallidos(null); carga(); }, [carga]);

  const conv = (qs = "") => modulePath(mod.id, `/conversaciones${qs}`);

  return (
    <>
      <PageHead title="Dashboard" subtitle="Verificaciones de datos del cliente y entrega del resultado a Salesforce" mod={mod} />
      <div className="view">
        <div className="pad">
          {error ? (
            <div className="card">
              <div className="empty">
                <p>No se pudo cargar el resumen: {error}</p>
                <button type="button" className="btn" onClick={carga} disabled={cargando}>
                  {cargando ? <Loader2 size={14} className="ospin" aria-hidden="true" /> : null}Reintentar
                </button>
              </div>
            </div>
          ) : !resumen ? (
            <div className="empty"><Loader2 size={20} className="ospin" aria-hidden="true" /><span className="vsub">Cargando...</span></div>
          ) : (
            <>
              <div className="sect">
                <h2><Icon name="clipboard" />Resumen</h2>
                <span className="spacer" />
                <div className="vseg" role="group" aria-label="Período">
                  {RANGOS.map((r) => (
                    <button key={r.id} type="button" aria-pressed={rango === r.id} onClick={() => setRango(r.id)}>{r.label}</button>
                  ))}
                </div>
              </div>

              {resumen.total === 0 ? (
                <div className="card"><div className="empty">Sin verificaciones en el período seleccionado.</div></div>
              ) : (
                <>
                  <div className="grid4">
                    <Stat label="Solicitudes recibidas" value={n(resumen.total)} note="En el período seleccionado" icon="clipboard" href={conv()} />
                    <Stat label="Pendientes de respuesta" value={n(resumen.pendientes)} note="El cliente no ha contestado" icon="clock" hot={resumen.pendientes > 0} href={conv("?estado=pendiente")} />
                    <Stat label="Válidas" value={n(resumen.validas)} note="El cliente confirmó sus datos" icon="calc" href={conv("?estado=valido")} />
                    <Stat label="No válidas" value={n(resumen.noValidas)} note="El cliente no confirmó sus datos" icon="search" href={conv("?estado=no_valido")} />
                  </div>

                  <div className="sect">
                    <h2><Icon name="out" />Callback a Salesforce</h2>
                    <span style={{ color: "var(--fg-3)", fontSize: 13 }}>Entrega del resultado de cada verificación</span>
                  </div>
                  <div className="grid4">
                    <Stat label="Enviado" value={n(resumen.callback.enviado)} note="Salesforce recibió el resultado" icon="out" href={conv("?callback=enviado")} />
                    <Stat label="Fallido" value={n(resumen.callback.fallido)} note="Se reintenta cuando el bot repite la acción" icon="bell" hot={resumen.callback.fallido > 0} href={conv("?callback=fallido")} />
                    <Stat label="Pendiente" value={n(resumen.callback.pendiente)} note="En espera de entregarse" icon="clock" href={conv("?callback=pendiente")} />
                    <Stat label="Simulados" value={n(resumen.callback.simulados)} note="No salieron a Salesforce (simulación)" icon="bot" />
                    <Stat label="Sin callback" value={n(resumen.sinCallback)} note="Sin intento de entrega todavía" icon="file" />
                  </div>
                </>
              )}

              <div className="card">
                <div className="card-h"><h2>Callbacks fallidos</h2><span className="sub">Los últimos 10, de cualquier período</span></div>
                {fallidos === null ? (
                  <div className="empty">Cargando...</div>
                ) : fallidos.length === 0 ? (
                  <div className="empty">Ningún callback fallido.</div>
                ) : fallidos.map((v) => {
                  const cuerpo = (
                    <>
                      <span className="grow">
                        <span className="t mono">{v.idExterno}</span>
                        <span className="s">{v.callback.ultimoError ?? "Sin detalle del error"}</span>
                      </span>
                      <span className="pill crit">{v.callback.intentos} intento{v.callback.intentos === 1 ? "" : "s"}</span>
                      <span className="s" style={{ flex: "none" }}>{v.callback.ultimoIntentoEn ? fechaHora(v.callback.ultimoIntentoEn) : fechaHora(v.creadoEn)}</span>
                    </>
                  );
                  return v.idConversacion
                    ? <Link key={v.idVerificacion} href={conversationPath(v.idConversacion, mod.id)} className="row" style={{ textDecoration: "none", color: "inherit" }}>{cuerpo}</Link>
                    : <div key={v.idVerificacion} className="row">{cuerpo}</div>;
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
