# Análisis: centralización de plataformas (Comercial + Servicio + nueva plataforma de Compra/Toma a cuenta)

Fecha: 2026-10-12
Repos analizados:
- `gerayga-cleber/cleber-bot-platform-comercial` → `PlataformaChatbotsComercial/` (este repo)
- `dcavazos/cleber-bot-platform` → `HondaChatbotChatLLM/`

---

## 0. Resumen ejecutivo

**No hay una sola pregunta, hay dos**, y conviene decidirlas por separado:

| | Qué significa | Recomendación |
|---|---|---|
| **A. Centralizar el runtime** | Una sola bandeja / un solo motor de conversación para todas las verticales | **Sí, y es lo urgente.** La plataforma de bots debe ser el *motor conversacional compartido*; la nueva plataforma de valuación y la de Servicio son **sistemas de negocio que la consumen**, no plataformas de chat propias |
| **B. Centralizar el código** | Unificar los dos repos forkeados en uno | **Sí, pero por fases.** Hoy se mantiene todo dos veces. Con una tercera vertical se mantendría tres veces |

**El riesgo principal del cambio que viene no es técnico, es de forma: hacer un tercer fork.** Los dos repos actuales ya demuestran el costo — comparten el 100% del núcleo y divergen solo en la lógica de negocio.

**La decisión clave:** la nueva plataforma de valuación **no debe meter su lógica en `main.py`**. Debe conectarse por tres contratos genéricos (dos de los cuales ya existen al 70%), quedándose con el negocio (valuación, oferta, inventario) y delegando a la plataforma de bots todo lo conversacional (WhatsApp, bandeja, handoff, horarios, recordatorios, métricas).

---

## 1. Estado real hoy (medido, no estimado)

### 1.1 Los dos repos son el mismo producto forkeado

| Métrica | Comercial | Servicio |
|---|---|---|
| `main.py` | 4,727 líneas | 2,654 líneas |
| Funciones en común | **46** | **46** |
| Funciones exclusivas | 50 (todas de CRM/leads/situaciones) | 7 (outcomes + broadcast responses) |
| Proyecto GCP | `ia-chatbots-ventas` | `atomic-hybrid-482121-n7` |
| Firestore | base `chatbots-ventas` | base default |
| Dashboard (`apps/web/src`) | ~95% el mismo set de archivos | ~95% el mismo set de archivos |

Las 46 funciones compartidas **son la plataforma entera**: los 3 webhooks de canal (`whatsapp_webhook`, `valuetext_webhook`, `meta_webhook`), `get_or_create_conversation`, `create_new_conversation`, `add_message`, `send_whatsapp_message` / `send_twilio_message` / `send_meta_message` / `send_salesforce_message`, `send_to_chatllm`, `auto_assign_agent`, `check_business_hours`, `check_handoff_keywords`, `inactivity_followup`, `voice_llm_endpoint`.

Lo que diverge es **lógica de negocio de la vertical**:
- Comercial: Salesforce Leads (`create_salesforce_lead`, `update_salesforce_lead`), citas (`create_salesforce_appointment`), situaciones (`process_situacion_handoff`, `_switch_conversation_bot`), `lead_webhook`, contactos programados.
- Servicio: `set_conversation_outcome`, `record_broadcast_response`, `get_ai_outcome_action`, `_next_round_robin_agent`.

### 1.2 Divergencia en el dashboard (archivos compartidos)

| Archivo | Comercial | Servicio | Líneas distintas |
|---|---|---|---|
| `types/index.ts` | 188 | 192 | 20 |
| `conversations/page.tsx` | 1,398 | 1,601 | 409 |
| `lib/bot-engine.ts` | 373 | 377 | 64 |
| `api/send-message/route.ts` | 285 | 294 | 31 |

Es drift reconciliable, no dos productos distintos. Pero **cada feature nueva se implementa dos veces**: semáforo, multi-org (`organizationIds`/`orgTeams`), horarios (`scheduleConfig`), ladder de inactividad y filtros de conversaciones están en **ambos** `CLAUDE.md`, escritos por separado.

### 1.3 Cada repo va adelante en algo distinto

Esto importa para elegir la base de la unificación:

| Capacidad | Comercial | Servicio |
|---|---|---|
| **Reglas de Firestore** | ⚠️ **Abiertas** — `allow read, write: if request.auth != null` a nivel raíz | ✅ Granulares por organización, rol, y agente asignado (~200 líneas) |
| Bot externo HTTP (`type: "external"`) | ✅ Implementado (`main.py:496`) | ❌ Solo `vertex_ai` |
| Situaciones / ruteo entre bots | ✅ `situationRouting`, `cambiar_bot` | ❌ |
| CRM Salesforce (leads, citas) | ✅ Completo | Parcial (Events de servicio) |
| Endpoint de integración entrante | ❌ | ✅ `api/integrations/situacion-detectada` |
| Outcomes de conversación | ❌ | ✅ `lib/conversation-outcomes.ts` |
| Broadcasts (retry, refresh, test-send, check-status) | Básico | ✅ Completo |
| Round robin transaccional | ✅ (`auto_assign_agent`, pero handoff siempre va a `waiting_agent` por decisión de negocio) | ✅ `_next_round_robin_agent` + asignación automática |

