# Tareas pendientes, por fase

**Fecha: 14 de octubre de 2026 · Reordenado el 18 de noviembre de 2026**

> **18 de noviembre de 2026 — Valuación es la primera fase productiva.** La Fase 2 deja de ser "Contrato de entrada" y pasa a ser **Núcleo en AWS + Valuación en producción**: sin Valuación en producción no se sale a producción. Ventas (Fase 3) y Servicio (Fase 4) se **adecuan** a AWS y PostgreSQL y después se migran. Las fases 0 y 1 se hicieron sobre GCP y Firestore; su código es la base, pero el backend se muda a AWS (Q40, [`DISENO_BACKEND_AWS.md`](DISENO_BACKEND_AWS.md)) y los datos a PostgreSQL ([`DISENO_MIGRACION_POSTGRES.md`](DISENO_MIGRACION_POSTGRES.md)). Lo que en las fases 0 y 1 dice Firestore, Cloud Functions, Pub/Sub o Secret Manager de GCP se lee con ese cambio. El porqué del reorden está en §1 y §6 del plan.

Checklist de trabajo. El porqué de cada cosa está en [`PLAN_TRABAJO_CENTRALIZACION.md`](PLAN_TRABAJO_CENTRALIZACION.md); el detalle de las funciones, en [`INVENTARIO_FUNCIONES_CLASIFICADAS.md`](INVENTARIO_FUNCIONES_CLASIFICADAS.md).

**Leyenda:** 🔒 bloquea otras tareas · 💻 se puede hacer local, sin GCP · ⚠️ necesita confirmación antes de ejecutar · 🔁 se rehace o se mueve por la arquitectura de tres funciones · ➕ tarea nueva · ⏩ se adelanta

> **16 de octubre de 2026 — arquitectura de tres funciones.** El diagrama "Mensajes en tres funciones" (router de canal, reglas de negocio, bot) cambia cómo se despliega lo ya portado y quién escribe en Firestore. La lógica de negocio de `core/`, `modules/` y `crm/` se conserva. Cambian el empaquetado, la cola entre funciones, la validación de firmas, la escritura única por la función 2 y el expediente por cliente. Las tareas afectadas llevan 🔁 y el trabajo nuevo está en **1.g**. Decisiones nuevas: D13 a D15.

---

## Resumen

| Fase | Objetivo | Local |
|---|---|---|
| **D** | Decisiones y trámites — no es desarrollo, pero bloquea | — |
| **0** | Fundación: que nazca segura, modular y con el esquema correcto | 💻 |
| **1** | Portar el núcleo conversacional probado | 💻 |
| **2** | **Núcleo en AWS + Valuación en producción** — primera fase productiva | ❌ |
| **3** | Adecuar y migrar Ventas | ❌ |
| **4** | Adecuar y migrar Servicio → **plataforma centralizada** | ❌ |
| **5** | Consolidación: transferencia interna y ficha de cliente | ❌ |

---

## Fase D — Decisiones y trámites

Arrancan el día 1 y corren en paralelo. Ninguna es desarrollo.

| # | Tarea | Bloquea |
|---|---|---|
| D1 | 🔒 Definir **dueño de la plataforma y propiedad del repo** (hoy `gerayga-cleber` y `dcavazos`) R= yo soy el dueño jayalacr04 | Todo |
| D2 | 🔒 Confirmar que **"desde cero" = infraestructura nueva con código portado**, no rewrite del producto R= sí, solo infraestructura nueva| Todo |
| D3 | ~~Conseguir sandbox de Salesforce para dev~~ R=no es posible y se deja como está: dev escribe en producción, aceptado (Comercial simula leads; Servicio no usa leads) | ✅ Cerrada |
| D4 | ⚠️ **Verificar con el equipo de Servicio si respetan opt-out** — no aparece en su `main.py`. Si se confirma el hueco, es cumplimiento R= actualmente no lo tiene pero sí hay que agregarlo, que se cierre la conversación | Prioridad Fase 1 |
| D5 | Decidir **¿un proyecto de GCP o dos (prod + dev)?** R= dos, prd y dev | Fase 0 |
| D6 | Decidir **opción A o B** para las pantallas de módulo (repo unificado vs. microfrontend) R=opcion A, aunque no entendí muy bien, cada módulo tendrá sus propias vistas? porque eso es lo que necesito | Fase 0 |
| D7 | Decidir **dónde vive el motor de bot**: el Web Chat llama a la Cloud Function, o se extrae a un servicio único R=pendiente el wbe chat ya que actualmente no se utiliza | Fase 0 |
| D8 | Decidir **¿hay ventana de mantenimiento?** → corte vs. doble escritura R= la idea es que sí se realice un corte | Fase 3 |
| D9 | Decidir **qué marca se migra primero** (recomendado: la de menor volumen) R=sigue pendiente | Fase 3 |
| D13 | ✅ **Clave del expediente:** teléfono normalizado **y** organización (`{orgId}_{phone}`). Un mismo cliente no mezcla historial entre marcas | Cerrada |
| D14 | ✅ **Reparto de tools (16 oct 2026):** la función 3 **no ejecuta tools de negocio**. Los bots (IA Workflow y ChatLLM) piden cada acción al **endpoint de acciones de la función 2** (`POST /actions/execute`, con `action` y `data`), que la despacha al registro de handlers. El contrato `actions: [...]` del bot externo **convive**. Ver §7.8 del plan | Cerrada → 1.43 a 1.48 |
| D15 | ✅ **Expediente al migrar:** arranca vacío. No se generan resúmenes de conversaciones históricas | Cerrada |
| D10 | ✅ **Cuándo entra Valuación** (18 nov 2026): **primero**, como primera fase productiva | Cerrada → Fase 2 |
| D11 | ✅ Quién hospeda el agente de Valuación: IA Workflow de Abacus | Cerrada → 2.13 |
| D12 | ¿Las ofertas de compra / toma a cuenta se registran en Salesforce? | Fase 2, si sí |
| D16 | **Fuente de precios de Valuación (DA-1):** Intelimotor o Autométrica | Fase 2 (2.18) |
| D17 | **Marcas y agencias piloto de Valuación en producción** (en dev: Toyota, agencias Fleteros y Cumbres) | Fase 2 (2.15) |

---

## Fase 0 — Fundación 💻

> Que la plataforma nazca con la seguridad, el esquema y la estructura correctos. Todo lo que aquí se haga bien son fases enteras que desaparecen.

### Entorno local (antes que la nube)

- [x] 0.1 Agregar el bloque `emulators` a `firebase.json` (hoy solo tiene `rules`)
- [ ] 0.2 Levantar Firestore emulator + `functions-framework` (ya está en `requirements.txt`) — **Diferido:** se trabaja directo sobre GCP dev
- [x] 0.3 Stubs de los 3 proveedores de WhatsApp y de Abacus (el de Salesforce es opcional)
- [ ] 0.4 `next dev` para el dashboard

