"use server";

/**
 * Configuración de un módulo en una marca sobre hub_cleber: equipos, números de WhatsApp y bots.
 *   Hub.consultaConfiguracionModulo   cualquier rol del módulo (puedeEditar = administrador del módulo)
 *   Hub.guardaEquipo / Hub.guardaNumero   administrador del módulo
 * Contratos: DB/Hub/Functions/Acciones/*.sql (DB/Hub/README.md, "Núcleo de conversaciones").
 * Las credenciales del proveedor NO pasan por aquí: van en Secrets Manager (hub/<ambiente>/numbers/<idNumero>).
 */

import { api } from "@/lib/api";
import type { ModuloHub } from "@/lib/hub/usuarios";

export type Proveedor = "twilio" | "meta" | "valuetext";

export interface Equipo {
  idEquipo: string;
  idMarca: string;
  modulo: ModuloHub;
  nombre: string;
  esActivo: boolean;
}

export interface Bot {
  idBot: string;
  idMarca: string;
  modulo: ModuloHub;
  nombre: string;
  tipo: string;
  esActivo: boolean;
}

export interface Numero {
  idNumero: string;
  idMarca: string;
  modulo: ModuloHub;
  telefono: string;
  nombre: string;
  proveedor: Proveedor;
  idEquipo: string | null;
  idBotDefault: string | null;
  ventanaReaperturaHoras: number;
  horasCierreInactividad: number | null;
  webhookCierreUrl: string | null;
  plantillas: Record<string, unknown>;
  configProveedor: { twilioAccountSid?: string; metaPhoneNumberId?: string; valuetextSenderId?: string };
  secretosConfigurados: string[];
  esActivo: boolean;
  creadoEn: string;
  actualizadoEn: string;
}

export interface ConfiguracionModulo {
  equipos: Equipo[];
  numeros: Numero[];
  bots: Bot[];
  puedeEditar: boolean;
}

export interface GuardaNumero {
  idNumero?: string;
  idMarca: string;
  modulo: ModuloHub;
  telefono?: string;
  nombre?: string;
  proveedor?: Proveedor;
  idEquipo?: string | null;
  idBotDefault?: string | null;
  ventanaReaperturaHoras?: number;
  plantillas?: Record<string, unknown>;
  configProveedor?: Record<string, string>;
  esActivo?: boolean;
}

export async function consultaConfiguracionModulo(p: { idMarca: string; modulo: ModuloHub }) {
  return api.call<ConfiguracionModulo>("hub", "consulta_configuracion_modulo", "Hub.consultaConfiguracionModulo", p);
}

export async function guardaEquipo(p: { idEquipo?: string; idMarca: string; modulo: ModuloHub; nombre: string; esActivo?: boolean }) {
  return api.call<{ equipo: Equipo; creado: boolean }>("hub", "guarda_equipo", "Hub.guardaEquipo", p);
}

export async function guardaNumero(p: GuardaNumero) {
  return api.call<{ numero: Numero; creado: boolean }>("hub", "guarda_numero", "Hub.guardaNumero", { ...p });
}
