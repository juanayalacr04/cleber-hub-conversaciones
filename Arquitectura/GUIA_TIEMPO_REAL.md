# Tiempo real con AppSync Events — guía de dev

Diseño: [`DISENO_BACKEND_AWS.md`](DISENO_BACKEND_AWS.md) §6. Tarea 2.10.

## Cómo funciona

```
 Lambdas del hub ── POST /event firmado con IAM ──► AppSync Events (namespace hub) ──WebSocket──► pantallas
 (core/appsync.py, después de cada cambio)                │
                                                          └─ al suscribirse: authorizer-appsync
                                                             (id_token de Google + Hub.autorizaCanal)
```

| Pieza | Dónde |
|---|---|
| Authorizer genérico (todos los sistemas; irá a su propio repo) | `infra/authorizer-appsync/` |
| Permiso por canal del hub | `DB/Hub/Functions/Acciones/autoriza_canal.sql` (`Hub.autorizaCanal`) |
| Publicador | `core/appsync.py`, conectado en `handlers._prepara` |
| Qué se avisa y a qué canales | `core/tiempo_real.py` |
| Cliente WebSocket y hook | `apps/web/src/lib/tiempoReal.ts`, `apps/web/src/hooks/useTiempoReal.ts` |

Canales:
- `/hub/<idMarca>/<modulo>`: la bandeja.
- `/hub/<idMarca>/<modulo>/<idConversacion>`: el chat abierto.

AppSync solo acepta letras, números y guiones en cada segmento del canal (hasta 50 caracteres). Por eso una marca con `_` en su id no tendría tiempo real.

**Otro sistema** que quiera tiempo real necesita tres cosas, sin cambiar el authorizer:
1. Su namespace en la API.
2. Su función `<Prefijo>.autorizaCanal` en su schema, con la petición `{ canal, operacion }` y la respuesta `{ autorizado, motivo }`.
3. Una entrada en `NAMESPACES` del authorizer.

## Pasos (cuenta de dev 807746362931, us-east-1)

### 1. Base
1. Correr `DB/Hub/Functions/Acciones/autoriza_canal.sql`, o `Alta_db.sql` completo, que ya lo incluye.
2. Dar el grant de ejecución de `hub_cleber.autoriza_canal(jsonb)` al rol de PostgREST, como a las demás acciones.
3. Opcional: `Pruebas/pruebas_conversaciones.sql` (sección 8).

### 2. Lambda `authorizer-appsync-dev`
1. **Rol:** solo necesita logs (`AWSLambdaBasicExecutionRole`). Va sin VPC.
2. **Crear la función:** `infra\authorizer-appsync\deploy.ps1 dev -RolArn <arn del rol>`, o en la consola con Node.js 24 en arm64, handler `index.handler` y timeout de 5 s.
3. **Variables de entorno:**

   | Variable | Valor en dev |
   |---|---|
   | `GOOGLE_CLIENT_IDS` | La misma que `authorizer-google-dev` |
   | `ALLOWED_EMAIL_DOMAINS` | La misma que `authorizer-google-dev` (o vacía) |
   | `NAMESPACES` | `{"hub":{"schema":"hub_cleber","accion":"Hub.autorizaCanal"}}` |
   | `URL_API_DB` | El mismo PostgREST que usan las Lambdas del hub |
   | `CLEBER_API_KEY` | Si PostgREST la pide |
   | `TTL_SEGUNDOS` | `300` (opcional) |

### 3. API de AppSync Events
1. **Crear la API:** AppSync → **Create API** → **Event API**, con el nombre `hub-eventos-dev`.
2. **Modos de autorización** (Settings → Authorization):
   - Agregar **AWS_IAM**.
   - Agregar **AWS_LAMBDA** con la función `authorizer-appsync-dev`. La consola le da el permiso de invocación. Si no, usa `deploy.ps1 dev -ApiId <apiId>`.
   - Quitar **API_KEY** si se creó por omisión.
3. **Modos por defecto:**
   - Conexión: **AWS_LAMBDA**.
   - Publicar: **AWS_IAM**.
   - Suscribirse: **AWS_LAMBDA**.
4. **Namespace:** crear `hub`, con publicar en AWS_IAM y suscribirse en AWS_LAMBDA. El namespace `default` se puede borrar.
5. **Endpoints:** anotar en Settings → DNS endpoints el **HTTP** (`<id>.appsync-api.us-east-1.amazonaws.com`) y el **Real-time**.

### 4. Lambdas del hub
1. **Permiso:** agregar al rol `cleber-hub-lambdas-dev` (o al de cada Lambda del hub) esta política:
   ```json
   {
     "Effect": "Allow",
     "Action": "appsync:EventPublish",
     "Resource": "arn:aws:appsync:us-east-1:807746362931:apis/<apiId>/channelNamespace/hub"
   }
   ```
2. **Endpoint:** agregar `APPSYNC_EVENTS_URL` = `https://<id>.appsync-api.us-east-1.amazonaws.com/event` al secreto `hub/dev/entorno`, que lo leen todas.
3. **Desplegar** el código nuevo, que trae `core/appsync.py` y las acciones del asesor en `hub-acciones-usuario`:
   `.\dev\deploy_aws.ps1 acciones-usuario dev`, y lo mismo con `msj-entrantes`, `entry-point` y `router`.

**Importante:** la web ya manda tomar, asignar, transferir, devolver, reabrir y cerrar a `/hub-acciones`. Hay que desplegar las Lambdas **antes o junto con** la web, porque una Lambda vieja responde ACCION_INVALIDA a esas acciones.

El API Gateway no cambia.

### 5. Web
- Configurar `NEXT_PUBLIC_APPSYNC_EVENTS_HOST=<id>.appsync-api.us-east-1.amazonaws.com` en `.env.local` y en Vercel.
- Configurar `NEXT_PUBLIC_APPSYNC_EVENTS_REALTIME_HOST` solo si hay dominio propio.
- Sin `NEXT_PUBLIC_APPSYNC_EVENTS_HOST`, las pantallas siguen refrescándose cada 15 s.

## Prueba en dev
1. Abrir Conversaciones de Valuación en dos navegadores con usuarios distintos: un administrador y un valuador del equipo.
2. En DevTools → Network → WS debe haber una conexión a `appsync-realtime-api` con `connection_ack` y `subscribe_success`.
3. Mandar un WhatsApp al número de pruebas. La bandeja y el chat abiertos deben mostrarlo en menos de un segundo.
4. Tomar, asignar o cerrar en un navegador debe verse en el otro.
5. Un valuador de otro equipo no recibe el chat de una conversación ajena: `subscribe_error` en WS y "SIN_ACCESO_CONVERSACION" en los logs del authorizer.

**Logs:**
- `authorizer-appsync-dev`: rechazos y su motivo.
- Lambdas del hub: `tiempo_real: no se pudo publicar` si falta el permiso o la URL.