> ✅ **D3 cerró en "sin sandbox y se deja como está".** Dev puede escribir al Salesforce de producción por decisión del dueño (Comercial ya simula leads; Servicio no usa leads). **No se construye guardarrail:** las antiguas 0.4b–0.4d (`SALESFORCE_MODE`, stub por defecto, log ruidoso) quedan descartadas. El stub de Salesforce es opcional.

### Repo y estructura

- [x] 0.5 🔒 Crear el repo con el dueño definido en D1
- [x] 0.6 Estructura modular: `main.py` solo con entry points, más `core/`, `channels/`, `ai/`, `crm/`, `modules/`, `integrations/`, `jobs/`
  - 🔁 Hoy es un solo paquete con 5 entry points. Pasa a 3 despliegues: router (`channels/`), reglas (`core/`, `modules/`, `crm/`, `jobs/`) y bot (`ai/`). Ver 1.g
- [x] 0.7 Montar el **registro de handlers por vertical** en `core/tools.py`
- [x] 0.8 Reglas de import: globales solo en `core/db.py`; `core/` **nunca** importa de `modules/`; ningún archivo llamado `twilio.py`
  - 🔁 Regla nueva: la función de reglas **no importa `ai/`**; habla con el bot solo por HTTP. El router no importa `core/` ni `modules/`

### Seguridad

- [x] 0.9 🔒 Portar las ~200 líneas de reglas granulares del repo de Servicio
- [x] 0.10 Extender las reglas para validar también **equipo/vertical**, no solo organización
  - 🔁 Las reglas de lectura se conservan. Las de escritura (`create`, `update`, `delete`, `write`) se eliminan cuando la función 2 sea la única puerta (1.40). La lógica de `canAccessTeam` se porta a Python (1.37)
- [ ] 0.11 **Pruebas automatizadas de reglas** con `@firebase/rules-unit-testing`: un usuario de la organización A no puede leer documentos de la B — **Diferida:** se probarán con datos reales sobre GCP dev (`ambiente-desarrollo-ti`), sin emulador
  - 🔁 Se simplifica: con reglas solo de lectura basta probar el aislamiento por organización y equipo en lecturas

### Esquema

- [x] 0.12 `teams/{id}.vertical` y `conversations/{id}.vertical` (denormalizado)
- [x] 0.13 `customers/{orgId}_{phone}` + `conversations.customerId` — se escriben desde la primera conversación, sin backfill después
  - 🔁 ⏩ Pasa a ser el **expediente** (D13: clave teléfono + organización): datos del cliente más resumen de cada conversación pasada. Lo consume el bot, así que se adelanta. Se construye en 1.38
- [x] 0.14 `conversations.source` / `.externalId`
- [x] 0.15 **Unicidad de `sfBrandCode`** (validación o índice)
- [x] 0.16 Base de Firestore, location `nam5`; Functions en `us-central1` — en desarrollo (`ambiente-desarrollo-ti`, proyecto compartido) es una base **con nombre**, `dev-hub-conversaciones`: `firebase.json`, `NEXT_PUBLIC_FIRESTORE_DATABASE` (web) y `FIRESTORE_DATABASE` (función) deben llevar el mismo ID. En producción se decide al crear el proyecto

### Dashboard como shell

- [x] 0.17 Navegación por módulo, no por sistema — Hecho en `apps/web/src/lib/modules.ts` y `components/shell/Shell.tsx`: rutas `/[module]/...`, selector filtrado por la `vertical` del usuario y color por módulo. Cerrada por decisión del 22 oct 2026: el menú (`NAV`) es el mismo para todos los módulos; las entradas propias de un módulo se agregan cuando exista la primera pantalla que las necesite
- [ ] 0.18 Una sesión y un padrón de usuarios; los servicios externos validan ese token
  - 🔁 La función 2 es quien valida el token y los permisos (1.37). Hoy esa validación está en `lib/auth-middleware.ts` y `lib/authz.ts`, en la web
- [ ] 0.19 Punto de extensión documentado para que un módulo agregue pantallas

### Nube (cuando haga falta el primer despliegue real)

- [x] 0.20 Crear GCP (según D5), Vercel y Firestore — GCP dev y su Firestore (`dev-hub-conversaciones`) creados y con las funciones desplegadas (confirmado 22 oct 2026). Producción y Vercel: sin confirmar
- [x] 0.21 Pipeline de deploy con `--project` **fijado explícitamente**
- [x] 0.22 Gestión de secretos por ambiente
  - 🔁 Los despliegues pasan de 5 funciones a 3 más una cola, y 0.21 debe cubrirlos con `--project` explícito. Secretos: ver 1.41

---

## Fase 1 — Portar el núcleo 💻

> **18 nov 2026 — dónde quedan los pendientes de esta fase.** El código se portó sobre GCP y Firestore; su despliegue en AWS es la Fase 2. Las tareas abiertas pasan a: 1.29 → 2.11 (solo Twilio) y 3.7 / 4.x para Meta y ValueText; 1.45 → 2.11b; 1.47 → 3.6; 1.48 → 3.6 (Ventas) y 4.2 (Servicio); 1.30, 1.30b y 1.26b se revisan al adecuar Ventas y Servicio.

> El orden importa: primero lo que no depende de decisiones de negocio. Las 40 funciones de núcleo/routing/CRM antes que las 19 handlers de Ventas.

### 1.a Capa de parseo — va primero, desbloquea todo lo demás

- [x] 1.1 `ai/parsing.py` con **estrategia por motor**: `chatllm`, `workflow`, `external`
  - 🔁 El código y las pruebas se conservan. Pasa a vivir en la función 3, que devuelve "texto + acciones" ya parseado (1.35)
- [x] 1.2 Colapsar las **6 `check_*_tool_call`** de Comercial en la estrategia `chatllm`
- [x] 1.3 Colapsar `get_ai_outcome_action` + `get_broadcast_response_action` en la estrategia `workflow`
- [x] 1.4 ⚠️ **Prueba que cubra la trampa de los dos segments de Abacus** — quedarse con el primero que hace match del title perdía el 100% de los params

### 1.b Núcleo — 24 funciones, sin decisiones de negocio

- [x] 1.5 Las **18 de núcleo** a `core/`, `channels/` y `ai/` (incluye las 5 de plataforma que aporta Servicio) — Hechas las 18 de núcleo: conversaciones, números, handoff, claims, idempotencia, canales, outcomes y campañas. Pendiente aparte: el motor (envío al bot), el pipeline de mensajes y los jobs, que son funciones comunes con drift
  - 🔁 En `core/pipeline.py`, `engine.send_to_bot` pasa a llamada HTTP síncrona a la función 3, y el envío (`send_whatsapp_message`) pasa a pedirse a la función 1. Lo demás del pipeline se conserva (1.35, 1.36)
