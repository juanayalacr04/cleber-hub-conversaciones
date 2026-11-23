"use client";

import { useAuth } from "@/contexts/AuthContext";
import type { UsuarioHub } from "@/lib/hub/usuario";

/** Roles de cada módulo con es_administrador (Datos_maestros/roles_modulo.sql). */
const ROLES_ADMINISTRADOR = ["ADMINISTRADOR"];

/** Nombre visible de cada rol del catálogo. */
const NOMBRE_ROL: Record<string, string> = {
  ADMINISTRADOR: "Administrador", GERENTE: "Gerente", VALUADOR: "Valuador", CONSULTA: "Consulta", AGENTE: "Agente",
};

/** Usuario de hub_cleber de la sesión (lo carga AuthContext al entrar). `error` si no se pudo cargar. */
export function useUsuarioHub() {
  const { usuarioHub, userDataError } = useAuth();
  return { usuario: usuarioHub, error: userDataError ? "No se pudo cargar el usuario del hub" : null };
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
