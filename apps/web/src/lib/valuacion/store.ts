/**
 * PROTOTIPO del módulo Valuación: datos inventados en memoria del navegador.
 *
 * Simula el resultado del cron de madrugada (citas → historial → criterios → precio de mercado)
 * y lo que el valuador hace después (guardar, enviar, rechazar, cambiar estatus, registrar la oferta final).
 * Los cambios viven solo en esta pestaña: al recargar se regeneran los mismos datos (semilla fija).
 * Cuando exista el backend, este archivo se sustituye por lecturas de Firestore con la misma forma.
 */
import { useSyncExternalStore } from "react";

// ---------- Catálogos ----------

export type Status =
  | "pendiente" | "guardada" | "enviada" | "seguimiento" | "interesado" | "inspeccion"
  | "oferta_final" | "aceptada" | "rechazada_cliente" | "descartada" | "incompleto" | "no_cumple";

/** Orden = recorrido normal de una oferta. `tone` es la clase de color de la píldora. */
export const STATUSES: { id: Status; label: string; tone: string; active: boolean }[] = [
  { id: "pendiente", label: "Pendiente de envío", tone: "closed", active: true },
  { id: "guardada", label: "Guardada", tone: "bot", active: true },
  { id: "enviada", label: "Enviada", tone: "bot", active: true },
  { id: "seguimiento", label: "Pendiente de seguimiento", tone: "wait", active: true },
  { id: "interesado", label: "Con interés (acepta inspección)", tone: "mod", active: true },
  { id: "inspeccion", label: "Inspección realizada", tone: "mod", active: true },
  { id: "oferta_final", label: "Oferta final registrada", tone: "mod", active: true },
  { id: "aceptada", label: "Oferta aceptada", tone: "agent", active: true },
  { id: "rechazada_cliente", label: "Rechazada por el cliente", tone: "crit", active: true },
  { id: "descartada", label: "Rechazada por valuador", tone: "crit", active: false },
  { id: "incompleto", label: "Datos incompletos", tone: "wait", active: false },
  { id: "no_cumple", label: "No cumple criterios", tone: "closed", active: false },
];
export const statusInfo = (s: Status) => STATUSES.find((x) => x.id === s)!;
/** Siguientes pasos lógicos de cada estatus (se muestran primero en el selector). */
export const NEXT_STATUS: Record<Status, Status[]> = {
  pendiente: ["guardada", "enviada", "descartada"],
  guardada: ["enviada", "descartada"],
  enviada: ["seguimiento", "interesado", "rechazada_cliente"],
  seguimiento: ["interesado", "rechazada_cliente"],
  interesado: ["inspeccion", "rechazada_cliente"],
  inspeccion: ["oferta_final", "rechazada_cliente"],
  oferta_final: ["aceptada", "rechazada_cliente"],
  aceptada: [],
  rechazada_cliente: ["interesado"],
  descartada: ["pendiente"],
  incompleto: ["pendiente"],
  no_cumple: ["pendiente"],
};
export const isActive = (s: Status) => statusInfo(s).active;
/** Se pueden enviar (individual o "Enviar todas"). */
export const SENDABLE: Status[] = ["pendiente", "guardada"];

export interface Agency { id: string; name: string }
export const AGENCIES: Agency[] = [
  { id: "fleteros", name: "Toyota Fleteros" },
  { id: "cumbres", name: "Toyota Cumbres" },
];
export const agencyName = (id: string) => AGENCIES.find((a) => a.id === id)?.name ?? id;

export const SERVICE_TYPES = [
  "Mantenimiento 10,000 km", "Mantenimiento 20,000 km", "Mantenimiento 30,000 km", "Mantenimiento 40,000 km",
  "Mantenimiento 50,000 km", "Mantenimiento 60,000 km", "Campaña de servicio", "Diagnóstico", "Garantía",
];

// ---------- Configuración por agencia ----------

