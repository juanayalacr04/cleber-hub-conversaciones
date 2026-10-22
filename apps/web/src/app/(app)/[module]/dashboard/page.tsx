"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { isAdmin, useAuth } from "@/contexts/AuthContext";
import { PageHead } from "@/components/shell/Shell";
import { Icon } from "@/components/shell/icons";
import { OUTCOME_LABELS, OUTCOME_VALUES } from "@/lib/conversation-outcomes";
import {
  loadAvgResponse, loadHistoricalStats, loadLiveStats, loadWaiting,
  type HistoricalStats, type LiveStats, type Scope, type WaitingItem,
} from "@/lib/dashboard-data";
import { MODULES, getModule } from "@/lib/modules";
import { conversationPath, modulePath } from "@/lib/routes";

function Stat({ label, value, note, icon, hot, href }: { label: string; value: string; note: string; icon: string; hot?: boolean; href?: string }) {
  const body = (
    <>
      <Icon name={icon} className="big" />
      <div className="top">{label}<span className="chipi"><Icon name={icon} /></span></div>
      <strong className="num">{value}</strong>
      <em>{note}</em>
    </>
  );
  const cls = `card stat${hot ? " hot" : ""}`;
  return href ? <Link href={href} className={cls} style={{ textDecoration: "none", color: "inherit" }}>{body}</Link> : <div className={cls}>{body}</div>;
}

const fmt = (n: number | undefined) => (n === undefined ? "—" : n.toLocaleString("es-MX"));
const pct = (n: number, total: number) => (total > 0 ? `${((n / total) * 100).toFixed(1)}% del total` : "Sin datos aún");
const today = () => new Date().toISOString().split("T")[0];
const monthStart = () => { const d = new Date(); d.setDate(1); return d.toISOString().split("T")[0]; };

