# Diseño — Backend del hub en AWS (primera rebanada: Valuación)

**Fecha:** 17 de noviembre de 2026 · **Estado:** propuesta, para revisar con el responsable del API Gateway e infraestructura.

Complementa [`DISENO_MIGRACION_POSTGRES.md`](DISENO_MIGRACION_POSTGRES.md) a partir de Q40 (el backend se muda a AWS). Lo que aquí se dice reemplaza, para el backend, sus §3, §4.3, §4.4, §6 y §7. El modelo de datos (§5) y las acciones `Hub.*` (§5.3) siguen valiendo.

---

## 1. Decisiones

| # | Tema | Decisión |
|---|------|----------|
| A1 | Plataforma | **AWS** (Q40). Nada nuevo en GCP |
| A2 | Runtime | **Python 3.12** en Lambda. Excepción a Node 22: se conserva el código del backend y sus pruebas |
| A3 | Tiempo real | **Sale de Firestore** a un servicio de AWS (§6). Firestore y Firebase Auth se apagan al terminar la mudanza |
| A4 | Orden | **Por rebanadas.** La primera es el núcleo de conversaciones + Valuación (§8). Ventas y Servicio se mudan después |
| A5 | Dónde vive la lógica por vertical | **En el backend del hub**, `modules/<vertical>.py` (`ANALISIS_CENTRALIZACION_TECNICO.md` §4-ter.D). No hay un backend aparte por módulo |
| A6 | Unidad de despliegue | **Una imagen** con todo el paquete y **una Lambda por punto de entrada** (las 11 funciones de hoy). Separar despliegues por módulo se decide después, sin reescribir (los módulos ya están separados en el código) |
| A8 | Números | **Cada módulo tiene su propio número por marca** (2026-11-17). Revierte el número compartido Servicio/Valuación del 2026-10-29. La conversación se busca por número + teléfono del cliente, y solo hay una abierta por esa pareja |
| A7 | Estado de la oferta vs envío | Valuación es dueña del estado de la oferta (`solicitaEnvio` / `marcaEnviada`, `acciones-valuacion.md` §6). El hub es dueño de la conversación y del envío por WhatsApp (contrato ①) |

---

## 2. Arquitectura

```
                    ┌────────────────────────────── AWS (us-east-1) ──────────────────────────────────────┐
Navegador           │ API Gateway REST v1 (z66x2zyooj)                                                    │
 ├─ NextAuth ──────►│  /hub/{proxy+}            authorizer Google + API key ─────────────┐                 │
 │  (Next.js,       │  /toma-unidades/...       idem ───► Lambdas TomaUnidades.*          ├─► NLB → PostgREST → PostgreSQL
 │   Vercel)        │  /hub-acciones/...        authorizer Google + API key ─► Lambda acciones-usuario   hub_cleber · clientes · valuacion
 │                  │  /webhook/{proveedor}     sin authorizer (firma propia) ─► Lambda router            ▲
 │                  └──────────────────────────────────────────────────────────────────────┘           │
 │                                                                                                      │ VPC (subredes privadas)
 │                  Lambda router ──► SQS FIFO hub-entrantes ──► Lambda entrantes ──invoke──► Lambda bot ──► Abacus
 │                                         (grupo = número + cliente)        │                          │
 │                  EventBridge Scheduler ──► Lambda jobs                    ├──► Twilio / Meta / ValueText (por NAT)
 │                  Lambda TomaUnidades.enviaOferta ──invoke──► Lambda contrato-entrada                 │
 │                                                                           └──► publica avisos ─┐
 │                                                                                                ▼
 └─ suscripción WebSocket (id_token) ◄──────────────────────────────── AppSync Events (canales por marca y módulo)
```

- Todo el backend corre dentro de la VPC, en subredes privadas, y llega a PostgREST por el NLB interno, como las Lambdas de Valuación.
- La salida a los proveedores (Twilio, Meta, Salesforce, Abacus) es por **NAT Gateway**.
- Las Lambdas se llaman entre sí con `lambda:InvokeFunction` (IAM), no por HTTP con secretos compartidos.

---

## 3. Funciones