- [x] 1.5b **Opt-out universal (D4):** `_is_stop_message` en `core/` → **cierra la conversación en los tres módulos**. Lo que cada módulo hace además se despacha como evento `opt_out` al handler: Ventas marca el Lead `Finalizado por cliente` (`_update_lead_on_stop`), Servicio solo cierra. Es el caso de §4 en su forma más limpia
- [x] 1.6 Las **6 de routing** a `core/routing.py` (motor de situaciones; las rutas ya son config)
- [x] 1.7 ⚠️ Corregir `get_whatsapp_number_by_brand`: **`.limit(1)` sin `orderBy`** es la colisión silenciosa de `sfBrandCode`
- [x] 1.8 Generalizar `_is_duplicate_lead` a idempotencia por **`(source, externalId)`** — la que pide la Fase 2
- [x] 1.9 Generalizar el patrón `_claim` a `core/claims.py`, separándolo de la parte de Lead

### 1.c CRM compartido

- [x] 1.10 Las **5 de CRM** a `crm/salesforce.py` y `crm/templates.py`
- [x] 1.11 ⚠️ Renombrar `send_lead_template` — **es ValueText** (inserta en `rsplus__SMS_Bucket__c`), el nombre engaña y es la raíz del límite de un solo proveedor

### 1.d Configuración fuera del código — antes de escribir handlers

- [x] 1.12 Nombres de tools (`Crear_Lead`, `Crear_Cita_Ventas_Salesforce`, …) → `bots/{id}.tools[]`
- [x] 1.13 Vocabularios `AI_OUTCOME_ACTIONS` y `BROADCAST_RESPONSE_ACTIONS` → config del bot
- [x] 1.14 Nombre del Flow `RRAgenteIACLEBER` → `salesforceConfig`
- [x] 1.15 `RecordTypeId` de Lead y Event, owners, owner de BDC → `salesforceConfig`
- [x] 1.16 Mapeo situación → `Status` / `Validacion_Prospecto__c` → config del módulo
- [x] 1.17 Zona horaria **UTC-6** → `organizations/{id}`

### 1.e Handlers de módulo

- [x] 1.18 Las **19 de Ventas** a `modules/ventas.py`, cada una registrada contra el núcleo
  - 🔁 Con D14 cerrada, **todos se quedan en la función 2** y el código no se mueve. Lo que cambia es la forma de invocación: además del evento del pipeline, los handlers expuestos se invocan desde el endpoint de acciones y **devuelven un resultado** (hoy devuelven `None`). Ver 1.43
- [x] 1.19 ⚠️ Decidir si el **contacto programado** (3 funciones) es de Ventas o genérico — si es genérico, sube a `core/`
- [x] 1.20 ⚠️ Separar las dos **mixtas**: `_block_handoff_out_of_hours` (gate core + lead Ventas) y el par de `claim`
- [x] 1.21 `modules/servicio.py` — nace prácticamente vacío; verificar que no quede nada mal clasificado

### 1.f Dashboard y despliegue

- [x] 1.22 Portar el dashboard: bandeja, ficha de conversación, administración, métricas
  - 🔁 Hecha en los commits `c11f69d` y `6772dfd`. Las lecturas en vivo se conservan; **cada escritura directa a Firestore se redirige a la función 2** (1.39)
- [x] 1.22b **Panel por módulo en la ficha de conversación** (D6): slot que renderiza según `conversations.vertical` — Lead y cita en Ventas, outcome en Servicio, oferta en Valuación. El núcleo del dashboard sin `if vertical ==` — Hecho con el registro `conversationPanels` (`components/conversations/panels.tsx`): Ventas = Leads; Servicio = Cuentas con sus vehículos y Etiquetas (outcome). Pendiente aparte: panel de cita en Ventas y el de Valuación, cuando exista el módulo
- [x] 1.22c ✅ **No portar `bot-engine.ts` (D7).** El Web Chat no está en uso, así que la duplicación Python ↔ TypeScript **desaparece del alcance**. Si el canal vuelve, llama a la Cloud Function en vez de reimplementar el motor
- [x] 1.23 🔒 **Decidir qué versión gana en cada archivo con drift antes de portar** (`conversations/page.tsx`: 409 líneas distintas; `bot-engine.ts`: 64)
- [x] 1.24 **Inventario del dashboard TypeScript** — el de `main.py` no lo cubre
- [x] 1.25 Flags de capacidad **explícitos** en los comandos de deploy (`--max-instances=300 --concurrency=40`); un redeploy sin ellos resetea a los defaults — Hecho en `dev/deploy.ps1`: tabla por función (timeout, instancias, concurrencia, CPU, memoria), `--project` obligatorio, `--no-cpu-throttling` del router tras cada deploy y lectura de la revisión al final. Valores por función propuestos, a confirmar. Corrido contra GCP dev: las funciones están desplegadas (confirmado 22 oct 2026)
  - 🔁 Se fijan **por función**: el router con alta concurrencia, y el bot con timeout largo por la llamada a Abacus
- [x] 1.26 ✅ `voice_llm_endpoint` y `assign_agent_by_lead` **no se usan** (confirmado 16 oct 2026): no se portan a las tres funciones. Queda por borrar la ruta `api/conversations/assign-agent-by-lead` ya portada
- [ ] 1.26b **Webhook de cierre (`closeWebhookUrl`) sin dueño.** Al cerrar, `ConversationChat.tsx` llama a `POST /api/conversations/close-webhook`, ruta que ya no existe en `apps/web` (404; el cierre no se rompe, el `.catch` solo lo registra). Ningún código del hub dispara `closeWebhookUrl` del número (solo se guarda en `core/numbers.py` y `core/admin_actions.py`). Decidir si lo dispara el hub en `conversation.close` y en los cierres del bot, de inactividad y de `close-by-phone`, y quitar la llamada del dashboard (detectado el 22 oct 2026 probando `user-actions-execute`)

### Jobs

- [x] 1.31 `jobs/inactivity.py`: recordatorio de inactividad y contacto programado, un solo job para todos los módulos (el cierre del Lead de Ventas es el evento `inactivity_closed`)
  - 🔁 Se queda en la función 2. Cambia la señal (cada 15 min, sin lógica en el cron, 1.32) y que al cerrar pide el resumen para el expediente (1.38)
- [x] 1.32 Portar los **crons del dashboard** (Vercel) que invocan al job y deciden qué conversación y cuándo: `inactivity-followup`, `close-inactive`, `scheduled-contact`, `verify-lead-templates` (Comercial) y `appointment-reminders`, `no-show` (Servicio). Viven en `apps/web/src/app/api/cron/`
  - 🔁 Es el mayor movimiento. La lógica de horarios, Salesforce y plantillas que hoy está en esas rutas pasa a la función 2. El cron queda como "solo avisa la hora" (1.39)

### 1.g Partir en tres funciones ➕

> Se hace **antes de 1.29 y de la Fase 2**, para que el primer tráfico migrado ya entre por la arquitectura final. Ver §7.7 del plan.