> **Esto es un hallazgo importante**: la base más segura (reglas) está en Servicio; la base más capaz (bot externo, situaciones, CRM) está en Comercial. La unificación no es "copiar uno sobre el otro".

### 1.4 Ya existe federación entre las dos plataformas

`docs/integraciones/integracion-bot-servicio.md` + `api/integrations/situacion-detectada/route.ts` (repo Servicio) ya implementan el patrón completo: Comercial detecta una situación → `POST` a Servicio → Servicio busca el `whatsappNumber`, manda su plantilla, crea la conversación, primea la sesión de Abacus y responde `{ conversationId }`.

**Ese endpoint es, casi literalmente, lo que necesita la nueva plataforma de valuación.** Hoy está hardcodeado a un solo evento (`situacion_detectada`) y a exactamente 2 variables de plantilla, y **no tiene autenticación** (decisión explícita documentada en el contrato).

---

## 2. Pregunta 1 — ¿Qué conviene para la nueva plataforma de Compra / Toma a cuenta?

### 2.1 El principio

> La plataforma de bots es el **motor conversacional**. Los sistemas de negocio (Salesforce, valuación, servicio) son **productores de conversaciones** y **consumidores de resultados**.

Lo que NO debe pasar: que la plataforma de valuación crezca su propia integración de WhatsApp, su propia bandeja y su propio handoff. Eso es el tercer fork, y multiplica por 3 el costo de cada cambio en el núcleo.

Lo que SÍ debe pasar: la plataforma de valuación se queda con **lo que es solo suyo** (análisis del cliente, valor del auto, cálculo de la oferta, inventario, reglas de toma a cuenta) y delega todo lo conversacional.

### 2.2 Los tres contratos

| # | Contrato | Dirección | Estado hoy |
|---|---|---|---|
| **1** | **Disparar conversación outbound** | Valuación → Bots | 70% — existe 4 veces, ad-hoc |
| **2** | **Generar las respuestas del bot** | Bots → Valuación | ✅ **100% listo** (`type: "external"`) |
| **3** | **Devolver el resultado** | Bots → Valuación | 30% — parcial en Servicio |

#### Contrato 1 — Disparar conversación outbound (lo que falta construir)

Hoy hay **cuatro** maneras distintas de arrancar una conversación saliente, cada una hardcodeada a su origen:

| Camino | Origen | Problema para reutilizar |
|---|---|---|
| `lead_webhook` (`main.py:4490`) | Salesforce, SOAP XML | Atado al objeto `Lead` y a `sfBrandCode` |
| `api/broadcasts/[id]/send` | CSV / UI | Masivo, no 1-a-1 por evento |
| `api/integrations/situacion-detectada` (Servicio) | HTTP JSON | 1 solo evento, 2 variables fijas, sin auth |
| `api/web-chat/init` | Widget web | Otro canal |

**Propuesta: un solo endpoint genérico** que reemplace/absorba los anteriores:

```
POST /api/integrations/conversations
Authorization: Bearer <api key por sistema origen>

{
  "source": "valuacion",                  // sistema que dispara
  "externalId": "VAL-00123",              // su ID, para idempotencia y trazabilidad
  "target": { "whatsappNumberId": "..." },// o { "brandCode": "HO" }
  "customer": { "phone": "+52...", "name": "Juan Pérez" },
  "template": { "name": "oferta_compra_auto", "variables": { "1": "Juan", "2": "Civic 2021", "3": "$285,000" } },
  "context": { "vin": "...", "modelo": "...", "oferta": 285000, "vigencia": "2026-10-20" },
  "botId": "bot-valuacion"                // opcional: override del bot del número
}
→ 200 { "conversationId": "...", "reused": false }
```

Qué hace por dentro (todo ya existe, hay que generalizarlo):
1. Idempotencia por `(source, externalId)` — ya hay precedente en `_is_duplicate_lead` / `lead_processed_ids`.
2. Resolver el `whatsappNumber` → `organizationId`, `teamId`, `defaultBotId`, proveedor.
3. Reusar conversación abierta o crear nueva (`create_new_conversation`), con la ventana de 24h ya validada.
4. Mandar la plantilla por el proveedor del número (Twilio / Meta / ValueText) — los 3 ya están implementados en `situacion-detectada`.
5. Guardar `<<PLANTILLA>>` + `<<CONTEXTO>>` y **primar la sesión de Abacus** (`primeAbacusSession` / `send_to_chatllm`).
6. Guardar `source` / `externalId` en la conversación para filtrar en la bandeja y cerrar el ciclo.