export interface AgencyConfig {
  kmMin: number; kmMax: number;
  yearMin: number; yearMax: number;
  /** Al menos `servicesMin` mantenimientos en los últimos `servicesMonths` meses */
  servicesMin: number; servicesMonths: number;
  excludedModels: string[];
  minMarketListings: number;
  /** % que se descuenta al precio de venta promedio de mercado */
  pctSale: number;
  /** % que se descuenta al promedio entre venta y compra */
  pctSaleBuy: number;
  serviceTypes: string[];
  /** Meta: citas esperadas por día × % de ofertas a enviar */
  expectedAppointments: number;
  goalPct: number;
}

const DEFAULT_CONFIG: AgencyConfig = {
  kmMin: 0, kmMax: 100000, yearMin: 2020, yearMax: 2026,
  servicesMin: 3, servicesMonths: 24, excludedModels: ["Tundra", "Sequoia"],
  minMarketListings: 4, pctSale: 15, pctSaleBuy: 8,
  serviceTypes: SERVICE_TYPES.slice(0, 6), expectedAppointments: 40, goalPct: 30,
};

/** Ofertas que se espera enviar por día hábil. */
export const dailyGoal = (c: AgencyConfig) => Math.round((c.expectedAppointments * c.goalPct) / 100);

// ---------- Oferta ----------

export interface HistoryEntry { at: string; text: string }

export interface Offer {
  id: string;
  agencyId: string;
  /** Día en que la generó el cron */
  processedOn: string;
  apptDate: string;
  apptTime: string;
  serviceType: string;
  customer: string;
  phone: string;
  idv: number;
  plate: string;
  vin: string;
  quiterModel: string;
  intelimotorModel: string;
  year: number;
  km: number;
  transmission: string;
  color: string;
  services2y: number;
  lastService: string;
  market: { low: number; avg: number; high: number; listings: number };
  /** Monto ofrecido (editable por el valuador) */
  amount: number;
  finalAmount: number | null;
  status: Status;
  /** Motivo de que no sea activa (datos incompletos / criterio que falla) */
  reason: string | null;
  sentAt: string | null;
  interestAt: string | null;
  inspectedAt: string | null;
  finalAt: string | null;
  acceptedAt: string | null;
  history: HistoryEntry[];
  /** Evaluación de los criterios de selección hecha por el proceso de madrugada */
  criteria: CriterionResult[];
}

export interface CriterionResult {
  id: string;
  label: string;
  /** Valor de la unidad */
  value: string;
  /** Regla configurada para la agencia */
  rule: string;
  ok: boolean;
}

/** Evalúa una unidad contra los criterios de la agencia (lo mismo que hará el cron). */
export function evaluateCriteria(o: Offer, c: AgencyConfig): CriterionResult[] {
  const model = c.excludedModels.find((x) => o.intelimotorModel.toLowerCase().startsWith(x.toLowerCase()));
  return [
    { id: "km", label: "Kilometraje", value: fmtKm(o.km), rule: `entre ${fmtKm(c.kmMin)} y ${fmtKm(c.kmMax)}`, ok: o.km >= c.kmMin && o.km <= c.kmMax },
    { id: "year", label: "Año del modelo", value: String(o.year), rule: `entre ${c.yearMin} y ${c.yearMax}`, ok: o.year >= c.yearMin && o.year <= c.yearMax },
    { id: "services", label: "Mantenimientos", value: `${o.services2y} en ${c.servicesMonths} meses`, rule: `mínimo ${c.servicesMin}`, ok: o.services2y >= c.servicesMin },
    { id: "model", label: "Modelo", value: o.intelimotorModel.split(" ")[0], rule: model ? `${model} está en modelos a descartar` : "no está en modelos a descartar", ok: !model },
    { id: "listings", label: "Ofertas en el mercado", value: `${o.market.listings} publicaciones`, rule: `mínimo ${c.minMarketListings}`, ok: o.market.listings >= c.minMarketListings },
    { id: "service", label: "Tipo de servicio", value: o.serviceType, rule: c.serviceTypes.includes(o.serviceType) ? "incluido en la configuración" : "no incluido en la configuración", ok: c.serviceTypes.includes(o.serviceType) },
  ];
}

