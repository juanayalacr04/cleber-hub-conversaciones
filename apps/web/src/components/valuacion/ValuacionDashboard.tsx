"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { PageHead } from "@/components/shell/Shell";
import { Icon } from "@/components/shell/icons";
import type { ModuleDef } from "@/lib/modules";
import {
  AGENCIES, addDays, businessDays, dailyGoal, fmtDate, monthEndIso, monthStartIso, todayIso, useValuacion, type Offer,
} from "@/lib/valuacion/store";
import { useValuacionHref } from "@/lib/valuacion/base";
import { AgencySelect, ProtoNote } from "./common";

const n = (v: number) => v.toLocaleString("es-MX");
const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "—");
const inRange = (d: string | null, from: string, to: string) => !!d && d >= from && d <= to;

function Stat({ label, value, note, icon, href }: { label: string; value: string; note: string; icon: string; href?: string }) {
  const body = (
    <>
      <Icon name={icon} className="big" />
      <div className="top">{label}<span className="chipi"><Icon name={icon} /></span></div>
      <strong className="num">{value}</strong>
      <em>{note}</em>
    </>
  );
  return href
    ? <Link href={href} className="card stat" style={{ textDecoration: "none", color: "inherit" }}>{body}</Link>
    : <div className="card stat">{body}</div>;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Barras de ofertas enviadas por día contra la línea de meta diaria. */
function DailyChart({ days, goal }: { days: { d: string; sent: number }[]; goal: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 180, top = 14, bottom = 22, left = 30;
  const max = Math.max(goal, ...days.map((x) => x.sent), 1) * 1.15;
  const y = (v: number) => top + (H - top - bottom) * (1 - v / max);
  const slot = days.length ? (w - left) / days.length : 0;
  const bw = Math.max(3, Math.min(28, slot - 4));
  const ticks = [0, Math.round(max / 2), Math.round(max)];
  const every = Math.ceil(days.length / Math.max(1, Math.floor((w - left) / 52)));

  return (
    <div ref={ref} className="vchart" onMouseLeave={() => setHover(null)}>
      <svg width={w} height={H} role="group" aria-label={`Ofertas enviadas por día contra la meta diaria de ${goal}`}>
        {ticks.map((t) => (
          <g key={t} aria-hidden="true">
            <line x1={left} x2={w} y1={y(t)} y2={y(t)} stroke="var(--line)" />
            <text x={left - 6} y={y(t) + 3} textAnchor="end">{t}</text>
          </g>
        ))}
        {days.map((x, i) => {
          const cx = left + slot * i + slot / 2;
          const h = Math.max(0, y(0) - y(x.sent));
          return (
            // Cada día es enfocable con teclado y se toca en pantallas táctiles: el tooltip no depende del mouse
            <g
              key={x.d} className="vbar" tabIndex={0} role="img"
              aria-label={`${fmtDate(x.d)}: ${x.sent} enviadas, ${goal ? pct(x.sent, goal) : "—"} de la meta`}
              onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
              onClick={() => setHover((h) => (h === i ? null : i))}
            >
              <rect x={left + slot * i} y={top} width={slot} height={H - top - bottom} fill="transparent" />
              {x.sent > 0 && <path d={roundTop(cx - bw / 2, y(x.sent), bw, h)} fill="var(--mod)" opacity={hover === null || hover === i ? 1 : 0.45} />}
              {i % every === 0 && <text x={cx} y={H - 6} textAnchor="middle" aria-hidden="true">{fmtDate(x.d)}</text>}
            </g>
          );
        })}
        <line x1={left} x2={w} y1={y(goal)} y2={y(goal)} stroke="var(--fg-2)" strokeWidth={1.5} strokeDasharray="5 4" />
        <text x={w - 4} y={y(goal) - 5} textAnchor="end" style={{ fill: "var(--fg-2)" }} aria-hidden="true">Meta diaria {goal}</text>
      </svg>
      {hover !== null && days[hover] && (
        <div className="vtip" aria-hidden="true" style={{ left: Math.min(w - 150, Math.max(0, left + slot * hover + slot / 2 - 75)) }}>
          <b>{fmtDate(days[hover].d)}</b>
          <span>{days[hover].sent} enviadas · meta {goal}</span>
          <span>{goal ? pct(days[hover].sent, goal) : "—"} de la meta</span>
        </div>
      )}
    </div>
  );
}
function roundTop(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function Funnel({ steps }: { steps: { label: string; value: number }[] }) {
  const base = steps[0]?.value || 0;
  return (
    <div className="vfunnel">
      {steps.map((s, i) => (
        <div key={s.label} className="vfstep">
          <div className="vfl"><span>{s.label}</span><b className="num">{n(s.value)}</b></div>
          <div className="bar"><i style={{ width: base ? `${(s.value / base) * 100}%` : 0 }} /></div>
          <div className="vfs">
            <span>{pct(s.value, base)} del total enviado</span>
            {i > 0 && <span>{pct(s.value, steps[i - 1].value)} del paso anterior</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ValuacionDashboard({ mod }: { mod: ModuleDef }) {
  const { offers, config } = useValuacion();
  const href = useValuacionHref();
  const [agency, setAgency] = useState("all");
  const [from, setFrom] = useState(monthStartIso);
  // Por defecto el mes completo: la barra muestra la meta del mes y la marca de lo esperado a hoy
  const [to, setTo] = useState(monthEndIso);
  const today = todayIso();
  const yesterday = addDays(today, -1);

  const m = useMemo(() => {
    const list: Offer[] = offers.filter((o) => agency === "all" || o.agencyId === agency);
    const goalPerDay = (agency === "all" ? AGENCIES.map((a) => a.id) : [agency]).reduce((s, id) => s + dailyGoal(config[id]), 0);
    const days = businessDays(from, to);
    const sentInRange = list.filter((o) => inRange(o.sentAt, from, to));
    const daysToDate = businessDays(from, to < today ? to : today).length;
    const todaySent = list.filter((o) => o.sentAt === today);
    const apptToday = list.filter((o) => o.apptDate === today && o.sentAt === yesterday);
    return {
      goalPerDay,
      goal: goalPerDay * days.length,
      expected: to > today ? goalPerDay * daysToDate : null,
      sent: sentInRange.length,
      interested: sentInRange.filter((o) => o.interestAt).length,
      accepted: sentInRange.filter((o) => o.acceptedAt).length,
      daily: days.map((d) => ({ d, sent: list.filter((o) => o.sentAt === d).length })),
      pendingSend: list.filter((o) => inRange(o.processedOn, from, to) && (o.status === "pendiente" || o.status === "guardada")).length,
      followUp: list.filter((o) => inRange(o.sentAt, from, to) && o.status === "seguimiento").length,
      todaySent: todaySent.length,
      todayInterested: list.filter((o) => o.interestAt === today).length,
      finalsToday: apptToday.filter((o) => o.finalAt === today).length,
      finalsAcceptedToday: apptToday.filter((o) => o.acceptedAt === today).length,
      apptToday: apptToday.length,
    };
  }, [offers, config, agency, from, to, today, yesterday]);

  const reach = m.goal ? m.sent / m.goal : 0;
  const tone = reach >= 1 ? "agent" : m.expected !== null ? (m.sent >= m.expected ? "agent" : "wait") : reach >= 0.8 ? "wait" : "crit";
  const toneText = tone === "agent" ? "En meta" : tone === "wait" ? "Cerca de la meta" : "Debajo de la meta";

  return (
    <>
      <ProtoNote />
      <PageHead title="Dashboard" subtitle="Ofertas de compra a clientes con cita de servicio" mod={mod} />
      <div className="view">
        <div className="pad">
          <div className="sect">
            <AgencySelect value={agency} onChange={setAgency} />
            <span className="spacer" />
            <input className="date" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="Desde" />
            <span style={{ color: "var(--fg-3)" }}>a</span>
            <input className="date" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="Hasta" />
          </div>

          <div className="two">
            <div className="card">
              <div className="card-h"><h2>Ofertas enviadas contra la meta</h2><span className="sub">{fmtDate(from)} – {fmtDate(to)}</span></div>
              <div className="vgoal">
                <div className="vgoal-n">
                  <strong className="num">{n(m.sent)}</strong>
                  <span>de {n(m.goal)} ofertas · <b>{pct(m.sent, m.goal)}</b></span>
                  <span className={`pill ${tone}`} style={{ marginLeft: "auto" }}>{toneText}</span>
                </div>
                <div className="vbullet" role="img" aria-label={`${m.sent} de ${m.goal} ofertas enviadas`}>
                  <i style={{ width: `${Math.min(100, reach * 100)}%` }} />
                  {m.expected !== null && m.goal > 0 && <b style={{ left: `${(m.expected / m.goal) * 100}%` }} title={`Esperado a hoy: ${m.expected}`} />}
                </div>
                <p className="vhint">
                  Meta = {m.goalPerDay} ofertas por día hábil × {m.daily.length} días.
                  {m.expected !== null && <> La marca indica lo esperado a hoy ({n(m.expected)}).</>}
                </p>
              </div>
              <DailyChart days={m.daily} goal={m.goalPerDay} />
            </div>

            <div className="card">
              <div className="card-h"><h2>Embudo de conversión</h2><span className="sub">Ofertas enviadas en el período</span></div>
              <Funnel steps={[
                { label: "Ofertas enviadas", value: m.sent },
                { label: "Cliente con interés (acepta inspección)", value: m.interested },
                { label: "Cliente acepta oferta", value: m.accepted },
              ]} />
            </div>
          </div>

          <div className="sect">
            <h2><Icon name="cal" />Hoy</h2>
            <span style={{ color: "var(--fg-3)", fontSize: 13 }}>Envío de ofertas · Inspección de las {m.apptToday} citas de hoy con oferta enviada ayer</span>
          </div>
          <div className="grid4">
            <Stat label="Ofertas enviadas" value={n(m.todaySent)} note={`Meta del día: ${m.goalPerDay}`} icon="out" href={href("/ofertas")} />
            <Stat label="Clientes con interés" value={n(m.todayInterested)} note="Aceptaron inspección hoy" icon="user" />
            <Stat label="Ofertas finales registradas" value={n(m.finalsToday)} note="Después de la inspección" icon="calc" />
            <Stat label="Ofertas finales aceptadas" value={n(m.finalsAcceptedToday)} note={`${pct(m.finalsAcceptedToday, m.finalsToday)} de las registradas`} icon="tag" />
          </div>

          <div className="sect"><h2><Icon name="clock" />Por atender</h2><span style={{ color: "var(--fg-3)", fontSize: 13 }}>En el período seleccionado</span></div>
          <div className="grid4">
            <Stat label="Pendientes de envío" value={n(m.pendingSend)} note="Generadas sin enviar" icon="clock" href={href("/ofertas")} />
            <Stat label="Pendientes de seguimiento" value={n(m.followUp)} note="Enviadas sin respuesta del cliente" icon="bell" href={href("/conversaciones")} />
          </div>
        </div>
      </div>
    </>
  );
}
