"use server";

/**
 * Configuración de un módulo en una marca sobre hub_cleber: equipos, números de WhatsApp y bots.
 *   Hub.consultaConfiguracionModulo   cualquier rol del módulo (puedeEditar = administrador del módulo)
 *   Hub.guardaEquipo / Hub.guardaNumero / Hub.guardaBot   administrador del módulo
 *   Hub.consultaPlantillaProveedor   administrador del módulo; Lambda hub-acciones-usuario (core/acciones_usuario.py)
 * Contratos: DB/Hub/Functions/Acciones/*.sql (DB/Hub/README.md, "Núcleo de conversaciones").
 * Las credenciales del proveedor NO pasan por aquí: Twilio usa la cuenta del ambiente y Meta va en Secrets Manager.
 */

import { api } from "@/lib/api";
import type { ModuloHub } from "@/lib/hub/usuarios";

export type Proveedor = "twilio" | "meta" | "valuetext";

export type ModoAsignacion = "manual" | "round_robin" | "least_busy" | "salesforce";

export interface Equipo {
  idEquipo: string;
  idMarca: string;
  modulo: ModuloHub;
  nombre: string;
  /** manual: la toma o la asigna un administrador; round_robin / least_busy: el hub la asigna al pasar a asesor */
  modoAsignacion: ModoAsignacion;
  /** Tope de conversaciones "Con agente" por asesor para la asignación automática; null = sin tope */
  maxConversacionesAgente: number | null;
  /** Qué hacer cuando el cliente escribe "stop": close / handoff; null = lo decide el bot */
  accionOptOut: "close" | "handoff" | null;
  esActivo: boolean;
}

export type TipoBot = "chatllm" | "workflow" | "vertex_ai" | "external";

/**
 * Configuración de un bot tal como la lee el backend (core/entrada_mensajes.py, core/datos/bots.py). Se guarda completa en
 * `config`; solo se listan las llaves que edita la pantalla de Bots, el resto se conserva tal cual.
 * Las credenciales NO van aquí (la base las rechaza): el token de Abacus es uno por módulo y vive en el secreto del ambiente.
 */
export interface ConfigBot {
  description?: string;
  abacusConfig?: { deploymentId?: string; workflowInputName?: string };
  handoffConfig?: { enabled?: boolean; triggerKeywords?: string[]; handoffMessage?: string; waitingMessage?: string };
  scheduleConfig?: {
    enabled?: boolean; viaBot?: boolean; timezone?: string; outOfHoursMessage?: string;
    schedule?: { day: string; startTime: string; endTime: string }[];
  };
  optOutAction?: "close" | "handoff";
  outcomeActions?: string[];
  outcomeTool?: string;
  injectPhoneContext?: boolean;
  [otra: string]: unknown;
}

export interface Bot {
  idBot: string;
  idMarca: string;
  modulo: ModuloHub;
  nombre: string;
  tipo: TipoBot | string;
  categoria?: string | null;
  config?: ConfigBot;
  secretosConfigurados?: string[];
  esActivo: boolean;
}

export interface Numero {
  idNumero: string;
  idMarca: string;
  modulo: ModuloHub;
  telefono: string;
  nombre: string;
  proveedor: Proveedor;
  idEquipo: string | null;
  idBotDefault: string | null;
  ventanaReaperturaHoras: number;
  horasCierreInactividad: number | null;
  webhookCierreUrl: string | null;
  plantillas: Record<string, unknown>;
  configProveedor: { twilioAccountSid?: string; metaPhoneNumberId?: string; valuetextSenderId?: string };
  secretosConfigurados: string[];
  esActivo: boolean;
  creadoEn: string;
  actualizadoEn: string;
}

export interface ConfiguracionModulo {
  equipos: Equipo[];
  numeros: Numero[];
  bots: Bot[];
  puedeEditar: boolean;
}

export interface GuardaNumero {
  idNumero?: string;
  idMarca: string;
  modulo: ModuloHub;
  telefono?: string;
  nombre?: string;
  proveedor?: Proveedor;
  idEquipo?: string | null;
  idBotDefault?: string | null;
  ventanaReaperturaHoras?: number;
  plantillas?: Record<string, unknown>;
  configProveedor?: Record<string, string>;
  esActivo?: boolean;
}

export async function consultaConfiguracionModulo(p: { idMarca: string; modulo: ModuloHub }) {
  return api.call<ConfiguracionModulo>("hub", "consulta_configuracion_modulo", "Hub.consultaConfiguracionModulo", p);
}

export async function guardaEquipo(p: {
  idEquipo?: string; idMarca: string; modulo: ModuloHub; nombre?: string; esActivo?: boolean;
  modoAsignacion?: ModoAsignacion; maxConversacionesAgente?: number | null; accionOptOut?: "close" | "handoff" | null;
}) {
  return api.call<{ equipo: Equipo; creado: boolean }>("hub", "guarda_equipo", "Hub.guardaEquipo", p);
}

export async function guardaNumero(p: GuardaNumero) {
  return api.call<{ numero: Numero; creado: boolean }>("hub", "guarda_numero", "Hub.guardaNumero", { ...p });
}

export interface GuardaBot {
  /** Sin id es un alta (idMarca, modulo y nombre son obligatorios); con id, solo se cambia lo que viene. */
  idBot?: string;
  idMarca?: string;
  modulo?: ModuloHub;
  nombre?: string;
  tipo?: TipoBot;
  /** Reemplaza la configuración completa: quien edita debe partir de la que ya tiene el bot. */
  config?: ConfigBot;
  esActivo?: boolean;
}

export async function guardaBot(p: GuardaBot) {
  return api.call<{ bot: Bot; creado: boolean }>("hub", "guarda_bot", "Hub.guardaBot", { ...p });
}

/** La plantilla tal como la tiene el proveedor (hoy solo Twilio, por Content SID). */
export interface PlantillaProveedor {
  nombre: string | null;
  idioma: string | null;
  tipo: string;
  cuerpo: string;
  botones: { titulo: string; id: string | null }[];
  /** Variables que usa la plantilla ("1", "2"...), en orden. */
  variables: string[];
}

export async function consultaPlantillaProveedor(p: { idMarca: string; modulo: ModuloHub; idPlantilla: string }) {
  return api.lambda<PlantillaProveedor>("hub-acciones", "Hub.consultaPlantillaProveedor", p);
}
