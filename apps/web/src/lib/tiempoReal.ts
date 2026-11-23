"use client";

/**
 * Cliente de AppSync Events en el navegador (DISENO_BACKEND_AWS.md §6), sin Amplify.
 *
 * Una sola conexión WebSocket por pestaña, compartida por todas las suscripciones (la bandeja y el chat abierto).
 * Se autentica con el id_token de Google de la sesión (el authorizer genérico, infra/authorizer-appsync, lo valida y
 * pregunta a Hub.autorizaCanal si el usuario puede escuchar el canal).
 *
 *   const quita = suscribe("/hub/TOYOTA/valuacion", { alAvisar: (aviso) => ..., alSuscribir: () => ... })
 *
 * Los avisos dicen "esto cambió", no traen datos: la pantalla vuelve a consultar. Si se cae la conexión, reintenta con
 * espera creciente y, al volver a suscribirse, llama alSuscribir (pudo perderse algo mientras tanto). Sin
 * NEXT_PUBLIC_APPSYNC_EVENTS_HOST no hace nada (estaConfigurado() = false) y las pantallas siguen con su refresco.
 *
 * Protocolo: https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-websocket-protocol.html
 */

import { getSession } from "next-auth/react";

export interface AvisoConversacion {
  tipo: "conversacion";
  idConversacion: string;
  version: number;
  estado: string;
  idEquipo: string | null;
  idAgente: string | null;
  ultimoMensajeEn: string | null;
  ultimoRemitente: string | null;
}

export interface Oyente {
  alAvisar: (aviso: AvisoConversacion) => void;
  /**
   * La suscripción quedó activa (al abrir o después de una caída): conviene volver a consultar, porque pudo cambiar algo
   * entre la consulta y la suscripción, o mientras no hubo conexión.
   */
  alSuscribir?: () => void;
  /** Cambió el estado de la conexión (para decidir cada cuánto refrescar como respaldo). */
  alCambiarEstado?: (conectado: boolean) => void;
}