- [x] 1.33 ➕ 🔒 **Contratos entre funciones** (paquete `contracts/`, sin pruebas automatizadas: se verifican a mano): mensaje canónico (router → reglas), mensaje a enviar (reglas → router), resultado del bot (reglas ↔ bot: texto, más acciones solo para el bot externo) y **petición/respuesta de acción** (bot → reglas, 1.44). D14 está cerrada
- [x] 1.34 ➕ **Cola entre router y reglas**, con orden por conversación y sin romper `core/claims.py` ni la deduplicación de `processed_events`
  - **Hecho con Pub/Sub y clave de orden (suposición mía, sin confirmar contigo; el transporte está detrás de `channels/event_queue.py`, cambiarlo es cambiar el publicador):** el router publica un `ChannelEvent` (`contracts/messages.py`: mensaje del cliente, estado de entrega o eco de salida de ValueText) y la función 2 lo consume en `POST /queue/incoming` (`channels/ingest.py`, entry point `queue_incoming`). Así el router ya **no escribe en Firestore** salvo `processed_events` (su deduplicación). La clave de orden es número del bot + cliente (los ecos comparten la de su conversación; los estados, la del mensaje al que se refieren). `publish` es **síncrono**: el router responde 200 solo cuando la cola aceptó el evento y 500 si no (suelta la marca de duplicado, y el proveedor reintenta; en segundo plano una Cloud Function puede congelarse y perder el evento). El consumidor procesa **antes** de acusar (2xx), así Pub/Sub no entrega el siguiente de la misma conversación hasta terminar el anterior: dos mensajes seguidos ya no corren en paralelo y `core/claims.py` queda como defensa para lo demás. La cola entrega al menos una vez: el consumidor deduplica por evento con su propia marca (`ingest__…`, distinta de la del router). Un evento inválido se descarta con 200 y un error en el log (reintentarlo bloquearía la clave); un fallo transitorio da 500 y se reintenta. Sin `INCOMING_TOPIC` (desarrollo) se procesa en proceso y sin orden. **Sin probar contra Pub/Sub real** (la biblioteca no está instalada aquí; las pruebas usan un cliente falso). **Al desplegar:** tema y suscripción **push** a `/queue/incoming?secret=` con orden de mensajes habilitado, `ack deadline` de 600 s, política de reintento con retroceso y **tema de mensajes muertos**; `INCOMING_TOPIC`, `PUBSUB_REGION` y `QUEUE_PUSH_SECRET`; `--timeout=540` en la función de reglas; la cuenta de servicio del router necesita `pubsub.publisher`. **Pendiente:** con la cola, `send_whatsapp_message` sigue en proceso dentro de la función 2 (el envío por el router llega con 1.46); y con `ordering` Pub/Sub entrega de a uno por clave, así que el tiempo de un turno (Abacus) es el techo por conversación
- [x] 1.35 ➕ **Función 3 (bot):** entrada HTTP propia, sin estado. Mueve `ai/engine.py` y `ai/parsing.py`; usa el expediente y devuelve el resultado. **No ejecuta tools de negocio** (D14): `parsing.py` queda para el bot externo, para los tools de ChatLLM que no se migren (1.47) y para texto y vocabularios
  - **Hecho (`ai/service.py`, entry point `bot` en `main.py`):** `POST /bot/turn` (`BotRequest` → `BotResponse`: texto, motivo, handoff y, solo en el bot externo, acciones) y `POST /bot/summary` (resumen para 1.38, en una sesión aparte de Abacus). Sin estado y sin escribir en Firestore: lee el bot por `bot_id` con sus credenciales de `secrets` (1.41). Autenticación de servicio con `X-Service-Secret` = `BOT_FUNCTION_SECRET`, falla cerrado (`ALLOW_UNAUTHENTICATED_BOT=true` en desarrollo). Errores tipados (`timeout`, `bot_error`, `bot_no_configurado`) con `retryable`. El expediente, si trae algo, se antepone al mensaje. `ai/engine.py` y `ai/parsing.py` no se movieron de carpeta: ya son el paquete `ai/` que despliega esta función. **Falta el cambio de llamador, que va con 1.46:** el pipeline, `routing`, `jobs/inactivity`, `modules/ventas`, `campaigns` y `situacion` todavía llaman a `engine.send_to_bot` en proceso y leen el `api_result` crudo para detectar tools; pasan a la llamada HTTP cuando el pipeline lea las acciones del endpoint en vez de parsear. Al desplegar: `--timeout=300` por Abacus y flags propios (1.25)
- [x] 1.36 ➕ **Función 1 (router):** una sola función con las rutas `/webhook/twilio`, `/webhook/meta` y `/webhook/valuetext`. Normaliza, deduplica, responde 200 y envía por el proveedor lo que pida la función 2
  - **Hecho (`channels/router.py`, entry point `router` en `main.py`):** reemplaza a `whatsapp_webhook`, `meta_webhook` y `valuetext_webhook`. Despacha por el final del path (tolera barra final y prefijo; otra ruta, 404) y cada ruta valida su firma (1.42) antes de procesar. Deduplica por el ID del proveedor en `processed_events`: `MessageSid` de Twilio (los callbacks de estado no, repiten el SID por estado), `id` del mensaje de Meta y `Id` del objeto de ValueText. El envío por proveedor sigue entrando por `core/outbound.py` (cableado en `main.py`). Con 1.34 el router publica en la cola en vez de procesar. Al desplegar: `PUBLIC_BASE_URL` es la URL de la función sin la ruta (Twilio firma `<base>/webhook/twilio`), y hay que reapuntar los webhooks de cada proveedor a su ruta
- [x] 1.37 ➕ **Endpoint de acciones en la función 2:** valida el token de Firebase y los permisos por organización, equipo y agente asignado (lo que hoy hacen `firestore.rules` y `lib/authz.ts`) — hecho en `core/authz.py`, `core/user_actions.py` y el entry point `user_actions_execute` (`POST /user-actions/execute`, con CORS por `ALLOWED_ORIGINS`). Cada acción se declara con `declare(nombre, scope=org|conversation, level=write|admin)`; las acciones concretas llegan en 1.39
- [x] 1.38 ➕ **Expediente** (`{orgId}_{phone}`, D13): datos del cliente y resumen de cada conversación pasada. Al cerrar (normal o por inactividad), la función 2 pide el resumen a la 3 y lo guarda **fuera del camino de respuesta**. Al bot le llegan los datos y los últimos resúmenes, no el historial completo. Arranca vacío (D15)
  - **Hecho (`core/expediente.py`, `core/bot_client.py`, `jobs/summaries.py`):** el expediente vive en la ficha `customers/{orgId}_{phone}` (nombre) y en `customers/{id}/summaries/{conversationId}` (un resumen por conversación; sin reglas, el navegador no lo lee). Los resúmenes los pide el job `conversation-summaries` (`POST /jobs/run?job=conversation-summaries`, cada pocos minutos) a la función 3 (`/bot/summary`): cubre los ocho caminos de cierre sin tocar ninguno y deja el cierre fuera del camino de respuesta. Pendiente = cerrada en los últimos 3 días sin `summaryAt` posterior a `closedAt`, así una reapertura y nuevo cierre se vuelve a resumir; lo anterior no se resume (D15). Tope de 25 por tick; un fallo se reintenta en el siguiente. Al bot le llegan el nombre y los últimos 3 resúmenes **en el primer mensaje de una conversación nueva** (una reabierta ya los tiene en su sesión de Abacus). Se necesita el índice `status + closedAt` de `firestore.indexes.json`. Al desplegar: `BOT_FUNCTION_URL` y `BOT_FUNCTION_SECRET` en la función 2, y un Cloud Scheduler para el job. **Límites:** los `datos` solo traen el nombre (estado del Lead y citas son de Ventas: faltan que el módulo los aporte); un bot externo, que no guarda sesión, solo ve el expediente en el primer mensaje hasta que el turno pase a la función 3 (1.46)