> **Punto fino, ya aprendido en producción:** el priming del contexto no es opcional. Sin él, el bot contesta sin saber qué oferta se mandó. Ya está resuelto en `lead_webhook:4649` y en `primeAbacusSession`.

#### Contrato 2 — El bot de valuación (ya está listo)

`bots.type: "external"` ya existe en `main.py:496` y en `bot-engine.ts`. El contrato es:

```
POST {externalConfig.endpoint}        Authorization: Bearer {externalConfig.apiKey}
{ message, session_id, customer_phone, history }
→ { response, action, metadata }      action ∈ ninguna | handoff | guardar_nombre | cita_agendada
```

**Esto significa que la plataforma de valuación puede hospedar su propio agente** (que es donde vive el precio, el VIN, el inventario y las reglas de la oferta) sin que nada de eso entre a `main.py`. La plataforma de bots sigue siendo dueña de WhatsApp, bandeja, handoff, horarios, recordatorios y métricas.

Ajuste necesario: el set de `action` está pensado para ventas de auto nuevo. Para valuación hace falta ampliarlo (ej. `oferta_aceptada`, `oferta_rechazada`, `agendar_inspeccion`) — o, mejor, pasar a un `actions: []` con payload, que es extensible sin tocar el enum cada vez.

#### Contrato 3 — Devolver el resultado (parcial)

La plataforma de valuación necesita saber qué pasó: ¿contestó?, ¿aceptó la oferta?, ¿pidió asesor?, ¿se cerró sin respuesta? Hoy eso solo existe a medias en Servicio (`conversation-outcomes.ts`, `set_conversation_outcome`).

Propuesta: webhook saliente configurable por `source`, con eventos `conversation.replied`, `conversation.handoff`, `conversation.outcome`, `conversation.closed`, llevando `source` + `externalId` para que el origen cierre su propio ciclo.

### 2.3 Por qué esto es "lo que sale mejor"

- **Un solo número de WhatsApp por marca/vertical, una sola bandeja, un solo login para el asesor.** Si la valuación monta su propio WhatsApp, el mismo cliente le escribe a dos números de Cleber y ningún asesor ve la historia completa.
- **Todo lo caro ya está construido y probado en producción**: ventana de 24h, delivery tracking de Meta, verificación diferida de plantillas de ValueText, horarios de atención, ladder de inactividad, semáforo, multi-org, control de acceso por equipo. Reimplementarlo es meses; consumirlo es un endpoint.
- **Las reglas de negocio de valuación quedan donde deben**, en su plataforma, versionadas por su equipo, sin colas en `main.py`.
- Es aditivo: no toca ningún camino de código existente.

---

## 3. Pregunta 2 — La plataforma de bots de Servicio

### 3.1 Las tres opciones

| | Opción A — Federación (status quo) | Opción B — Merge big-bang | Opción C — Convergencia por fases ✅ |
|---|---|---|---|
| **Qué es** | Dos deployments que se hablan por HTTP | Un repo, una Firestore, un deploy, de una vez | Primero un repo; después, cuando el código sea idéntico, una sola Firestore |
| **Esfuerzo** | ~0 (ya está) | Alto y concentrado | Medio, distribuido |
| **Riesgo** | Bajo | **Alto** — migrar conversaciones vivas entre dos Firestore, reconciliar credenciales de Twilio/Meta/ValueText, dos Salesforce, dos sets de números | Bajo por fase, reversible |
| **"Todo centralizado"** | ❌ No lo cumple: 2 bandejas, 2 logins, métricas partidas | ✅ | ✅ al final |
| **Costo de mantenimiento** | Se mantiene ×2 (×3 con valuación) | ×1 | ×1 desde la fase 2 |

**La Opción A no cumple el objetivo que planteas.** Es lo que hay hoy y es justo lo que se quiere resolver.

**La Opción B es la correcta en destino pero mala como ejecución.** El problema no es el código (el drift es reconciliable), es el dato vivo: migrar conversaciones en curso entre dos bases de Firestore, con WhatsApp abierto y ventanas de 24h corriendo, sin ventana de mantenimiento clara.

### 3.2 Recomendación: Opción C

**Fase 1 — Un solo repo, dos deployments.** Unificar el código en un repo con el núcleo compartido; lo específico de cada vertical vive en módulos y, sobre todo, en **configuración de Firestore** (`bots.category` ya existe con `"Ventas" | "Servicio" | "Soporte" | "General"`; `situationRouting` ya demuestra el patrón de "el comportamiento lo decide la config, no el código"). Cada vertical sigue desplegando a su propio proyecto GCP / Vercel / Firestore. **Las bases de datos no se tocan.** Al terminar esta fase, ya se arregla un bug una sola vez.

**Fase 2 — Una sola Firestore.** Con el código idéntico, migrar las organizaciones de Servicio a la base unificada. Aquí las verticales se separan por `organizationId` + `teamId` + `botCategory`, que es exactamente para lo que ya está diseñado el modelo multi-tenant.

