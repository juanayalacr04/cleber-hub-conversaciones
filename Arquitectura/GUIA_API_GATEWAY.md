# Guía — API Gateway para el hub y valuación

Configura en el **API Gateway REST v1 de Cleber** (`z66x2zyooj`, stage `v3`, `us-east-1`) lo que necesita el dashboard para llegar a PostgreSQL con la identidad del usuario:

```
Dashboard (Next.js, servidor) ── id_token de Google + x-api-key ──► API Gateway z66x2zyooj
                                                                     │ Lambda authorizer (authorizer-google)
                                                                     │   valida el token → context.email
                                                                     │ X-User-Email ← context.email
                                                                     │ Content-Profile ← schema fijo de la ruta
                                                                     ▼
                                              VPC Link g55dvn → NLB → PostgREST :3000 → plpgsql
```

Diseño: [`DISENO_MIGRACION_POSTGRES.md`](DISENO_MIGRACION_POSTGRES.md) §3 y §4 (Q1, Q3, Q26, Q27). Convenciones: `template-para-desarrollo/docs/infraestructura.md` y `autenticacion.md`.

**Diferencias con el template** (se proponen al dueño del template, §12 del diseño):
- El template habla de "JWT Authorizer", pero ese tipo **solo existe en HTTP API**. `z66x2zyooj` es REST v1, así que el authorizer es una **Lambda** (`infra/authorizer-google/`).
- El template dice que el vencimiento del `id_token` (1 hora) no afecta al usuario. Sí afecta: el authorizer rechaza tokens vencidos. El login del dashboard refresca el `id_token` con el refresh token de Google antes de que venza.

Rutas que crea esta guía:

| Ruta | Schema (`Content-Profile`) | Quién la usa |
|------|----------------------------|--------------|
| `/toma-unidades/{proxy+}` | `valuacion` | Pantallas de valuación |
| `/hub/{proxy+}` | `hub_cleber` | Dashboard (usuarios, organizaciones; después el resto) y backend reenviando el token del usuario |

`/internal/{proxy+}` (IAM, para máquinas) **no** es parte de esta guía.

---

## Paso 0 — Cliente OAuth de Google

En **Google Cloud Console**, proyecto **`ambiente-desarrollo-ti`** (el mismo del Firebase del hub: así `signInWithCredential` acepta el token sin configuración extra).

1. *APIs y servicios → Pantalla de consentimiento de OAuth*: tipo **Interno** si todas las cuentas son del Workspace de Cleber.
2. *Credenciales → Crear credenciales → ID de cliente de OAuth → Aplicación web*. Nombre: `hub-conversaciones-dev`.
3. URIs de redireccionamiento autorizados:
   - `http://localhost:3000/api/auth/callback/google` (orígenes de JavaScript: `http://localhost:3000`)
   - la URL del dashboard en Vercel + `/api/auth/callback/google`, cuando exista
4. Guarda el **Client ID** (es la *audiencia* que valida el authorizer) y el **Client secret** (solo para NextAuth, nunca en el repo).

## Paso 1 — Lambda `authorizer-google`

Código: `infra/authorizer-google/index.mjs` (sin dependencias). Pruebas: `cd infra/authorizer-google && node --test`.

1. *Lambda → Crear función*: nombre `authorizer-google`, runtime **Node.js 22.x**, arquitectura x86_64 o arm64.
2. Sube `index.mjs` (y `package.json`) en un zip. Handler: `index.handler`.
3. **Sin VPC.** Necesita salir a internet para descargar las llaves públicas de Google (`https://www.googleapis.com/oauth2/v3/certs`). Si se pone en VPC, requiere NAT.
4. Variables de entorno:

   | Variable | Valor |
   |----------|-------|
   | `GOOGLE_CLIENT_IDS` | Client ID del paso 0 (si hay varios ambientes, separados por comas) |
   | `ALLOWED_EMAIL_DOMAINS` | Opcional: `cleber.com,grupocleber.com`. Vacía = cualquier cuenta de Google verificada (plpgsql igual rechaza a quien no esté en `hub_cleber.usuarios`) |

5. Timeout: 5 s. Memoria: 128 MB.

## Paso 2 — Authorizer en el API

*API Gateway → API CLEBER (`z66x2zyooj`) → Authorizers → Create New Authorizer*:

| Campo | Valor |
|-------|-------|
| Name | `google-id-token` |
| Type | **Lambda** |
| Lambda Function | `authorizer-google` |
| Lambda Event Payload | **Token** |
| Token Source | `Authorization` |
| Token Validation | `^Bearer [-0-9A-Za-z\._]+$` |
| Authorization Caching | Activado, TTL **300** s |

Acepta el permiso para que API Gateway invoque la Lambda.

## Paso 3 — Ruta `/toma-unidades/{proxy+}`