- [x] 1.39 ➕ **Migrar cada escritura de las pantallas y rutas `/api` a la función 2:** tomar y cerrar conversación, etiquetas, bots, equipos, números, plantillas, campañas (`api/broadcasts/*`), mensajes (`api/send-message`), altas (`api/invite`), `api/conversations/*`, `api/integrations/situacion-detectada` y los 6 crons de 1.32
  - **Avance (rebanadas 1 a 9, hechas; tarea cerrada):** (1) las 10 escrituras de `ConversationChat.tsx` van por `conversation.*` (`core/conversation_actions.py`). (2) Las páginas de administración (agentes, equipos y su detalle con etiquetas, números, bots, plantillas, organizaciones, configuración) van por `team|number|bot|template|label|organization.*` y `member.*` (`core/admin_actions.py`: lista blanca de campos por entidad, referencias de la misma organización, cascadas de borrado y reasignación en el servidor). Cliente: `lib/hub-actions.ts` con `NEXT_PUBLIC_HUB_ACTIONS_URL`. (3) `AuthContext.tsx` ya no escribe: `me.claim_invite` (el primer inicio de sesión de un invitado, con email verificado del token), `me.sign_in` y `me.sign_out` en `core/account_actions.py`. (4) `conversation.send_message` (envío del agente por el proveedor del número, con el envío inyectado por `main.py` hasta que exista la función 1) y `member.invite` (con el webhook de correo en `INVITE_EMAIL_WEBHOOK_URL`); se borraron `api/invite` y `api/send-message`. (5) `broadcast.create` (`core/broadcast_actions.py`): el alta de campañas con sus destinatarios ya no la escribe `campanas/new`; se borró `api/broadcasts/route.ts`, que no usaba nadie. (6) `situacion-detectada` es un entry point de la función 2 (`core/situacion.py`, `POST /integrations/situacion-detectada`); el envío de plantillas por los tres proveedores vive en `channels/` y entra por la costura `core/outbound.py`; se borró la ruta del dashboard. (7) Envío, reintento, prueba, refresco y verificación de entregas de campañas: `broadcast.send|retry|refresh|check_status|test_send` (`core/campaigns.py`, `channels/campaign_templates.py`, `crm/campaign_events.py`); se borró `api/broadcasts/[id]/*`. (8) Los 6 crons del dashboard pasan a `jobs/` (`inactivity_ladder`, `scheduled_contacts`, `close_inactive`, `verify_templates`, `reminders`) con un solo entry point `POST /jobs/run?job=<nombre>` (`jobs/runner.py`): el cron solo avisa la hora. La escalación por inactividad vive en `core/escalation.py` y lo de Salesforce en eventos de `modules/ventas.py`; se borraron `api/cron/*` y `api/conversations/assign-agent-by-lead` (1.26). (9) `close-by-phone` es un entry point de la función 2 (`core/close_by_phone.py`, `POST /integrations/close-by-phone`). **Ninguna ruta de `/api` ni pantalla escribe ya en Firestore**: lo que queda en `/api` solo lee o consulta (`abacus-config`, `salesforce/*`, `test-salesforce`)
- [x] 1.40 ➕ **Recortar `firestore.rules` a solo lectura** y borrar la lógica duplicada en `/api`. Después de 1.39 — hecho: las reglas solo tienen `get`, `list` y `read` (`tests/test_firestore_rules.py` lo verifica) y `lib/authz.ts` quedó con lo que usan las consultas a Abacus y Salesforce. Las lecturas por organización y equipo no cambian; ya no hay búsqueda de usuario por correo ni alta del propio usuario desde el navegador
- [x] 1.41 ➕ ⚠️ **Credenciales de Twilio, Meta, ValueText y Abacus a Secret Manager.** La decisión #16 solo movió las de Salesforce, y hoy el GET de Meta busca `metaWebhookVerifyToken` en Firestore. Hay que decidir cómo se manejan los tokens por número
  - **Hecho con la opción B (decidida el 20 oct 2026):** las credenciales de números (`twilioAuthToken`, `metaAccessToken`, `metaWebhookVerifyToken`) y de bots (`twilioConfig.authToken`, `abacusConfig.deploymentToken` y `apiKey`, `externalConfig.apiKey`) viven en la colección `secrets`, sin ninguna regla en `firestore.rules`: el navegador no la lee. El documento solo guarda `secretsSet` y las pantallas muestran "configurado". Las acciones `number.*` y `bot.*` las separan al escribir; `core/credentials.py` las vuelve a poner al leer (`reveal`). Migración de lo ya cargado: `dev/migrate_secrets.py`. Las credenciales de Salesforce siguen en variables de entorno, y `BOT_ACTION_KEYS` en una variable montada desde Secret Manager. **Pasar cada credencial a Secret Manager** cuando entre producción solo cambia `core/credentials.py`
- [x] 1.42 ➕ ⚠️ **Validar la firma de cada webhook** en la función 1: Twilio, Meta y ValueText (el SOAP de Salesforce no tiene firma estándar: definir secreto compartido o lista de IPs). Hoy no existe ninguna validación. **Debe estar lista antes del corte de la Fase 3**
  - **Hecho (`channels/signatures.py`, `channels/webhook_auth.py`):** Twilio valida `X-Twilio-Signature` con el token del número que recibe o envía (se comprobó contra la biblioteca oficial, incluido el ejemplo de su documentación); Meta, `X-Hub-Signature-256` sobre el cuerpo crudo con `META_APP_SECRET` (varios, separados por comas); ValueText, secreto compartido en la URL (`VALUETEXT_WEBHOOK_SECRET`), porque un Outbound Message de Salesforce no se puede firmar. Todo falla cerrado (sin configuración se rechaza), salvo `ALLOW_UNAUTHENTICATED_WEBHOOKS=true` en desarrollo. Vive en cada ruta del router (1.36, `channels/router.py`). Twilio firma la URL exacta: `PUBLIC_BASE_URL` fija la pública de cada función. Sin protección contra repetición (ni Twilio ni Meta firman una marca de tiempo): la idempotencia de cada canal es la defensa. Al desplegar hay que poner `?secret=` en las URL de Salesforce (Outbound Messages de ValueText y de `close-by-phone`)

