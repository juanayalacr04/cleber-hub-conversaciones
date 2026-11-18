/**
 * Formulario de un bot de Valuación ⇄ su configuración en hub_cleber (`bots.config`).
 *
 * La pantalla (components/valuacion/BotValuacionEditor.tsx) edita un `BorradorBot`; al guardar, `aConfig` lo convierte a la
 * forma que lee el backend (core/entrada_mensajes.py, core/datos/bots.py) PARTIENDO de la configuración que el bot ya tiene:
 * Hub.guardaBot reemplaza `config` completa, así que lo que la pantalla no edita se conserva.
 *
 * Qué lee el backend de cada llave:
 *   abacusConfig.deploymentId           el bot de Abacus. El token es uno por módulo y vive en el secreto del ambiente
 *                                       (ABACUS_DEPLOYMENT_TOKEN_<MODULO>): no se captura aquí y la base rechaza credenciales
 *   handoffConfig                       paso a asesor por palabras clave y sus mensajes
 *   scheduleConfig                      horario de atención de los asesores (fuera de horario no se escala)
 *   optOutAction                        qué hacer cuando el cliente pide no ser contactado
 *   outcomeActions / outcomeTool        vocabulario con el que el bot clasifica el resultado y la herramienta que lo reporta
 *   injectPhoneContext                  antepone el teléfono del cliente al primer mensaje del bot
 */

import type { Bot, ConfigBot } from "@/lib/hub/configuracion";

export const DIAS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

export type Dia = { enabled: boolean; startTime: string; endTime: string };

/** Lo que Valuación reconoce como resultado de la conversación (etiquetas.accion_hub, acciones-valuacion.md §7.2). */
export const RESULTADOS_VALUACION = ["oferta_aceptada_venta", "oferta_aceptada_venta_y_compra", "oferta_rechazada", "contacto_futuro"] as const;
export const HERRAMIENTA_RESULTADO = "Clasificar_Motivo";

export interface BorradorBot {
  nombre: string;
  descripcion: string;
  tipo: "chatllm" | "workflow";
  esActivo: boolean;
  deploymentId: string;
  workflowInputName: string;
  handoffActivo: boolean;
  palabras: string;
  mensajeHandoff: string;
  mensajeEspera: string;
  optOut: "inherit" | "close" | "handoff";
  horarioActivo: boolean;
  horarioViaBot: boolean;
  zonaHoraria: string;
  mensajeFueraHorario: string;
  dias: Record<string, Dia>;
  resultados: string;
  herramientaResultado: string;
  telefonoEnContexto: "default" | "yes" | "no";
}

export function diasPorOmision(): Record<string, Dia> {
  return Object.fromEntries(DIAS.map((d) => [d, { enabled: false, startTime: "09:00", endTime: "18:00" }]));
}

export function borradorVacio(): BorradorBot {
  return {
    nombre: "", descripcion: "", tipo: "chatllm", esActivo: true, deploymentId: "", workflowInputName: "",
    handoffActivo: false, palabras: "", mensajeHandoff: "", mensajeEspera: "", optOut: "inherit",
    horarioActivo: false, horarioViaBot: false, zonaHoraria: "America/Mexico_City", mensajeFueraHorario: "", dias: diasPorOmision(),
    resultados: RESULTADOS_VALUACION.join(", "), herramientaResultado: HERRAMIENTA_RESULTADO, telefonoEnContexto: "default",
  };
}

const lista = (texto: string) => texto.split(",").map((x) => x.trim()).filter(Boolean);

