// ---------------------------------------------------------------------------------------------------
// Verificación del id_token de Google, sin dependencias (firma RS256 con node:crypto y las llaves públicas de Google).
// Misma lógica que infra/authorizer-google/index.mjs: cuando los dos authorizers vivan en su propio repo, comparten
// este módulo.
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

const base64url = (s) => Buffer.from(s, "base64url")

/**
 * Devuelve los claims del id_token si es válido (con `email` en minúsculas); si no, lanza un Error con el motivo
 * (va al log, no al cliente).
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
