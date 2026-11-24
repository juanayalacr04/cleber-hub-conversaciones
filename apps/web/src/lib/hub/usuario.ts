"use server";

/**
 * Usuario de la sesión según hub_cleber: es la identidad del dashboard (quién entra, qué marcas ve y qué rol tiene en
 * cada módulo de cada marca). Es la misma fuente con la que la base decide los permisos.
 *   Hub.registraInicioSesion  al entrar: registra el acceso; SIN_PERMISO = no está dado de alta (o está inactivo)
 *   Hub.consultaUsuarioActual  usuario y marcas que puede ver
 */

import { api } from "@/lib/api";

export interface UsuarioHub {
  idUsuario: string;
  email: string;
  nombre: string;
  fotoUrl: string | null;
  esSuperAdmin: boolean;
  esDisponible: boolean;
  estado: "online" | "away" | "offline";
  ultimoAccesoEn: string | null;
  creadoEn: string;
  marcas: { idMarca: string; nombre: string; agencias: string[]; modulos: Record<string, { rol: string; idEquipo: string | null }> }[];
}

export async function consultaUsuarioActual() {
  return api.call<{ usuario: UsuarioHub; marcasVisibles: { idMarca: string; nombre: string; esSeminuevos: boolean }[] }>(
    "hub", "consulta_usuario_actual", "Hub.consultaUsuarioActual");
}

/** Nombre y foto de la cuenta de Google (si vienen) se guardan en el hub. */
export async function registraInicioSesion(p: { nombre?: string | null; fotoUrl?: string | null }) {
  return api.call<{ usuario: UsuarioHub }>("hub", "registra_inicio_sesion", "Hub.registraInicioSesion", {
    ...(p.nombre ? { nombre: p.nombre } : {}),
    ...(p.fotoUrl ? { fotoUrl: p.fotoUrl } : {}),
  });
}
