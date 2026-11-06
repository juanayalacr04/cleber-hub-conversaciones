"use client";

import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, MessageSquare, MoreHorizontal, RotateCcw, Search, Send, X } from "lucide-react";
import { PageHead } from "@/components/shell/Shell";
import type { ModuleDef } from "@/lib/modules";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SENDABLE, agencyName, fmtDate, fmtKm, fmtMoney, isActive, prevBusinessDay, todayIso, useValuacion,
  type Offer, type Status,
} from "@/lib/valuacion/store";
import { useValuacionHref } from "@/lib/valuacion/base";
import { AgencySelect, InlineAmount, OfferDetail, ProtoNote, StatusPill, changeStatus, pctOff, sendWithUndo } from "./common";

type Tab = "activas" | "inactivas";
type Sort = "hora" | "modelo";

/** Filtros rápidos: agrupan los estatus en pocas opciones y muestran el conteo de cada una. */
const QUICK: Record<Tab, { id: string; label: string; statuses: Status[] }[]> = {
  activas: [
    { id: "por_enviar", label: "Por enviar", statuses: ["pendiente", "guardada"] },
    { id: "enviadas", label: "Enviadas", statuses: ["enviada", "seguimiento"] },
    { id: "en_proceso", label: "En proceso", statuses: ["interesado", "inspeccion", "oferta_final"] },
    { id: "cerradas", label: "Cerradas", statuses: ["aceptada", "rechazada_cliente"] },
  ],
  inactivas: [
    { id: "descartada", label: "Rechazadas por valuador", statuses: ["descartada"] },
    { id: "incompleto", label: "Datos incompletos", statuses: ["incompleto"] },
    { id: "no_cumple", label: "No cumplen criterios", statuses: ["no_cumple"] },
  ],
};


/** Por qué una oferta no está activa: cada criterio que falló con su valor y la regla. */
function Reason({ o }: { o: Offer }) {
  if (o.status === "no_cumple") {
    return (
      <ul className="vfails">
        {o.criteria.filter((c) => !c.ok).map((c) => (
          <li key={c.id}><X size={13} aria-hidden="true" /><span><b>{c.label}:</b> {c.value} <em>({c.rule})</em></span></li>
        ))}
      </ul>
    );
  }
  if (o.status === "incompleto") return <span><b>Falta información:</b> {o.reason}</span>;
  return <span>Rechazada por el valuador</span>;
}

