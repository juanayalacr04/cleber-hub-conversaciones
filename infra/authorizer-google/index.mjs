// ---------------------------------------------------------------------------------------------------
// authorizer-google
// ---------------------------------------------------------------------------------------------------
// Lambda authorizer (tipo TOKEN) del API Gateway REST v1 de Cleber (z66x2zyooj).
//
// Valida el id_token de Google que manda el dashboard (NextAuth) y devuelve el email en el contexto, para que la
// integración lo inyecte como X-User-Email hacia PostgREST:
//     integration.request.header.X-User-Email = context.authorizer.email
//
// REST v1 no tiene JWT Authorizer nativo (eso es de HTTP API); por eso es una Lambda (diseño del hub, Q26).
// Sin dependencias: verifica la firma RS256 con node:crypto y las llaves públicas de Google (JWKS).
//
// Variables de entorno:
//   GOOGLE_CLIENT_IDS       Client IDs de OAuth aceptados como audiencia (aud), separados por comas. Obligatoria.
//   ALLOWED_EMAIL_DOMAINS   Dominios de email permitidos, separados por comas (ej. cleber.com,grupocleber.com).
//                           Vacía = cualquier cuenta de Google con email verificado.
//
// Respuesta:
//   Token válido   → política Allow sobre todo el stage (el resultado se cachea por token) y context.email.
//   Token inválido → error "Unauthorized" (API Gateway responde 401; el dashboard manda a /login).
// ---------------------------------------------------------------------------------------------------

import { createPublicKey, verify } from "node:crypto"

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"])
const TOLERANCIA_S = 60   // diferencia de reloj aceptada al revisar exp / iat

// ---------- Llaves públicas de Google (cache en memoria según Cache-Control) ----------

let cacheLlaves = { llaves: new Map(), vence: 0 }

async function descargaLlaves(fetchFn = fetch) {
  const res = await fetchFn(JWKS_URL)
  if (!res.ok) throw new Error(`JWKS de Google respondió ${res.status}`)
  const { keys } = await res.json()
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600)
  return { llaves: new Map(keys.map((k) => [k.kid, k])), vence: Date.now() + maxAge * 1000 }
}

async function llavePorKid(kid, fetchFn) {
  if (Date.now() >= cacheLlaves.vence || !cacheLlaves.llaves.has(kid)) {
    cacheLlaves = await descargaLlaves(fetchFn)   // también si Google rotó las llaves antes de tiempo
  }
  return cacheLlaves.llaves.get(kid)
}

// ---------- Verificación del id_token ----------

const base64url = (s) => Buffer.from(s, "base64url")
const lista = (valor) => (valor ?? "").split(",").map((s) => s.trim()).filter(Boolean)

/**
 * Devuelve los claims del id_token si es válido; si no, lanza un Error con el motivo (va al log, no al cliente).
 * opciones: { audiencias: string[], dominios: string[], obtenLlave?: (kid) => jwk, ahora?: segundos }
 */
export async function verificaIdToken(token, opciones) {
  const { audiencias, dominios = [], ahora = Math.floor(Date.now() / 1000) } = opciones
  const obtenLlave = opciones.obtenLlave ?? ((kid) => llavePorKid(kid))
  if (!audiencias?.length) throw new Error("Falta GOOGLE_CLIENT_IDS")

  const partes = (token ?? "").split(".")
  if (partes.length !== 3) throw new Error("El token no es un JWT")
  const [h, p, s] = partes
  const header = JSON.parse(base64url(h).toString("utf8"))
  if (header.alg !== "RS256" || !header.kid) throw new Error(`Algoritmo no aceptado: ${header.alg}`)

  const jwk = await obtenLlave(header.kid)
  if (!jwk) throw new Error(`Llave desconocida: ${header.kid}`)
  const firmaValida = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: "jwk" }), base64url(s))
  if (!firmaValida) throw new Error("Firma inválida")

  const claims = JSON.parse(base64url(p).toString("utf8"))
  if (!ISSUERS.has(claims.iss)) throw new Error(`Emisor no aceptado: ${claims.iss}`)
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!aud.some((a) => audiencias.includes(a))) throw new Error(`Audiencia no aceptada: ${claims.aud}`)
  if (typeof claims.exp !== "number" || claims.exp + TOLERANCIA_S < ahora) throw new Error("Token vencido")
  if (typeof claims.iat === "number" && claims.iat - TOLERANCIA_S > ahora) throw new Error("Token emitido en el futuro")

  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : ""
  if (!email || claims.email_verified !== true) throw new Error("Email ausente o no verificado")
  if (dominios.length && !dominios.includes(email.split("@")[1])) throw new Error(`Dominio no permitido: ${email}`)
  return { ...claims, email }
}

// ---------- Política ----------

// Allow sobre todo el stage: API Gateway cachea el resultado por token y lo reutiliza en otros métodos y rutas.
// arn:aws:execute-api:<region>:<cuenta>:<api>/<stage>/<metodo>/<ruta> → .../<api>/<stage>/*
export function recursoDelStage(methodArn) {
  const [api, stage] = methodArn.split("/")
  return `${api}/${stage}/*`
}

function politica(email, methodArn) {
  return {
    principalId: email,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "execute-api:Invoke", Effect: "Allow", Resource: recursoDelStage(methodArn) }],
    },
    context: { email },
  }
}

// ---------- Punto de entrada ----------

export const handler = async (event) => {
  const token = (event.authorizationToken ?? "").replace(/^Bearer\s+/i, "").trim()
  try {
    const claims = await verificaIdToken(token, {
      audiencias: lista(process.env.GOOGLE_CLIENT_IDS),
      dominios: lista(process.env.ALLOWED_EMAIL_DOMAINS).map((d) => d.toLowerCase()),
    })
    return politica(claims.email, event.methodArn)
  } catch (e) {
    console.log("authorizer-google - rechazado: %s", e.message)
    throw new Error("Unauthorized")   // API Gateway lo traduce a 401
  }
}
