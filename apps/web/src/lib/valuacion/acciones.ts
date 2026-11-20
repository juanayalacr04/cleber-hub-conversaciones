"use server";

/**
 * Acciones de valuación para las pantallas (Server Actions). Corren en el servidor y llaman al API Gateway por la
 * ruta `/toma-unidades` con lib/api.ts: la API key y el id_token nunca llegan al navegador.
 * Contratos: toma-unidades-en-taller/DB/Valuacion/Functions/Acciones/*.sql (docs/acciones-valuacion.md).
 *
 * El envío por WhatsApp va a la Lambda de valuación (ruta `/toma-unidades-acciones`, TomaUnidades.enviaOferta): ella
 * llama a Valuacion.solicitaEnvio en nombre del usuario, al hub (Hub.abreConversacion) y a Valuacion.marcaEnviada.
 */

import { api, type ApiResponse } from "@/lib/api";
import type { ConfiguracionAgencia, ConsultaOfertas, DetalleOferta, EstadoOferta, Etiqueta, GuardaConfiguracion, Oferta } from "./tipos";

const llama = <T>(funcion: string, accion: string, params: Record<string, unknown> = {}) =>
  api.call<T>("toma-unidades", funcion, `Valuacion.${accion}`, params);

export async function consultaOfertas(params: { fechaGeneracion?: string; idMarca?: string; idAgencia?: string; estados?: EstadoOferta[] }) {
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

/** A quién se envía: a un teléfono de prueba (+52XXXXXXXXXX) o al cliente. Siempre uno de los dos: el hub rechaza un envío sin destino. */
export type DestinoEnvio = { telefonoDestino: string; alCliente?: false } | { alCliente: true; telefonoDestino?: undefined };

/**
 * Envía la oferta por WhatsApp. Si el hub no pudo enviarla, la respuesta falla con su errorCode e
 * info { oferta (ya en FALLIDO), hub: { motivo... } }; ver mensajeError.
 */
export async function enviaOferta(o: Ref & DestinoEnvio): Promise<ApiResponse<{ oferta: Oferta; idConversacion: string }>> {
  const destino = o.alCliente ? { alCliente: true } : { telefonoDestino: o.telefonoDestino };
  return api.lambda("toma-unidades-acciones", "TomaUnidades.enviaOferta", { idOferta: o.idOferta, version: o.version, ...destino });
}

// ---------- Configuración por agencia (permiso: configurar) ----------

export async function consultaConfiguracion() {
  return llama<{ agencias: ConfiguracionAgencia[] }>("consulta_configuracion", "consultaConfiguracion");
}

/** Upsert por idAgencia; los cambios aplican desde la siguiente corrida del cron. */
export async function guardaConfiguracion(c: GuardaConfiguracion): Promise<ApiResponse<ConfiguracionAgencia>> {
  return llama("guarda_configuracion", "guardaConfiguracion", c);
}
