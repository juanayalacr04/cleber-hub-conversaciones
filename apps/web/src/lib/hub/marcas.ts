"use server";

/** Marcas del hub (hub_cleber.marcas), solo super admin: Hub.consultaMarcas y Hub.guardaMarca. */

import { api } from "@/lib/api";

export interface Marca {
  /** Código de la marca (TO, HO...) */
  idMarca: string;
  nombre: string;
  sfCalendario: string | null;
  /** ID de la marca en Salesforce (opcional) */
  idSalesforce: string | null;
  esActiva: boolean;
  esSeminuevos: boolean;
  /** El callback de verificación a Salesforce no sale a la red y queda marcado como simulado (solo pruebas) */
  simularCallbackSf: boolean;
  creadoEn: string;
  actualizadoEn: string;
}

export interface GuardaMarca {
  idMarca: string;
  nombre?: string;
  idSalesforce?: string;
  esActiva?: boolean;
  esSeminuevos?: boolean;
  simularCallbackSf?: boolean;
}

export interface ModulosDeMarca {
  idMarca: string;
  nombre: string;
  esActiva: boolean;
  /** Solo los módulos con fila; el que no aparece no está activo */
  modulos: { modulo: string; esActivo: boolean }[];
}

/** Módulos activos por marca: lo enciende o apaga solo el super admin; la lista de módulos existentes está en lib/modules.ts. */
export async function consultaModulosMarca() {
  return api.call<{ marcas: ModulosDeMarca[] }>("hub", "consulta_modulos_marca", "Hub.consultaModulosMarca");
}

export async function guardaModuloMarca(p: { idMarca: string; modulo: string; esActivo: boolean }) {
  return api.call<{ idMarca: string; modulo: string; esActivo: boolean }>("hub", "guarda_modulo_marca", "Hub.guardaModuloMarca", { ...p });
}

export async function consultaMarcas() {
  return api.call<{ marcas: Marca[] }>("hub", "consulta_marcas", "Hub.consultaMarcas");
}

export async function guardaMarca(m: GuardaMarca) {
  return api.call<{ marca: Marca; creada: boolean }>("hub", "guarda_marca", "Hub.guardaMarca", { ...m });
}
