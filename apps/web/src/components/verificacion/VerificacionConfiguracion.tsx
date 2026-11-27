"use client";

/**
 * Configuración del módulo de Verificación: los datos de la marca activa y la simulación del callback a Salesforce.
 * El check es `marcas.simular_callback_sf` y se guarda con Hub.guardaMarca (solo super admin, como el alta de marcas);
 * con él encendido el hub no llama a Salesforce y el intento queda marcado como simulado.
 */

import { useCallback, useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { PageHead } from "@/components/shell/Shell";
import { useAuth } from "@/contexts/AuthContext";
import type { ModuleDef } from "@/lib/modules";
import { consultaMarcas, guardaMarca, type Marca } from "@/lib/hub/marcas";
import { mensajeError } from "@/lib/hub/errores";

export function VerificacionConfiguracion({ mod }: { mod: ModuleDef }) {
  const { userData, refreshOrganizations } = useAuth();
  const idMarca = userData?.organizationId ?? null;
  const puedeEditar = !!userData?.isSuperAdmin;
  const [marca, setMarca] = useState<Marca | null>(null);
  const [simular, setSimular] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [guardando, setGuardando] = useState(false);

  const carga = useCallback(async () => {
    if (!idMarca || !puedeEditar) return;
    setCargando(true);
    setError(null);
    const r = await consultaMarcas();
    setCargando(false);
    if (!r.successful) {
      if (r.errorCode === "SESION_EXPIRADA") { toast.error(mensajeError(r, "Verificación")); signOut({ redirectTo: "/login" }); return; }
      setMarca(null);
      setError(mensajeError(r, "Verificación"));
      return;
    }
    const m = r.info.marcas.find((x) => x.idMarca === idMarca) ?? null;
    setMarca(m);
    setSimular(!!m?.simularCallbackSf);
    if (!m) setError(`La marca ${idMarca} no existe en el hub`);
  }, [idMarca, puedeEditar]);

  useEffect(() => { setMarca(null); carga(); }, [carga]);

  const guarda = async () => {
    if (!idMarca || !marca) return;
    setGuardando(true);
    try {
      const r = await guardaMarca({ idMarca, simularCallbackSf: simular });
      if (!r.successful) {
        if (r.errorCode === "SESION_EXPIRADA") { toast.error(mensajeError(r, "Verificación")); signOut({ redirectTo: "/login" }); return; }
        toast.error(r.errorMessage || "No se pudo guardar la configuración");
        return;
      }
      setMarca(r.info.marca);
      setSimular(!!r.info.marca.simularCallbackSf);
      refreshOrganizations();
      toast.success("Configuración guardada");
    } catch (e) {
      console.error(e);
      toast.error(e instanceof Error ? e.message : "No se pudo guardar. Revisa tus permisos.");
    } finally {
      setGuardando(false);
    }
  };

  const cambios = !!marca && simular !== !!marca.simularCallbackSf;

  // Hub.consultaMarcas y Hub.guardaMarca son de super admin (como la pantalla Marcas)
  if (!puedeEditar) {
    return <p className="text-muted-foreground">Solo un superadministrador puede ver la configuración de la marca.</p>;
  }

  return (
    <>
      <PageHead title="Configuración" subtitle="Datos de la marca y entrega del resultado a Salesforce" mod={mod} />
      <div className="view">
        <div className="pad" style={{ maxWidth: 900 }}>
          {error ? (
            <div className="card">
              <div className="empty">
                <p>{error}</p>
                <button type="button" className="btn" onClick={carga} disabled={cargando}>Reintentar</button>
              </div>
            </div>
          ) : !marca ? (
            <div className="empty"><Loader2 size={20} className="ospin" aria-hidden="true" /><span className="vsub">Cargando...</span></div>
          ) : (
            <>
              {simular && (
                <div className="vwarn" role="status">
                  Simulación activa: el hub no llama a Salesforce y marca cada callback como enviado simulado. Úsalo solo en pruebas y apágalo en producción.
                </div>
              )}

              <div className="card">
                <div className="card-h"><h2>Marca</h2><span className="sub">{marca.idMarca}</span></div>
                <div className="info">
                  <dl className="dl">
                    <dt>Nombre</dt><dd>{marca.nombre}</dd>
                    <dt>Código</dt><dd className="mono">{marca.idMarca}</dd>
                    <dt>Estado</dt><dd><span className={`pill ${marca.esActiva ? "agent" : "closed"}`}>{marca.esActiva ? "Activa" : "Inactiva"}</span></dd>
                    <dt>ID en Salesforce</dt><dd className="mono">{marca.idSalesforce ?? "—"}</dd>
                  </dl>
                </div>
              </div>

              <div className="card">
                <div className="card-h"><h2>Callback a Salesforce</h2></div>
                <div className="info">
                  <label className="flex items-start gap-3 text-sm">
                    <input
                      type="checkbox" className="mt-1" checked={simular} disabled={guardando}
                      onChange={(e) => setSimular(e.target.checked)}
                    />
                    <span>
                      <span className="font-medium">Simular la entrega del resultado a Salesforce</span>
                      <span className="block text-xs text-muted-foreground">
                        Con el check activo el hub no llama a Salesforce y marca el callback como enviado simulado. Solo para pruebas: apágalo en producción.
                      </span>
                    </span>
                  </label>
                  <div className="sect">
                    <span className="spacer" />
                    <button type="button" className="btn primary" onClick={guarda} disabled={!cambios || guardando}>
                      {guardando && <Loader2 size={14} className="ospin" aria-hidden="true" />}Guardar cambios
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