const HOST = (process.env.NEXT_PUBLIC_APPSYNC_EVENTS_HOST ?? "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
const HOST_RT = (process.env.NEXT_PUBLIC_APPSYNC_EVENTS_REALTIME_HOST ?? "").trim().replace(/^wss?:\/\//, "").replace(/\/.*$/, "")
  || HOST.replace(".appsync-api.", ".appsync-realtime-api.");
const ESPERA_MAX_MS = 30_000;
const CIERRE_SIN_USO_MS = 10_000;

export const estaConfigurado = () => !!HOST;

const base64url = (texto: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(texto))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function idToken(): Promise<string | null> {
  try {
    const s = await getSession();   // pasa por /api/auth/session: renueva el id_token si está por vencer
    return s?.error ? null : (s?.idToken ?? null);
  } catch {
    return null;
  }
}

/** Aviso de un evento de AppSync: objeto, o texto JSON (hasta dos veces codificado). null si no es un aviso. */
function leeAviso(crudo: unknown): AvisoConversacion | null {
  let valor = crudo;
  for (let i = 0; i < 2 && typeof valor === "string"; i++) {
    try { valor = JSON.parse(valor); } catch { return null; }
  }
  return valor && typeof valor === "object" && (valor as { tipo?: unknown }).tipo === "conversacion"
    ? (valor as AvisoConversacion) : null;
}

interface Suscripcion {
  id: string;
  canal: string;
  oyentes: Set<Oyente>;
  activa: boolean;
}

let ws: WebSocket | null = null;
let conectado = false;
let intentos = 0;
let reintento: ReturnType<typeof setTimeout> | null = null;
let vigilante: ReturnType<typeof setTimeout> | null = null;
let cierreSinUso: ReturnType<typeof setTimeout> | null = null;
let tiempoKeepAlive = 300_000;
const porCanal = new Map<string, Suscripcion>();
const porId = new Map<string, Suscripcion>();

function avisaEstado(valor: boolean) {
  if (conectado === valor) return;
  conectado = valor;
  porCanal.forEach((s) => s.oyentes.forEach((o) => o.alCambiarEstado?.(valor)));
}

function vigila() {
  if (vigilante) clearTimeout(vigilante);
  // Sin "ka" en connectionTimeoutMs la conexión se da por muerta (protocolo de AppSync)
  vigilante = setTimeout(() => ws?.close(4000, "sin keep-alive"), tiempoKeepAlive);
}

async function enviaSuscripcion(s: Suscripcion) {
  const token = await idToken();
  if (!token || !ws || ws.readyState !== WebSocket.OPEN || porId.get(s.id) !== s) return;
  ws.send(JSON.stringify({ type: "subscribe", id: s.id, channel: s.canal, authorization: { Authorization: token, host: HOST } }));
}

function programaReconexion() {
  if (reintento || porCanal.size === 0) return;
  const espera = Math.min(ESPERA_MAX_MS, 1000 * 2 ** intentos) + Math.random() * 500;
  intentos += 1;
  reintento = setTimeout(() => { reintento = null; void conecta(); }, espera);
}

async function conecta() {
  if (ws || porCanal.size === 0 || !HOST) return;
  const token = await idToken();
  if (!token) {
    console.warn("[tiempo real] la sesión no trae id_token: no se conecta (se reintenta)");
    programaReconexion();
    return;
  }
  if (ws || porCanal.size === 0) return;
  console.info(`[tiempo real] conectando a wss://${HOST_RT}/event/realtime (host ${HOST})`);

  const encabezado = base64url(JSON.stringify({ host: HOST, Authorization: token }));
  const socket = new WebSocket(`wss://${HOST_RT}/event/realtime`, ["aws-appsync-event-ws", `header-${encabezado}`]);
  ws = socket;

  socket.onopen = () => socket.send(JSON.stringify({ type: "connection_init" }));
  socket.onmessage = (e) => {
    let m: { type?: string; id?: string; event?: unknown; connectionTimeoutMs?: number; errors?: unknown };
    try { m = JSON.parse(String(e.data)); } catch { return; }
    switch (m.type) {
      case "connection_ack":
        console.info("[tiempo real] conectado");
        intentos = 0;
        tiempoKeepAlive = m.connectionTimeoutMs ?? 300_000;
        vigila();
        avisaEstado(true);
        porCanal.forEach((s) => void enviaSuscripcion(s));
        break;
      case "ka":
        vigila();
        break;
      case "subscribe_success": {
        const s = porId.get(m.id ?? "");
        if (!s) break;
        s.activa = true;
        console.info("[tiempo real] escuchando", s.canal);
        s.oyentes.forEach((o) => o.alSuscribir?.());
        break;
      }
      case "subscribe_error":
        console.warn(`[tiempo real] no se pudo suscribir a ${porId.get(m.id ?? "")?.canal}: ${JSON.stringify(m.errors)}`);
        break;
      case "data": {
        const s = porId.get(m.id ?? "");
        if (!s) break;
        // AppSync manda `event` como UN texto JSON por mensaje (no un arreglo): recorrerlo como arreglo iba carácter por
        // carácter. Se aceptan los dos, y un evento publicado doblemente codificado (texto que contiene JSON)
        const crudos: unknown[] = Array.isArray(m.event) ? m.event : m.event != null ? [m.event] : [];
        for (const crudo of crudos) {
          const aviso = leeAviso(crudo);
          if (aviso) s.oyentes.forEach((o) => o.alAvisar(aviso));
        }
        break;
      }
      case "connection_error":
      case "error":
        console.warn(`[tiempo real] ${m.type}: ${JSON.stringify(m.errors ?? m)}`);
        break;
    }
  };
  socket.onclose = (e) => {
    if (ws !== socket) return;
    console.warn(`[tiempo real] conexión cerrada (código ${e.code}${e.reason ? `: ${e.reason}` : ""}); se reintenta`);
    ws = null;
    if (vigilante) clearTimeout(vigilante);
    porCanal.forEach((s) => { s.activa = false; });
    avisaEstado(false);
    programaReconexion();
  };
  socket.onerror = () => socket.close();
}

/** Escucha un canal. Regresa la función para dejar de escucharlo. */
let avisoSinConfigurar = false;

export function suscribe(canal: string, oyente: Oyente): () => void {
  if (!HOST) {
    if (!avisoSinConfigurar) {
      avisoSinConfigurar = true;
      console.info("[tiempo real] sin NEXT_PUBLIC_APPSYNC_EVENTS_HOST en este build: las pantallas se refrescan cada 15 s");
    }
    return () => {};
  }
  if (cierreSinUso) { clearTimeout(cierreSinUso); cierreSinUso = null; }
  let s = porCanal.get(canal);
  if (!s) {
    s = { id: crypto.randomUUID(), canal, oyentes: new Set(), activa: false };
    porCanal.set(canal, s);
    porId.set(s.id, s);
    if (conectado) void enviaSuscripcion(s);
  }
  s.oyentes.add(oyente);
  oyente.alCambiarEstado?.(conectado);
  void conecta();

  return () => {
    const actual = porCanal.get(canal);
    if (!actual) return;
    actual.oyentes.delete(oyente);
    if (actual.oyentes.size > 0) return;
    porCanal.delete(canal);
    porId.delete(actual.id);
    if (ws?.readyState === WebSocket.OPEN && actual.activa) ws.send(JSON.stringify({ type: "unsubscribe", id: actual.id }));
    if (porCanal.size === 0) {
      // Sin suscripciones: se cierra al rato (si la pantalla solo cambió de vista, se reutiliza la conexión)
      cierreSinUso = setTimeout(() => {
        cierreSinUso = null;
        if (porCanal.size === 0) {
          if (reintento) { clearTimeout(reintento); reintento = null; }
          ws?.close(1000, "sin suscripciones");
        }
      }, CIERRE_SIN_USO_MS);
    }
  };
}
