# Tareas pendientes, por fase

**Fecha: 14 de octubre de 2026**

Checklist de trabajo. El porqué de cada cosa está en [`PLAN_TRABAJO_CENTRALIZACION.md`](PLAN_TRABAJO_CENTRALIZACION.md); el detalle de las funciones, en [`INVENTARIO_FUNCIONES_CLASIFICADAS.md`](INVENTARIO_FUNCIONES_CLASIFICADAS.md).

**Leyenda:** 🔒 bloquea otras tareas · 💻 se puede hacer local, sin GCP · ⚠️ necesita confirmación antes de ejecutar

---

## Resumen

| Fase | Objetivo | Local |
|---|---|---|
| **D** | Decisiones y trámites — no es desarrollo, pero bloquea | — |
| **0** | Fundación: que nazca segura, modular y con el esquema correcto | 💻 |
| **1** | Portar el núcleo conversacional probado | 💻 |
| **2** | Contrato de entrada único, y el punto de extensión verificado | 💻 |
| **3** | Migrar Comercial | ❌ |
| **4** | Migrar Servicio → **plataforma centralizada** | ❌ |
| **5** | Consolidación: transferencia interna y ficha de cliente | ❌ |
| ~~6~~ | ~~Valuación~~ — ⏸️ **fuera del alcance de este plan** | — |

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
| D9 | Decidir **qué marca se migra primero** (recomendado: la de menor volumen) | Fase 3 |
| ~~D10~~ | ~~Cuándo entra Valuación~~ | ⏸️ Fuera de alcance |
| ~~D11~~ | ~~Quién hospeda el agente de Valuación~~ — respondido: IA Workflow de Abacus | ⏸️ Fuera de alcance |
| ~~D12~~ | ~~Ofertas de compra / toma a cuenta en Salesforce~~ | ⏸️ Fuera de alcance |

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
- [x] 0.7 Montar el **registro de handlers por vertical** en `core/tools.py`
- [x] 0.8 Reglas de import: globales solo en `core/db.py`; `core/` **nunca** importa de `modules/`; ningún archivo llamado `twilio.py`

### Seguridad

- [x] 0.9 🔒 Portar las ~200 líneas de reglas granulares del repo de Servicio
- [x] 0.10 Extender las reglas para validar también **equipo/vertical**, no solo organización
- [ ] 0.11 **Pruebas automatizadas de reglas** con `@firebase/rules-unit-testing`: un usuario de la organización A no puede leer documentos de la B — **Diferida:** se probarán con datos reales sobre GCP dev (`dev-hub-conversaciones`), sin emulador

### Esquema

- [x] 0.12 `teams/{id}.vertical` y `conversations/{id}.vertical` (denormalizado)
- [ ] 0.13 `customers/{orgId}_{phone}` + `conversations.customerId` — se escriben desde la primera conversación, sin backfill después
- [ ] 0.14 `conversations.source` / `.externalId`
- [x] 0.15 **Unicidad de `sfBrandCode`** (validación o índice)
- [x] 0.16 Base **default** de Firestore, location `nam5`; Functions en `us-central1`

### Dashboard como shell

- [ ] 0.17 Navegación por módulo, no por sistema
- [ ] 0.18 Una sesión y un padrón de usuarios; los servicios externos validan ese token
- [ ] 0.19 Punto de extensión documentado para que un módulo agregue pantallas

### Nube (cuando haga falta el primer despliegue real)

- [ ] 0.20 Crear GCP (según D5), Vercel y Firestore
- [ ] 0.21 Pipeline de deploy con `--project` **fijado explícitamente**
- [ ] 0.22 Gestión de secretos por ambiente

---

## Fase 1 — Portar el núcleo 💻

> El orden importa: primero lo que no depende de decisiones de negocio. Las 40 funciones de núcleo/routing/CRM antes que las 19 handlers de Ventas.

### 1.a Capa de parseo — va primero, desbloquea todo lo demás

- [x] 1.1 `ai/parsing.py` con **estrategia por motor**: `chatllm`, `workflow`, `external`
- [x] 1.2 Colapsar las **6 `check_*_tool_call`** de Comercial en la estrategia `chatllm`
- [x] 1.3 Colapsar `get_ai_outcome_action` + `get_broadcast_response_action` en la estrategia `workflow`
- [x] 1.4 ⚠️ **Prueba que cubra la trampa de los dos segments de Abacus** — quedarse con el primero que hace match del title perdía el 100% de los params

### 1.b Núcleo — 24 funciones, sin decisiones de negocio

