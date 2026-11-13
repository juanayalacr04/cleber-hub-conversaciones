// Pruebas del authorizer: node --test   (sin red: las llaves se generan aquí)
import { test } from "node:test"
import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { verificaIdToken, recursoDelStage, handler } from "./index.mjs"

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const KID = "llave-prueba"
const JWK = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" }
const AUD = "cliente-prueba.apps.googleusercontent.com"
const AHORA = 1_800_000_000

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
function firma(claims, header = { alg: "RS256", kid: KID, typ: "JWT" }, llave = privateKey) {
  const datos = `${b64(header)}.${b64(claims)}`
  return `${datos}.${sign("RSA-SHA256", Buffer.from(datos), llave).toString("base64url")}`
}
const claimsBase = {
  iss: "https://accounts.google.com", aud: AUD, email: "Ana@Cleber.com", email_verified: true,
  iat: AHORA - 10, exp: AHORA + 3600, sub: "123",
}
const opciones = { audiencias: [AUD], obtenLlave: async (kid) => (kid === KID ? JWK : undefined), ahora: AHORA }

test("token válido: devuelve el email en minúsculas", async () => {
  const claims = await verificaIdToken(firma(claimsBase), opciones)
  assert.equal(claims.email, "ana@cleber.com")
})

test("emisor sin https también es de Google", async () => {
  await verificaIdToken(firma({ ...claimsBase, iss: "accounts.google.com" }), opciones)
})

const rechazos = [
  ["vencido", firma({ ...claimsBase, exp: AHORA - 120 }), /vencido/],
  ["otra audiencia", firma({ ...claimsBase, aud: "otro-cliente" }), /Audiencia/],
  ["otro emisor", firma({ ...claimsBase, iss: "https://evil.example" }), /Emisor/],
  ["email no verificado", firma({ ...claimsBase, email_verified: false }), /verificado/],
  ["sin email", firma({ ...claimsBase, email: undefined }), /verificado/],
  ["algoritmo none", firma(claimsBase, { alg: "none", kid: KID }), /Algoritmo/],
  ["llave desconocida", firma(claimsBase, { alg: "RS256", kid: "otra" }), /Llave/],
  ["firmado con otra llave", firma(claimsBase, undefined, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey), /Firma/],
  ["emitido en el futuro", firma({ ...claimsBase, iat: AHORA + 600 }), /futuro/],
  ["no es JWT", "abc.def", /JWT/],
]
for (const [caso, token, motivo] of rechazos) {
  test(`rechaza: ${caso}`, async () => {
    await assert.rejects(() => verificaIdToken(token, opciones), motivo)
  })
}

test("payload alterado invalida la firma", async () => {
  const [h, , s] = firma(claimsBase).split(".")
  await assert.rejects(() => verificaIdToken(`${h}.${b64({ ...claimsBase, email: "otro@cleber.com" })}.${s}`, opciones), /Firma/)
})

test("dominios permitidos", async () => {
  await verificaIdToken(firma(claimsBase), { ...opciones, dominios: ["cleber.com"] })
  await assert.rejects(() => verificaIdToken(firma(claimsBase), { ...opciones, dominios: ["grupocleber.com"] }), /Dominio/)
})

test("sin audiencias configuradas falla cerrado", async () => {
  await assert.rejects(() => verificaIdToken(firma(claimsBase), { ...opciones, audiencias: [] }), /GOOGLE_CLIENT_IDS/)
})

test("la política cubre todo el stage", () => {
  assert.equal(recursoDelStage("arn:aws:execute-api:us-east-1:111:z66x2zyooj/v3/POST/toma-unidades/rpc/consulta_ofertas"),
               "arn:aws:execute-api:us-east-1:111:z66x2zyooj/v3/*")
})

test("handler: token inválido responde Unauthorized (401)", async () => {
  process.env.GOOGLE_CLIENT_IDS = AUD
  await assert.rejects(() => handler({ type: "TOKEN", authorizationToken: "Bearer basura", methodArn: "arn:x:y/v3/POST/a" }),
                       /^Error: Unauthorized$/)
})
