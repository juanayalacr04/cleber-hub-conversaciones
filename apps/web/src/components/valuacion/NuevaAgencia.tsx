"use client";

/**
 * Alta de una agencia de valuación (solo super admin): marca, nombre, id y taller de Quiter. Se guarda con
 * `guardaConfiguracion` PAUSADA y con criterios por omisión, para que el proceso de madrugada no la tome antes de
 * revisar sus criterios y activarla en la pantalla de Configuración.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { guardaConfiguracion } from "@/lib/valuacion/acciones";
import { SERVICE_TYPES } from "@/lib/valuacion/store";
import { mensajeError, type ConfiguracionAgencia } from "@/lib/valuacion/tipos";

/** "Toyota Cumbres" → "toyota-cumbres" */
const aId = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const anio = new Date().getFullYear();
/** Criterios con los que nace la agencia; se ajustan en Configuración antes de activarla. */
const CRITERIOS_INICIALES = {
  criterios: {
    minYear: anio - 6, maxYear: anio, minKm: 0, maxKm: 100000,
    minMantenimientos: 1, aniosHistorial: 2, minPublicaciones: 3,
    tiposServicio: SERVICE_TYPES.slice(0, 6),
  },
  montos: { pctDescuentoVenta: 15, pctDescuentoVentaCompra: 8 },
  meta: { citasEsperadasDia: 40, pctMetaEnvio: 30 },
};

export function NuevaAgencia({ open, onOpenChange, marcas, existentes, onCreada }: {
  open: boolean;
  /** Ids de agencia ya dados de alta: guardaConfiguracion es upsert y pisaría su configuración */
  existentes: string[];
  onOpenChange: (o: boolean) => void;
  marcas: { idMarca: string; nombre: string }[];
  onCreada: (a: ConfiguracionAgencia) => void;
}) {
  const [idMarca, setIdMarca] = useState("");
  const [nombre, setNombre] = useState("");
  const [idAgencia, setIdAgencia] = useState("");
  const [idTocado, setIdTocado] = useState(false);
  const [taller, setTaller] = useState("");
  const [error, setError] = useState<{ campo: string | null; mensaje: string } | null>(null);
  const [guardando, setGuardando] = useState(false);

  const reinicia = () => { setIdMarca(""); setNombre(""); setIdAgencia(""); setIdTocado(false); setTaller(""); setError(null); };
  const cambiaAbierto = (o: boolean) => { if (!o) reinicia(); onOpenChange(o); };

  const listo = idMarca && nombre.trim() && idAgencia.trim() && taller.trim();

  const crea = async () => {
    if (!listo) return;
    if (existentes.includes(idAgencia.trim())) {
      setError({ campo: "idAgencia", mensaje: "Ya existe una agencia con ese id" });
      return;
    }
    setGuardando(true);
    setError(null);
    const r = await guardaConfiguracion({
      idAgencia: idAgencia.trim(), idTallerQuiter: taller.trim(), nombreAgencia: nombre.trim(), idMarca,
      esActivo: false, ...CRITERIOS_INICIALES,
    });
    setGuardando(false);
    if (r.successful) { onCreada(r.info); cambiaAbierto(false); return; }
    const campo = (r.info as { campo?: string } | undefined)?.campo ?? null;
    setError({ campo, mensaje: campo ? r.errorMessage : mensajeError(r) });
  };

  const err = (campo: string) => (error?.campo === campo ? <small className="verr" role="alert">{error.mensaje}</small> : null);

  return (
    <Dialog open={open} onOpenChange={cambiaAbierto}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nueva agencia</DialogTitle>
          <DialogDescription>
            Se crea pausada y con criterios por omisión: revísalos y activa la agencia para que entre al proceso de madrugada.
          </DialogDescription>
        </DialogHeader>
        <form className="vnueva" onSubmit={(e) => { e.preventDefault(); crea(); }}>
          <label className="vfl-l" htmlFor="na-marca">Marca</label>
          <select id="na-marca" className="date" value={idMarca} onChange={(e) => setIdMarca(e.target.value)}>
            <option value="" disabled>Elige la marca</option>
            {marcas.map((m) => <option key={m.idMarca} value={m.idMarca}>{m.nombre}</option>)}
          </select>
          {marcas.length === 0 && <small className="vhint">No hay marcas activas. Créala primero en Marcas.</small>}
          {err("idMarca")}

          <label className="vfl-l" htmlFor="na-nombre">Nombre de la agencia</label>
          <input
            id="na-nombre" className="date" value={nombre} placeholder="Ej. Toyota Cumbres"
            onChange={(e) => { setNombre(e.target.value); if (!idTocado) setIdAgencia(aId(e.target.value)); }}
          />
          {err("nombreAgencia")}

          <label className="vfl-l" htmlFor="na-id">Id de la agencia</label>
          <input id="na-id" className="date num" value={idAgencia} onChange={(e) => { setIdTocado(true); setIdAgencia(e.target.value); }} placeholder="toyota-cumbres" />
          <small className="vhint">Lo guardan las ofertas y las agencias de cada usuario; no se cambia después.</small>
          {err("idAgencia")}

          <label className="vfl-l" htmlFor="na-taller">Taller de Quiter</label>
          <input id="na-taller" className="date num" value={taller} onChange={(e) => setTaller(e.target.value)} placeholder="workshopId de Quiter" />
          {err("idTallerQuiter")}

          {error && !error.campo && <small className="verr" role="alert">{error.mensaje}</small>}

          <div className="vnueva-acts">
            <button type="button" className="btn" onClick={() => cambiaAbierto(false)}>Cancelar</button>
            <button type="submit" className="btn primary" disabled={!listo || guardando}>
              {guardando && <Loader2 size={14} className="animate-spin" />}Crear agencia
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