- [ ] 1.5 Las **18 de núcleo** a `core/`, `channels/` y `ai/` (incluye las 5 de plataforma que aporta Servicio)
- [ ] 1.5b **Opt-out universal (D4):** `_is_stop_message` en `core/` → **cierra la conversación en los tres módulos**. Lo que cada módulo hace además se despacha como evento `opt_out` al handler: Ventas marca el Lead `Finalizado por cliente` (`_update_lead_on_stop`), Servicio solo cierra. Es el caso de §4 en su forma más limpia
- [ ] 1.6 Las **6 de routing** a `core/routing.py` (motor de situaciones; las rutas ya son config)
- [ ] 1.7 ⚠️ Corregir `get_whatsapp_number_by_brand`: **`.limit(1)` sin `orderBy`** es la colisión silenciosa de `sfBrandCode`
- [ ] 1.8 Generalizar `_is_duplicate_lead` a idempotencia por **`(source, externalId)`** — la que pide la Fase 2
- [ ] 1.9 Generalizar el patrón `_claim` a `core/claims.py`, separándolo de la parte de Lead

### 1.c CRM compartido

- [ ] 1.10 Las **5 de CRM** a `crm/salesforce.py` y `crm/templates.py`
- [ ] 1.11 ⚠️ Renombrar `send_lead_template` — **es ValueText** (inserta en `rsplus__SMS_Bucket__c`), el nombre engaña y es la raíz del límite de un solo proveedor

### 1.d Configuración fuera del código — antes de escribir handlers

- [ ] 1.12 Nombres de tools (`Crear_Lead`, `Crear_Cita_Ventas_Salesforce`, …) → `bots/{id}.tools[]`
- [ ] 1.13 Vocabularios `AI_OUTCOME_ACTIONS` y `BROADCAST_RESPONSE_ACTIONS` → config del bot
- [ ] 1.14 Nombre del Flow `RRAgenteIACLEBER` → `salesforceConfig`
- [ ] 1.15 `RecordTypeId` de Lead y Event, owners, owner de BDC → `salesforceConfig`
- [ ] 1.16 Mapeo situación → `Status` / `Validacion_Prospecto__c` → config del módulo
- [ ] 1.17 Zona horaria **UTC-6** → `organizations/{id}`

### 1.e Handlers de módulo

- [ ] 1.18 Las **19 de Ventas** a `modules/ventas.py`, cada una registrada contra el núcleo
- [ ] 1.19 ⚠️ Decidir si el **contacto programado** (3 funciones) es de Ventas o genérico — si es genérico, sube a `core/`
- [ ] 1.20 ⚠️ Separar las dos **mixtas**: `_block_handoff_out_of_hours` (gate core + lead Ventas) y el par de `claim`
- [ ] 1.21 `modules/servicio.py` — nace prácticamente vacío; verificar que no quede nada mal clasificado

### 1.f Dashboard y despliegue

- [ ] 1.22 Portar el dashboard: bandeja, ficha de conversación, administración, métricas
- [ ] 1.22b **Panel por módulo en la ficha de conversación** (D6): slot que renderiza según `conversations.vertical` — Lead y cita en Ventas, outcome en Servicio, oferta en Valuación. El núcleo del dashboard sin `if vertical ==`
- [ ] 1.22c ✅ **No portar `bot-engine.ts` (D7).** El Web Chat no está en uso, así que la duplicación Python ↔ TypeScript **desaparece del alcance**. Si el canal vuelve, llama a la Cloud Function en vez de reimplementar el motor
- [ ] 1.23 🔒 **Decidir qué versión gana en cada archivo con drift antes de portar** (`conversations/page.tsx`: 409 líneas distintas; `bot-engine.ts`: 64)
- [ ] 1.24 **Inventario del dashboard TypeScript** — el de `main.py` no lo cubre
- [ ] 1.25 Flags de capacidad **explícitos** en los comandos de deploy (`--max-instances=300 --concurrency=40`); un redeploy sin ellos resetea a los defaults
- [ ] 1.26 ⚠️ Confirmar si `voice_llm_endpoint` y `assign_agent_by_lead` están en uso — no aparecen en los comandos de deploy documentados

### Criterio de cierre

- [ ] 1.27 `core/` **sin un solo `if vertical == ...`** y sin importar de `modules/`
- [ ] 1.28 `cita_agendada` despachando a handlers distintos en Ventas y Servicio
- [ ] 1.29 Conversación end-to-end por los 3 proveedores
- [ ] 1.30 Bot `type: "external"` validado contra un stub

---

## Fase 2 — Contrato de entrada 💻

> Una sola puerta en vez de cuatro. Al cerrarla, la plataforma queda **certificada como preparada**.

- [ ] 2.1 `POST /api/integrations/conversations` con **API key por sistema origen**
- [ ] 2.2 Idempotencia por `(source, externalId)` — reusa 1.8
- [ ] 2.3 Resolución del número → organización, equipo, bot, proveedor
- [ ] 2.4 Reusar conversación abierta o crear nueva, con ventana de 24h
- [ ] 2.5 Envío de plantilla por los **3 proveedores**
- [ ] 2.6 **Priming de la sesión** con `<<PLANTILLA>>` + `<<CONTEXTO>>` — sin esto el bot contesta sin saber qué se mandó
- [ ] 2.7 Persistir `source` / `externalId` en la conversación
- [ ] 2.8 **Reimplementar `lead_webhook` sobre este contrato**, no al lado
- [ ] 2.9 Plan de absorción de los otros 3 caminos (broadcasts, `situacion-detectada`, web-chat)