**Fase 3 — La valuación entra directo como vertical nativa**, sin fork, consumiendo los tres contratos de la sección 2.

> Si la nueva plataforma de valuación entra **antes** de la Fase 1, hay que construirle su integración sobre el repo Comercial (que es el que tiene bot externo y situaciones) y diseñarla desde el día 1 como contrato genérico, no como un segundo `situacion-detectada`.

---

## 4. Bloqueadores técnicos que hay que resolver antes de centralizar

Estos no son opinables — son condiciones para que una sola base de datos compartida entre verticales sea viable.

### 4.1 🔴 Reglas de Firestore abiertas en Comercial

```
// firestore.rules (Comercial) — completo
match /{document=**} {
  allow read, write: if request.auth != null;
}
```

**Cualquier usuario autenticado puede leer y escribir cualquier documento de cualquier organización.** Hoy el daño está acotado porque la base es solo de Ventas. Al meter Servicio y Valuación en la misma base, un asesor de servicio de una marca podría leer las conversaciones y los leads de ventas de otra.

Mitigación: portar las reglas del repo de Servicio (ya están escritas, probadas y cubren multi-org, roles y agente asignado). **Es el primer trabajo a hacer, independientemente de todo lo demás.**

### 4.2 🟠 Lógica duplicada Python ↔ TypeScript

`main.py` (Cloud Functions) y `apps/web/src/lib/bot-engine.ts` (canal Web Chat) implementan **el mismo motor de bot dos veces, en dos lenguajes, sin librería compartida**. Hoy eso ya causa desalineación (el chat web no soporta situaciones — documentado en `CLAUDE.md`).

Con una tercera vertical, cada cambio del motor son 2 lenguajes × N repos. Antes de sumar verticales hay que decidir: o el Web Chat llama a la Cloud Function en vez de reimplementarla, o se extrae el motor a un servicio único.

### 4.3 🟠 Autenticación inconsistente en las integraciones

- `situacion-detectada` (Servicio): **sin auth**, por contrato explícito.
- `assign-agent-by-lead` y `close-by-phone` (Comercial): `EXTERNAL_API_SECRET` compartido.
- `lead_webhook` / `valuetext_webhook` / `meta_webhook`: `--allow-unauthenticated`.
- `externalConfig.apiKey`: auth **saliente** (no confundir).

Con una plataforma de valuación mandando ofertas monetarias por WhatsApp, un endpoint sin auth es un riesgo distinto al de hoy. El contrato nuevo debe nacer con API key por sistema origen.

### 4.4 🟡 `sfBrandCode` debe ser único entre organizaciones

Ya documentado en `CLAUDE.md`: `get_whatsapp_number_by_brand()` hace `.where(...).limit(1)` **sin `orderBy`**. Con más organizaciones en la misma base (Servicio + Valuación + QA), la probabilidad de colisión sube y el modo de falla es silencioso: los leads se van siempre al mismo documento. Hay que agregar unicidad (validación en el dashboard o índice) antes de la Fase 2.

### 4.5 🟡 `main.py` como archivo único de 4,727 líneas

Se despliega entero en 5 Cloud Functions. Sumar una vertical más sin modularizar hace que un cambio en valuación obligue a redesplegar los webhooks de ventas. Mínimo: separar por módulos aunque el empaquetado siga siendo uno. **Detalle y estructura propuesta en §4-ter.D.**

---

## 4-bis. Visión objetivo: las 3 verticales en una sola plataforma

Esta sección responde "¿cómo se ve el destino?" — el modelo de datos y de operación de una plataforma que atiende Ventas, Servicio y Valuación/Toma a cuenta.

### A. La decisión central: ¿dónde vive la "vertical"?

Hoy el modelo tiene cuatro dimensiones:

| Dimensión | Qué es hoy | Fuerza |
|---|---|---|
| `organization` | La marca (Honda, Nissan, Toyota, Kia, Changan) | **Frontera de seguridad** — es lo único que validan las reglas de Firestore (`belongsToOrg`). Carga `salesforceConfig` y `sfBrandCode` |
| `team` | Unidad operativa dentro de la marca | **El filtro real de todo**: las 6 queries de `conversations/page.tsx`, el cron de inactividad, `ConverseView`, el semáforo, las etiquetas, el `assignmentMode`. Pero **no** es frontera de seguridad: se aplica solo en la UI |
| `bots.category` | `"Ventas" \| "Servicio" \| "Soporte" \| "General"` | Decorativo hoy — se denormaliza a `conversations.botCategory` y se muestra, no filtra ni autoriza |
| `whatsappNumber` | El canal | Apunta a `organizationId` + `teamId` + `defaultBotId` |

Tres formas de meter la vertical:

