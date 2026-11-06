"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, MessageSquare, Save, Send, X } from "lucide-react";
import { toast } from "sonner";
import {
  AGENCIES, NEXT_STATUS, SENDABLE, SEND_DELAY_MS, STATUSES, agencyName, fmtDate, fmtKm, fmtMoney, queueSend, registerFinal,
  restoreOffer, saveAmount, setStatus, statusInfo, useValuacion, type Offer, type Status,
} from "@/lib/valuacion/store";

/** Envía con 5 s de gracia: el aviso permite deshacer antes de que salga el WhatsApp. */
export function sendWithUndo(offers: Offer[]) {
  if (!offers.length) return;
  const undo = queueSend(offers.map((o) => o.id));
  const what = offers.length === 1 ? `la oferta a ${offers[0].customer}` : `${offers.length} ofertas`;
  toast(`Enviando ${what}…`, {
    duration: SEND_DELAY_MS,
    action: { label: "Deshacer", onClick: () => { undo(); toast("Envío cancelado"); } },
  });
}

/** Cambia el estatus y ofrece deshacer (el cambio afecta métricas). */
export function changeStatus(offer: Offer, status: Status, note?: string) {
  if (offer.status === status) return;
  setStatus(offer.id, status, note);
  toast(`Estatus: ${statusInfo(status).label}`, {
    action: { label: "Deshacer", onClick: () => restoreOffer(offer) },
  });
}

export function useSending() {
  return useValuacion().sending;
}

export function ProtoNote() {
  return <div className="note">Prototipo con datos inventados: los cambios se guardan solo en esta pestaña y se pierden al recargar.</div>;
}

export function StatusPill({ status }: { status: Status }) {
  const s = statusInfo(status);
  return <span className={`pill ${s.tone}`}>{s.label}</span>;
}