// ---------- Fechas (YYYY-MM-DD, hora local) ----------

export const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const parseIso = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const addDays = (s: string, n: number) => { const d = parseIso(s); d.setDate(d.getDate() + n); return iso(d); };
export const todayIso = () => iso(new Date());
export const monthStartIso = () => { const d = new Date(); d.setDate(1); return iso(d); };
export const monthEndIso = () => { const d = new Date(); d.setMonth(d.getMonth() + 1, 0); return iso(d); };
/** Día hábil anterior (salta domingo). */
export const prevBusinessDay = (s: string) => { let d = addDays(s, -1); if (isSunday(d)) d = addDays(d, -1); return d; };
const isSunday = (s: string) => parseIso(s).getDay() === 0;
/** Días hábiles (lunes a sábado) entre dos fechas, ambas incluidas. */
export function businessDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!isSunday(d)) out.push(d);
  return out;
}
export const fmtDate = (s: string) => parseIso(s).toLocaleDateString("es-MX", { day: "numeric", month: "short" });
export const fmtMoney = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
export const fmtKm = (n: number) => `${n.toLocaleString("es-MX")} km`;

// ---------- Generador (semilla fija) ----------

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODELS = [
  { q: "RAV4 LE", i: "RAV4 2.5 Le At", base: 560000, t: "AT" },
  { q: "CAMRY XLE NAVI HV", i: "Camry 2.5 Xle Hibrido At", base: 640000, t: "AT" },
  { q: "COROLLA LE CVT", i: "Corolla 2.0 Le Cvt", base: 380000, t: "CVT" },
  { q: "COROLLA CROSS XLE", i: "Corolla Cross 2.0 Xle Cvt", base: 470000, t: "CVT" },
  { q: "YARIS S HB CVT", i: "Yaris 1.5 S Hb Cvt", base: 280000, t: "CVT" },
  { q: "HILUX DC SR", i: "Hilux 2.7 Doble Cabina Sr Mt", base: 450000, t: "MT" },
  { q: "TACOMA TRD SPORT", i: "Tacoma 3.5 Trd Sport At", base: 720000, t: "AT" },
  { q: "SIENNA XLE HV", i: "Sienna 2.5 Xle Hibrido At", base: 820000, t: "AT" },
  { q: "PRIUS BASE HV", i: "Prius 1.8 Base Hibrido Cvt", base: 410000, t: "CVT" },
  { q: "AVANZA LE AT", i: "Avanza 1.5 Le At", base: 300000, t: "AT" },
  { q: "HIGHLANDER LIMITED", i: "Highlander 3.5 Limited At", base: 860000, t: "AT" },
  { q: "TUNDRA SR5", i: "Tundra 3.5 Sr5 At", base: 950000, t: "AT" },
];
const FIRST = ["Ernesto", "María", "José", "Ana", "Luis", "Gabriela", "Jorge", "Patricia", "Ricardo", "Sofía", "Fernando", "Daniela", "Héctor", "Lucía", "Raúl", "Verónica", "Arturo", "Claudia", "Miguel", "Andrea"];
const LAST = ["Cavazos", "Garza", "Treviño", "Martínez", "González", "Villarreal", "Rodríguez", "Salinas", "Elizondo", "Hernández", "Leal", "Flores", "Sepúlveda", "Cantú", "Guerra", "Zambrano"];
const COLORS = ["Plata", "Blanco", "Negro", "Gris", "Rojo", "Azul"];
const MISSING = ["Sin versión en Quiter", "Sin año modelo", "Sin IDV", "Sin teléfono del cliente"];