### 1.h Endpoint de acciones para los bots (D14) ➕

> Los bots dejan de devolver acciones para que el hub las detecte. Piden cada acción al hub y reciben el resultado. Un solo catálogo y dos puertas: HTTP para IA Workflows y ChatLLM. Ver §7.8 del plan.

- [x] 1.43 ➕ 💻 **Registro con contrato** (hecho en `core/tools.py`: `ActionSpec`, `declare`, `execute`. Quedan para 1.46 `Transferir_a_Asesor`, `Clasificar_Motivo` y `situacion`, que cambian el flujo del turno) en `core/tools.py`: cada acción declara schema de `data`, valor de retorno (`ok`, `status`, `result` o `error` con `code` y `retryable`) y flag `expuesta_a_bots`. Los handlers de Ventas devuelven resultado en vez de `None`. Un tool no expuesto no se puede invocar desde fuera
- [x] 1.44 ➕ 🔒 **`POST /actions/execute` en la función 2** (hecho en `core/actions.py` y el entry point `actions_execute`; clave por bot en `BOT_ACTION_KEYS`, a pasar a Secret Manager en 1.41): `{action, conversationId, idempotencyKey, data}`. El cliente, la organización y la vertical **salen de `conversationId`**, nunca de `data`. Autenticación de servicio por bot (distinta de la de usuarios, 1.37), lista de acciones permitidas por bot y errores tipados. Idempotencia reusando `core/idempotency.py`
- [ ] 1.45 ➕ ⚠️ **Reentrada:** mientras la función 2 espera a la 3 (HTTP síncrono), Abacus puede llamar de vuelta a la función 2. Verificar que `core/claims.py` no se bloquea a sí mismo, que la concurrencia y los timeouts alcanzan (el bot ya tiene timeout largo, 1.25) y que una acción lenta de Salesforce no vence al turno
  - **Revisión de código hecha (20 oct 2026), falta la prueba real contra GCP dev y Abacus:**
    - **Claims: no hay bloqueo.** El turno no sostiene ningún claim mientras espera al bot: `claim()` solo se toma dentro de `crear_lead` y `handoff_lead_seminuevo`, dura una transacción corta y se libera si falla. La acción de reentrada y el turno nunca esperan el mismo claim. Si el endpoint crea el Lead mientras el turno tiene su copia vieja de la conversación, el `claim` del turno ve `leadId` ya escrito y usa ese (es para lo que existe). Las escrituras del pipeline son `update` parciales, no pisan lo que escribió el endpoint.
    - **Concurrencia: no compite.** `actions-execute` se despliega como función propia (`main.py`), con su propio pool de instancias; la reentrada no ocupa el espacio del turno que espera. El turno ocupa un slot de `queue-incoming` hasta 120 s (timeout de `_post_json`) y hay 40 por instancia.
    - **Timeouts: ajustado en `main.py`.** `actions-execute` no tenía `--timeout`, y el defecto (60 s) es corto para una acción con varias llamadas a Salesforce de 30 s cada una; se documentó `--timeout=120`. Cadena: `queue-incoming` 540 s → bot 300 s → Abacus (120 s por llamada) → de vuelta a `actions-execute` 120 s.
    - **Hasta 1.46 el pipeline llama al motor en proceso, no a `/bot/turn`:** la cadena de tres saltos aún no existe en producción; esta revisión vale para cuando exista.
    - **Falta (⚠️, con ejecución real):** el timeout del paso HTTP del workflow en Abacus (debe ser mayor a 120 s o la acción vence antes de responder), y un turno completo con una acción lenta. Se confirma junto con 1.47.
    - **Observación fuera de 1.45:** en `crear_lead`, si otra invocación tiene el claim y aún no hay `leadId`, devuelve éxito con `leadId` vacío (`status: duplicate`). El bot creería que hay Lead. **Corregido (20 oct 2026):** ahora devuelve `ERROR_EXTERNO` con `retryable`.
- [x] 1.46 ➕ **El pipeline lee las acciones ejecutadas del turno** (registradas por el endpoint en la conversación) en lugar de parsear la respuesta del bot. El handoff y el fuera de horario se leen del **resultado** de la acción: el gate de horario y módulo se aplica dentro del endpoint
  - **Hecho (20 oct 2026; `core/action_log.py`, `core/pipeline.py`, `core/default_tools.py`):** el pipeline deja un `turnId` en la conversación antes de llamar al bot; el endpoint copia ese id a `conversations/{id}/actionLog/{idempotencyKey}` en cada acción exitosa; al volver, el pipeline lee las de su turno. Lo que el bot ya ejecutó por el endpoint cuenta como hecho (no se detecta otra vez en su respuesta) y la conversación del turno se refresca con lo que esas acciones escribieron (p. ej. el `leadId`). **Conviven los dos caminos:** un bot que no migró sigue detectándose por `ai/parsing.py` (1.48 retira esa parte).
  - **Dos acciones nuevas, expuestas a bots:** `clasificar_motivo` (valida contra `outcomeActions`) y `transferir_a_asesor`. Esta última corre dentro del endpoint el `handoff_gate` del módulo y el horario, aplica el estado y devuelve `escalado`, `ya_escalado`, `fuera_de_horario` (con `mensaje`) o el error `precondicion_fallida` con lo que falta (Ventas: crear el Lead; el bot lo crea y vuelve a pedir la transferencia, sin que el hub le hable al cliente ni re-invoque al bot). Entran al catálogo de `DEFAULT_TOOLS` con `phase: "endpoint"`: el pipeline nunca las detecta en la respuesta. **Un bot con `tools[]` propio debe agregarlas para poder pedirlas.**
  - **El aviso al cliente sigue saliendo del pipeline** (el endpoint no tiene el canal): tras `escalado` contesta lo que dijo el bot; tras `fuera_de_horario` manda el aviso del admin, o lo que el bot redactó si `scheduleConfig.viaBot`.
  - **Falta, a propósito:** (a) `situacion` sigue por el camino viejo: cambia de bot y reemplaza la respuesta del turno, y no cabe en el endpoint sin rediseñarlo; (b) el pipeline sigue llamando al motor en proceso, no a `/bot/turn` de la función 3 — mover el turno es otro paso (necesita la función 3 desplegada y `BotRequest.expediente`); (c) los bots no han migrado (1.47 y 1.48).
- [ ] 1.47 ➕ ⚠️ **Prueba del ChatLLM (opción A):** tool personalizado en Abacus que hace el POST al endpoint con `conversationId` y los params del modelo. Abacus **sí permite** llamadas HTTP salientes (confirmado 16 oct 2026): basta crear el tool. Falta confirmar que se pueda pasar el `conversationId` al tool. **Si no se puede**, ChatLLM sigue con detección posterior (`ai/parsing.py`) y solo migran los workflows
- [ ] 1.48 ➕ **Migrar los bots a la forma nueva:** los IA Workflows de Servicio llaman al endpoint en vez de devolver segmentos `action` (se retira la estrategia `workflow` de `parsing.py` cuando el último migre) y, si 1.47 sale bien, los tools del ChatLLM de Ventas. Cada cambio se hace en Abacus, coordinado con el corte de la Fase 3 o la 4

