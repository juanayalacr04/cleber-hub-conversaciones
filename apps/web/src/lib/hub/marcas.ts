"use server";

/** Marcas del hub (hub_cleber.marcas), solo super admin: Hub.consultaMarcas y Hub.guardaMarca. */

import { api } from "@/lib/api";

export interface Marca {
  idMarca: string;
  nombre: string;
  zonaHoraria: string;
  sfCodigoMarca: string | null;
  sfCalendario: string | null;
  plan: string;
  esActiva: boolean;
  creadoEn: string;
  actualizadoEn: string;
}

export interface GuardaMarca {
  idMarca: string;
  nombre?: string;
  zonaHoraria?: string;
  /** "" quita el código */
  sfCodigoMarca?: string;
  esActiva?: boolean;
}

export async function consultaMarcas() {
  return api.call<{ marcas: Marca[] }>("hub", "consulta_marcas", "Hub.consultaMarcas");
}

export async function guardaMarca(m: GuardaMarca) {
  return api.call<{ marca: Marca; creada: boolean }>("hub", "guarda_marca", "Hub.guardaMarca", { ...m });
}