/** El valuador puede mover la oferta a cualquier estatus; los siguientes pasos lógicos van primero. */
export function StatusSelect({ offer }: { offer: Offer }) {
  const next = NEXT_STATUS[offer.status];
  const others = STATUSES.filter((s) => s.id !== offer.status && !next.includes(s.id));
  return (
    <select
      className="date" style={{ width: "100%" }} value={offer.status} aria-label="Estatus de la oferta"
      onChange={(e) => changeStatus(offer, e.target.value as Status)}
    >
      <option value={offer.status}>{statusInfo(offer.status).label} (actual)</option>
      {next.length > 0 && <optgroup label="Siguiente paso">{next.map((s) => <option key={s} value={s}>{statusInfo(s).label}</option>)}</optgroup>}
      <optgroup label="Otros estatus">{others.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</optgroup>
    </select>
  );
}

/**
 * Monto editable directo en la celda de la tabla: Enter guarda, Esc descarta.
 * Muestra el promedio de mercado para comparar sin abrir la ficha.
 */
export function InlineAmount({ offer, disabled }: { offer: Offer; disabled?: boolean }) {
  const [v, setV] = useState(offer.amount.toLocaleString("es-MX"));
  const [base, setBase] = useState(offer.amount);
  if (base !== offer.amount) { setBase(offer.amount); setV(offer.amount.toLocaleString("es-MX")); }
  const n = toNum(v);
  const dirty = n !== offer.amount;
  const commit = () => {
    if (!n) { setV(offer.amount.toLocaleString("es-MX")); return; }
    if (dirty) { saveAmount(offer.id, n); toast.success(`Monto guardado: ${fmtMoney(n)}`); }
  };
  return (
    <div className="vamt" onClick={(e) => e.stopPropagation()}>
      <span className="vamt-in">
        <span aria-hidden="true">$</span>
        <input
          className="num" inputMode="numeric" value={v} disabled={disabled} aria-label={`Monto de la oferta para ${offer.customer}`}
          onChange={(e) => setV(e.target.value)}
          onFocus={(e) => { setV(String(toNum(e.target.value) || offer.amount)); requestAnimationFrame(() => e.target.select()); }}
          onBlur={() => { commit(); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") { setV(offer.amount.toLocaleString("es-MX")); requestAnimationFrame(() => (e.target as HTMLInputElement).blur()); }
          }}
        />
      </span>
      <small className="vsub">Prom. {fmtMoney(offer.market.avg)} · −{pctOff(n || offer.amount, offer.market.avg)}</small>
    </div>
  );
}

export function AgencySelect({ value, onChange, all = true }: { value: string; onChange: (v: string) => void; all?: boolean }) {
  return (
    <select className="date" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Agencia">
      {all && <option value="all">Todas las agencias</option>}
      {AGENCIES.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
    </select>
  );
}

export const pctOff = (amount: number, avg: number) => `${((1 - amount / avg) * 100).toFixed(1)}%`;
const toNum = (s: string) => Number(s.replace(/[^\d]/g, ""));

/** Monto editable de una oferta que aún no se envía: guardar (sin enviar) o enviar. */
function AmountEditor({ offer }: { offer: Offer }) {
  const [v, setV] = useState(String(offer.amount));
  const [base, setBase] = useState(offer.amount);
  if (base !== offer.amount) { setBase(offer.amount); setV(String(offer.amount)); }
  const n = toNum(v);
  const dirty = n !== offer.amount;
  const sending = useSending().includes(offer.id);
  return (
    <div className="vedit">
      <label className="vfl-l" htmlFor={`amt-${offer.id}`}>Monto de la oferta</label>
      <div className="vrange">
        <input id={`amt-${offer.id}`} className="date num" inputMode="numeric" value={v} onChange={(e) => setV(e.target.value)} style={{ width: 130 }} />
        <span>{n ? `−${pctOff(n, offer.market.avg)} vs. promedio` : ""}</span>
      </div>
      <div className="vrange">
        <button type="button" className="btn" disabled={!dirty || !n} onClick={() => { saveAmount(offer.id, n); toast.success("Oferta guardada (no se envió)"); }}>
          <Save size={14} />Guardar
        </button>
        <button type="button" className="btn primary" disabled={!n || sending} onClick={() => {
          if (dirty) saveAmount(offer.id, n);
          sendWithUndo([offer]);
        }}>
          <Send size={14} />{sending ? "Enviando…" : "Enviar"}
        </button>
      </div>
    </div>
  );
}

function FinalEditor({ offer }: { offer: Offer }) {
  const [v, setV] = useState(offer.finalAmount ? String(offer.finalAmount) : "");
  return (
    <div className="vedit">
      <label className="vfl-l" htmlFor={`fin-${offer.id}`}>Oferta final (después de la inspección)</label>
      <div className="vrange">
        <input id={`fin-${offer.id}`} className="date num" inputMode="numeric" placeholder="Monto" value={v} onChange={(e) => setV(e.target.value)} style={{ width: 130 }} />
        <button type="button" className="btn" onClick={() => {
          const n = toNum(v);
          if (!n) { toast.error("Captura el monto de la oferta final"); return; }
          registerFinal(offer.id, n); toast.success("Oferta final registrada");
        }}>Registrar</button>
      </div>
      <small className="vhint">Solo se registra en la plataforma; no se envía al cliente.</small>
    </div>
  );
}

/**
 * Ficha de la oferta. Se muestra a demanda: desplegada bajo la fila en Ofertas
 * o en la pestaña "Oferta" de la conversación.
 */
export function OfferDetail({ offer, conversationHref }: { offer: Offer; conversationHref?: string }) {
  return (
    <div className="vdetail">
      <section>
        <h3>Cliente y cita</h3>
        <dl className="dl">
          <dt>Teléfono</dt><dd className="num">{offer.phone}</dd>
          <dt>Agencia</dt><dd>{agencyName(offer.agencyId)}</dd>
          <dt>Cita</dt><dd>{fmtDate(offer.apptDate)} · {offer.apptTime}</dd>
          <dt>Servicio</dt><dd>{offer.serviceType}</dd>
        </dl>
        {conversationHref && offer.sentAt && <Link href={conversationHref} className="btn vbtn-link"><MessageSquare size={14} />Abrir conversación</Link>}
      </section>

      <section>
        <h3>Vehículo</h3>
        <dl className="dl">
          <dt>Quiter</dt><dd>{offer.quiterModel}</dd>
          <dt>Año · km</dt><dd className="num">{offer.year} · {fmtKm(offer.km)}</dd>
          <dt>Transmisión</dt><dd>{offer.transmission} · {offer.color}</dd>
          <dt>IDV / Placa</dt><dd className="num">{offer.idv} · {offer.plate}</dd>
          <dt>Servicios 2 años</dt><dd>{offer.services2y} · último {fmtDate(offer.lastService)}</dd>
        </dl>
      </section>

      <section>
        <h3>Criterios de selección</h3>
        {offer.status === "incompleto" && <p className="vreason"><b>Falta información:</b> {offer.reason}</p>}
        <ul className="vcrit">
          {offer.criteria.map((c) => (
            <li key={c.id} className={c.ok ? "ok" : "bad"}>
              {c.ok ? <Check size={14} aria-label="Cumple" /> : <X size={14} aria-label="No cumple" />}
              <span><b>{c.label}</b> {c.value}<small>{c.rule}</small></span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3>Mercado (Intelimotor)</h3>
        <dl className="dl">
          <dt>Bajo</dt><dd className="num">{fmtMoney(offer.market.low)}</dd>
          <dt>Promedio</dt><dd className="num"><b>{fmtMoney(offer.market.avg)}</b></dd>
          <dt>Alto</dt><dd className="num">{fmtMoney(offer.market.high)}</dd>
          <dt>Publicaciones</dt><dd>{offer.market.listings}</dd>
        </dl>
      </section>

      <section>
        <h3>Oferta</h3>
        {SENDABLE.includes(offer.status) ? <AmountEditor offer={offer} /> : (
          <dl className="dl">
            <dt>Oferta enviada</dt><dd className="num"><b>{fmtMoney(offer.amount)}</b> (−{pctOff(offer.amount, offer.market.avg)})</dd>
            {offer.finalAmount !== null && <><dt>Oferta final</dt><dd className="num"><b>{fmtMoney(offer.finalAmount)}</b></dd></>}
          </dl>
        )}
        {offer.sentAt && <FinalEditor key={`${offer.id}-${offer.finalAmount}`} offer={offer} />}
      </section>

      <section>
        <h3>Estatus</h3>
        <StatusSelect offer={offer} />
        <details className="vhist-d">
          <summary>Historial ({offer.history.length})</summary>
          <ol className="vhist">
            {[...offer.history].reverse().map((h, i) => <li key={i}><small>{h.at}</small>{h.text}</li>)}
          </ol>
        </details>
      </section>
    </div>
  );
}