**Opción A — vertical = organización** (`org-honda-ventas`, `org-honda-servicio`, `org-honda-valuacion`). Es lo que las dos plataformas hacen hoy de facto. Rompe por cuatro lados:
- `sfBrandCode` vive en la organización y `get_whatsapp_number_by_brand()` lo resuelve como único → Honda-Ventas y Honda-Servicio pelearían por `"HO"` (el mismo modo de falla silenciosa ya documentado en `CLAUDE.md`).
- `salesforceConfig` (credenciales completas) se copia 3× por marca.
- 5 marcas × 3 verticales = **15 organizaciones** que administrar.
- Cliente 360 imposible: el mismo teléfono queda en 3 organizaciones sin relación entre sí.
- Un gerente de marca necesita 3 membresías y andar cambiando el selector de organización.

**Opción B — vertical = equipo** (org = Honda; equipos = Ventas, Servicio, Valuación). Casi gratis: `teamId` ya es el filtro de todas las queries. Pero:
- `users.orgTeams[orgId]` es **un equipo por usuario por organización** → un asesor no puede estar en Ventas y Servicio de la misma marca.
- Si una vertical tiene dos squads (ej. Ventas piso y Ventas digital), se pierde un nivel de jerarquía.

**Opción C — vertical como atributo de primera clase, montada sobre la plomería de B. ✅ DECIDIDA (2026-10-12):**

```
organizations/{id}          → la marca. Una sola salesforceConfig, un solo sfBrandCode
  teams/{id}.vertical       → "ventas" | "servicio" | "valuacion"   ← campo nuevo
  bots/{id}.category        → se alinea con vertical (ya existe)
  conversations/{id}.vertical → denormalizado del bot activo        ← campo nuevo
```

- Caso simple (un equipo por vertical): vertical y equipo coinciden; cero complejidad extra.
- Caso complejo (dos squads en Ventas): dos equipos con `vertical: "ventas"`.
- **Todas las queries de hoy (por `teamId`) siguen funcionando sin tocarse.** Las vistas cruzadas nuevas (gerente de marca, cliente 360) consultan por `organizationId + vertical`.
- Denormalizar `vertical` en la conversación es el mismo gesto que ya se hace con `botCategory` en `_switch_conversation_bot` (`main.py:1016`).

> **Por qué C se implementa sobre B y no como filtro duro nuevo:** `conversations` ya tiene 9 índices compuestos. Meter `vertical` como filtro obligatorio en las queries existentes los multiplicaría. Por eso la vertical **no** entra en el camino caliente de la bandeja (eso lo sigue resolviendo `teamId`, ya indexado) — solo en las vistas cruzadas nuevas.

### B. El número de WhatsApp: uno por módulo por marca ✅ DECIDIDO (2026-10-12)

**Modelo elegido:** cada módulo tiene su propio número por marca (Ventas Honda, Servicio Honda, Valuación Honda son tres números distintos). ~15 números en total (5 marcas × 3 módulos).

Esto encaja directo con el modelo actual: `whatsappNumbers/{id}` ya apunta a `organizationId` + `teamId` + `defaultBotId`. El "módulo" queda determinado por el número — la conversación **nace** en el equipo y con el bot correctos, sin ruteo por intención.

**Dos problemas que esta decisión elimina** (eran los bloqueadores del modelo de un solo número por marca con bot recepcionista):
- ~~El cambio de bot no mueve la bandeja~~ (`_CHANNEL_BOT_FIELDS` conserva `teamId`, `main.py:204`) — ya no aplica: no hay cambio de bot en el camino normal.
- ~~El cambio es de una sola vía por conversación~~ (`situationHandoffSentAt`, `main.py:983-985`) — ya no aplica.

`cambiar_bot` sigue siendo útil para casos puntuales dentro de un mismo número, pero deja de ser el mecanismo principal de ruteo entre módulos.

**El mecanismo que SÍ pasa a ser crítico: la transferencia entre números.** El cliente que le escribe a Ventas queriendo valuar su auto es un caso frecuente. Eso es el destino `interno` de `situationRouting` → `_notify_situacion_interna()` (`main.py:790`), que ya existe y funciona: lee el `whatsappNumber` destino, crea conversación nueva en su org/equipo/bot, arrastra el `leadId`, inyecta `<<CONTEXTO>>` y manda la plantilla. **Funciona incluso entre organizaciones distintas.**

Tres ajustes necesarios para un mundo de 3 módulos:

1. **Hoy la transferencia cierra la conversación origen y descarta el lead.** Se diseñó para "esto no es mi negocio, quítamelo" (`situacion_postventa` / `fuera_de_alcance`). Entre módulos hermanos de la misma marca hay que poder transferir **conservando** el lead y sin marcarlo como perdido — es un destino nuevo (`transferir_modulo`) o un flag en la ruta, no un cambio al existente.
2. **`_notify_situacion_interna` solo envía por ValueText.** Llama a `send_lead_template()` (`main.py:824`), que inserta en `rsplus__SMS_Bucket__c` de Salesforce. Si el número destino es Twilio o Meta, **no manda nada y retorna `False`**. Hay que generalizarlo a los 3 proveedores — el código ya existe en `api/integrations/situacion-detectada/route.ts` (repo Servicio), que sí maneja los tres.
3. **Cada transferencia consume una plantilla** (ventana de 24h del número destino) y el cliente recibe un mensaje desde un número distinto al que escribió. Inevitable con números separados; es tema de redacción de la plantilla, no técnico.

