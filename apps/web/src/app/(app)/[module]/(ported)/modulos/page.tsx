"use client";

/**
 * Módulos activos por marca (hub_cleber.marcas_modulos), solo super admin.
 *
 * Solo se enciende o apaga: la lista de módulos que existen está en el código (lib/modules.ts) y no se agrega desde aquí.
 * El selector de módulos de la barra lateral muestra únicamente los activos de la marca.
 */

import { useCallback, useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { consultaModulosMarca, guardaModuloMarca, type ModulosDeMarca } from "@/lib/hub/marcas";
import { MODULES } from "@/lib/modules";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function ModulosPage() {
  const { userData, refreshOrganizations } = useAuth();
  const [marcas, setMarcas] = useState<ModulosDeMarca[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState<string | null>(null);

  const carga = useCallback(async () => {
    setError(null);
    const r = await consultaModulosMarca();
    if (r.successful) { setMarcas(r.info.marcas); return; }
    if (r.errorCode === "SESION_EXPIRADA") { signOut({ redirectTo: "/login" }); return; }
    setError(r.errorMessage || "No se pudieron cargar los módulos");
  }, []);

  useEffect(() => { carga(); }, [carga]);

  const cambia = async (idMarca: string, modulo: string, esActivo: boolean) => {
    const clave = `${idMarca}/${modulo}`;
    setGuardando(clave);
    const r = await guardaModuloMarca({ idMarca, modulo, esActivo });
    setGuardando(null);
    if (r.successful) {
      setMarcas((ms) => ms && ms.map((m) => m.idMarca !== idMarca ? m : {
        ...m,
        modulos: [...m.modulos.filter((x) => x.modulo !== modulo), { modulo, esActivo }],
      }));
      refreshOrganizations();
      return;
    }
    if (r.errorCode === "SESION_EXPIRADA") { signOut({ redirectTo: "/login" }); return; }
    toast.error(r.errorMessage || "No se pudo guardar el módulo");
  };

  if (!userData?.isSuperAdmin) {
    return <p className="text-muted-foreground">Solo un superadministrador administra los módulos de cada marca.</p>;
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Módulos</h1>
        <p className="text-sm text-muted-foreground">
          Activa o desactiva los módulos de cada marca. Un módulo desactivado deja de aparecer en el selector de módulos de la marca; no se borra su información.
        </p>
      </div>

      {error ? (
        <Card><CardContent className="py-8 text-center space-y-3">
          <p className="font-medium">No se pudieron cargar los módulos</p>
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" onClick={carga}>Reintentar</Button>
        </CardContent></Card>
      ) : !marcas ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : marcas.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Aún no hay marcas.</CardContent></Card>
      ) : (
        <div className="grid gap-3">
          {marcas.map((m) => (
            <Card key={m.idMarca} className={m.esActiva ? undefined : "opacity-60"}>
              <CardContent className="py-4 space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold">{m.nombre}</h3>
                  <Badge variant="outline" className="text-xs font-mono">{m.idMarca}</Badge>
                  {!m.esActiva && <Badge variant="outline" className="text-xs">Inactiva</Badge>}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {MODULES.map((mod) => {
                    const activo = m.modulos.some((x) => x.modulo === mod.id && x.esActivo);
                    const clave = `${m.idMarca}/${mod.id}`;
                    return (
                      <label key={mod.id} className="flex items-start gap-2 text-sm">
                        <input
                          type="checkbox" className="mt-1" checked={activo} disabled={guardando === clave}
                          onChange={(e) => cambia(m.idMarca, mod.id, e.target.checked)}
                        />
                        <span><b>{mod.label}</b><br /><span className="text-xs text-muted-foreground">{mod.description}</span></span>
                      </label>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