1. *Resources → `/` → Create Resource*: `toma-unidades`. Dentro, *Create Resource* con **proxy resource** activado: `{proxy+}`.
2. En `/{proxy+}` borra el método `ANY` que se crea solo y crea **POST**:
   - Integration type: **VPC Link**, **Use Proxy Integration** activado.
   - Method: `POST`. VPC Link: `g55dvn` (`Svcs-Privados-API-CLEBER-VPCL`).
   - Endpoint URL: `http://Svcs-Privados-API-CLEBER-NLB-7f3d7dcabf386d67.elb.us-east-1.amazonaws.com:3000/{proxy}`
3. **Method Request**:
   - Authorization: `google-id-token`
   - API Key Required: **true**
   - Request Paths: `proxy`
4. **Integration Request → URL Path Parameters**: `proxy` = `method.request.path.proxy`
5. **Integration Request → HTTP Headers** (sobrescriben lo que mande el cliente):

   | Name | Mapped from |
   |------|-------------|
   | `X-User-Email` | `context.authorizer.email` |
   | `Content-Profile` | `'valuacion'` (con comillas simples: valor fijo) |
   | `Accept-Profile` | `'valuacion'` |

   Fijar el schema en la ruta evita que alguien use `/toma-unidades` para llamar funciones de otro schema.

## Paso 4 — Ruta `/hub/{proxy+}`

Igual que el paso 3, con el recurso `hub` y `Content-Profile` / `Accept-Profile` = `'hub_cleber'`.

## Paso 5 — API key y despliegue

1. *API Keys → Create*: `hub-conversaciones-dev`. Agrégala al **usage plan** del stage `v3`.
2. *Resources → Deploy API* → stage `v3`.
3. La key va en `API_GATEWAY_KEY` del dashboard (solo servidor, nunca `NEXT_PUBLIC_*`).

## Paso 6 — PostgREST

- Que exponga los schemas `valuacion` y `hub_cleber` (`db-schemas`) y que su rol tenga los grants (los das tú).
- **Verificar el header `Authorization`.** Con proxy integration, API Gateway reenvía a PostgREST el `Authorization: Bearer <id_token de Google>`. Si PostgREST tiene `jwt-secret` configurado, intentará validarlo y responderá 401. Si no lo tiene, puede responder `PGRST300`. La prueba del paso 7 lo muestra. Si pasa:
  - **Opción A:** en *Integration Request → HTTP Headers* mapea `Authorization` a un valor fijo que PostgREST acepte (por ejemplo, un JWT de servicio del rol anónimo).
  - **Opción B:** cambia el *Token Source* del authorizer a `X-Id-Token` y en el dashboard `API_GATEWAY_TOKEN_HEADER=X-Id-Token`. `lib/api.ts` lo soporta: así `Authorization` no viaja.

## Paso 7 — Verificación

Un `id_token` de prueba, mientras el login del dashboard no esté listo: en **solo dev**, agrega temporalmente a `GOOGLE_CLIENT_IDS` la audiencia de gcloud (`32555940559.apps.googleusercontent.com`) y usa:

```powershell
$TOKEN = gcloud auth print-identity-token
$KEY   = "<API key>"
$URL   = "https://z66x2zyooj.execute-api.us-east-1.amazonaws.com/v3"
```

1. **Identidad** (debe responder `successful: true` con tu email):
   ```powershell
   curl.exe -s -X POST "$URL/hub/rpc/consulta_usuario_actual" -H "Authorization: Bearer $TOKEN" -H "x-api-key: $KEY" `
     -H "Content-Type: application/json" -H "Prefer: params=single-object" -d '{\"action\":\"Hub.consultaUsuarioActual\",\"params\":{}}'
   ```
2. **El email no se puede suplantar** (pendiente §12 del diseño): repite el 1 agregando `-H "X-User-Email: otra@cleber.com"`. La respuesta debe traer **tu** email.
3. **Sin token → 401** y **sin API key → 403**.
4. **Valuación**:
   ```powershell
   curl.exe -s -X POST "$URL/toma-unidades/rpc/consulta_ofertas" -H "Authorization: Bearer $TOKEN" -H "x-api-key: $KEY" `
     -H "Content-Type: application/json" -H "Prefer: params=single-object" -d '{\"action\":\"Valuacion.consultaOfertas\",\"params\":{}}'
   ```
5. **El schema de la ruta es fijo**: `POST $URL/toma-unidades/rpc/consulta_usuario_actual` debe fallar (la función no existe en `valuacion`).

Al terminar, **quita la audiencia de gcloud** de `GOOGLE_CLIENT_IDS`.

## Variables del dashboard

| Variable | Valor |
|----------|-------|
| `API_GATEWAY_URL` | `https://z66x2zyooj.execute-api.us-east-1.amazonaws.com/v3` |
| `API_GATEWAY_KEY` | key del paso 5 |
| `API_GATEWAY_TOKEN_HEADER` | `Authorization` (default) o `X-Id-Token` (paso 6, opción B) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | paso 0 |
| `AUTH_SECRET` | `openssl rand -base64 32` |