function generate(today: string): Offer[] {
  const r = rng(20261106);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const between = (a: number, b: number) => Math.round(a + r() * (b - a));
  const out: Offer[] = [];
  const thisYear = parseIso(today).getFullYear();

  for (let day = addDays(today, -45); day <= today; day = addDays(day, 1)) {
    if (isSunday(day)) continue;
    let appt = addDays(day, 1);
    if (isSunday(appt)) appt = addDays(appt, 1);
    const isToday = day === today;

    for (const ag of AGENCIES) {
      const n = between(10, 16);
      for (let k = 0; k < n; k++) {
        const m = pick(MODELS);
        const year = between(2018, thisYear);
        const km = Math.max(4000, between(8000, 22000) * (thisYear - year + 1) + between(-5000, 5000));
        const listings = between(2, 14);
        const depreciation = Math.pow(0.9, thisYear - year) * (1 - km / 900000);
        const avg = Math.round((m.base * depreciation) / 500) * 500;
        const services = between(1, 6);
        const hour = between(8, 17);
        const o: Offer = {
          id: `of-${ag.id}-${day}-${k}`,
          agencyId: ag.id, processedOn: day, apptDate: appt,
          apptTime: `${String(hour).padStart(2, "0")}:${r() < 0.5 ? "00" : "30"}`,
          serviceType: pick(SERVICE_TYPES.slice(0, 7)),
          customer: `${pick(FIRST)} ${pick(LAST)} ${pick(LAST)}`,
          phone: `+52 81 ${between(1000, 9999)} ${between(1000, 9999)}`,
          idv: between(1000000, 1999999), plate: `${String.fromCharCode(65 + between(0, 25))}${String.fromCharCode(65 + between(0, 25))}${String.fromCharCode(65 + between(0, 25))}${between(100, 999)}${String.fromCharCode(65 + between(0, 25))}`,
          vin: `2T3${Math.floor(r() * 1e14).toString(36).toUpperCase().padEnd(14, "X").slice(0, 14)}`,
          quiterModel: m.q, intelimotorModel: m.i, year, km, transmission: m.t, color: pick(COLORS),
          services2y: services, lastService: addDays(day, -between(60, 200)),
          market: { low: Math.round(avg * 0.95), avg, high: Math.round(avg * 1.05), listings },
          amount: Math.round((avg * 0.85) / 1000) * 1000, finalAmount: null,
          status: "pendiente", reason: null,
          sentAt: null, interestAt: null, inspectedAt: null, finalAt: null, acceptedAt: null,
          history: [{ at: `${day} 03:10`, text: "Generada por el proceso de madrugada" }],
          criteria: [],
        };

        // Filtros del cron: datos incompletos y criterios (se guarda la evaluación completa)
        o.criteria = evaluateCriteria(o, DEFAULT_CONFIG);
        if (r() < 0.07) { o.status = "incompleto"; o.reason = pick(MISSING); out.push(o); continue; }
        const failed = o.criteria.filter((c) => !c.ok);
        if (failed.length) { o.status = "no_cumple"; o.reason = failed.map((c) => `${c.label}: ${c.value} (${c.rule})`).join(" · "); out.push(o); continue; }

        const x = r();
        if (isToday) {
          if (x < 0.05) reject(o, day);
          else if (x < 0.55) { /* pendiente */ }
          else if (x < 0.65) { o.status = "guardada"; o.amount += 5000; o.history.push({ at: `${day} 09:05`, text: "Monto ajustado y guardada" }); }
          else { send(o, day); if (x > 0.88) interest(o, day); }
          out.push(o); continue;
        }
        if (x < 0.06) { reject(o, day); out.push(o); continue; }
        if (x < 0.1) { out.push(o); continue; } // se quedó sin enviar
        send(o, day);
        const y = r();
        if (y < 0.4) {
          interest(o, r() < 0.7 ? day : appt);
          if (appt <= today && r() < 0.82) {
            o.inspectedAt = appt; o.status = "inspeccion"; o.history.push({ at: `${appt} ${o.apptTime}`, text: "Inspección realizada en la cita" });
            if (r() < 0.85) {
              o.finalAmount = Math.round((o.amount * (0.94 + r() * 0.08)) / 1000) * 1000;
              o.finalAt = appt; o.status = "oferta_final";
              o.history.push({ at: `${appt} 13:40`, text: `Oferta final registrada: ${fmtMoney(o.finalAmount)}` });
              const z = r();
              if (z < 0.55) { o.acceptedAt = appt; o.status = "aceptada"; o.history.push({ at: `${appt} 16:20`, text: "El cliente aceptó la oferta final" }); }
              else if (z < 0.8) { o.status = "rechazada_cliente"; o.history.push({ at: `${appt} 16:20`, text: "El cliente rechazó la oferta final" }); }
            }
          }
        } else if (y < 0.65) {
          o.status = "rechazada_cliente"; o.history.push({ at: `${day} 19:12`, text: "El cliente respondió que no le interesa" });
        } else {
          o.status = "seguimiento";
        }
        out.push(o);
      }
    }
  }
  return out;

  function send(o: Offer, day: string) {
    o.sentAt = day; o.status = "enviada";
    o.history.push({ at: `${day} 10:${String(between(0, 59)).padStart(2, "0")}`, text: `Oferta enviada por WhatsApp: ${fmtMoney(o.amount)}` });
  }
  function interest(o: Offer, day: string) {
    o.interestAt = day; o.status = "interesado";
    o.history.push({ at: `${day} 18:${String(between(0, 59)).padStart(2, "0")}`, text: "El cliente aceptó la inspección" });
  }
  function reject(o: Offer, day: string) {
    o.status = "descartada"; o.history.push({ at: `${day} 09:30`, text: "Rechazada por el valuador" });
  }
}