**Consecuencia operativa:** un mismo cliente puede tener hasta 3 conversaciones abiertas simultáneas, una por módulo. No colisionan (`get_or_create_conversation` busca por número + teléfono), pero en la bandeja aparecen como hilos sin relación. Esto convierte la ficha de cliente (sección C) de "deseable" en **necesaria**.

### C. El cliente 360 — lo único que *solo* se consigue centralizando

`Customer` está declarado en `types/index.ts:154` y tiene **cero usos** en todo el dashboard: la colección no existe.

Con las tres verticales en una base, el mismo teléfono es cliente en las tres, y eso es exactamente el insumo del negocio de la nueva plataforma:

> *"Compró un Civic en 2023 (Ventas) · 2 servicios este año (Servicio) · su auto vale hoy $285,000 (Valuación) → ofrécele el cambio."*

Hoy esa pregunta no se puede ni formular, porque los datos viven en dos bases de Firestore distintas.

Propuesta: `customers/{orgId}_{phone}` con el timeline cruzado, y `conversations.customerId` apuntando ahí. Todo lo demás que da la centralización (una bandeja, un login, métricas juntas) es ahorro operativo; **esto es capacidad de negocio nueva**, y es el argumento más fuerte para centralizar en vez de federar.

### D. Cómo se ve la operación

| Rol | Qué ve |
|---|---|
| Asesor | Su equipo, exactamente como hoy — sin cambios |
| Gerente de marca | Selector de vertical sobre la misma organización (mismo patrón que el selector de org que ya existe) |
| Ficha de conversación | Panel de cliente con el historial cruzado de las 3 verticales |
| Dirección | Métricas por marca × vertical en la misma base |

Las reglas de Firestore pasan a validar organización **y** equipo/vertical. Hoy solo validan organización (y en Comercial, ni eso — ver §4.1).

### E. Qué ya existe y qué hay que construir

| Pieza | Estado |
|---|---|
| Multi-tenant org + equipos + roles + multi-org por usuario | ✅ Listo |
| 3 proveedores de WhatsApp (Twilio, Meta, ValueText) + voz + web chat | ✅ Listo |
| Bot por número + override de bot por conversación | ✅ Listo |
| Ruteo por intención entre bots (`situationRouting`) | ✅ Listo (una sola vía) |
| Motor de bot externo HTTP (`type: "external"`) | ✅ Listo |
| Horarios, ladder de inactividad, semáforo, etiquetas, broadcasts, ventana 24h | ✅ Listo |
| Transferencia entre números, incluso cross-org (`_notify_situacion_interna`) | ✅ Listo |
| `vertical` en `teams` + denormalizado en `conversations` | ❌ Campo nuevo |
| Transferir entre módulos **conservando** el lead y sin cerrar en falso | ❌ Destino nuevo / flag en la ruta |
| Transferencia por los 3 proveedores | ❌ Hoy solo ValueText (`main.py:824`); el código de los 3 ya existe en el repo de Servicio |
| Cliente 360 (`customers`) | ❌ Tipo declarado, 0 usos |
| Reglas de Firestore por organización en Comercial | ❌ Abiertas (§4.1) |
| Contrato outbound único | ⚠️ 4 variantes ad-hoc (§2.2) |
| Outcomes de vuelta al sistema origen | ⚠️ Parcial, solo en Servicio |

**El 70% del destino ya está construido.** Lo que falta son dos campos, dos desbloqueos en el ruteo de bots, una colección nueva y las reglas de seguridad.

---

## 4-ter. Infraestructura: dónde vive qué

### A. Las Cloud Functions son por canal, no por vertical

Esto es lo primero que hay que entender porque determina casi todo lo demás: las funciones están partidas por **proveedor de mensajería**, no por línea de negocio.

| Función | Entry point | Qué atiende |
|---|---|---|
| `whatsapp-honda-bot` | `whatsapp_webhook` | Todo lo que entra por Twilio |
| `valuetext-webhook` | `valuetext_webhook` | Todo lo que entra por ValueText / Salesforce |
| `meta-webhook` | `meta_webhook` | Todo lo que entra por Meta Cloud API |
| `lead-webhook` | `lead_webhook` | Outbound Messages de Lead desde Salesforce |
| `inactivity-followup` | `inactivity_followup` | Cron de recordatorios y cierre |

