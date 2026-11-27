"use client";

/**
 * Alta de una agencia de valuación (solo super admin): se elige del catálogo de Cleber de la marca de la pantalla
 * (lib/hub/agencias.ts). Del catálogo salen el id (que también es el taller de Quiter), el nombre y la marca; no se
 * capturan. Se guarda con `guardaConfiguracion` PAUSADA y con criterios por omisión, para que el proceso de madrugada
 * no la tome antes de revisar sus criterios y activarla.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { consultaAgenciasMarca, type AgenciaCatalogo } from "@/lib/hub/agencias";
import { guardaConfiguracion } from "@/lib/valuacion/acciones";
import { SERVICE_TYPES } from "@/lib/valuacion/store";
import { mensajeError } from "@/lib/hub/errores";
import { type ConfiguracionAgencia } from "@/lib/valuacion/tipos";

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

const lugar = (a: AgenciaCatalogo) => [a.municipio, a.estado].filter(Boolean).join(", ");

export function NuevaAgencia({ open, onOpenChange, existentes, onCreada }: {
  open: boolean;
  /** Ids de agencia ya dados de alta: guardaConfiguracion es upsert y pisaría su configuración */
  existentes: string[];
  onOpenChange: (o: boolean) => void;
  onCreada: (a: ConfiguracionAgencia) => void;
}) {
  const { userData } = useAuth();
  const idMarca = userData?.organizationId ?? "";
  const [catalogo, setCatalogo] = useState<AgenciaCatalogo[] | null>(null);
  const [errorCatalogo, setErrorCatalogo] = useState<string | null>(null);
  const [idAgencia, setIdAgencia] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  // Catálogo de la marca al abrir (y si cambia la marca)
  useEffect(() => {
    if (!open || !idMarca) return;
    let vivo = true;
    setCatalogo(null);
    setErrorCatalogo(null);
    consultaAgenciasMarca(idMarca)
      .then((r) => {
        if (!vivo) return;
        if (r.successful) setCatalogo(r.info.agencias);
        else setErrorCatalogo(r.errorMessage || "No se pudo cargar el catálogo de agencias");
      })
      .catch(() => vivo && setErrorCatalogo("No se pudo cargar el catálogo de agencias"));
    return () => { vivo = false; };
  }, [open, idMarca]);

  const cambiaAbierto = (o: boolean) => { if (!o) { setIdAgencia(""); setError(null); } onOpenChange(o); };

  const disponibles = (catalogo ?? []).filter((a) => !existentes.includes(a.idAgencia));
  const elegida = disponibles.find((a) => a.idAgencia === idAgencia) ?? null;

  const crea = async () => {
    if (!elegida || !idMarca) return;
    setGuardando(true);
    setError(null);
    const r = await guardaConfiguracion({
      idAgencia: elegida.idAgencia, idTallerQuiter: elegida.idAgencia, nombreAgencia: elegida.nombre, idMarca,
      esActivo: false, ...CRITERIOS_INICIALES,
    });
    setGuardando(false);
    if (r.successful) { onCreada(r.info); cambiaAbierto(false); return; }
    setError((r.info as { campo?: string } | undefined)?.campo ? r.errorMessage : mensajeError(r));
  };

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
          <label className="vfl-l" htmlFor="na-agencia">Agencia</label>
          <select id="na-agencia" className="date" value={idAgencia} onChange={(e) => { setIdAgencia(e.target.value); setError(null); }} disabled={!catalogo}>
            <option value="" disabled>{catalogo ? "Elige la agencia" : errorCatalogo ? "Sin catálogo" : "Cargando catálogo…"}</option>
            {disponibles.map((a) => (
              <option key={a.idAgencia} value={a.idAgencia}>{a.idAgencia} · {a.nombre}{lugar(a) ? ` — ${lugar(a)}` : ""}</option>
            ))}
          </select>
          {errorCatalogo && <small className="verr" role="alert">{errorCatalogo}</small>}
          {catalogo && disponibles.length === 0 && (
            <small className="vhint">{catalogo.length ? "Todas las agencias de la marca ya están dadas de alta." : "El catálogo no tiene agencias para esta marca."}</small>
          )}
          {error && <small className="verr" role="alert">{error}</small>}

          <div className="vnueva-acts">
            <button type="button" className="btn" onClick={() => cambiaAbierto(false)}>Cancelar</button>
            <button type="submit" className="btn primary" disabled={!elegida || guardando}>
              {guardando && <Loader2 size={14} className="animate-spin" />}Crear agencia
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