/** Dashboard de un módulo: pendientes en vivo y métricas del período. Cada módulo ve solo lo suyo. */
function ModuleDashboard({ scope, moduleId }: { scope: Scope; moduleId: string }) {
  const { user, userData } = useAuth();
  const admin = isAdmin(userData);
  const [live, setLive] = useState<LiveStats | null>(null);
  const [avg, setAvg] = useState<string | null | undefined>(undefined);
  const [waiting, setWaiting] = useState<WaitingItem[] | null>(null);
  const [hist, setHist] = useState<HistoricalStats | null>(null);
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [loadingHist, setLoadingHist] = useState(false);
  const [error, setError] = useState(false);
  const isVentas = scope.vertical === "ventas";

  useEffect(() => {
    let off = false;
    const fail = (e: unknown) => { console.error("dashboard:", e); if (!off) setError(true); };
    loadLiveStats(scope).then((v) => !off && setLive(v)).catch(fail);
    loadWaiting(scope).then((v) => !off && setWaiting(v)).catch(fail);
    loadAvgResponse(scope, userData?.role === "agent" ? user?.uid : null).then((v) => !off && setAvg(v)).catch(() => !off && setAvg(null));
    return () => { off = true; };
  }, [scope, user?.uid, userData?.role]);

  const search = useCallback(async () => {
    setLoadingHist(true);
    try { setHist(await loadHistoricalStats(scope, from, to)); } catch (e) { console.error("dashboard:", e); setError(true); } finally { setLoadingHist(false); }
  }, [scope, from, to]);
  useEffect(() => { if (admin) search(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [scope, admin]);

  const conv = (qs = "") => modulePath(moduleId, `/conversaciones${qs}`);
  const range = `dateFrom=${from}&dateTo=${to}`;

  return (
    <div className="pad">
      {error && <div className="alert" role="alert">Algunos indicadores no se pudieron cargar. Recarga la página; si sigue igual, revisa tus permisos.</div>}

      <div className="grid4">
        <Stat label="Esperando agente" value={fmt(live?.waiting)} note="Pidieron hablar con una persona" icon="clock" hot={!!live && live.waiting > 0} href={conv("?tab=waiting")} />
        <Stat label="Conversaciones activas" value={fmt(live?.active)} note={live ? `${live.bot} con bot · ${live.withAgent} con agente` : "Cargando…"} icon="msg" href={conv()} />
        <Stat label="Tiempo de respuesta" value={avg === undefined ? "—" : avg ?? "—"} note={avg === null ? "Sin datos aún" : "Primer mensaje del agente"} icon="bell" />
        <Stat label={isVentas ? "Prospectos completos" : "Citas con bot"} value={fmt(isVentas ? hist?.prospectos : hist?.citasBot)} note="En el período seleccionado" icon={isVentas ? "tag" : "wrench"} />
      </div>

      {admin && (
        <>
          <div className="sect">
            <h2><Icon name="cal" />Métricas del período</h2>
            <span className="spacer" />
            <input className="date" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="Desde" />
            <span style={{ color: "var(--fg-3)" }}>a</span>
            <input className="date" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="Hasta" />
            <button type="button" className="btn primary" onClick={search} disabled={loadingHist}>{loadingHist ? "Cargando…" : "Buscar"}</button>
          </div>

          <div className="grid3">
            <Stat label="Conversaciones totales" value={fmt(hist?.total)} note="En el período seleccionado" icon="msg" href={conv(`?${range}`)} />
            <Stat label="Inbound" value={fmt(hist?.inbound)} note={hist ? pct(hist.inbound, hist.total) : "—"} icon="in" href={conv(`?direction=inbound&${range}`)} />
            <Stat label="Outbound" value={fmt(hist?.outbound)} note={hist ? pct(hist.outbound, hist.total) : "—"} icon="out" href={conv(`?direction=outbound&${range}`)} />
          </div>

          <div className="grid3">
            <Stat label="Citas con bot" value={fmt(hist?.citasBot)} note={hist ? pct(hist.citasBot, hist.total) : "—"} icon="bot" href={conv(`?appointmentStatus=cita_bot&${range}`)} />
            <Stat label="Citas con agente" value={fmt(hist?.citasAgente)} note={hist ? pct(hist.citasAgente, hist.total) : "—"} icon="user" href={conv(`?appointmentStatus=cita_agente&${range}`)} />
            {isVentas && <Stat label="Prospectos completos" value={fmt(hist?.prospectos)} note={hist ? pct(hist.prospectos, hist.total) : "—"} icon="tag" />}
          </div>

          {!isVentas && (
            <div className="card">
              <div className="card-h"><h2>Resultado de las conversaciones entrantes</h2><span className="sub">Clic para verlas</span></div>
              <div className="grid4" style={{ padding: 16 }}>
                {OUTCOME_VALUES.map((o) => (
                  <Link key={o} href={conv(`?direction=inbound&outcome=${o}&${range}`)} className="card" style={{ padding: 14, textDecoration: "none", color: "inherit" }}>
                    <div style={{ fontSize: 12, color: "var(--fg-3)" }}>{OUTCOME_LABELS[o]}</div>
                    <strong className="num" style={{ fontSize: 24 }}>{fmt(hist?.outcomes[o])}</strong>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <div className="card">
        <div className="card-h"><h2>Requieren atención</h2><span className="sub">Esperando agente</span></div>
        {waiting === null ? <div className="empty">Cargando…</div> : waiting.length === 0 ? <div className="empty">Sin pendientes.</div> :
          waiting.map((c) => (
            <Link key={c.id} href={conversationPath(c.id, moduleId)} className="row" style={{ textDecoration: "none", color: "inherit" }}>
              <span className="avatar">{c.name.slice(0, 2).toUpperCase()}</span>
              <span className="grow"><span className="t">{c.name}</span><span className="s">{c.preview}</span></span>
              <span className="pill wait">Esperando agente</span>
            </Link>
          ))}
      </div>
    </div>
  );
}

/** Vista general: un resumen por módulo, cada uno lleva a su propio dashboard. */
function GeneralDashboard({ orgId }: { orgId: string }) {
  const [rows, setRows] = useState<Record<string, { live: LiveStats; avg: string | null } | undefined>>({});
  useEffect(() => {
    let off = false;
    MODULES.filter((m) => m.vertical).forEach((m) => {
      const scope: Scope = { orgId, vertical: m.vertical };
      Promise.all([loadLiveStats(scope), loadAvgResponse(scope)])
        .then(([live, avg]) => !off && setRows((r) => ({ ...r, [m.id]: { live, avg } })))
        .catch((e) => console.error("dashboard:", e));
    });
    return () => { off = true; };
  }, [orgId]);

  const total = Object.values(rows).reduce((a, r) => ({ waiting: a.waiting + (r?.live.waiting ?? 0), active: a.active + (r?.live.active ?? 0) }), { waiting: 0, active: 0 });
  return (
    <div className="pad">
      <div className="grid4">
        <Stat label="Esperando agente" value={fmt(total.waiting)} note="Entre los dos módulos" icon="clock" hot={total.waiting > 0} />
        <Stat label="Conversaciones activas" value={fmt(total.active)} note="Entre los dos módulos" icon="msg" />
      </div>
      <div className="sect"><h2><Icon name="grid" />Módulos</h2></div>
      <div className="grid3">
        {MODULES.filter((m) => m.vertical).map((m) => {
          const r = rows[m.id];
          return (
            <Link key={m.id} href={modulePath(m.id, "/dashboard")} className="modcard" style={{ ["--c" as string]: m.id === "ventas" ? "var(--vent)" : "var(--serv)", textDecoration: "none", color: "inherit" }}>
              <h3><Icon name={m.icon} />{m.label}</h3>
              <dl>
                <dt>Esperando agente</dt><dd className="num">{fmt(r?.live.waiting)}</dd>
                <dt>Activas</dt><dd className="num">{fmt(r?.live.active)}</dd>
                <dt>Tiempo de respuesta</dt><dd>{r ? (r.avg ?? "—") : "—"}</dd>
              </dl>
              <span style={{ color: "var(--fg-3)", fontSize: 12.5 }}>Abrir el dashboard de {m.label}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { module: moduleId } = useParams<{ module: string }>();
  const { userData } = useAuth();
  const mod = getModule(moduleId);
  const scope = useMemo<Scope | null>(() => {
    if (!userData?.organizationId || !mod) return null;
    return { orgId: userData.organizationId, vertical: mod.vertical, teamId: isAdmin(userData) ? null : userData.teamId };
  }, [userData, mod]);
  if (!mod || !scope) return null;

  const first = (userData?.name || "").split(" ")[0] || "Usuario";
  return (
    <>
      <PageHead title={`Hola, ${first}`} subtitle={mod.id === "general" ? "Resumen de los dos módulos" : `Dashboard del módulo de ${mod.label}`} mod={mod} />
      <div className="view">
        {mod.id === "general" ? <GeneralDashboard orgId={scope.orgId} /> : <ModuleDashboard scope={scope} moduleId={mod.id} />}
      </div>
    </>
  );
}
