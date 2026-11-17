"use server";

/**
 * Usuario de la sesión según hub_cleber (Hub.consultaUsuarioActual): super admin y rol por marca y módulo.
 * Es la misma fuente con la que la base decide los permisos de los módulos que ya están en PostgreSQL (valuación).
 */

import { api } from "@/lib/api";

export interface UsuarioHub {
  email: string;
  nombre: string;
  esSuperAdmin: boolean;
  marcas: { idMarca: string; nombre: string; agencias: string[]; modulos: Record<string, { rol: string; idEquipo: string | null }> }[];
}

export async function consultaUsuarioActual() {
  return api.call<{ usuario: UsuarioHub; marcasVisibles: { idMarca: string; nombre: string }[] }>(
    "hub", "consulta_usuario_actual", "Hub.consultaUsuarioActual");
}