| Hoy (Cloud Function) | En AWS | Disparador | Tiempo máx. | Notas |
|----------------------|--------|-----------|-------------|-------|
| `router` | `hub-router` | API Gateway `/webhook/*` | 30 s | Valida firma y **siempre encola** (en Lambda no hay "seguir trabajando después de responder 200") |
| `queue-incoming` | `hub-entrantes` | SQS FIFO, lote de 1, fallos parciales | 300 s | Un mensaje a la vez por grupo (número + cliente) |
| `bot` | `hub-bot` | Invocación directa | 300 s | Concurrencia reservada propia. Se quita `X-Service-Secret` |
| `actions-execute` | `hub-acciones-bot` | API Gateway (API key del bot) | 120 s | Ver §9, límite de 29 s |
| `user-actions-execute` | `hub-acciones-usuario` | API Gateway con authorizer Google | 29 s | Deja de verificar el token de Firebase: usa `X-User-Email`. Campañas: ver abajo |
| *(nuevo)* contrato ① | `hub-contrato-entrada` | Invocación directa (Valuación) y API Gateway `/internal` (Salesforce, otros) | 60 s | §5 |
| `lead-webhook`, `close-by-phone`, `situacion-detectada` | Se mudan en la rebanada de Ventas/Servicio | API Gateway | | |
| `jobs-run`, `inactivity-followup` | `hub-jobs` | EventBridge Scheduler | 600 s | Concurrencia reservada 1. Se quita `X-Cron-Secret` |
| `health` | Se elimina | | | CloudWatch y alarmas lo cubren |

**Campañas.** Hoy `broadcast.send` corre hasta 900 s dentro de `user-actions-execute`. En AWS la acción solo encola los destinatarios en una **cola aparte** (`hub-campanas`) y regresa; otra Lambda los manda en lotes. Así una campaña grande no retrasa los mensajes entrantes ni choca con el límite de 29 s del API Gateway.

---

## 4. Cambios en el código

### 4.1 Puntos de entrada
- `main.py` (functions_framework) → **`handlers.py`**, un handler de Lambda por función.
- **`core/http_lambda.py`**: adaptador del evento de API Gateway a un objeto con la forma del `request` actual (`get_data`, `get_json`, `headers`, `args`, `method`, `path`). `channels/router.py`, `core/actions.py` y `core/user_actions.py` casi no cambian.
- Twilio firma con la URL exacta: `PUBLIC_BASE_URL` debe ser la URL pública final, y la ruta debe pasar path y query sin cambios.

### 4.2 Datos (PostgreSQL)
Lo que dice `DISENO_MIGRACION_POSTGRES.md` §7, con dos cambios:
- **`core/postgrest.py`** llama al NLB interno con la identidad de sistema (`X-User-Email: sistema@hub-conversaciones.internal`), igual que las Lambdas de Valuación. **Ya no hay SigV4 por federación**. Para actuar por un usuario reenvía su `id_token` a la ruta `/hub` (Q21, sin cambio).
- **`core/aviso.py` → `core/tiempo_real.py`**: publica en AppSync Events (§6) en lugar de escribir en Firestore.

`core/datos/` por entidad y la prueba de arquitectura quedan como estaban diseñadas. En la primera rebanada solo se reescriben las entidades del núcleo (§8).

### 4.3 Cola
- `channels/event_queue.py`: `PubSubPublisher` → **`SqsPublisher`**. `MessageGroupId` = `ChannelEvent.ordering_key` (número del bot + cliente), `MessageDeduplicationId` = id del evento del proveedor. `publish` sigue siendo síncrono: el router contesta 200 solo cuando SQS aceptó.
- `channels/ingest.py`: `handle` recibe el registro de SQS en lugar del push de Pub/Sub. Un fallo devuelve el mensaje como fallo parcial para que SQS lo reintente; tras N intentos va a la DLQ.
- Se elimina `DirectPublisher` en producción; se conserva para pruebas locales.

### 4.4 Llamadas entre funciones
- `core/bot_client.py`: invoca `hub-bot` con `boto3` (`InvocationType=RequestResponse`). Sin `BOT_FUNCTION_SECRET` y sin el límite de 29 s.

### 4.5 Credenciales
- `core/credentials.py`: lee de **Secrets Manager** un secreto por número y uno por bot (`hub/<ambiente>/numeros/<id>`, `hub/<ambiente>/bots/<id>`), con el mismo caché de 60 s. La interfaz (`reveal`, `store`, `clear`, `mark_configured`) no cambia; `secretsSet` pasa a columna de `numeros` y `bots`.
- `META_APP_SECRET`, `VALUETEXT_WEBHOOK_SECRET` y similares: un secreto por ambiente, leído al iniciar la Lambda.

### 4.6 Dependencias y empaquetado
- Se quitan `functions-framework`, `google-cloud-pubsub`, `google-cloud-firestore` y `firebase-admin`; se agrega `boto3`.
- **Imagen de contenedor** en ECR (una para todas las funciones; cambia el `CMD` del handler).
- `dev/deploy.ps1` → script de despliegue a AWS siguiendo `toma-unidades-en-taller/deploy.ps1`. Sigue siendo la única fuente de tiempos, memoria y concurrencia por función.

---

## 5. Envío de ofertas de Valuación

### 5.1 Flujo

