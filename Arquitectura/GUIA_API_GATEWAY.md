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

Antes de configurar, lee **[Diferencias con el template](#diferencias-con-el-template)** al final: el template pide un "JWT Authorizer" que no existe en este tipo de API Gateway, y aquí se explica qué se tomó del template y qué se decidió aparte.

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

La función se crea y se actualiza con **`infra/authorizer-google/deploy.ps1`** (mismo patrón que `toma-unidades-en-taller/deploy.ps1`). El script arma el zip y crea o actualiza la función; las pruebas se corren aparte, antes de desplegar. Características:

| Característica | Valor |
|----------------|-------|
| Nombre | `authorizer-google-dev` (dev) / `authorizer-google` (prd) |
| Runtime / arquitectura | **Node.js 24.x / arm64** |
| Handler | `index.handler` |
| Timeout / memoria | 5 s / 128 MB |
| VPC | **Ninguna.** Necesita salir a internet para descargar las llaves públicas de Google (`https://www.googleapis.com/oauth2/v3/certs`). En VPC requeriría NAT |
| Rol | Uno con la política administrada `AWSLambdaBasicExecutionRole` (solo escribe logs); créalo antes en IAM |

Variables de entorno. Se configuran en la consola (*Lambda → Configuration → Environment variables*) o, opcionalmente, con los parámetros del script. **Mientras `GOOGLE_CLIENT_IDS` no exista, el authorizer rechaza todo.**

| Variable | Parámetro (opcional) | Valor |
|----------|----------------------|-------|
| `GOOGLE_CLIENT_IDS` | `-GoogleClientIds` | Client ID del paso 0 (varios, separados por comas) |
| `ALLOWED_EMAIL_DOMAINS` | `-DominiosPermitidos` | Opcional: `cleber.com,grupocleber.com`. Vacía = cualquier cuenta de Google verificada (plpgsql igual rechaza a quien no esté en `hub_cleber.usuarios`) |

Desde `infra/authorizer-google`:

```powershell
# Pruebas (antes de desplegar)
node --test

# Crear (la primera vez); las variables se ponen después en la consola
.\deploy.ps1 dev -Perfil AWSPowerUserAccess-386458449724 -RolArn <arn del rol>

# O crear con variables y con permiso para el API Gateway (-ApiId; también se puede dar en el paso 2)
.\deploy.ps1 dev -Perfil AWSPowerUserAccess-386458449724 -RolArn <arn del rol> `
    -GoogleClientIds <client id del paso 0> -ApiId z66x2zyooj

# Actualizar el código después de un cambio
.\deploy.ps1 dev -Perfil AWSPowerUserAccess-386458449724

# Cambiar las variables (reemplaza las dos)
.\deploy.ps1 dev -Perfil AWSPowerUserAccess-386458449724 -GoogleClientIds "<id 1>,<id 2>" -DominiosPermitidos "cleber.com"

# Solo generar el zip, sin tocar AWS
.\deploy.ps1 dev -SoloEmpaquetar
```

Para `prd` el script pide confirmación escribiendo `prd`.

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

---

## Diferencias con el template

Para revisar con el responsable del API Gateway y con el dueño de `template-para-desarrollo` (§12 del diseño).

### Qué hace el authorizer

Es una Lambda (`infra/authorizer-google/index.mjs`) que API Gateway ejecuta **antes** de dejar pasar una petición a PostgREST. Recibe el `id_token` de Google que manda el dashboard y revisa, en orden:

1. Que sea un JWT firmado con RS256.
2. **La firma**, con las llaves públicas de Google (`https://www.googleapis.com/oauth2/v3/certs`, en caché según su `Cache-Control`). Si alguien altera el token, por ejemplo el correo, la firma no cuadra.
3. El **emisor** (`iss` = `accounts.google.com`) y la **audiencia** (`aud` = un Client ID de `GOOGLE_CLIENT_IDS`): un token de Google emitido para otra aplicación no sirve.
4. Que **no haya vencido** (`exp`), con 60 s de tolerancia de reloj.
5. Que traiga **correo verificado** (`email`, `email_verified = true`).
6. Opcional: que el correo sea de un dominio de `ALLOWED_EMAIL_DOMAINS`.

Si todo pasa, responde una política *Allow* con `context.email`; la integración lo pone en `X-User-Email`. Si algo falla, API Gateway responde **401** y la petición no llega a PostgREST.

### Lo que viene del template

| Qué | Dónde lo dice el template |
|-----|---------------------------|
| Login con NextAuth v5 + Google; el `id_token` viaja en cada llamada al API Gateway | `autenticacion.md`, "Flujo objetivo" |
| API Gateway valida el token antes de llegar a PostgREST | `autenticacion.md`, "Flujo objetivo" |
| Lo que se valida: `iss` = Google, `aud` = Client ID, `exp`, `email`, `email_verified` | `autenticacion.md`, "Claims JWT que usa el API Gateway" |
| El correo se inyecta como `X-User-Email` y solo lo pone el gateway; plpgsql no decodifica el token | `autenticacion.md`, "Reglas de seguridad" |
| Un solo authorizer en `z66x2zyooj`, asignado a cada ruta nueva de sistema | `infraestructura.md`, "Pasos al agregar un sistema nuevo" |
| API key por sistema **además** del authorizer | `infraestructura.md`, "API Keys" |
| Restringir a dominio corporativo es opcional | `autenticacion.md`, "Dominios permitidos" |
| Lambdas en Node.js (el template dice 22; el authorizer usa **24 y arm64**, como la Lambda de valuación) | `infraestructura.md`, "Lambda functions" |

### Lo que no coincide con el template

| El template dice | Lo que pasa | Qué se hizo |
|------------------|-------------|-------------|
| "API Gateway valida el JWT con el **JWT Authorizer** de AWS" (con *Issuer* y *Audience*) | El JWT Authorizer solo existe en **HTTP API**. `z66x2zyooj` es **REST v1** (confirmado). En REST v1 los authorizers son *Lambda* o *Cognito* | El mismo qué (validar el `id_token` de Google e inyectar el correo), hecho como **Lambda authorizer** (diseño, Q26) |
| El ejemplo de `infraestructura.md` describe un **HTTP API** con JWT Authorizer y, a la vez, **API keys** en todos los endpoints | HTTP API **no tiene API keys ni usage plans**: las dos cosas no pueden convivir en un HTTP API | Se queda REST v1 (tiene API keys) con Lambda authorizer |
| "La expiración del `id_token` de Google a la hora no afecta al usuario porque NextAuth reutiliza el último `id_token`" | El authorizer (y cualquier JWT Authorizer) **rechaza tokens vencidos** con 401: después de una hora, todas las llamadas fallarían | El login pide refresh token (`access_type=offline`) y renueva el `id_token` 5 min antes de que venza (`apps/web/src/lib/auth.ts`) |

### Decisiones propias (el template no las cubre)

| Decisión | Por qué | Base |
|----------|---------|------|
| Lambda authorizer tipo **Token** que devuelve política + `context.email` | Forma estándar de AWS para REST v1 | Documentación de AWS de Lambda authorizers |
| Verificar la firma con `node:crypto`, **sin librerías** | `API/build/build.sh` del repo `api` empaqueta solo `.mjs` y `.json` de cada Lambda, sin `node_modules` | Pasos de Google para verificar un ID token |
| No usar `templates/lambda/index.mjs` como base | Ese template es para Lambdas de integración que llaman a PostgREST con secretos; el authorizer no hace nada de eso (el empaquetado y despliegue siguen `toma-unidades-en-taller/deploy.ps1`) | — |
| Caché del resultado por token, **300 s** | La Lambda no corre en cada petición: menos costo y latencia | Opción estándar del authorizer |
| Política *Allow* sobre **todo el stage** (`.../v3/*`), no solo la ruta pedida | Con caché, API Gateway reutiliza la política en otras rutas; si cubriera solo una, las demás darían 403 | Comportamiento documentado de AWS con caché de authorizer |
| Token inválido → **401** (`Unauthorized`), no *Deny* (403) | El dashboard trata 401 como sesión vencida y 403 como error de configuración (`autenticacion.md`, "Manejo de errores") | Template, tabla de errores HTTP |
| **Schema fijo por ruta** (`Content-Profile` / `Accept-Profile` en la integración: `/toma-unidades` → `valuacion`, `/hub` → `hub_cleber`) | Que una ruta no sirva para llamar funciones de otro schema | Agregado propio |
| Plan B para el header del token: `X-Id-Token` en lugar de `Authorization` | Con proxy integration, `Authorization` llega a PostgREST; si tiene `jwt-secret`, lo rechazaría. **Sin verificar**: se confirma en el paso 7 | Agregado propio (paso 6) |
| Lambda **fuera de la VPC** | Necesita internet para descargar las llaves de Google | Requisito técnico |
| `GOOGLE_CLIENT_IDS` acepta varios Client IDs | Un solo authorizer para todos los sistemas: cada uno puede tener su propio cliente OAuth | Template ("solo se crea una vez") + diseño (Q27) |

### Pendientes de acordar

- **Dónde vive el código:** hoy en `infra/authorizer-google/` de este repo, provisional. Su lugar es el repo central `api` (`API/authorizer-google/`), con dueño de plataforma (Q27).
- **Clientes OAuth:** uno por sistema (cada uno agrega su Client ID a `GOOGLE_CLIENT_IDS`) o uno compartido.
- **Otros sistemas que lo necesitan:** el schema central `autorizaciones` (repo `api`, rama `autorizaciones`) planea su ruta `/autorizaciones/{proxy+}` con "JWT Authorizer"; le aplica este mismo authorizer.
- **Corregir el template:** `autenticacion.md` (JWT Authorizer y vencimiento del token) e `infraestructura.md` (HTTP API con API keys).
