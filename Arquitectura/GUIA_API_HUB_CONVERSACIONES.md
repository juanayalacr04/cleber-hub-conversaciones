# Guía — API propio del hub: `API CLEBER - Hub Conversaciones`

**Cuenta:** 807746362931 · **Región:** us-east-1 · **Ambiente:** dev · **Fecha:** 18 de noviembre de 2026

El hub tiene su propio API Gateway, como los demás proyectos de la cuenta (`API CLEBER - Quiter-api`, `API CLEBER - Solicitudes de pagos`…), en lugar de rutas dentro de `api-cleber` (`hcd3skw782`). Reemplaza para el hub lo que dice [`GUIA_API_GATEWAY.md`](GUIA_API_GATEWAY.md), que describe las rutas en el API compartido.

Copia la configuración que ya funciona en `api-cleber` (stage `dev`, verificada el 2026-11-18):

| En `api-cleber` hoy | En el API nuevo |
|---------------------|-----------------|
| Authorizer `google-id-token-dev` → Lambda `authorizer-google-dev` | **Se reusa la misma Lambda**; el authorizer se crea en el API nuevo |
| `/hub-cleber/{proxy+}` POST, HTTP proxy a `http://ec2-3-89-235-189.compute-1.amazonaws.com:3000/{proxy}`, schema `hub_cleber` | Igual |
| `/toma-unidades/{proxy+}` POST, igual con schema `valuacion` | Igual |
| — | `/toma-unidades-acciones` POST → Lambda `toma-unidades-en-taller-api-dev` (botón **Enviar** de Ofertas) |

Los nombres de los recursos no cambian: el dashboard solo cambia `API_GATEWAY_URL` y `API_GATEWAY_KEY`.

---

## Paso 1 — Crear el API

*API Gateway → Create API → **REST API** → Build*:

| Campo | Valor |
|-------|-------|
| API details | New API |
| API name | `API CLEBER - Hub Conversaciones` |
| Description | `Hub de conversaciones y módulo de valuación (dashboard, contrato de entrada, webhooks)` |
| API endpoint type | **Regional** |

## Paso 2 — Authorizer

*Authorizers → Create authorizer*:

| Campo | Valor |
|-------|-------|
| Authorizer name | `google-id-token-dev` |
| Authorizer type | **Lambda** |
| Lambda function | `authorizer-google-dev` (us-east-1) |
| Lambda event payload | **Token** |
| Token source | `X-Id-Token` (no `Authorization`: PostgREST intentaría validarlo como JWT propio; ver `GUIA_API_GATEWAY.md` paso 6) |
| Token validation | `^[-0-9A-Za-z\._]+$` |
| Authorization caching | Activado, TTL **300** |

Al guardar, la consola ofrece dar permiso al API para invocar la Lambda: acéptalo. Si no lo ofrece (o el authorizer responde 500 en la verificación), dalo con la CLI:

```
aws lambda add-permission --function-name authorizer-google-dev --statement-id api-hub-conversaciones `
  --action lambda:InvokeFunction --principal apigateway.amazonaws.com `
  --source-arn "arn:aws:execute-api:us-east-1:807746362931:<id del API>/authorizers/*"
```

## Paso 3 — `/hub-cleber/{proxy+}` (PostgREST, schema `hub_cleber`)

1. *Resources → `/` → Create resource*: Resource name `hub-cleber` (sin proxy).
2. Selecciona `/hub-cleber` → *Create resource*: activa **Proxy resource**, Resource name `{proxy+}`.
   La consola le crea un método `ANY`: **bórralo** (solo se expone POST).
3. En `/hub-cleber/{proxy+}` → *Create method*:
   - Method type: **POST**
   - Integration type: **HTTP**, **HTTP proxy integration** activado
   - HTTP method: `POST`
   - Endpoint URL: `http://ec2-3-89-235-189.compute-1.amazonaws.com:3000/{proxy}`
4. *Method request → Edit*:
   - Authorization: `google-id-token-dev`
   - API key required: **activado**
   - Request paths: `proxy` (normalmente ya aparece)
5. *Integration request → Edit*:
   - URL path parameters: `proxy` = `method.request.path.proxy`
   - URL request headers parameters (sobrescriben lo que mande el cliente):

     | Name | Mapped from |
     |------|-------------|
     | `X-User-Email` | `context.authorizer.email` |
     | `Content-Profile` | `'hub_cleber'` (comillas simples: valor fijo) |
     | `Accept-Profile` | `'hub_cleber'` |

   Fijar el schema en la ruta evita que se use para llamar funciones de otro schema, y el email lo pone el authorizer: el cliente no lo puede suplantar.

## Paso 4 — `/toma-unidades/{proxy+}` (PostgREST, schema `valuacion`)

Igual que el paso 3, con el recurso `toma-unidades` y `Content-Profile` / `Accept-Profile` = `'valuacion'`.

## Paso 5 — `/toma-unidades-acciones` (Lambda de valuación)

