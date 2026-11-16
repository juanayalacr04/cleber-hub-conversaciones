"use client";

import { useMemo, useRef, useState, type DragEvent } from "react";
import { FileSpreadsheet, Loader2, RotateCcw, Search, Upload } from "lucide-react";
import { toast } from "sonner";
import { PageHead } from "@/components/shell/Shell";
import { Icon } from "@/components/shell/icons";
import type { ModuleDef } from "@/lib/modules";
import { AGENCIES, agencyName, fmtMoney } from "@/lib/valuacion/store";
import { AgencySelect } from "./common";

/**
 * Carga de la cartera de vehículos financiados de la marca (solo demo).
 * El archivo no se lee: cualquier archivo que se elija muestra la misma cartera simulada.
 */

type Estatus = "corriente" | "por_liquidar" | "atraso";

interface Financiado {
  contrato: string;
  cliente: string;
  modelo: string;
  anio: number;
  vin: string;
  agencyId: string;
  plazo: number;
  pagados: number;
  mensualidad: number;
  saldo: number;
  termina: string; // AAAA-MM
  estatus: Estatus;
}

const ESTATUS: Record<Estatus, { label: string; tone: string }> = {
  corriente: { label: "Al corriente", tone: "agent" },
  por_liquidar: { label: "Por liquidar", tone: "mod" },
  atraso: { label: "Con atraso", tone: "crit" },
};

const [A, B] = AGENCIES.map((a) => a.id);

// Cartera simulada: la misma sin importar el archivo
const CARTERA: Financiado[] = [
  { contrato: "TFS-24-018734", cliente: "María Fernanda López Garza", modelo: "Corolla SE", anio: 2023, vin: "JTDBCMFE3PJ018734", agencyId: A, plazo: 48, pagados: 44, mensualidad: 9850, saldo: 38420, termina: "2027-03", estatus: "por_liquidar" },
  { contrato: "TFS-23-009215", cliente: "José Luis Treviño Salinas", modelo: "RAV4 XLE", anio: 2022, vin: "2T3W1RFV8NW009215", agencyId: B, plazo: 48, pagados: 46, mensualidad: 13420, saldo: 26180, termina: "2027-01", estatus: "por_liquidar" },
  { contrato: "TFS-25-031102", cliente: "Ana Sofía Cantú Elizondo", modelo: "Hilux Doble Cabina", anio: 2024, vin: "MR0EX8DD5R0031102", agencyId: A, plazo: 60, pagados: 18, mensualidad: 11960, saldo: 486300, termina: "2029-05", estatus: "corriente" },
  { contrato: "TFS-24-022478", cliente: "Roberto Garza Villarreal", modelo: "Camry XSE", anio: 2023, vin: "4T1K61AK2PU022478", agencyId: B, plazo: 36, pagados: 31, mensualidad: 16780, saldo: 82100, termina: "2027-04", estatus: "por_liquidar" },
  { contrato: "TFS-25-040917", cliente: "Daniela Martínez Rodríguez", modelo: "Yaris Sedán", anio: 2024, vin: "MR2B29F35R1040917", agencyId: A, plazo: 48, pagados: 12, mensualidad: 6890, saldo: 238450, termina: "2028-11", estatus: "corriente" },
  { contrato: "TFS-24-027663", cliente: "Carlos Alberto Ramírez Leal", modelo: "Tacoma TRD Sport", anio: 2023, vin: "3TYCZ5AN1PT027663", agencyId: B, plazo: 60, pagados: 27, mensualidad: 15240, saldo: 456900, termina: "2028-08", estatus: "atraso" },
  { contrato: "TFS-23-011846", cliente: "Patricia Hernández Cavazos", modelo: "Highlander Hybrid", anio: 2022, vin: "5TDABRCH3NS011846", agencyId: A, plazo: 48, pagados: 45, mensualidad: 18950, saldo: 55730, termina: "2027-02", estatus: "por_liquidar" },
  { contrato: "TFS-25-036520", cliente: "Luis Eduardo González Sáenz", modelo: "Corolla Cross Hybrid", anio: 2024, vin: "7MUFBABG2RV036520", agencyId: B, plazo: 48, pagados: 15, mensualidad: 10630, saldo: 342600, termina: "2028-08", estatus: "corriente" },
  { contrato: "TFS-24-019958", cliente: "Gabriela Montemayor Ríos", modelo: "Sienna XLE", anio: 2023, vin: "5TDYRKEC6PS019958", agencyId: A, plazo: 60, pagados: 30, mensualidad: 17310, saldo: 470800, termina: "2028-05", estatus: "corriente" },
  { contrato: "TFS-23-006384", cliente: "Jorge Arturo Flores Medina", modelo: "Avanza LE", anio: 2022, vin: "MHKMF53F7NK006384", agencyId: B, plazo: 36, pagados: 33, mensualidad: 7420, saldo: 21980, termina: "2027-02", estatus: "por_liquidar" },
  { contrato: "TFS-25-044071", cliente: "Mariana Sepúlveda Castillo", modelo: "Prius Hybrid", anio: 2025, vin: "JTDACAAU5S3044071", agencyId: A, plazo: 48, pagados: 6, mensualidad: 12480, saldo: 497200, termina: "2029-05", estatus: "corriente" },
  { contrato: "TFS-24-025190", cliente: "Héctor Javier Benavides Ochoa", modelo: "Hilux Chasis", anio: 2023, vin: "MR0CA3CD1P0025190", agencyId: B, plazo: 48, pagados: 25, mensualidad: 8970, saldo: 198700, termina: "2028-10", estatus: "atraso" },
  { contrato: "TFS-24-021337", cliente: "Lorena Guadalupe Pérez Tijerina", modelo: "RAV4 Hybrid Limited", anio: 2023, vin: "4T3D6RFV9PU021337", agencyId: A, plazo: 36, pagados: 32, mensualidad: 19860, saldo: 78900, termina: "2027-03", estatus: "por_liquidar" },
  { contrato: "TFS-25-038805", cliente: "Ricardo Villanueva Zambrano", modelo: "Tundra Limited", anio: 2024, vin: "5TFJA5DB4RX038805", agencyId: B, plazo: 60, pagados: 14, mensualidad: 24350, saldo: 1068500, termina: "2029-09", estatus: "corriente" },
  { contrato: "TFS-24-016622", cliente: "Verónica Alejandra Salazar Peña", modelo: "Corolla LE", anio: 2023, vin: "JTDBCMFE6PJ016622", agencyId: A, plazo: 48, pagados: 34, mensualidad: 8940, saldo: 121400, termina: "2027-12", estatus: "corriente" },
  { contrato: "TFS-23-008751", cliente: "Fernando Guerra Aguirre", modelo: "4Runner TRD Off-Road", anio: 2022, vin: "JTENU5JR5N5008751", agencyId: B, plazo: 48, pagados: 47, mensualidad: 17650, saldo: 17650, termina: "2026-12", estatus: "por_liquidar" },
  { contrato: "TFS-25-042259", cliente: "Claudia Ivonne Rangel Moreno", modelo: "Raize", anio: 2025, vin: "MHKAB1BY4SJ042259", agencyId: A, plazo: 36, pagados: 8, mensualidad: 9230, saldo: 254800, termina: "2028-11", estatus: "atraso" },
  { contrato: "TFS-24-029904", cliente: "Eduardo Saldaña Quintanilla", modelo: "Camry Hybrid", anio: 2024, vin: "4T1G31AK7RU029904", agencyId: B, plazo: 48, pagados: 22, mensualidad: 14960, saldo: 381200, termina: "2028-10", estatus: "corriente" },
];

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const fmtMes = (s: string) => { const [y, m] = s.split("-"); return `${MESES[Number(m) - 1]} ${y}`; };
const fmtSize = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