export function OfertasView({ mod }: { mod: ModuleDef }) {
  const router = useRouter();
  const href = useValuacionHref();
  const convHref = (o: Offer) => href(`/conversaciones/${o.id}`);
  const { offers, sending } = useValuacion();
  const today = todayIso();
  const yesterday = prevBusinessDay(today);
  const [tab, setTab] = useState<Tab>("activas");
  const [agency, setAgency] = useState("all");
  const [quick, setQuick] = useState<string>("all");
  const [date, setDate] = useState(today);
  const [sort, setSort] = useState<Sort>("hora");
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const ofDay = useMemo(
    () => offers.filter((o) => o.processedOn === date && (agency === "all" || o.agencyId === agency)),
    [offers, date, agency],
  );
  const inTab = ofDay.filter((o) => (tab === "activas") === isActive(o.status));
  const activeCount = ofDay.filter((o) => isActive(o.status)).length;
  const sendable = ofDay.filter((o) => SENDABLE.includes(o.status) && !sending.includes(o.id));
  const quickDef = QUICK[tab].find((x) => x.id === quick);
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return inTab
      .filter((o) => (!quickDef || quickDef.statuses.includes(o.status)) && (!term || `${o.customer} ${o.intelimotorModel} ${o.phone}`.toLowerCase().includes(term)))
      .sort((a, b) => (sort === "hora" ? a.apptTime.localeCompare(b.apptTime) : a.intelimotorModel.localeCompare(b.intelimotorModel)) || a.customer.localeCompare(b.customer));
  }, [inTab, quickDef, q, sort]);
  const filtered = quick !== "all" || q.trim() !== "";

  const changeTab = (t: Tab) => { setTab(t); setQuick("all"); setExpanded(null); };
  const toggle = (id: string) => setExpanded((e) => (e === id ? null : id));
  const clear = () => { setQuick("all"); setQ(""); };
  const reject = (o: Offer) => { setExpanded(null); changeStatus(o, "descartada", "Rechazada por el valuador"); };
  const resume = (o: Offer) => { setExpanded(null); changeStatus(o, "pendiente", "Retomada por el valuador"); };
  const sendAll = () => { sendWithUndo(sendable); setConfirm(false); };

  const RowMenu = ({ o }: { o: Offer }) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="icon-btn vmenu" aria-label={`Más acciones para ${o.customer}`} onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={() => toggle(o.id)}>{expanded === o.id ? "Ocultar ficha" : "Ver ficha"}</DropdownMenuItem>
        {o.sentAt && <DropdownMenuItem onSelect={() => router.push(convHref(o))}><MessageSquare />Abrir conversación</DropdownMenuItem>}
        {isActive(o.status) && !o.sentAt && <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onSelect={() => reject(o)}><X />Rechazar oferta</DropdownMenuItem></>}
        {o.status === "descartada" && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => resume(o)}><RotateCcw />Retomar oferta</DropdownMenuItem></>}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      <ProtoNote />
      <PageHead title="Ofertas" subtitle="Resultado del proceso de madrugada: una propuesta por cita" mod={mod} />
      <div className="toolbar">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" className="tab" aria-selected={tab === "activas"} onClick={() => changeTab("activas")}>Activas<span className="n">{activeCount}</span></button>
          <button type="button" role="tab" className="tab" aria-selected={tab === "inactivas"} onClick={() => changeTab("inactivas")}>No activas<span className="n">{ofDay.length - activeCount}</span></button>
        </div>
        {tab === "activas" && (
          <button type="button" className="btn primary" style={{ marginBottom: 6 }} disabled={!sendable.length} onClick={() => setConfirm(true)}>
            <Send size={14} />Enviar todas ({sendable.length})
          </button>
        )}
      </div>
      <div className="view">
        <div className="pad" style={{ maxWidth: 1240, gap: 14 }}>
          <div className="vfilters">
            <div className="vdate" role="group" aria-label="Fecha de proceso">
              <span className="vfl-l">Proceso del</span>
              <div className="vseg">
                <button type="button" aria-pressed={date === today} onClick={() => setDate(today)}>Hoy</button>
                <button type="button" aria-pressed={date === yesterday} onClick={() => setDate(yesterday)}>Ayer</button>
              </div>
              <input className="date" type="date" value={date} onChange={(e) => setDate(e.target.value || today)} aria-label="Otra fecha de proceso" />
            </div>
            <AgencySelect value={agency} onChange={setAgency} />
            <label className="search vsearch"><Search size={15} aria-hidden="true" /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar cliente o modelo" aria-label="Buscar ofertas por cliente o modelo" /></label>
            {tab === "activas" && (
              <select className="date" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Ordenar">
                <option value="hora">Por hora de cita</option>
                <option value="modelo">Por modelo</option>
              </select>
            )}
          </div>

          <div className="vchips" role="group" aria-label="Filtrar por estatus">
            <button type="button" className="vqchip" aria-pressed={quick === "all"} onClick={() => setQuick("all")}>Todas<b>{inTab.length}</b></button>
            {QUICK[tab].map((x) => (
              <button key={x.id} type="button" className="vqchip" aria-pressed={quick === x.id} onClick={() => setQuick(quick === x.id ? "all" : x.id)}>
                {x.label}<b>{inTab.filter((o) => x.statuses.includes(o.status)).length}</b>
              </button>
            ))}
          </div>

          <div className="card">
            <div className="tbl-wrap">
              {ofDay.length === 0 ? (
                <div className="empty">
                  <b style={{ color: "var(--fg)" }}>Sin ofertas para el {fmtDate(date)}</b><br />
                  El proceso de madrugada no generó ofertas para esta fecha{agency !== "all" && ` en ${agencyName(agency)}`}.
                  {date !== today && <><br /><button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => setDate(today)}>Ver las de hoy</button></>}
                </div>
              ) : rows.length === 0 ? (
                <div className="empty">
                  Ninguna oferta coincide con los filtros.
                  {filtered && <><br /><button type="button" className="btn" style={{ marginTop: 12 }} onClick={clear}>Limpiar filtros</button></>}
                </div>
              ) : (
                <table className="vtable">
                  <thead><tr>
                    <th aria-label="Desplegar" style={{ width: 36 }} />
                    <th>Cita</th><th>Cliente</th><th>Vehículo</th>
                    <th>{tab === "activas" ? "Oferta" : "Motivo"}</th><th>Estatus</th>
                    <th aria-label="Acciones" />
                  </tr></thead>
                  <tbody>
                    {rows.map((o) => {
                      const open = expanded === o.id;
                      const isSending = sending.includes(o.id);
                      return (
                        <Fragment key={o.id}>
                          <tr className={`vrow${open ? " open" : ""}`} onClick={() => toggle(o.id)}>
                            <td>
                              <button type="button" className="vchev" aria-expanded={open} aria-label={open ? "Ocultar ficha" : "Ver ficha"} onClick={(e) => { e.stopPropagation(); toggle(o.id); }}>
                                {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                              </button>
                            </td>
                            <td><b className="num">{o.apptTime}</b><small className="vsub">{fmtDate(o.apptDate)}</small></td>
                            <td><span className="vname">{o.customer}</span>{agency === "all" && <small className="vsub">{agencyName(o.agencyId)}</small>}</td>
                            <td><span className="vname">{o.intelimotorModel}</span><small className="vsub">{o.year} · {fmtKm(o.km)}</small></td>
                            {tab === "activas" ? (
                              <td>
                                {SENDABLE.includes(o.status)
                                  ? <InlineAmount offer={o} disabled={isSending} />
                                  : <><b className="num">{fmtMoney(o.amount)}</b><small className="vsub">Prom. {fmtMoney(o.market.avg)} · −{pctOff(o.amount, o.market.avg)}</small></>}
                              </td>
                            ) : <td className="vwrap"><Reason o={o} /></td>}
                            <td>{isSending ? <span className="pill bot">Enviando…</span> : <StatusPill status={o.status} />}</td>
                            <td>
                              <div className="vacts">
                                {SENDABLE.includes(o.status) && (
                                  <button type="button" className="btn" disabled={isSending} onClick={(e) => { e.stopPropagation(); sendWithUndo([o]); }}>
                                    <Send size={14} />{isSending ? "Enviando…" : "Enviar"}
                                  </button>
                                )}
                                {o.status === "descartada" && (
                                  <button type="button" className="btn" onClick={(e) => { e.stopPropagation(); resume(o); }}><RotateCcw size={14} />Retomar</button>
                                )}
                                <RowMenu o={o} />
                              </div>
                            </td>
                          </tr>
                          {open && (
                            <tr className="vexp"><td colSpan={7}><OfferDetail offer={o} conversationHref={convHref(o)} /></td></tr>
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

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Enviar {sendable.length} ofertas por WhatsApp?</AlertDialogTitle>
            <AlertDialogDescription>
              Se enviarán las ofertas pendientes y guardadas del proceso del {fmtDate(date)}
              {agency !== "all" && ` de ${agencyName(agency)}`}. Las rechazadas no se envían.
              Tendrás 5 segundos para deshacer el envío.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={sendAll}>Enviar {sendable.length} ofertas</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