```
Valuador pulsa "Enviar" (OfertasApiView)
  └─► /toma-unidades → Lambda TomaUnidades.enviaOferta (Valuación, acciones-valuacion.md §6.1)
        1. Valuacion.solicitaEnvio            → SOLICITADO; regresa envio {source, externalId, idMarca, telefono, claveCliente, contexto}
        2. invoke hub-contrato-entrada (①)    → idConversacion
        3. Valuacion.marcaEnviada             → ENVIADO (con idConversacion) o FALLIDO
```

Dentro del hub, `hub-contrato-entrada`:

1. **Valida** `fuente` y que la fuente pueda abrir conversaciones en esa marca y vertical.
2. **Número**: el número de Valuación de la marca (`Hub.resuelveNumero` por marca y módulo). **Cada módulo tiene su propio número** (A8); no se comparte con Servicio.
3. **Conversación**: `Hub.abreConversacionExterna`, idempotente por (`fuente`, `id_externo`). Si ya existe, regresa la misma y no vuelve a enviar.
4. **Lo propio de la vertical** se despacha al módulo: `modules/valuacion.py` registra el handler de la fuente `valuacion`, que arma
   - las variables de la plantilla a partir de `contexto`;
   - el texto `<<CONTEXTO>>` que se guarda como mensaje de sistema y que el bot recibe en su primer turno.
5. **Envío**: `core/outbound.send_template` por el proveedor del número. Se guarda el mensaje y su id de proveedor (`Hub.guardaMensaje`).
6. **Aviso** en tiempo real a la bandeja de Valuación de la marca.

Si el envío falla después de abrir la conversación, ① regresa el error. La conversación queda abierta sin mensaje, y el reintento de la oferta la reutiliza por idempotencia.

### 5.2 La respuesta del cliente

Cuando el cliente contesta, el mensaje entra por el pipeline normal (`router` → cola → `entrantes`). `obtieneOAbreConversacion` encuentra la conversación abierta de ese número y teléfono, que es la de Valuación, y el turno usa su bot (el de la vertical). Los eventos de la conversación (contestó, pasó a asesor, resultado, cierre) se mandan a Valuación por el contrato ③ (`TomaUnidades.recibeEventoHub`). El módulo `valuacion.py` decide cuáles.

### 5.3 Pendientes del envío
- Plantilla aprobada de la oferta: nombre o id y variables.
- Número de WhatsApp de Valuación de cada marca piloto y su proveedor.
- Bot de Valuación (Abacus) y su configuración.

---

## 6. Tiempo real

Hoy el navegador escucha Firestore (`onSnapshot`) en 14 pantallas: bandeja, kanban, chat, notificaciones, semáforo y configuración.

**Propuesta: AppSync Events.**
- El backend **publica** por HTTP con IAM después de que la acción `Hub.*` confirma: `{idConversacion, version, estado, ultimoMensajeEn, …}`, lo mismo que se pensaba poner en el documento de aviso (`DISENO_MIGRACION_POSTGRES.md` §6.1).
- El navegador **se suscribe** por WebSocket a canales `/hub/<idMarca>/<modulo>` (bandeja) y `/hub/<idMarca>/<modulo>/<idConversacion>` (chat abierto).
- **Permisos**: un Lambda authorizer valida el `id_token` de Google (el mismo validador que el del API Gateway) y consulta en `hub_cleber` si el usuario tiene rol en esa marca y módulo. Reemplaza las reglas de Firestore y `accesos/{email}`.
- **Los eventos son avisos, no datos**: al recibirlo, la pantalla pide lo que cambió (`Hub.consultaConversaciones`, `Hub.consultaMensajes` con `desde`). Si se pierde uno, el siguiente lo corrige, y al reconectar la pantalla vuelve a consultar.

| Opción | A favor | En contra |
|--------|---------|-----------|
| **AppSync Events** (propuesta) | Pub/sub administrado: sin tabla de conexiones ni código de difusión. Authorizer por canal | Servicio nuevo para Cleber |
| API Gateway WebSocket | Ya se usa API Gateway | Hay que guardar las conexiones (tabla) y difundir a mano |
| Polling | Lo más simple | Menos inmediato y más carga a PostgREST |

Con esto **se van Firestore, Firebase Auth y `accesos/{email}`** (Q2, Q8, Q24 y §6 del otro diseño quedan sin efecto). En el dashboard, `contexts/AuthContext.tsx` deja de abrir la sesión de Firebase cuando la última pantalla deje de leer Firestore.

---

## 7. Consolas