type Archivo = { nombre: string; tamano: number };

export function FinanciamientoView({ mod }: { mod: ModuleDef }) {
  const input = useRef<HTMLInputElement>(null);
  const [archivo, setArchivo] = useState<Archivo | null>(null);
  const [procesando, setProcesando] = useState(false);
  const [arrastrando, setArrastrando] = useState(false);
  const [agency, setAgency] = useState("all");
  const [filtro, setFiltro] = useState<Estatus | "all">("all");
  const [q, setQ] = useState("");

  const cargar = (f: File | undefined) => {
    if (!f) return;
    setProcesando(true);
    setArchivo(null);
    setTimeout(() => {
      setArchivo({ nombre: f.name, tamano: f.size });
      setProcesando(false);
      toast.success(`${CARTERA.length} vehículos cargados de ${f.name}`);
    }, 1400);
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setArrastrando(false); cargar(e.dataTransfer.files?.[0]); };
  const reiniciar = () => { setArchivo(null); setFiltro("all"); setQ(""); setAgency("all"); if (input.current) input.current.value = ""; };

  const deAgencia = useMemo(() => CARTERA.filter((r) => agency === "all" || r.agencyId === agency), [agency]);
  const filas = useMemo(() => {
    const t = q.trim().toLowerCase();
    return deAgencia.filter((r) => (filtro === "all" || r.estatus === filtro)
      && (!t || `${r.cliente} ${r.modelo} ${r.contrato} ${r.vin}`.toLowerCase().includes(t)));
  }, [deAgencia, filtro, q]);

  const m = useMemo(() => {
    const porLiquidar = deAgencia.filter((r) => r.estatus === "por_liquidar");
    return {
      total: deAgencia.length,
      saldo: deAgencia.reduce((s, r) => s + r.saldo, 0),
      porLiquidar: porLiquidar.length,
      atraso: deAgencia.filter((r) => r.estatus === "atraso").length,
    };
  }, [deAgencia]);

  const fileInput = (
    <input
      ref={input} type="file" hidden accept=".xlsx,.xls,.csv"
      onChange={(e) => cargar(e.target.files?.[0])}
    />
  );

  if (!archivo) {
    return (
      <>
        <PageHead title="Financiamiento" subtitle="Cartera de vehículos financiados de la marca" mod={mod} />
        <div className="view">
          <div className="pad" style={{ maxWidth: 820 }}>
            <div
              className={`card vdrop${arrastrando ? " over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setArrastrando(true); }}
              onDragLeave={() => setArrastrando(false)}
              onDrop={onDrop}
            >
              {fileInput}
              {procesando ? (
                <>
                  <Loader2 className="vdrop-i spin" size={36} aria-hidden="true" />
                  <b>Procesando archivo…</b>
                  <p>Leyendo contratos y cruzando con el inventario de vehículos.</p>
                </>
              ) : (
                <>
                  <FileSpreadsheet className="vdrop-i" size={36} aria-hidden="true" />
                  <b>Arrastra aquí el archivo de vehículos financiados</b>
                  <p>Excel (.xlsx, .xls) o CSV con la cartera que envía la financiera de la marca.</p>
                  <button type="button" className="btn primary" onClick={() => input.current?.click()}>
                    <Upload size={14} />Seleccionar archivo
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead title="Financiamiento" subtitle="Cartera de vehículos financiados de la marca" mod={mod} />
      <div className="view">
        <div className="pad" style={{ gap: 16 }}>
          <div className="card vfile">
            <FileSpreadsheet size={20} aria-hidden="true" />
            <span className="grow"><b>{archivo.nombre}</b><small className="vsub">{fmtSize(archivo.tamano)} · {CARTERA.length} contratos leídos</small></span>
            {fileInput}
            <button type="button" className="btn" onClick={() => input.current?.click()}><Upload size={14} />Cargar otro</button>
            <button type="button" className="btn" onClick={reiniciar}><RotateCcw size={14} />Quitar</button>
          </div>

          <div className="grid4">
            <Stat icon="bank" label="Vehículos financiados" value={String(m.total)} />
            <Stat icon="offer" label="Saldo total por pagar" value={fmtMoney(m.saldo)} />
            <Stat icon="clock" label="Por liquidar (≤ 6 meses)" value={String(m.porLiquidar)} hint="Candidatos a oferta de compra" />
            <Stat icon="bell" label="Con atraso" value={String(m.atraso)} hot={m.atraso > 0} />
          </div>

          <div className="vfilters">
            <AgencySelect value={agency} onChange={setAgency} />
            <label className="search vsearch"><Search size={15} aria-hidden="true" /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar cliente, modelo, contrato o VIN" aria-label="Buscar en la cartera" /></label>
          </div>
          <div className="vchips" role="group" aria-label="Filtrar por estatus">
            <button type="button" className="vqchip" aria-pressed={filtro === "all"} onClick={() => setFiltro("all")}>Todos<b>{deAgencia.length}</b></button>
            {(Object.keys(ESTATUS) as Estatus[]).map((e) => (
              <button key={e} type="button" className="vqchip" aria-pressed={filtro === e} onClick={() => setFiltro(filtro === e ? "all" : e)}>
                {ESTATUS[e].label}<b>{deAgencia.filter((r) => r.estatus === e).length}</b>
              </button>
            ))}
          </div>

          <div className="card">
            <div className="tbl-wrap">
              {filas.length === 0 ? (
                <div className="empty">Ningún contrato coincide con los filtros.</div>
              ) : (
                <table className="vtable">
                  <thead><tr>
                    <th>Contrato</th><th>Cliente</th><th>Vehículo</th><th>Pagos</th>
                    <th>Mensualidad</th><th>Saldo</th><th>Termina</th><th>Estatus</th>
                  </tr></thead>
                  <tbody>
                    {filas.map((r) => (
                      <tr key={r.contrato}>
                        <td><b className="num">{r.contrato}</b><small className="vsub">{agencyName(r.agencyId)}</small></td>
                        <td><span className="vname">{r.cliente}</span></td>
                        <td><span className="vname">{r.modelo} {r.anio}</span><small className="vsub num">{r.vin}</small></td>
                        <td>
                          <span className="num">{r.pagados} / {r.plazo}</span>
                          <div className="vprog" aria-hidden="true"><i style={{ width: `${(r.pagados / r.plazo) * 100}%` }} /></div>
                        </td>
                        <td className="num">{fmtMoney(r.mensualidad)}</td>
                        <td><b className="num">{fmtMoney(r.saldo)}</b></td>
                        <td className="num">{fmtMes(r.termina)}</td>
                        <td><span className={`pill ${ESTATUS[r.estatus].tone}`}>{ESTATUS[r.estatus].label}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({ icon, label, value, hint, hot }: { icon: string; label: string; value: string; hint?: string; hot?: boolean }) {
  return (
    <div className={`card stat${hot ? " hot" : ""}`}>
      <Icon name={icon} className="big" />
      <div className="top">{label}<span className="chipi"><Icon name={icon} /></span></div>
      <strong className="num">{value}</strong>
      {hint && <em>{hint}</em>}
    </div>
  );
}
