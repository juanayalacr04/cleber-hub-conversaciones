"use client";

import { useEffect, useState } from "react";
import { consultaUsuarioActual, type UsuarioHub } from "@/lib/hub/usuario";

/** Roles de cada módulo con es_administrador (Datos_maestros/roles_modulo.sql). */
const ROLES_ADMINISTRADOR = ["ADMINISTRADOR"];

/** Nombre visible de cada rol del catálogo. */
const NOMBRE_ROL: Record<string, string> = {
  ADMINISTRADOR: "Administrador", GERENTE: "Gerente", VALUADOR: "Valuador", CONSULTA: "Consulta", AGENTE: "Agente",
};

/**
 * Usuario de hub_cleber, pedido una vez por carga de página. `usuario` es null mientras carga o si falla; `error`
 * dice por qué falló (se escribe también en la consola del navegador).
 */
export function useUsuarioHub(activo: boolean) {
  const [usuario, setUsuario] = useState<UsuarioHub | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!activo) return;
    let vivo = true;
    consultaUsuarioActual()
      .then((r) => {
        if (!vivo) return;
        if (r.successful) { setUsuario(r.info.usuario); setError(null); return; }
        console.error("Hub.consultaUsuarioActual falló:", r.errorCode, r.errorMessage, r.info ?? "");
        setError(`${r.errorCode}: ${r.errorMessage}`);
      })
      .catch((e) => { console.error("Hub.consultaUsuarioActual falló:", e); if (vivo) setError(String(e)); });
    return () => { vivo = false; };
  }, [activo]);
  return { usuario, error };
}

/**
 * Cómo se presenta el usuario en un módulo: etiqueta para la pastilla y si administra el módulo (ve "Administración").
 * El rol es por marca: se usa el de la marca elegida y, si ahí no tiene, el de otra marca (con su nombre).
 */
export function rolEnModulo(u: UsuarioHub, modulo: string, idMarca: string | null) {
  if (u.esSuperAdmin) return { etiqueta: "superadmin", admin: true, superAdmin: true };
  const conRol = u.marcas.filter((o) => o.modulos[modulo]);
  const admin = conRol.some((o) => ROLES_ADMINISTRADOR.includes(o.modulos[modulo].rol));
  const actual = conRol.find((o) => o.idMarca === idMarca);
  const o = actual ?? conRol[0];
  if (!o) return { etiqueta: "sin rol en el módulo", admin: false, superAdmin: false };
  const rol = NOMBRE_ROL[o.modulos[modulo].rol] ?? o.modulos[modulo].rol;
  return { etiqueta: actual ? rol : `${rol} · ${o.nombre}`, admin, superAdmin: false };
}