### Criterio de cierre

- [x] 1.27 `core/` **sin un solo `if vertical == ...`** y sin importar de `modules/`
- [x] 1.28 `cita_agendada` despachando a handlers distintos en Ventas y Servicio
- [ ] 1.29 Conversación end-to-end por los 3 proveedores
  - 🔁 Se mueve hasta después de 1.g: el recorrido cruza cola y tres funciones
- [ ] 1.30 Bot `type: "external"` validado contra un stub
  - 🔁 Se valida sobre la función 3
- [ ] 1.30b ➕ Una acción pedida por el endpoint (1.44) corre el mismo handler que la pedida por el pipeline, y devuelve el mismo efecto en Salesforce y en Firestore

---

## Fase 2 — Núcleo en AWS + Valuación en producción

> **Primera fase productiva** (reescrita el 18 nov 2026). El núcleo de conversaciones se muda a AWS y PostgreSQL, Valuación entra por el contrato de entrada y sale a producción con sus marcas piloto. Diseño: [`DISENO_BACKEND_AWS.md`](DISENO_BACKEND_AWS.md) (rebanada 1). Las antiguas 2.1 a 2.11 se reparten aquí y en la Fase 3 (ver al final de la fase).

### 2.a Núcleo en AWS

- [x] 2.1 Cliente de PostgREST (`core/postgrest.py`) y credenciales en AWS Secrets Manager
- [x] 2.2 Puntos de entrada de Lambda (`handlers.py`, adaptador de API Gateway) y despliegue (`dev/deploy_aws.ps1`)
- [ ] 2.3 Tablas y acciones `Hub.*` del núcleo en `hub_cleber` (`equipos`, `numeros`, `bots`, `conversaciones`, `mensajes`, `bitacora`) y `core/datos/` por entidad — hecho en parte (números, conversaciones de Valuación)
- [x] 2.4 🔒 **Entrada de mensajes** (probada en dev el 2026-11-18, solo Twilio; Lambdas `hub-router-dev` y `hub-msj-entrantes-dev`): `hub-router` → SQS FIFO `hub-entrantes` (con DLQ) → `hub-msj-entrantes` → `hub-bot`. Reemplaza Pub/Sub (1.34) y las tres funciones de GCP (1.g)
- [x] 2.5 Firma del webhook de Twilio validada con `TWILIO_AUTH_TOKEN` del ambiente; `PUBLIC_BASE_URL` = URL pública final
- [x] 2.6 Reapuntar el webhook del número de pruebas de Twilio a AWS (el cambio tardó unos minutos en aplicar)
- [ ] 2.7 `hub-acciones-bot` (endpoint de acciones para bots, D14) en AWS; resolver el límite de 29 s del API Gateway (`DISENO_BACKEND_AWS.md` §9, I2)
- [x] 2.8 `hub-acciones-usuario` con el authorizer de Google — corre en dev (vista previa de plantilla)
- [ ] 2.9 `hub-jobs` con EventBridge Scheduler: inactividad, cierre y resúmenes del expediente
- [ ] 2.10 **Tiempo real** en AWS (propuesta: AppSync Events, `DISENO_BACKEND_AWS.md` §6). La bandeja y el chat dejan `onSnapshot` de Firestore
- [ ] 2.11 Conversación de punta a punta en dev por Twilio: entra, contesta el bot, handoff, el asesor contesta, cierre (antes 1.29, solo Twilio)
- [ ] 2.11b ⚠️ Reentrada bot → acciones con Abacus real (antes 1.45)

### 2.b Contratos con Valuación

- [x] 2.12 **Contrato ① (entrada):** `hub-entry-point`, idempotente por (`fuente`, `id_externo`), con `<<CONTEXTO>>` para el bot y botón **Enviar** en Ofertas — en dev
- [ ] 2.12b Autenticación por sistema origen en ① (invocación directa con IAM para Valuación; `/internal` con API key para otros)
- [ ] 2.13 **Contrato ② (bot):** IA Workflow de Abacus de Valuación, con su vocabulario de acciones como configuración; priming verificado (el bot responde sabiendo qué oferta se mandó)
- [ ] 2.14 **Contrato ③ (salida):** eventos de la conversación a `TomaUnidades.recibeEventoHub` (contestó, pasó a asesor, resultado, cierre). Leer el `ButtonPayload` (`oferta_interesa` / `oferta_no_interesa`)
  - **Hecho en el hub (18 nov 2026), sin desplegar:** el router conserva el `ButtonPayload`; `core/contrato_salida.py` entrega los eventos al terminar el turno llamando a `Valuacion.registraResultadoConversacion` por PostgREST (sin Lambda), y `modules/valuacion.py` emite `conversation.replied` (con el payload del botón como `accion`), `.handoff`, `.outcome` y `.closed` (opt-out). Un evento fallido queda en el log y en la bitácora (`evento_salida_fallido`).
  - **Falta:** (a) en Valuación, autorizar a `sistema@hub-conversaciones.internal` en `valuacion.contexto_usuario` (decisión B); (b) el cierre que hace el asesor desde la bandeja y el cierre por inactividad todavía no emiten `conversation.closed`; (c) probarlo de punta a punta.
- [ ] 2.15 🔒 ⚠️ **Números de WhatsApp de Valuación por marca piloto** (D17) y **plantilla de la oferta aprobada**. Trámite externo: arrancarlo ya
- [x] 2.16 Pantalla de Números de WhatsApp con vista previa de la plantilla de Twilio
- [x] 2.17 Pantallas de Ofertas y Conversaciones con datos reales — en dev
- [ ] 2.17b Dashboard y Configuración por agencia de Valuación con datos reales
- [x] 2.17c Pantalla de **Bots** de Valuación sobre `hub_cleber` (18 nov 2026, sin desplegar): lista, crear y editar con las pestañas General, Abacus AI, Handoff, Horarios, Avanzado y ChatLLM (lo que Abacus tiene configurado para el deployment, con la misma vista que Ventas y Servicio; solo administradores), igual que la de Ventas y Servicio. Pendientes de esa pantalla: Inactividad (cuando corran los recordatorios en AWS) y las herramientas del bot (con 2.7). Requiere `ABACUS_API_KEY` en el servidor web (Vercel)
- [ ] 2.18 Originación diaria (cron de madrugada: Quiter → BigQuery → criterios → precios) en producción, con la fuente de precios decidida (D16)
- [ ] 2.19 Registro de la oferta final después de la inspección
- [ ] 2.20 Verificar que no quedó nada de Valuación en `core/`, el router ni el bot (el ensayo de §3 del plan, antes 2.10 y 2.11)

### 2.d Producción

