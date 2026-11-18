"use server";

/**
 * Conversaciones del hub en hub_cleber (lectura desde el dashboard).
 *   Hub.consultaConversaciones   bandeja del módulo en la marca (mismos permisos por equipo)
 *   Hub.consultaMensajes         quien ve la conversación (administrador del módulo: toda la marca; los demás: su equipo)
 * Hub.cierraConversacion      cierra la conversación con un motivo (cierre manual: si el cliente vuelve a escribir se abre una
 *                              nueva). Lo puede hacer quien escribe en el módulo; con asesor asignado, su asesor o un administrador.
 * Contratos: DB/Hub/Functions/Acciones/consulta_mensajes.sql y cierra_conversacion.sql. Las demás escrituras (tomar, responder)
 * van por el backend, que además manda el mensaje al proveedor y publica el aviso de tiempo real.
 */

import { api } from "@/lib/api";
import type { ModuloHub } from "@/lib/hub/usuarios";

export type EstadoConversacion = "bot" | "waiting_agent" | "with_agent" | "closed";

export interface ConversacionHub {
  idConversacion: string;
  idMarca: string;
  modulo: ModuloHub;
  idNumero: string;
  idEquipo: string | null;
  idBot: string | null;
  direccion: "inbound" | "outbound";
  telefonoCliente: string;
  nombreCliente: string | null;
  estado: EstadoConversacion;
  idAgente: string | null;
  fuente: string | null;
  idExterno: string | null;
  resultado: string | null;
  motivoCierre: string | null;
  ultimoMensajeEn: string;
  ultimoMensajeTexto: string | null;
  ultimoRemitente: "customer" | "bot" | "agent" | null;
  metadatos: Record<string, unknown>;
  cerradaEn: string | null;
  creadoEn: string;
  version: number;
}

export interface MensajeHub {
  idMensaje: string;
  idConversacion: string;
  remitente: "customer" | "bot" | "agent" | "system";
  idAgente: string | null;
  texto: string | null;
  mediaUrl: string | null;
  esPlantilla: boolean;
  creadoEn: string;
}

export async function consultaConversaciones(p: {
  idMarca: string; modulo: ModuloHub; estados?: EstadoConversacion[]; busqueda?: string; antesDe?: string; limite?: number;
}) {
  return api.call<{ conversaciones: ConversacionHub[]; hayMas: boolean }>(
    "hub", "consulta_conversaciones", "Hub.consultaConversaciones", p);
}

export async function consultaMensajes(p: { idConversacion: string; incluyeSistema?: boolean; limite?: number }) {
  return api.call<{ conversacion: ConversacionHub; mensajes: MensajeHub[]; hayMas: boolean }>(
    "hub", "consulta_mensajes", "Hub.consultaMensajes", p);
}

/** Cierra la conversación. `motivo` es obligatorio (hasta 200 caracteres). `versionEsperada` evita cerrar una que cambió mientras tanto. */
export async function cierraConversacion(p: { idConversacion: string; motivo: string; versionEsperada?: number }) {
  return api.call<{ conversacion: ConversacionHub }>("hub", "cierra_conversacion", "Hub.cierraConversacion", p);
}