1. *Resources → `/` → Create resource*: `toma-unidades-acciones` (sin proxy).
2. *Create method*:
   - Method type: **POST**
   - Integration type: **Lambda function**, **Lambda proxy integration** activado
   - Lambda function: `toma-unidades-en-taller-api-dev`
   - Acepta el permiso para que el API invoque la Lambda.
3. *Method request → Edit*: Authorization `google-id-token-dev`, API key required **activado**.
4. Sin mapeo de headers (con proxy a Lambda no se puede): la Lambda lee el email en `event.requestContext.authorizer.email`. Por esta ruta solo acepta acciones de usuario (`ACCIONES_USUARIO` en su `index.mjs`).

Lo que necesita la Lambda de valuación para `enviaOferta`:
- Variable `HUB_ENTRY_POINT` = `hub-entry-point-dev`.
- En su rol (`toma-unidades-en-taller-role`): `lambda:InvokeFunction` sobre `arn:aws:lambda:us-east-1:807746362931:function:hub-entry-point-dev`.
- El código nuevo: `.\deploy.ps1 dev` en `toma-unidades-en-taller`.

## Paso 6 — Desplegar

*Deploy API* → Stage: **New stage**, nombre `dev`.

Queda en `https://<id del API>.execute-api.us-east-1.amazonaws.com/dev`. Cada cambio posterior en recursos o métodos requiere volver a desplegar al stage `dev`.

## Paso 7 — API key y usage plan

1. *Usage plans → Create usage plan*: nombre `hub-conversaciones-dev`, throttling rate **50** y burst **100** (ajustable), sin cuota.
2. En el plan → *Associated stages → Add*: el API nuevo, stage `dev`.
3. *API keys → Create API key*: nombre `hub-conversaciones-dashboard-dev`, auto generate.
4. En el plan → *Associated API keys → Add*: esa key.

Una key por consumidor: el dashboard tiene la suya. Las Lambdas del hub no la usan (llaman a PostgREST directo, `URL_API_DB`).

## Paso 8 — Dashboard

En las variables del dashboard (local `.env.local` y Vercel de dev), solo servidor:

```
API_GATEWAY_URL=https://<id del API>.execute-api.us-east-1.amazonaws.com/dev
API_GATEWAY_KEY=<valor de hub-conversaciones-dashboard-dev>
```

`API_GATEWAY_TOKEN_HEADER` no cambia (`X-Id-Token` por omisión). Reinicia el servidor de desarrollo.

## Paso 9 — Verificación

Desde PowerShell, sin sesión (deben fallar):

```
$u = "https://<id del API>.execute-api.us-east-1.amazonaws.com/dev"
# Sin API key → 403 Forbidden
Invoke-WebRequest -Method Post "$u/hub-cleber/rpc/consulta_usuario_actual" -Body '{}' -ContentType 'application/json'
# Con API key y sin token → 401 Unauthorized
Invoke-WebRequest -Method Post "$u/hub-cleber/rpc/consulta_usuario_actual" -Body '{}' -ContentType 'application/json' -Headers @{ 'x-api-key' = '<key>' }
```

Con sesión, desde el dashboard:
1. Entrar con Google: carga marcas y módulos (`Hub.consultaUsuarioActual` por `/hub-cleber`).
2. Valuación → Ofertas: carga la lista (`/toma-unidades`).
3. **Enviar** en una oferta: llega a la Lambda de valuación y al hub (`/toma-unidades-acciones`). Sin plantilla configurada en el número, la oferta queda *Fallido* con "Falta configurar la plantilla de WhatsApp…": la cadena completa funciona sin mandar nada real.

Si algo falla, *Stages → dev → Logs and tracing* permite activar los logs de ejecución en CloudWatch para ver qué recibió y qué respondió cada integración.

---

## Después

| Recurso | Para qué | Integración | Seguridad |
|---------|----------|-------------|-----------|
| `/entry-point` | Contrato ① desde sistemas que no pueden invocar la Lambda directo (Salesforce…) | Lambda proxy → `hub-entry-point-dev` | `AWS_IAM` o API key por sistema |
| `/webhook/{proveedor}` | WhatsApp entrante (Twilio, Meta, ValueText) | Lambda proxy → `hub-router-dev` | Sin authorizer ni API key: valida la firma del proveedor (excepción a la convención, DISENO_BACKEND_AWS.md §9 I1) |

## Riesgo pendiente antes de producción

El gateway llega a PostgREST por internet, a la URL pública del EC2 (`:3000`), igual que hoy `api-cleber` y las Lambdas. Mientras ese puerto esté abierto a internet, **el gateway no protege a PostgREST**: cualquiera puede llamarlo directo y mandar el `X-User-Email` que quiera. Antes de producción, una de dos:
- Security group del EC2 que acepte el puerto 3000 solo desde las Lambdas (en VPC) y desde un VPC Link del gateway (NLB interno), o
- PostgREST con un secreto compartido que solo el gateway y las Lambdas conozcan (header fijo validado por PostgREST o por un proxy delante).
