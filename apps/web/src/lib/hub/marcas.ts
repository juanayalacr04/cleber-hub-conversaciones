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
  creadoEn: string;
  actualizadoEn: string;
}

export interface GuardaMarca {
  idMarca: string;
  nombre?: string;
  idSalesforce?: string;
  esActiva?: boolean;
  esSeminuevos?: boolean;
}

export async function consultaMarcas() {
  return api.call<{ marcas: Marca[] }>("hub", "consulta_marcas", "Hub.consultaMarcas");
}

export async function guardaMarca(m: GuardaMarca) {
  return api.call<{ marca: Marca; creada: boolean }>("hub", "guarda_marca", "Hub.guardaMarca", { ...m });
}
