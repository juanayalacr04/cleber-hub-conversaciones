"use server";

/**
 * Editor de usuarios del hub (hub_cleber, decisión Q39): Hub.consultaUsuarios, consultaRolesModulo, invitaUsuario,
 * guardaUsuario, quitaUsuarioDeMarca y cambiaDisponibilidad. Contratos: DB/Hub/Functions/Acciones/*.sql.
 *
 * El correo de invitación sale por la Lambda hub-acciones-usuario (Hub.enviaInvitacion), después del alta.
 * Pendiente del diseño (DISENO_MIGRACION_POSTGRES.md §6.2): escribir accesos/{email} en Firestore y validar agencias
 * contra su API. Las demás acciones se llaman directo con el token del usuario.
 */

import { headers } from "next/headers";
import { api } from "@/lib/api";

export type ModuloHub = "ventas" | "servicio" | "valuacion";

export interface UsuarioEnMarca {
  idUsuario: string;
  email: string;
  nombre: string;
  fotoUrl: string | null;
  esSuperAdmin: boolean;
  esActivo: boolean;
  esDisponible: boolean;
  estado: "online" | "away" | "offline";
  ultimoAccesoEn: string | null;
  esInvitado: boolean;
  agencias: string[];
  modulos: Partial<Record<ModuloHub, { rol: string; idEquipo: string | null }>>;
}

export interface RolModulo {
  modulo: ModuloHub;
  rol: string;
  nombre: string;
  descripcion: string | null;
  esAdministrador: boolean;
}

export interface ConsultaUsuarios {
  usuarios: UsuarioEnMarca[];
  /** Qué puede editar quien consulta en esta marca */
  permisos: { modulos: ModuloHub[]; agencias: boolean };
}

export async function consultaUsuarios(p: { idMarca: string; modulo?: ModuloHub; incluyeInactivos?: boolean }) {
  return api.call<ConsultaUsuarios>("hub", "consulta_usuarios", "Hub.consultaUsuarios", { ...p });
}

export async function consultaRolesModulo(modulo?: ModuloHub) {
  return api.call<{ roles: RolModulo[] }>("hub", "consulta_roles_modulo", "Hub.consultaRolesModulo", modulo ? { modulo } : {});
}

export async function invitaUsuario(p: {
  email: string; idMarca: string; modulo: ModuloHub; rol: string; idEquipo?: string; agencias?: string[]; nombre?: string;
}) {
  return api.call<{ usuario: { idUsuario: string }; creado: boolean }>("hub", "invita_usuario", "Hub.invitaUsuario", { ...p });
}

/** Manda el correo de invitación a quien ya tiene rol en el módulo y la marca. Sirve también para reenviarlo. */
export async function enviaInvitacion(p: { email: string; idMarca: string; modulo: ModuloHub; nombreMarca?: string }) {
  // El enlace del correo apunta al ambiente desde el que se invita (dev/qa/prd/local); la Lambda solo valida que sea un origen (esquema y host, sin ruta)
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host");
  const proto = h.get("x-forwarded-proto")?.split(",")[0].trim() || (host?.startsWith("localhost") ? "http" : "https");
  return api.lambda<{ enviado: boolean }>("hub-acciones", "Hub.enviaInvitacion", { ...p, ...(host ? { origen: `${proto}://${host}` } : {}) });
}

export async function guardaUsuario(p: {
  idUsuario: string; idMarca: string; agencias?: string[];
  modulos?: Partial<Record<ModuloHub, { rol: string; idEquipo?: string | null } | null>>;
}) {
  return api.call<unknown>("hub", "guarda_usuario", "Hub.guardaUsuario", { ...p });
}

export async function quitaUsuarioDeMarca(p: { idUsuario: string; idMarca: string }) {
  return api.call<unknown>("hub", "quita_usuario_de_marca", "Hub.quitaUsuarioDeMarca", { ...p });
}

export async function cambiaDisponibilidad(p: { idUsuario: string; esDisponible: boolean }) {
  return api.call<{ idUsuario: string; esDisponible: boolean }>("hub", "cambia_disponibilidad", "Hub.cambiaDisponibilidad", { ...p });
}
