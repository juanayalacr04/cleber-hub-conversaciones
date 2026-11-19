"use server";

/**
 * Conversaciones del hub en hub_cleber (lectura desde el dashboard).
 *   Hub.consultaConversaciones   bandeja del módulo en la marca (mismos permisos por equipo)
 *   Hub.consultaMensajes         quien ve la conversación (administrador del módulo: toda la marca; los demás: su equipo)
 * Hub.cierraConversacion      cierra la conversación con un motivo (cierre manual: si el cliente vuelve a escribir se abre una
 *                              nueva). Lo puede hacer quien escribe en el módulo; con asesor asignado, su asesor o un administrador.
 * Tomar, asignar, transferir de equipo, devolver al bot y reabrir: Hub.* directo (abajo). Responder va por el backend (enviaMensajeAgente).
 * Contratos: DB/Hub/Functions/Acciones/*.sql. Sin tiempo real: las pantallas vuelven a consultar
 * después de cada cambio.
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
  /** Agencia que atiende (Valuación): quien no administra el módulo solo ve las de sus agencias. null = sin filtro */
  idAgencia: string | null;
  resultado: string | null;
  motivoCierre: string | null;
  ultimoMensajeEn: string;
  ultimoMensajeTexto: string | null;
  ultimoRemitente: "customer" | "bot" | "agent" | null;
  /** Último mensaje del cliente: WhatsApp solo deja escribirle texto libre hasta 24 h después */
  ultimoMensajeClienteEn: string | null;
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

// ---- Atender la conversación (Hub.* directo con el token del usuario: la base decide los permisos) ----

type CambioConversacion = { idConversacion: string; versionEsperada?: number };
type ConConversacion = { conversacion: ConversacionHub };

/** El asesor toma una conversación que espera asesor: pasa a "Con agente", asignada a él. */
export async function tomaConversacion(p: CambioConversacion) {
  return api.call<ConConversacion>("hub", "toma_conversacion", "Hub.tomaConversacion", p);
}

/** Un administrador asigna la conversación a un asesor del módulo (pasa a "Con agente"). */
export async function asignaConversacion(p: CambioConversacion & { idAgente: string }) {
  return api.call<ConConversacion>("hub", "asigna_conversacion", "Hub.asignaConversacion", p);
}

/** Un administrador la pasa a otro equipo del módulo: queda esperando asesor, sin asignar. */
export async function transfiereEquipo(p: CambioConversacion & { idEquipo: string }) {
  return api.call<ConConversacion>("hub", "transfiere_equipo", "Hub.transfiereEquipo", p);
}

/** Su asesor (o un administrador) la suelta y vuelve a contestar el bot. */
export async function devuelveAlBot(p: CambioConversacion) {
  return api.call<ConConversacion>("hub", "devuelve_al_bot", "Hub.devuelveAlBot", p);
}

/** Reabre una conversación cerrada; vuelve al bot. CONVERSACION_ABIERTA si el cliente ya tiene otra abierta en el número. */
export async function reabreConversacion(p: CambioConversacion) {
  return api.call<ConConversacion>("hub", "reabre_conversacion", "Hub.reabreConversacion", p);
}

/**
 * El asesor le escribe al cliente. Va por la Lambda hub-acciones-usuario (Hub.enviaMensajeAgente): autoriza con el usuario,
 * envía por WhatsApp y guarda. Si la conversación esperaba asesor o estaba con el bot, el asesor la toma.
 */
export async function enviaMensajeAgente(p: { idConversacion: string; texto: string }) {
  return api.lambda<ConConversacion & { mensaje: MensajeHub; duplicado: boolean }>("hub-acciones", "Hub.enviaMensajeAgente", p);
}