`main.py` tiene además `voice_llm_endpoint` y `assign_agent_by_lead` como entry points, que no aparecen en la lista de deploy del `CLAUDE.md` raíz ni en `docs/google-cloud/comandos_deploy.md` — conviene confirmar su estado antes de la unificación.

Cada mensaje entra, la función resuelve el `whatsappNumber` y de ahí saca `organizationId`, `teamId` y `defaultBotId`. **Agregar la vertical de Valuación no agrega funciones**: los ~15 números entran por las mismas 3 puertas. Lo que cambia son documentos en Firestore, no código de despliegue.

### B. Topología: hoy → destino

| Capa | Hoy | Destino |
|---|---|---|
| **Proyectos GCP** | Tres: `ia-chatbots-ventas` (prod comercial), `dev-chatbot-ventas` (dev comercial), `atomic-hybrid-482121-n7` (Servicio) | Dos: uno de prod y uno de dev para toda la plataforma. El de Servicio se apaga al completar la etapa 5 |
| **Firestore** | Dos bases en proyectos distintos. Comercial usa una base **nombrada**: `firestore.Client(database="chatbots-ventas")` (`main.py:59`). Servicio usa la base **default**: `firestore.Client()` sin argumentos | Una sola base. Hay que elegir nombre y ajustar el cliente del lado que migre — no es solo copiar documentos |
| **Cloud Functions** | 5 por proyecto, mismo código | Las mismas 5. No cambian de forma |
| **Dashboard (Vercel)** | Dos proyectos, uno por plataforma. Comercial: Production + Preview (`dev-cleber-ventas`, `qa-cleber-ventas`) | Un solo proyecto. Los crons (`inactivity-followup`, `verify-lead-templates`, `close-inactive`, `scheduled-contact`) **solo corren en Production** — tenerlo presente al consolidar |
| **Plataforma de Valuación** | — | **Fuera de esta infraestructura.** Su propio stack y su propia base de datos (autos, precios, ofertas). Se conecta solo por los contratos HTTP de §2.2. No necesita acceso a Firestore ni entrar al proyecto GCP |

### C. Capacidad: las dos plataformas están configuradas distinto

`valuetext-webhook` en **prod de Servicio** corre con `--max-instances=300 --concurrency=40`, explícitamente documentado como distinto de las demás funciones y del ambiente dev, que usan los defaults de gcloud (100 / 1). El `valuetext-webhook` de Comercial usa los defaults.

Al unificar, el tráfico de las tres verticales pasa por la misma función. **Hay que revisar y fijar estos flags antes de la migración**, y dejarlos explícitos en los comandos de deploy: un redeploy sin ellos resetea la función a los defaults, que es justo el modo de falla ya documentado.

### D. Modularización de `main.py`

Hoy los 5 deploys son idénticos salvo el `--entry-point`, todos con `--source=.`. Eso significa que **las 5 funciones son el mismo archivo completo**, cada una entrando por una puerta distinta: la función de Meta también lleva dentro el código de leads y de citas aunque nunca lo ejecute.

Consecuencias con tres verticales:
- Un error de sintaxis o de import a nivel de módulo en el código de valuación **tumba las 5 funciones**, no solo la suya.
- Cualquier cambio obliga a redesplegar las 5; desplegar solo una deja a las otras con código viejo, que es peor que no desplegar.
- 5 deploys = 5 oportunidades de equivocarse de `--project` (riesgo ya señalado en `Plan-Bots-Externos-Openclaw-Hermes.md` §5).

**Estructura propuesta** — `main.py` se queda solo con los entry points y todo lo demás se agrupa por responsabilidad:

```
PlataformaChatbotsComercial/
├── main.py                 ← solo entry points (~60 líneas)
├── requirements.txt
├── .gcloudignore           ← ya existe, no cambia
│
├── core/                   común a las tres verticales
│   ├── db.py                  cliente Firestore, clientes Twilio, executor
│   ├── numbers.py             whatsappNumber → org, team, bot, override
│   ├── conversations.py       get_or_create, create, add_message, status
│   ├── handoff.py             auto_assign_agent, business hours, apply_handoff
│   ├── routing.py             situationRouting, transferencia entre módulos
│   └── utils.py               normalize_phone, fechas, helpers
│
├── channels/               uno por proveedor
│   ├── twilio_wa.py
│   ├── meta_wa.py
│   ├── valuetext_wa.py
│   └── voice.py
│
├── ai/
│   ├── engine.py              chatllm / workflow / external
│   └── tools.py               check_*_tool_call, _find_tool_params_in_segments
│
├── crm/
│   ├── salesforce.py          token, leads, citas, flows
│   └── templates.py           send_lead_template, _get_template_structure
│
├── modules/                lógica de negocio por vertical
│   ├── ventas.py
│   ├── servicio.py
│   └── valuacion.py        ← lo nuevo vive aquí, y solo aquí
│
├── jobs/
│   └── inactivity.py
│
├── apps/web/               sin cambios
├── docs/
└── gcp-toyota-bot/
```

