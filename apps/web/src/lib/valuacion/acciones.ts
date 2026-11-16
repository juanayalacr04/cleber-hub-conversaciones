"use server";

/**
 * Acciones de valuación para las pantallas (Server Actions). Corren en el servidor y llaman al API Gateway por la
 * ruta `/toma-unidades` con lib/api.ts: la API key y el id_token nunca llegan al navegador.
 * Contratos: toma-unidades-en-taller/DB/Valuacion/Functions/Acciones/*.sql (docs/acciones-valuacion.md).
 *
 * El envío por WhatsApp no está aquí: lo hace la Lambda (TomaUnidades.enviaOferta → Valuacion.solicitaEnvio, que es
 * de sistema) y aún no tiene ruta en el gateway.
 */

import { api, type ApiResponse } from "@/lib/api";
import type { ConsultaOfertas, DetalleOferta, EstadoOferta, Etiqueta, Oferta } from "./tipos";

const llama = <T>(funcion: string, accion: string, params: Record<string, unknown> = {}) =>
  api.call<T>("toma-unidades", funcion, `Valuacion.${accion}`, params);

export async function consultaOfertas(params: { fechaGeneracion?: string; idAgencia?: string; estados?: EstadoOferta[] }) {
  return llama<ConsultaOfertas>("consulta_ofertas", "consultaOfertas", params);
}

export async function consultaOferta(idOferta: number) {
  return llama<DetalleOferta>("consulta_oferta", "consultaOferta", { idOferta });
}

export async function consultaEtiquetas() {
  return llama<{ etiquetas: Etiqueta[] }>("consulta_etiquetas", "consultaEtiquetas");
}

type Ref = { idOferta: number; version: number };

export async function calibraOferta(o: Ref & { montoOferta: number; motivo?: string }): Promise<ApiResponse<{ oferta: Oferta }>> {
  return llama("calibra_oferta", "calibraOferta", o);
}

export async function descartaOferta(o: Ref & { motivo: string }): Promise<ApiResponse<{ oferta: Oferta }>> {
  return llama("descarta_oferta", "descartaOferta", o);
}

export async function retomaOferta(o: Ref & { motivo?: string }): Promise<ApiResponse<{ oferta: Oferta }>> {
  return llama("retoma_oferta", "retomaOferta", o);
}

export async function registraRespuesta(o: Ref & { idEtiqueta: string; motivo?: string }): Promise<ApiResponse<{ oferta: Oferta }>> {
  return llama("registra_respuesta", "registraRespuesta", o);
}

export async function cierraOferta(o: Ref & { motivo?: string }): Promise<ApiResponse<{ oferta: Oferta }>> {
  return llama("cierra_oferta", "cierraOferta", o);
}
