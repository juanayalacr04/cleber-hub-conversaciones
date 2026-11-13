import { auth } from "@/lib/auth";

/**
 * Cliente HTTP hacia el API Gateway de Cleber (template-para-desarrollo, lib/api.ts). SOLO SERVIDOR:
 * Server Components, Route Handlers y Server Actions. La API key y el id_token nunca llegan al navegador.
 *
 *   const r = await api.call<{ ofertas: Oferta[] }>("toma-unidades", "consulta_ofertas", "Valuacion.consultaOfertas", { idAgencia })
 *   if (!r.successful) { ... r.errorCode ... }
 *
 * Cada ruta del gateway apunta a un schema fijo (Arquitectura/GUIA_API_GATEWAY.md): `toma-unidades` → valuacion,
 * `hub` → hub_cleber. La función es la de PostgREST (`rpc/<funcion>`) y `action` la del envelope { action, params }.
 *
 * Errores HTTP (autenticacion.md): 401 → SESION_EXPIRADA (volver a /login), 403 → CONFIGURACION (API key).
 */

export type ApiResponse<T> =
  | { successful: true; info: T }
  | { successful: false; errorCode: string; errorMessage: string; info?: unknown };

export type RutaApi = "toma-unidades" | "hub";

// El authorizer lee el token de este header. X-Id-Token y no Authorization: con proxy integration el gateway reenvía
// Authorization a PostgREST, que lo intenta validar como JWT propio y responde PGRST300 ("Server lacks JWT secret").
// Verificado en dev el 2026-11-13 (guía, paso 6; PENDIENTES_INFRA_DEV.md, V2).
const HEADER_TOKEN = process.env.API_GATEWAY_TOKEN_HEADER || "X-Id-Token";

async function call<T>(ruta: RutaApi, funcion: string, action: string, params: Record<string, unknown> = {}): Promise<ApiResponse<T>> {
  const base = process.env.API_GATEWAY_URL;
  const key = process.env.API_GATEWAY_KEY;
  if (!base || !key) {
    return { successful: false, errorCode: "CONFIGURACION", errorMessage: "Falta API_GATEWAY_URL o API_GATEWAY_KEY" };
  }

  const session = await auth();
  if (!session?.idToken || session.error) {
    return { successful: false, errorCode: "SESION_EXPIRADA", errorMessage: "Inicia sesión de nuevo" };
  }

  let res: Response;
  try {
    res = await fetch(`${base}/${ruta}/rpc/${funcion}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "params=single-object",
        "x-api-key": key,
        [HEADER_TOKEN]: HEADER_TOKEN.toLowerCase() === "authorization" ? `Bearer ${session.idToken}` : session.idToken,
      },
      body: JSON.stringify({ action, params }),
      cache: "no-store",
    });
  } catch (e) {
    console.error(`api.call ${ruta}/${funcion}: sin respuesta`, e);
    return { successful: false, errorCode: "SIN_CONEXION", errorMessage: "No se pudo contactar al servidor" };
  }

  if (res.status === 401) return { successful: false, errorCode: "SESION_EXPIRADA", errorMessage: "Inicia sesión de nuevo" };
  if (res.status === 403) {
    console.error(`api.call ${ruta}/${funcion}: 403 (API key o ruta)`);
    return { successful: false, errorCode: "CONFIGURACION", errorMessage: "Error de configuración del servidor" };
  }
  if (!res.ok) {
    console.error(`api.call ${ruta}/${funcion}: HTTP ${res.status}`, await res.text().catch(() => ""));
    return { successful: false, errorCode: `HTTP_${res.status}`, errorMessage: `Error HTTP ${res.status}` };
  }
  return res.json();
}

export const api = { call };