- [ ] 2.21 🔒 Seguridad de dev resuelta antes de copiar el patrón (`PENDIENTES_INFRA_DEV.md` S1 a S3, I1 e I2)
- [ ] 2.22 Cuenta de AWS de producción (`386458449724`): Lambdas, SQS, Secrets Manager, tiempo real y alarmas de CloudWatch
- [ ] 2.23 API Gateway de producción: authorizer de Google, rutas con VPC Link y excepción de API key para `/webhook/*` (`PENDIENTES_INFRA_DEV.md` P1 a P4)
- [ ] 2.24 PostgreSQL de producción con `hub_cleber`, `clientes` y `valuacion`
- [ ] 2.25 Vercel y cliente de Google OAuth de producción
- [ ] 2.26 Revisar `CLEBER_API_KEY` en los secretos de cada ambiente (en `hub/dev/entorno` está vacía)
- [ ] 2.27 Prueba de punta a punta en producción con una marca piloto
- [ ] 2.28 ✅ **Hito: Valuación operando en producción con sus marcas piloto**

### Lo que salió de la antigua Fase 2

| Antes | Ahora |
|---|---|
| 2.1 a 2.7 — contrato de entrada | 2.12 y 2.12b (ya existe sobre AWS para Valuación) |
| 2.5 — envío por los 3 proveedores | Twilio aquí; Meta y ValueText en las fases 3 y 4 |
| 2.8 — `lead_webhook` sobre el contrato | Fase 3 (3.3) |
| 2.9 — absorber broadcasts, `situacion-detectada` y web-chat | Fases 3 y 4 |
| 2.10 y 2.11 — ensayo con módulo de prueba | 2.20: el ensayo es Valuación misma |

---

## Fase 3 — Adecuar y migrar Ventas

> Ventas sobre el núcleo que Valuación ya dejó en producción. Primero se adecua a AWS y PostgreSQL (rebanada 2 de `DISENO_BACKEND_AWS.md`); después se migra marca por marca.

### Adecuar

- [ ] 3.1 `modules/ventas.py` y `crm/` sobre `core/datos/` (PostgreSQL), sin Firestore
- [ ] 3.2 Validar la firma de Meta y ValueText en `hub-router`, si las marcas de Ventas los usan
- [ ] 3.3 **`lead-webhook` reimplementado sobre el contrato de entrada**, no al lado (antes 2.8)
- [ ] 3.4 Situaciones y ruteo entre bots; campañas por la cola `hub-campanas`; contacto programado y crons de Ventas en `hub-jobs`
- [ ] 3.5 Pantallas de Ventas que leen Firestore → `Hub.consulta*` y tiempo real de AWS
- [ ] 3.6 Prueba del ChatLLM con el endpoint de acciones y migración de los bots de Ventas (antes 1.47 y 1.48)
- [ ] 3.7 Conversación de punta a punta de Ventas en dev, y verificar que Valuación sigue igual

### Migrar

- [ ] 3.8 ✅ **Migración en corte (D8)** — sin doble escritura. Definir ventana, duración máxima tolerable y el punto de no retorno de cada corte
- [ ] 3.9 Migrar equipos, números, bots, usuarios y configuración (`Hub.importaConfiguracion`)
- [ ] 3.10 Migrar las conversaciones **activas** y sus mensajes (`Hub.importaConversaciones`). El expediente **arranca vacío** (D15)
- [ ] 3.11 Reapuntar webhooks de los proveedores a `hub-router` — **los números no cambian**
- [ ] 3.12 Plan de rollback: la plataforma vieja encendida y capaz de recibir hasta cerrar cada corte
- [ ] 3.13 Migrar **marca por marca**, empezando por la de D9
- [ ] 3.14 🔒 **Validar que la federación Ventas → Servicio sigue funcionando a través del corte** — durante esta ventana Ventas está en la nueva y Servicio en la vieja
- [ ] 3.15 Reconciliar métricas contra la plataforma vieja
- [ ] 3.16 Apagar la plataforma de Ventas vieja

---

## Fase 4 — Adecuar y migrar Servicio

> Al cerrarla: **plataforma centralizada** con Valuación, Ventas y Servicio.

- [ ] 4.1 Adecuar lo propio de Servicio: parseo `workflow`, outcomes, recordatorios de cita, no-show, `close-by-phone` y `situacion-detectada` sobre AWS y PostgreSQL
- [ ] 4.2 Migrar los IA Workflows de Servicio al endpoint de acciones (antes 1.48)
- [ ] 4.3 ⚠️ El script de migración lee la **base default** de Servicio (`atomic-hybrid-482121-n7`), no una nombrada
- [ ] 4.4 Migrar configuración y conversaciones activas de Servicio
- [ ] 4.5 Reapuntar webhooks
- [ ] 4.6 Verificar que la federación HTTP Ventas ↔ Servicio **desaparece** y pasa a ser transferencia interna
- [ ] 4.7 Apagar las plataformas viejas (GCP y Vercel), el despliegue congelado del hub en GCP y su Firestore
- [ ] 4.8 ✅ **Hito: un repo, una base, una bandeja, un login**

---

## Fase 5 — Consolidación

> Cobrar lo que la centralización hizo posible.

### Transferencia entre módulos

- [ ] 5.1 Dos destinos distintos: `derivar_fuera` (cierra) y **`transferir_modulo` (conserva el lead)**
- [ ] 5.2 Generalizar la transferencia a los **3 proveedores** (hoy `_notify_situacion_interna` solo manda por ValueText y retorna `False` con los otros)
  - 🔁 Se simplifica: el hub ya envía por los tres proveedores, así que basta pedirle el envío
- [ ] 5.3 Redactar las plantillas de transferencia para que no se sientan como un rebote
- [ ] 5.4 Validar transferencia entre organizaciones distintas, incluido Ventas → Valuación

### Ficha de cliente

- [ ] 5.5 Panel de cliente en la ficha de conversación, con timeline cruzado de los tres módulos
  - 🔁 El dato ya existe desde 1.38 (expediente, hoy `clientes.clientes` y `clientes.resumenes`). Solo falta la vista
- [ ] 5.6 Vistas cruzadas por marca y módulo para el gerente de marca
- [ ] 5.7 Métricas por marca × módulo

---

## Las que no se pueden dejar para después

| Tarea | Por qué |
|---|---|
| **2.15 · Números y plantilla de Valuación** | Trámite externo con tiempos que no controlamos: sin él Valuación no sale a producción |
| **2.4 y 2.5 · Entrada de mensajes con firma** | Sin esto el cliente no puede contestar la oferta |
| **2.21 · Seguridad de dev** | PostgREST de dev está abierto a internet; producción no debe copiar ese patrón |
| **2.20 · Nada de Valuación en `core/`** | Corregir un gancho mal puesto es barato antes de que entren Ventas y Servicio, caro después |
| **D16 · Fuente de precios** | Bloquea la originación en producción |
| **3.14 · Federación a través del corte** | Es de las que se asumen y luego se rompen en producción |
