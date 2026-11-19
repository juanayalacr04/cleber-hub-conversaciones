// ---------------------------------------------------------------------------------------------------
// authorizer-appsync
// ---------------------------------------------------------------------------------------------------
// Lambda authorizer (AWS_LAMBDA) genérico de AppSync Events para los sistemas de Cleber.
//
// Quién es: valida el id_token de Google que manda la pantalla (el mismo que usa el API Gateway).
// Qué puede escuchar: no lo decide aquí. Cada namespace de AppSync tiene una función en PostgREST que lo decide con
// las reglas de su sistema (convención `<Prefijo>.autorizaCanal`); este authorizer solo la llama con el email del
// token en X-User-Email. Agregar un sistema = su namespace en AppSync, su función en la base y una entrada en
// NAMESPACES; el código no cambia.
//
//   EVENT_CONNECT     token válido → autorizado (no hay canal todavía)
//   EVENT_SUBSCRIBE   token válido y la función del namespace responde { autorizado: true }
//   EVENT_PUBLISH     siempre rechazado: publica solo el backend, con IAM (el namespace usa IAM para publicar)
//
// Función de cada namespace (PostgREST, rpc con Prefer: params=single-object):
//   Petición:  { action: "<Prefijo>.autorizaCanal", params: { canal, operacion } }   con X-User-Email = email del token
//   Respuesta: { successful: true, info: { autorizado: boolean, motivo?: string } }
//   Cualquier otra respuesta (rechazo, error, sin conexión) = no autorizado.
//
// Caché: AppSync guarda la respuesta por API, operación, canal y token. Un permiso concedido dura TTL_SEGUNDOS (sin
// pasar del vencimiento del token); los rechazos por falla técnica no se guardan (ttlOverride 0).
//
// Variables de entorno:
//   GOOGLE_CLIENT_IDS       Client IDs de OAuth aceptados como audiencia (aud), separados por comas. Obligatoria.
//   ALLOWED_EMAIL_DOMAINS   Dominios de email permitidos, separados por comas. Vacía = cualquiera con email verificado.
//   NAMESPACES              JSON: { "<namespace>": { "schema": "<schema de PostgREST>", "accion": "<Prefijo>.autorizaCanal" } }
//                           ej. {"hub":{"schema":"hub_cleber","accion":"Hub.autorizaCanal"}}
//   URL_API_DB              Base de PostgREST (con o sin "/" final).
//   CLEBER_API_KEY          x-api-key hacia PostgREST (opcional si la ruta no la pide).
//   TTL_SEGUNDOS            Caché de un permiso concedido (default 300).
// ---------------------------------------------------------------------------------------------------

import { verificaIdToken } from "./google.mjs"

const lista = (valor) => (valor ?? "").split(",").map((s) => s.trim()).filter(Boolean)

// 'Hub.autorizaCanal' → 'autoriza_canal' (nombre de la función en PostgREST)
export function funcionDe(accion) {
  const nombre = String(accion ?? "").split(".")[1]
  if (!nombre) throw new Error(`Acción sin prefijo: ${accion}`)
  return nombre.replace(/([A-Z])/g, "_$1").toLowerCase()
}

export function configDe(env = process.env) {
  let namespaces = {}
  try {
    namespaces = JSON.parse(env.NAMESPACES || "{}")
  } catch {
    console.error("authorizer-appsync: NAMESPACES no es JSON válido; se rechaza toda suscripción")
  }
  return {
    audiencias: lista(env.GOOGLE_CLIENT_IDS),
    dominios: lista(env.ALLOWED_EMAIL_DOMAINS).map((d) => d.toLowerCase()),
    namespaces,
    urlApiDb: (env.URL_API_DB ?? "").trim().replace(/\/+$/, ""),
    apiKey: (env.CLEBER_API_KEY ?? "").trim(),
    ttl: Number.parseInt(env.TTL_SEGUNDOS ?? "", 10) || 300,
  }
}

/** Pregunta a la función del namespace si el email puede hacer `operacion` en `canal`. true / false; lanza por falla técnica. */
export async function consultaPermiso({ config, ns, canal, operacion, email, fetchFn = fetch }) {
  if (!config.urlApiDb) throw new Error("Falta URL_API_DB")
  const headers = {
    "Content-Type": "application/json",
    "Prefer": "params=single-object",
    "Content-Profile": ns.schema,
    "X-User-Email": email,
  }
  if (config.apiKey) headers["x-api-key"] = config.apiKey
  const res = await fetchFn(`${config.urlApiDb}/rpc/${funcionDe(ns.accion)}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: ns.accion, params: { canal, operacion } }),
    signal: AbortSignal.timeout(4000),
  })
  if (!res.ok) throw new Error(`PostgREST respondió ${res.status}`)
  const datos = await res.json()
  if (!datos?.successful) {
    // Rechazo de negocio (p. ej. SIN_PERMISO: usuario no registrado): no autorizado, sin ser falla técnica
    console.log("authorizer-appsync - %s rechazó a %s en %s: %s", ns.accion, email, canal, datos?.errorCode)
    return false
  }
  if (datos.info?.autorizado !== true) {
    console.log("authorizer-appsync - %s en %s: %s", email, canal, datos.info?.motivo ?? "no autorizado")
  }
  return datos.info?.autorizado === true
}

const permitido = (email, ttl) => ({ isAuthorized: true, ttlOverride: ttl, handlerContext: { email } })
const rechazado = (ttl = 0) => ({ isAuthorized: false, ttlOverride: ttl })

/**
 * Decide un evento del authorizer de AppSync Events.
 * deps (para pruebas): { config, verifica: (token) => claims, consulta: (args) => boolean, ahora: segundos }
 */
export async function autoriza(event, deps = {}) {
  const config = deps.config ?? configDe()
  const ahora = deps.ahora ?? Math.floor(Date.now() / 1000)
  const verifica = deps.verifica ?? ((token) => verificaIdToken(token, { audiencias: config.audiencias, dominios: config.dominios }))
  const consulta = deps.consulta ?? consultaPermiso

  const { operation: operacion, channelNamespaceName: namespace, channel: canal } = event?.requestContext ?? {}
  const token = String(event?.authorizationToken ?? "").replace(/^Bearer\s+/i, "").trim()

  let claims
  try {
    claims = await verifica(token)
  } catch (e) {
    console.log("authorizer-appsync - token rechazado (%s): %s", operacion, e.message)
    return rechazado()
  }
  // Un permiso guardado en caché no debe sobrevivir al token
  const ttl = Math.max(0, Math.min(config.ttl, (claims.exp ?? ahora) - ahora))

  if (operacion === "EVENT_CONNECT") return permitido(claims.email, ttl)
  if (operacion !== "EVENT_SUBSCRIBE") {
    console.log("authorizer-appsync - operación no permitida a pantallas: %s (%s)", operacion, claims.email)
    return rechazado(ttl)
  }

  const ns = config.namespaces?.[namespace]
  if (!ns?.schema || !ns?.accion) {
    console.log("authorizer-appsync - namespace sin configurar: %s", namespace)
    return rechazado(ttl)
  }
  try {
    const autorizado = await consulta({ config, ns, canal, operacion, email: claims.email })
    return autorizado ? permitido(claims.email, ttl) : rechazado(Math.min(ttl, 60))
  } catch (e) {
    console.error("authorizer-appsync - no se pudo consultar el permiso de %s en %s: %s", claims.email, canal, e.message)
    return rechazado()
  }
}

export const handler = (event) => autoriza(event)