```python
# main.py después
import functions_framework
from channels import twilio_wa, meta_wa, valuetext_wa, voice
from crm import leads
from jobs import inactivity

@functions_framework.http
def whatsapp_webhook(request):
    return twilio_wa.webhook(request)

@functions_framework.http
def meta_webhook(request):
    return meta_wa.webhook(request)
# ...
```

**Lo que NO cambia:** los comandos de deploy quedan idénticos (`--source=.` + `--entry-point`). El `.gcloudignore` existente ya excluye `apps/`, `docs/` y `gcp-toyota-bot/`, así que los paquetes nuevos se suben sin configurar nada.

**Lo que SÍ resuelve:** aislamiento de la lógica de negocio. Un cambio de valuación toca un archivo que ventas no importa, el diff es revisable y el radio de daño de un error baja mucho.

**Lo que NO resuelve:** siguen siendo 5 deploys del mismo paquete. Para que valuación se despliegue sin tocar ventas harían falta unidades de despliegue separadas (más infra, y el código compartido empaquetado aparte). Decisión más grande — conviene posponerla hasta que las tres verticales estén operando y se vea si estorba de verdad.

**Dónde está el riesgo del refactor:**
- **Globales compartidos**: `_db`, `_twilio_clients` y `_executor` tienen que quedar en un único lugar (`core/db.py`) o se terminan creando conexiones y pools duplicados por módulo.
- **Imports circulares**: `routing.py` necesita `conversations.py`, pero `conversations.py` no debe necesitar `routing.py`. Si se cruzan, Python falla al importar y **caen las 5 funciones a la vez**.
- **No nombrar un archivo `twilio.py`** — colisiona con el paquete instalado.
- Hacerlo **en una sola pasada y validarlo completo en `dev-chatbot-ventas`**, no por partes. A favor: es un refactor de comportamiento cero — mismas entradas, mismas salidas — así que es verificable y reversible.

### E. El pendiente que empeora con una vertical más

`AMBIENTE_DESARROLLO.md` §4: **dev usa el mismo Salesforce de producción.** Hoy ya es el principal vector de impacto a prod desde pruebas. Con valuación escribiendo ofertas, conviene resolverlo antes de la etapa 5 y no después.

---

## 5. Secuencia propuesta

| Fase | Trabajo | Desbloquea |
|---|---|---|
| **0** | Portar las reglas de Firestore de Servicio a Comercial | Condición para cualquier base compartida |
| **1** | Contrato 1 genérico (`POST /api/integrations/conversations`) con API key, generalizando `situacion-detectada` | La valuación puede disparar conversaciones **ya**, sin esperar la unificación |
| **2** | Contrato 3 (webhook de outcomes) + ampliar las `action` del bot externo | La valuación cierra su ciclo y puede hospedar su agente |
| **2-bis** | Modularizar `main.py` según §4-ter.D, antes de que entre la tercera vertical | El código de valuación queda aislado; un error suyo deja de tumbar los webhooks de ventas |
| **3** | Unificar los dos repos en uno (núcleo compartido, vertical por config). Deployments siguen separados | Se arregla un bug una sola vez |
| **4** | Resolver la duplicación Python/TS del motor | Condición para escalar a N verticales |
| **5** | Migrar Servicio a la Firestore unificada; una sola bandeja | "Todo centralizado" de verdad |

Las fases 1 y 2 **no dependen** de las 3–5: se pueden entregar primero y dan valor inmediato a la plataforma de valuación.

---

## 6. Decisiones que hay que tomar (no las resuelve el código)

1. **¿Quién hospeda el agente de IA de valuación?** Si lo hospeda la plataforma de valuación (recomendado, `type: "external"`), no entra nada a `main.py`. Si se hospeda en Abacus como los demás bots, hay que decidir cómo le llegan el VIN, el valor y la oferta (hoy sería por `<<CONTEXTO>>`, que ya funciona pero es texto plano).
2. **¿Las ofertas de compra/toma a cuenta generan registro en Salesforce?** Si sí, se repite el patrón de `create_salesforce_lead` con otro `RecordTypeId` y otro owner; si no, el ciclo se cierra solo contra la plataforma de valuación.
3. **¿Un número de WhatsApp propio para valuación, o el mismo de ventas de la marca?** Afecta directo el diseño del Contrato 1 (`brandCode` vs `whatsappNumberId`) y la experiencia del cliente. Si es el mismo número, hay que definir cómo convive con el bot de ventas (el mecanismo `cambiar_bot` de `situationRouting` ya resuelve exactamente esto).
4. **¿Los dos repos siguen con dueños distintos de GitHub?** Hoy son `gerayga-cleber` y `dcavazos`. La unificación requiere definir repo y propiedad antes de empezar la Fase 3.
5. **¿Hay ventana de mantenimiento posible para la Fase 5?** Determina si la migración de Firestore se hace en corte o con doble escritura temporal.