export function aBorrador(bot: Bot): BorradorBot {
  const c = bot.config ?? {};
  const horario = c.scheduleConfig;
  const dias = diasPorOmision();
  for (const franja of horario?.schedule ?? []) {
    if (franja.day in dias) dias[franja.day] = { enabled: true, startTime: franja.startTime, endTime: franja.endTime };
  }
  return {
    nombre: bot.nombre,
    descripcion: c.description ?? "",
    tipo: bot.tipo === "workflow" ? "workflow" : "chatllm",
    esActivo: bot.esActivo,
    deploymentId: c.abacusConfig?.deploymentId ?? "",
    workflowInputName: c.abacusConfig?.workflowInputName ?? "",
    handoffActivo: c.handoffConfig?.enabled ?? false,
    palabras: (c.handoffConfig?.triggerKeywords ?? []).join(", "),
    mensajeHandoff: c.handoffConfig?.handoffMessage ?? "",
    mensajeEspera: c.handoffConfig?.waitingMessage ?? "",
    optOut: c.optOutAction ?? "inherit",
    horarioActivo: horario?.enabled ?? false,
    horarioViaBot: horario?.viaBot ?? false,
    zonaHoraria: horario?.timezone ?? "America/Mexico_City",
    mensajeFueraHorario: horario?.outOfHoursMessage ?? "",
    dias,
    resultados: (c.outcomeActions ?? []).join(", "),
    herramientaResultado: c.outcomeTool ?? "",
    telefonoEnContexto: c.injectPhoneContext === undefined ? "default" : c.injectPhoneContext ? "yes" : "no",
  };
}

/** Por qué el formulario no se puede guardar; null si está bien. */
export function validaBorrador(b: BorradorBot): string | null {
  if (!b.nombre.trim()) return "Escribe el nombre del bot.";
  if (!b.deploymentId.trim()) return "Falta el Deployment ID del bot en Abacus (pestaña Abacus AI).";
  if (b.handoffActivo && lista(b.palabras).length === 0) return "Con el handoff habilitado, escribe al menos una palabra clave (pestaña Handoff).";
  if (b.horarioActivo && !DIAS.some((d) => b.dias[d]?.enabled)) return "Con el horario habilitado, activa al menos un día (pestaña Horarios).";
  for (const d of DIAS) {
    const dia = b.dias[d];
    if (b.horarioActivo && dia?.enabled && dia.startTime >= dia.endTime) return "En el horario, la hora de inicio debe ser anterior a la de fin.";
  }
  return null;
}

/** `bots.config` completa: la previa del bot con lo que edita la pantalla encima. Las llaves vacías se quitan. */
export function aConfig(b: BorradorBot, previa: ConfigBot | undefined): ConfigBot {
  const config: ConfigBot = { ...(previa ?? {}) };

  if (b.descripcion.trim()) config.description = b.descripcion.trim(); else delete config.description;

  // Sin credenciales, aunque la previa trajera alguna: la base las rechaza
  const { deploymentToken: _t, apiKey: _k, ...abacus } = (previa?.abacusConfig ?? {}) as Record<string, unknown>;
  void _t; void _k;
  config.abacusConfig = { ...abacus, deploymentId: b.deploymentId.trim() };
  if (b.tipo === "workflow" && b.workflowInputName.trim()) config.abacusConfig.workflowInputName = b.workflowInputName.trim();
  else delete config.abacusConfig.workflowInputName;

  config.handoffConfig = {
    enabled: b.handoffActivo,
    triggerKeywords: lista(b.palabras),
    ...(b.mensajeHandoff.trim() ? { handoffMessage: b.mensajeHandoff.trim() } : {}),
    ...(b.mensajeEspera.trim() ? { waitingMessage: b.mensajeEspera.trim() } : {}),
  };

  config.scheduleConfig = {
    enabled: b.horarioActivo,
    viaBot: b.horarioViaBot,
    timezone: b.zonaHoraria,
    outOfHoursMessage: b.mensajeFueraHorario,
    schedule: DIAS.filter((d) => b.dias[d]?.enabled).map((d) => ({ day: d, startTime: b.dias[d].startTime, endTime: b.dias[d].endTime })),
  };

  if (b.optOut === "inherit") delete config.optOutAction; else config.optOutAction = b.optOut;

  const resultados = lista(b.resultados);
  if (resultados.length > 0) config.outcomeActions = resultados; else delete config.outcomeActions;
  if (b.herramientaResultado.trim()) config.outcomeTool = b.herramientaResultado.trim(); else delete config.outcomeTool;

  if (b.telefonoEnContexto === "default") delete config.injectPhoneContext;
  else config.injectPhoneContext = b.telefonoEnContexto === "yes";

  return config;
}