### El ensayo que certifica

- [ ] 2.10 🔒 **Módulo de prueba end-to-end**: bot `external` contra un stub, número de prueba, `vertical: "prueba"` → disparar, conversar, handoff, cerrar
- [ ] 2.11 🔒 **Verificar que corrió sin tocar `core/`.** Si hubo que tocarlo, el gancho está mal puesto y se corrige **antes** de migrar

---

## Fase 3 — Migrar Ventas

> Primera vertical con datos vivos. Marca por marca; la primera es el rodaje de la plataforma.

- [ ] 3.1 ✅ **Migración en corte (D8)** — sin doble escritura. Definir ventana, duración máxima tolerable y el punto de no retorno de cada corte
- [ ] 3.2 Migrar organizaciones, equipos, números, bots, usuarios y configuración
- [ ] 3.3 Migrar conversaciones y mensajes, **poblando `vertical` y `customerId` al escribir**
- [ ] 3.4 Reapuntar webhooks de los proveedores al GCP nuevo — **los números no cambian**
- [ ] 3.5 Plan de rollback: la plataforma vieja encendida y capaz de recibir hasta cerrar cada corte
- [ ] 3.6 Migrar **marca por marca**, empezando por la de D9
- [ ] 3.7 🔒 **Validar que la federación Ventas → Servicio sigue funcionando a través del corte** — durante esta ventana Ventas está en la nueva y Servicio en la vieja
- [ ] 3.8 Reconciliar métricas contra la plataforma vieja
- [ ] 3.9 Apagar la plataforma de Ventas vieja

---

## Fase 4 — Migrar Servicio

> Al cerrarla: **plataforma centralizada**.

- [ ] 4.1 ⚠️ Ajustar el cliente de Firestore: Servicio usa la **base default**, no nombrada
- [ ] 4.2 Migrar organizaciones, datos y conversaciones de Servicio
- [ ] 4.3 Reapuntar webhooks
- [ ] 4.4 Verificar que la federación HTTP Ventas ↔ Servicio **desaparece** y pasa a ser transferencia interna
- [ ] 4.5 Apagar los proyectos de GCP y Vercel viejos
- [ ] 4.6 ✅ **Hito: un repo, una base, una bandeja, un login**

---

## Fase 5 — Consolidación

> Cobrar lo que la centralización hizo posible.

### Transferencia entre módulos

- [ ] 5.1 Dos destinos distintos: `derivar_fuera` (cierra) y **`transferir_modulo` (conserva el lead)**
- [ ] 5.2 Generalizar la transferencia a los **3 proveedores** (hoy `_notify_situacion_interna` solo manda por ValueText y retorna `False` con los otros)
- [ ] 5.3 Redactar las plantillas de transferencia para que no se sientan como un rebote
- [ ] 5.4 Validar transferencia entre organizaciones distintas

### Ficha de cliente

- [ ] 5.5 Panel de cliente en la ficha de conversación, con timeline cruzado
- [ ] 5.6 Vistas cruzadas por `organizationId + vertical` para el gerente de marca
- [ ] 5.7 Métricas por marca × vertical

---

## Fuera del alcance — Valuación

**No se trabaja en este plan.** El detalle está en el [Apéndice A](PLAN_TRABAJO_CENTRALIZACION.md) del plan, para retomarlo cuando el negocio lo defina.

Lo que quedaría por hacer, en una línea: alta de 5 números, documentos de Firestore por marca, API key, contrato de salida (outcomes), vocabulario de acciones del Workflow como config, y las pantallas de Valuación dentro del dashboard.

Y tres decisiones de negocio abiertas: cuándo entra, si las ofertas se registran en Salesforce, y **cómo le llegan el VIN, el valor y la oferta al Workflow** — la de más peso.

> **Nada de esto condiciona las fases 0 a 5.** Los ganchos que Valuación necesitaría se construyen igual porque la centralización de Comercial y Servicio los necesita (ver §1 del plan).

---

## Las que no se pueden dejar para después

| Tarea | Por qué |
|---|---|
| **D1 · Dueño del repo** | Sin esto no arranca la Fase 0 |
| **D4 · Opt-out de Servicio** | Si el hueco es real, es cumplimiento, no funcionalidad |
| **0.9–0.11 · Reglas de Firestore** | Con los módulos en una base, un asesor podría leer datos de otra marca |
| **1.12–1.17 · Config fuera del código** | Un handler se escribe mucho más limpio cuando los valores ya salieron |
| **1.23 · Decidir el drift antes de portar** | Decidirlo después significa portar dos veces |
| **2.10–2.11 · El ensayo** | Corregir un gancho mal puesto es barato con la plataforma vacía, caro después de migrar |
| **3.7 · Federación a través del corte** | Es de las que se asumen y luego se rompen en producción |
