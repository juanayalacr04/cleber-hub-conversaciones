"use server";

/**
 * Verificaciones de datos del cliente en hub_cleber (lectura desde el dashboard).
 *   Hub.consultaVerificaciones   bandeja del módulo en la marca (permisos del módulo verificacion)
 *   Hub.resumenVerificaciones    conteos del período para las tarjetas del dashboard
 * Las verificaciones las resuelve el bot y el resultado se entrega a Salesforce; el hub solo consulta.
 * Contratos: DB/Hub/Functions/Acciones/consulta_verificaciones.sql y resumen_verificaciones.sql.
 */

import { api } from "@/lib/api";

export type EstadoVerificacion = "pendiente" | "valido" | "no_valido";
export type EstadoCallback = "pendiente" | "enviado" | "fallido";

export interface Verificacion {
  idVerificacion: string;
  idMarca: string;
  tipo: string;
  /** Teléfono verificado (o el dato del `tipo` que se haya verificado) */
  valor: string;
  /** ID del registro en Salesforce */
  idExterno: string;
  idConversacion: string | null;
  estado: EstadoVerificacion;
  resueltoEn: string | null;
  callback: {
    /** null = todavía no se ha intentado entregar */
    estado: EstadoCallback | null;
    intentos: number;
    ultimoError: string | null;
    ultimoIntentoEn: string | null;
    enviadoEn: string | null;
  };
  /** El intento no salió a Salesforce (simulación de la marca) */
  callbackSimulado: boolean;
  /** La marca tiene encendida la simulación del callback */
  simularCallback: boolean;
  creadoEn: string;
  actualizadoEn: string;
  /** Conversación donde se verificó, si la tiene */
  conversacion: { estado: string; resultado: string | null } | null;
}

export interface ResumenVerificaciones {
  total: number;
  pendientes: number;
  validas: number;
  noValidas: number;
  callback: { pendiente: number; enviado: number; fallido: number; simulados: number };
  /** Sin intento de entrega todavía */
  sinCallback: number;
}

/** De la más reciente a la más vieja. `antesDe` es el creadoEn de la última que ya se tiene (paginación). */
export async function consultaVerificaciones(p: {
  idMarca: string; estados?: EstadoVerificacion[]; callbackEstados?: EstadoCallback[]; busqueda?: string; antesDe?: string; limite?: number;
}) {
  return api.call<{ verificaciones: Verificacion[]; hayMas: boolean }>(
    "hub", "consulta_verificaciones", "Hub.consultaVerificaciones", p);
}

/** Conteos por estado y por estado del callback en el rango (por creadoEn). */
export async function resumenVerificaciones(p: { idMarca: string; desde?: string; hasta?: string }) {
  return api.call<ResumenVerificaciones>("hub", "resumen_verificaciones", "Hub.resumenVerificaciones", p);
}