**AWS**
1. **IAM**: un rol de ejecución por grupo de funciones, con lo mínimo (VPC, logs, sus colas, sus secretos por ARN, invocar `hub-bot`, publicar en AppSync). La Lambda `TomaUnidades.enviaOferta` necesita `lambda:InvokeFunction` sobre `hub-contrato-entrada`.
2. **VPC**: subredes privadas con NAT; security group con acceso al NLB de PostgREST.
3. **SQS**: `hub-entrantes.fifo` y `hub-campanas.fifo`, cada una con su DLQ. Visibilidad mayor al tiempo máximo de su consumidor. Modo de alto rendimiento de FIFO.
4. **Secrets Manager**: secretos de números, bots y webhooks.
5. **ECR**: repositorio de la imagen.
6. **Lambda**: funciones de §3, con concurrencia reservada para `hub-bot` y `hub-jobs`.
7. **API Gateway** (lo configura su responsable): `/webhook/{proveedor}` sin authorizer (con la excepción a la API key), `/hub-acciones` con authorizer Google y API key, `/internal` para entradas de sistema, dominio propio.
8. **AppSync Events**: API con su Lambda authorizer.
9. **EventBridge Scheduler**: una regla por job, con la frecuencia actual.
10. **CloudWatch**: logs y alarmas (errores, DLQ, antigüedad de la cola).

**GCP** (al terminar todas las rebanadas): apagar Cloud Functions, Pub/Sub, Cloud Scheduler, Secret Manager y Firestore del hub, y quitar Firebase del dashboard.

**Proveedores**: URL del webhook en Twilio y Meta, Outbound Messages de Salesforce y herramientas HTTP de Abacus, cuando se mude cada número.

---

## 8. Rebanadas

El código es uno solo. Mientras dura la mudanza, **el despliegue de GCP se congela** en el último commit antes de empezar: Ventas y Servicio siguen funcionando ahí (no son productivos), y el repo avanza hacia AWS.

### Rebanada 1 — Núcleo + Valuación

| Parte | Contenido |
|-------|-----------|
| Base de datos | Tablas `equipos`, `numeros`, `bots`, `conversaciones`, `mensajes`, `bitacora` (`DISENO_MIGRACION_POSTGRES.md` §5.2). Acciones: `resuelveNumero`, `obtieneOAbreConversacion`, `guardaMensaje`, `consultaHistorial`, `abreConversacionExterna`, cambios de estado (asignar, tomar, cerrar), `consultaConversaciones`, `consultaMensajes`; configuración de números y bots |
| Backend | `handlers.py` y adaptador; `core/postgrest.py`; `core/datos/` de esas entidades; `core/tiempo_real.py`; cola SQS; credenciales en Secrets Manager; invocación de `hub-bot`; `hub-contrato-entrada`; `modules/valuacion.py` |
| Valuación | Lambda `TomaUnidades.enviaOferta`; botón **Enviar** activo en `OfertasApiView` |
| Dashboard | Conversaciones de Valuación (bandeja y chat) sobre `Hub.consulta*` y AppSync; configuración del número y el bot de Valuación sobre `hub_cleber` |
| Prueba de punta a punta en dev | Enviar oferta → llega la plantilla → el cliente contesta → contesta el bot → pasa a asesor → el asesor contesta → cierre → Valuación recibe los eventos ③ |

### Rebanada 2 — Ventas y Servicio
`modules/ventas.py` y `servicio.py`, campañas, jobs, `lead-webhook`, `close-by-phone`, `situacion-detectada`, acciones de administración y el resto de las pantallas que leen Firestore. Al terminar, se apaga GCP (§7).

### Rebanada 3 — Migración de marcas
Sin cambios respecto a `DISENO_MIGRACION_POSTGRES.md` §9, salvo que el script escribe directo al hub en AWS y no crea documentos de aviso.

---

## 9. Lo que hay que acordar con infraestructura

| # | Tema | Por qué importa | Propuesta |
|---|------|-----------------|-----------|
| I1 | Webhooks sin API key | Twilio, Meta y Salesforce no mandan `x-api-key`; la convención la exige en todo endpoint | Excepción para `/webhook/*`: validan su propia firma |
| I2 | Límite de 29 s del API Gateway REST | `hub-acciones-bot` puede tardar hasta 120 s (Salesforce) | Pedir más tiempo de espera para esa ruta (solo APIs regionales), o Function URL con IAM |
| I3 | NAT Gateway | Las Lambdas en VPC necesitan salida a internet | Confirmar si ya existe en la VPC de PostgREST |
| I4 | Acceso a PostgREST desde las Lambdas | Identidad de sistema | El mismo NLB interno y patrón que las Lambdas de Valuación |
| I5 | Tiempo real | Servicio nuevo | AppSync Events (§6) |
| I6 | Concurrencia de la cuenta | Se comparte con todas las Lambdas de Cleber | Concurrencia reservada para `hub-entrantes` y `hub-bot` |
| I7 | Dominio | URLs de webhook estables entre despliegues | Dominio propio del hub en el API Gateway |
