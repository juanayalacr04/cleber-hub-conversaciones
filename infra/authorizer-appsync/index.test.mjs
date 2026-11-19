// Pruebas del authorizer de AppSync: node --test   (sin red: las llaves se generan aquí y PostgREST es falso)
import { test } from "node:test"
import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { autoriza, configDe, consultaPermiso, funcionDe } from "./index.mjs"
import { verificaIdToken } from "./google.mjs"

const AHORA = 1_800_000_000
const config = configDe({
  GOOGLE_CLIENT_IDS: "cliente",
  NAMESPACES: JSON.stringify({ hub: { schema: "hub_cleber", accion: "Hub.autorizaCanal" } }),
  URL_API_DB: "http://postgrest:3000/",
  CLEBER_API_KEY: "clave",
})
const verifica = async (token) => {
  if (token !== "bueno") throw new Error("Firma inválida")
  return { email: "ana@cleber.com", exp: AHORA + 3600 }
}
const evento = (operation, channel = null, token = "Bearer bueno") => ({
  authorizationToken: token,
  requestContext: { apiId: "api", accountId: "111", requestId: "r", operation,
                    channelNamespaceName: channel ? channel.split("/")[1] : null, channel },
  requestHeaders: {},
})
const deps = (consulta) => ({ config, verifica, consulta, ahora: AHORA })

test("conectar: basta el token válido", async () => {
  const r = await autoriza(evento("EVENT_CONNECT"), deps(async () => assert.fail("no debe consultar")))
  assert.deepEqual(r, { isAuthorized: true, ttlOverride: 300, handlerContext: { email: "ana@cleber.com" } })
})

test("token inválido: rechazado y sin caché", async () => {
  assert.deepEqual(await autoriza(evento("EVENT_CONNECT", null, "malo"), deps()), { isAuthorized: false, ttlOverride: 0 })
})

test("suscribirse: decide la función del namespace, con el canal y el email", async () => {
  let recibido
  const r = await autoriza(evento("EVENT_SUBSCRIBE", "/hub/TOYOTA/valuacion"),
                           deps(async (args) => { recibido = args; return true }))
  assert.equal(r.isAuthorized, true)
  assert.equal(recibido.ns.accion, "Hub.autorizaCanal")
  assert.equal(recibido.canal, "/hub/TOYOTA/valuacion")
  assert.equal(recibido.email, "ana@cleber.com")
})

test("suscribirse sin permiso: rechazado, con caché corto", async () => {
  const r = await autoriza(evento("EVENT_SUBSCRIBE", "/hub/TOYOTA/valuacion"), deps(async () => false))
  assert.deepEqual(r, { isAuthorized: false, ttlOverride: 60 })
})

test("namespace sin configurar: rechazado sin consultar", async () => {
  const r = await autoriza(evento("EVENT_SUBSCRIBE", "/otro/x"), deps(async () => assert.fail("no debe consultar")))
  assert.equal(r.isAuthorized, false)
})

test("publicar desde una pantalla: siempre rechazado", async () => {
  const r = await autoriza(evento("EVENT_PUBLISH", "/hub/TOYOTA/valuacion"), deps(async () => true))
  assert.equal(r.isAuthorized, false)
})

test("falla al consultar: rechazado y sin caché", async () => {
  const r = await autoriza(evento("EVENT_SUBSCRIBE", "/hub/TOYOTA/valuacion"), deps(async () => { throw new Error("sin red") }))
  assert.deepEqual(r, { isAuthorized: false, ttlOverride: 0 })
})

test("el caché no pasa del vencimiento del token", async () => {
  const r = await autoriza(evento("EVENT_CONNECT"), { config, ahora: AHORA, verifica: async () => ({ email: "a@b.c", exp: AHORA + 90 }) })
  assert.equal(r.ttlOverride, 90)
})

test("funcionDe convierte la acción al nombre de PostgREST", () => {
  assert.equal(funcionDe("Hub.autorizaCanal"), "autoriza_canal")
})

// ---------- consultaPermiso contra un PostgREST falso ----------

const fetchFalso = (respuesta, status = 200) => {
  const llamadas = []
  const fn = async (url, init) => {
    llamadas.push({ url, init })
    return { ok: status < 400, status, json: async () => respuesta }
  }
  return { fn, llamadas }
}
const ns = config.namespaces.hub
const args = { config, ns, canal: "/hub/TOYOTA/valuacion", operacion: "EVENT_SUBSCRIBE", email: "ana@cleber.com" }

test("consultaPermiso: llama la rpc con el schema, el email y el envelope", async () => {
  const { fn, llamadas } = fetchFalso({ successful: true, info: { autorizado: true } })
  assert.equal(await consultaPermiso({ ...args, fetchFn: fn }), true)
  const { url, init } = llamadas[0]
  assert.equal(url, "http://postgrest:3000/rpc/autoriza_canal")
  assert.equal(init.headers["Content-Profile"], "hub_cleber")
  assert.equal(init.headers["X-User-Email"], "ana@cleber.com")
  assert.equal(init.headers["x-api-key"], "clave")
  assert.deepEqual(JSON.parse(init.body), { action: "Hub.autorizaCanal", params: { canal: "/hub/TOYOTA/valuacion", operacion: "EVENT_SUBSCRIBE" } })
})

test("consultaPermiso: rechazo de negocio (usuario no registrado) = no autorizado", async () => {
  const { fn } = fetchFalso({ successful: false, errorCode: "SIN_PERMISO" })
  assert.equal(await consultaPermiso({ ...args, fetchFn: fn }), false)
})

test("consultaPermiso: autorizado distinto de true = no autorizado", async () => {
  const { fn } = fetchFalso({ successful: true, info: { autorizado: "true" } })
  assert.equal(await consultaPermiso({ ...args, fetchFn: fn }), false)
})

test("consultaPermiso: HTTP de error es falla técnica", async () => {
  const { fn } = fetchFalso({}, 502)
  await assert.rejects(() => consultaPermiso({ ...args, fetchFn: fn }), /502/)
})

// ---------- Token de Google (lo mismo que prueba authorizer-google) ----------

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "k", alg: "RS256", use: "sig" }
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
const firma = (claims) => {
  const datos = `${b64({ alg: "RS256", kid: "k" })}.${b64(claims)}`
  return `${datos}.${sign("RSA-SHA256", Buffer.from(datos), privateKey).toString("base64url")}`
}
const opciones = { audiencias: ["cliente"], obtenLlave: async (kid) => (kid === "k" ? JWK : undefined), ahora: AHORA }
const claims = { iss: "https://accounts.google.com", aud: "cliente", email: "Ana@Cleber.com", email_verified: true, iat: AHORA, exp: AHORA + 3600 }

test("google: token válido da el email en minúsculas", async () => {
  assert.equal((await verificaIdToken(firma(claims), opciones)).email, "ana@cleber.com")
})

test("google: token vencido se rechaza", async () => {
  await assert.rejects(() => verificaIdToken(firma({ ...claims, exp: AHORA - 120 }), opciones), /vencido/)
})
