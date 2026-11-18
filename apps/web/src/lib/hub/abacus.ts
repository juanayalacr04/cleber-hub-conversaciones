"use server";

/**
 * Configuración de Abacus de un bot de Valuación (hub_cleber), para la pestaña ChatLLM de la pantalla de Bots.
 * El Deployment ID sale del bot en hub_cleber y solo lo ve quien administra Valuación en la marca (la misma regla que la
 * pestaña de Ventas y Servicio, que pide administrador). La consulta a Abacus es la de lib/abacus-config.ts.
 */

import { api, type ApiResponse } from "@/lib/api";
import { cargaConfigAbacus } from "@/lib/abacus-config";
import type { ConfiguracionModulo } from "@/lib/hub/configuracion";

export async function consultaConfigAbacus(p: { idMarca: string; idBot: string }): Promise<ApiResponse<Record<string, unknown>>> {
  const conf = await api.call<ConfiguracionModulo>("hub", "consulta_configuracion_modulo", "Hub.consultaConfiguracionModulo", {
    idMarca: p.idMarca, modulo: "valuacion",
  });
  if (!conf.successful) return conf;
  if (!conf.info.puedeEditar) {
    return { successful: false, errorCode: "SIN_PERMISO", errorMessage: "Solo un administrador de Valuación puede ver la configuración de Abacus." };
  }
  const bot = conf.info.bots.find((b) => b.idBot === p.idBot);
  if (!bot) return { successful: false, errorCode: "RECURSO_NO_ENCONTRADO", errorMessage: "Bot no encontrado." };
  const deploymentId = bot.config?.abacusConfig?.deploymentId;
  if (!deploymentId) {
    return { successful: false, errorCode: "CAMPO_REQUERIDO", errorMessage: "El bot no tiene Deployment ID configurado (pestaña Abacus AI)." };
  }

  const r = await cargaConfigAbacus(deploymentId);
  if (!r.ok) return { successful: false, errorCode: r.status >= 500 && r.status !== 502 ? "CONFIGURACION" : "ERROR_ABACUS", errorMessage: r.error };
  return { successful: true, info: r.result };
}