// ---------- Almacén ----------

interface State { offers: Offer[]; config: Record<string, AgencyConfig>; sending: string[] }

let state: State | null = null;
const listeners = new Set<() => void>();

function get(): State {
  if (!state) {
    state = {
      offers: generate(todayIso()),
      config: Object.fromEntries(AGENCIES.map((a, i) => [a.id, { ...DEFAULT_CONFIG, expectedAppointments: i === 0 ? 40 : 32 }])),
      sending: [],
    };
  }
  return state;
}
function set(next: State) { state = next; listeners.forEach((l) => l()); }
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

export function useValuacion() {
  return useSyncExternalStore(subscribe, get, get);
}

const nowStamp = () => { const d = new Date(); return `${iso(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/** Fecha que se llena al pasar a cada estatus (solo si no existía). */
const STAMP: Partial<Record<Status, keyof Offer>> = {
  enviada: "sentAt", interesado: "interestAt", inspeccion: "inspectedAt", oferta_final: "finalAt", aceptada: "acceptedAt",
};

function patch(ids: string[], fn: (o: Offer) => Offer) {
  const s = get();
  const set_ = new Set(ids);
  set({ ...s, offers: s.offers.map((o) => (set_.has(o.id) ? fn(o) : o)) });
}

export function setStatus(id: string, status: Status, note?: string) {
  patch([id], (o) => {
    const n: Offer = { ...o, status, history: [...o.history, { at: nowStamp(), text: note ?? `Estatus cambiado a "${statusInfo(status).label}"` }] };
    const key = STAMP[status];
    if (key && !n[key]) (n as unknown as Record<string, unknown>)[key] = todayIso();
    return n;
  });
}

export function saveAmount(id: string, amount: number) {
  patch([id], (o) => ({
    ...o, amount, status: o.status === "pendiente" ? "guardada" : o.status,
    history: [...o.history, { at: nowStamp(), text: `Monto guardado: ${fmtMoney(amount)}` }],
  }));
}

export function sendOffers(ids: string[]) {
  const today = todayIso();
  patch(ids, (o) => ({
    ...o, status: "enviada", sentAt: today,
    history: [...o.history, { at: nowStamp(), text: `Oferta enviada por WhatsApp: ${fmtMoney(o.amount)}` }],
  }));
}

/** Segundos de gracia antes de que el envío sea real (para poder deshacer). */
export const SEND_DELAY_MS = 5000;

/** Pone las ofertas "en envío" y las envía al terminar el plazo. Devuelve la función para deshacer. */
export function queueSend(ids: string[]): () => void {
  const s = get();
  set({ ...s, sending: [...new Set([...s.sending, ...ids])] });
  const done = () => { const c = get(); set({ ...c, sending: c.sending.filter((x) => !ids.includes(x)) }); };
  const t = setTimeout(() => { sendOffers(ids); done(); }, SEND_DELAY_MS);
  return () => { clearTimeout(t); done(); };
}

/** Devuelve una oferta a una copia previa (deshacer un cambio). */
export function restoreOffer(prev: Offer) {
  patch([prev.id], () => prev);
}

export function registerFinal(id: string, amount: number) {
  patch([id], (o) => ({
    ...o, finalAmount: amount, finalAt: o.finalAt ?? todayIso(), inspectedAt: o.inspectedAt ?? todayIso(),
    status: o.status === "aceptada" ? "aceptada" : "oferta_final",
    history: [...o.history, { at: nowStamp(), text: `Oferta final registrada: ${fmtMoney(amount)}` }],
  }));
}

export function saveConfig(agencyId: string, cfg: AgencyConfig) {
  const s = get();
  set({ ...s, config: { ...s.config, [agencyId]: cfg } });
}

// ---------- Conversación (independiente del estatus de la oferta) ----------

/**
 * Estatus de la conversación de WhatsApp, con los mismos valores que en Ventas y Servicio.
 * Es distinto del estatus de la oferta: dice quién atiende el chat, no en qué etapa va la oferta.
 */
export type ConvStatus = "bot" | "waiting_agent" | "with_agent" | "closed";
export type ClosedReason = "resolved" | "not_interested" | "no_response";

export interface Conversation {
  status: ConvStatus;
  /** Valuador asignado (solo con agente) */
  agent: string | null;
  lastSender: "customer" | "bot" | "agent";
  closedReason: ClosedReason | null;
}

export const VALUADORES: Record<string, string[]> = {
  fleteros: ["Carlos Ibarra", "Mónica Reyes"],
  cumbres: ["Iván Saldaña", "Paola Quiroga"],
};

/** Número estable a partir del id, para que los datos inventados no cambien entre renders. */
const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };

/**
 * En el prototipo la conversación se deriva de la oferta: el bot envía la oferta y da
 * seguimiento; cuando el cliente dice que sí, pasa a un valuador; se cierra al terminar
 * la oferta o tras 4 días sin respuesta. En producción vendrá de la conversación real.
 */
export function conversationOf(o: Offer): Conversation | null {
  if (!o.sentAt) return null;
  const h = hash(o.id);
  const agents = VALUADORES[o.agencyId] ?? [];
  const agent = agents[h % agents.length] ?? null;
  const closed = (closedReason: ClosedReason): Conversation => ({ status: "closed", agent: null, lastSender: "bot", closedReason });
  switch (o.status) {
    case "aceptada": return closed("resolved");
    case "rechazada_cliente": return closed("not_interested");
    case "descartada": return closed("resolved");
    case "interesado":
      // Unas esperan que un valuador las tome; otras ya las tomó y el cliente espera respuesta
      return h % 3 === 0
        ? { status: "waiting_agent", agent: null, lastSender: "customer", closedReason: null }
        : { status: "with_agent", agent, lastSender: h % 2 ? "customer" : "agent", closedReason: null };
    case "inspeccion":
    case "oferta_final":
      return { status: "with_agent", agent, lastSender: h % 4 === 0 ? "customer" : "agent", closedReason: null };
    default: // enviada, seguimiento
      return o.sentAt < addDays(todayIso(), -4) ? closed("no_response") : { status: "bot", agent: null, lastSender: "bot", closedReason: null };
  }
}
