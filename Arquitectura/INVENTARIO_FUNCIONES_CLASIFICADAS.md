# Inventario de funciones exclusivas, clasificadas

**Fecha: 14 de octubre de 2026**
Entregable de la **Fase 1** del [`PLAN_TRABAJO_CENTRALIZACION.md`](PLAN_TRABAJO_CENTRALIZACION.md), según los tres niveles de su §4.

---

## 1. Procedencia y alcance

Extraído de los `main.py` de los dos repos en disco:

| | Ruta | Líneas | Funciones |
|---|---|---|---|
| **Comercial** | `cleber-bot-platform-comercial/PlataformaChatbotsComercial/main.py` | 4,738 | 99 |
| **Servicio** | `cleber-bot-platform/HondaChatbotChatLLM/main.py` | 2,654 | 54 |

| | |
|---|---|
| **Comunes** | 47 |
| **Exclusivas de Comercial** | 52 |
| **Exclusivas de Servicio** | 7 |
| **Total a clasificar** | **59** |

> **Son 59, no 57.** El análisis original (2026-10-12) contó 46 comunes y 50 + 7 exclusivas sobre un `main.py` de 4,727 líneas. Hoy son 4,738. Los archivos avanzaron; este inventario refleja el estado actual.

**Alcance:** solo `main.py` de ambos repos. **No cubre** el dashboard TypeScript (`apps/web/`), que tiene su propia divergencia —`conversations/page.tsx`, `bot-engine.ts`, `conversation-outcomes.ts`— y necesita un inventario aparte antes de la Fase 1.

**Método:** la clasificación sale de firma + docstring + verificación puntual de cuerpos. Las marcadas **⚠️ confirmar** necesitan leer el cuerpo completo antes de portar.

---

## 2. El resultado, en una tabla

| Destino | Qué es | Comercial | Servicio | Total |
|---|---|---|---|---|
| **Núcleo** (`core/`, `channels/`, `ai/`) | Capacidad de plataforma, no regla de vertical | 13 | 5 | **18** |
| **Núcleo · routing** (`core/routing.py`) | Motor de situaciones; las rutas son config | 6 | 0 | **6** |
| **Colapsan** | Detectores de tool | 6 | 2 | **8 → 2 estrategias** |
| **CRM compartido** (`crm/`) | Mecánica de Salesforce y plantillas | 5 | 0 | **5** |
| **Handler de módulo** (`modules/`) | Regla de negocio real de la vertical | 19 | **0** | **19** |
| **Entry points** (`main.py`) | Puertas de Cloud Functions | 3 | 0 | **3** |
| | | **52** | **7** | **59** |

### Los tres hallazgos que cambian el presupuesto de la Fase 1

**1. Solo 19 de 59 son reglas de negocio de vertical — y todas son de Ventas.**
Las otras 40 son núcleo, mecánica compartida o duplicación. `modules/ventas.py` nace con ~19 funciones, no con 50. **`modules/servicio.py` nace prácticamente vacío**: las 7 exclusivas de Servicio son capacidades de plataforma que a Comercial le faltan, no lógica de servicio.

**2. Ocho funciones colapsan en dos estrategias.** Las seis `check_*_tool_call` de Comercial son **idénticas carácter por carácter salvo el nombre del tool** (verificado en L1375, L1434, L1458, L1492) → **una sola función**. Las dos de Servicio son idénticas entre sí pero **leen otra forma de respuesta**, porque los bots de cada plataforma corren un motor distinto → **una segunda estrategia**. Ver §2-bis.

**3. Cada plataforma le falta algo que la otra tiene, y son cosas serias.** Ver §6.

---

## 2-bis. Los dos motores: ChatLLM vs. Workflows

**Los bots de Comercial corren Abacus ChatLLM; los de Servicio corren IA Workflows.** Es un dato que cambia cómo se porta la capa de parseo.

### La buena noticia: el motor ya es configuración

Los **dos repos soportan los tres motores en código**. Verificado:

| | Comercial | Servicio |
|---|---|---|
| `bot_config.get("type", "chatllm")` | L484 | L427 |
| `chatllm` | ✅ | ✅ |
| `workflow` | ✅ L576 | ✅ L515 |
| `vertex_ai` | ✅ L493 | ✅ L436 |
| `external` | ✅ L493 | ❌ |

La diferencia entre plataformas **no está en el código: está en qué `type` tienen configurados los bots en Firestore**. Es decir, el motor **ya es nivel 1** y la plataforma ya fue construida para que convivan.

Eso es exactamente lo que necesita el destino: los bots de Ventas pueden seguir en ChatLLM, los de Servicio en Workflows y los de Valuación en `external`, **en la misma plataforma, sin ramas por vertical**. Lo único que falta portar es `external`, que Servicio no tiene.

### La mala noticia: las respuestas no tienen la misma forma

Ambos motores comparten el camino de `toolResults`, pero divergen en el fallback por segmentos:

| | **ChatLLM** (Comercial) | **Workflow** (Servicio) |
|---|---|---|
| Camino primario | `result.toolResults[].toolName` + `.input` | `result.toolResults[].toolName` + `.input` |
| Fallback | `result.segments[]` con `title` = `"Executing <tool>"` | `result.response.segments[]` con `seg.id == "action"` |
| Qué devuelve | **dict de params** del `collapsible_component` | **string plano** del segmento |
| Trampa conocida | Abacus emite **dos segments con el mismo title**: primero uno de texto sin params y después el que sí los trae. Quedarse con el primero que hace match del title **perdía el 100% de los params** (documentado en L1411) | — |

**Consecuencia para `ai/parsing.py`:** no es un detector, son **estrategias por motor** detrás de una interfaz común.

```python
# ai/parsing.py — normaliza; core/tools.py despacha; modules/* ejecuta
def detect(api_result, bot_type, tool_name):
    return _STRATEGIES[bot_type](api_result, tool_name)
```

- `chatllm` — toolResults, y si no, `segments[].title` con el fix de los dos segmentos
- `workflow` — toolResults, y si no, `response.segments[].id == "action"`
- `external` — el `actions: []` del contrato (nuevo, Fase 6)

**La frontera correcta:** la diferencia de motor **muere en la capa de parseo**. El handler de `modules/` recibe params normalizados y no sabe —ni debe saber— con qué motor se generaron. Un bot de Ventas puede migrar de ChatLLM a Workflow sin tocar un solo handler.

> ⚠️ **A confirmar al portar:** la trampa de los dos segmentos de Abacus costó el 100% de los params una vez. Hay que portarla con su comentario y una prueba que la cubra, o se vuelve a perder.

---

## 3. Exclusivas de Comercial (52)

### 3.1 Núcleo — capacidad de plataforma, no lógica de Ventas (13)

Estas no son reglas de Ventas: son capacidades universales que Servicio simplemente nunca recibió. Al núcleo, y **Servicio las gana**.

| L | Función | Destino | Nota |
|---|---|---|---|
| 250 | `_is_stop_message` | `core/conversations.py` | Opt-out ("stop" como palabra completa). **Servicio no lo tiene** — ver §6 |
| 212 | `apply_active_bot_override` | `core/numbers.py` | Qué bot responde esta conversación |
| 334 | `apply_out_of_hours_context` | `core/handoff.py` | Antepone el aviso de asesor no disponible |
| 2109 | `apply_handoff_status` | `core/handoff.py` | Status según el `assignmentMode` del equipo |
| 1776 | `_clean_chatllm_text` | `ai/parsing.py` | Limpia artefactos de Abacus |
| 1394 | `_parse_params_from_segment` | `ai/parsing.py` | Params del segmento de un tool call |
| 1411 | `_find_tool_params_in_segments` | `ai/parsing.py` | Base del detector genérico de §3.3 |
| 2860 | `_save_template_outbound` | `core/conversations.py` | Guarda template outbound masivo |
| 4428 | `get_whatsapp_number_by_brand` | `core/numbers.py` | ⚠️ **`.limit(1)` sin `orderBy`** — la colisión silenciosa de `sfBrandCode`. Corregir al portar |
| 4171 | `_claim` | `core/claims.py` | Claim transaccional genérico |
| 4146 | `claim_lead_creation` | `core/claims.py` + `modules/ventas.py` | **Mixta**: el patrón es núcleo, el "lead" es Ventas |
| 4192 | `release_lead_creation_claim` | `core/claims.py` + `modules/ventas.py` | **Mixta**, igual que la anterior |
| 4405 | `_is_duplicate_lead` | `core/idempotency.py` | **Generalizar a `(source, externalId)`** — es la idempotencia que pide el contrato de entrada de la Fase 2 |

### 3.2 Núcleo · routing — el motor de situaciones (6)

Genérico: las rutas ya viven en `situationRouting` (config). **Servicio no tiene nada de esto** (0 coincidencias de `situacion` en su `main.py`), y es lo que Valuación va a necesitar para la transferencia entre módulos.

| L | Función | Destino | Nota |
|---|---|---|---|
| 1048 | `process_situacion_handoff` | `core/routing.py` | Resuelve la situación según la ruta configurada |
| 790 | `_notify_situacion_interna` | `core/routing.py` | ⚠️ **Solo ValueText** (llama `send_lead_template`). Generalizar a los 3 proveedores — Fase 5 del plan |
| 829 | `_notify_situacion_externa` | `core/routing.py` | POST a sistema externo. Precursor del contrato de salida |
| 979 | `_switch_conversation_bot` | `core/routing.py` | Cambia el bot sin cambiar de número. Aquí se redenormaliza `vertical` |
| 952 | `build_switch_context` | `core/routing.py` | Contexto que recibe el bot destino |
| 1030 | `run_switched_bot` | `core/routing.py` | Corre el mensaje contra el bot recién activado |

> `_patch_lead_situacion` (L756) se invoca desde este flujo pero **es de Ventas** — ver §3.5. Es el ejemplo exacto de §4 del plan: el motor es núcleo, lo que hace con el Lead es handler.

### 3.3 Colapsan en la estrategia `chatllm` (6 → 1)

Verificado: idénticas salvo el string del tool y, en dos casos, el campo que extraen. Todas leen la forma de respuesta de **ChatLLM** (§2-bis).

| L | Función | Tool que detecta |
|---|---|---|
| 702 | `check_situacion_tool_call` | *(situación)* |
| 1434 | `check_crear_lead_tool_call` | `Crear_Lead` |
| 1375 | `check_actualizar_lead_tool_call` | `Actualizar_Lead` |
| 1458 | `check_crear_cita_tool_call` | `Crear_Cita_Ventas_Salesforce` |
| 1492 | `check_schedule_contact_tool_call` | `Agendar_Recordatorio` |
| 1513 | `check_cancel_scheduled_contact_tool_call` | `Cancelar_Recordatorio` |

**Reemplazo:** la estrategia `chatllm` de `ai/parsing.py` (§2-bis), y los nombres de tool pasan a ser **nivel 1 (config)** en el documento del bot. Agregar un tool deja de requerir una función nueva.

### 3.4 CRM — mecánica compartida, no regla de vertical (5)

| L | Función | Destino | Nota |
|---|---|---|---|
| 4026 | `_get_lead_field` | `crm/salesforce.py` | Lee un campo del Lead |
| 4044 | `_build_appended_comment` | `crm/salesforce.py` | Append con timestamp sin pisar |
| 4334 | `_get_template_structure` | `crm/templates.py` | Estructura de plantilla ValueText desde SF |
| 4357 | `send_lead_template` | `crm/templates.py` | ⚠️ Inserta en `rsplus__SMS_Bucket__c`. **Es ValueText, no "mandar plantilla"** — el nombre engaña. Es la raíz del límite de `_notify_situacion_interna` |
| 4468 | `parse_lead_outbound_message` | `crm/salesforce.py` | Parsea el SOAP de Outbound Message |

### 3.5 Handler de módulo — Ventas (19)

**Estas sí son reglas de negocio de la vertical.** Van a `modules/ventas.py` como handlers del registro de §4.

#### Lead y cita (6)

| L | Función | Config que hay que extraerle (nivel 1) |
|---|---|---|
| 4202 | `create_salesforce_lead` | `RecordTypeId`, owner por defecto, mapeo de campos |
| 4052 | `update_salesforce_lead` | Mapeo de campos |
| 1614 | `create_salesforce_appointment` | `RecordTypeId` del Event, Status destino (`Cita`) |
| 1586 | `_find_existing_appointment` | — |
| 1569 | `_parse_appointment_datetime` | **Zona horaria UTC-6** |
| 1453 | `_lead_input_has_completion_data` | Qué campos cuentan como "completo" |

#### Owner, round robin y estados del Lead (7)

| L | Función | Config que hay que extraerle (nivel 1) |
|---|---|---|
| 1287 | `_patch_lead_owner_id` | — |
| 756 | `_patch_lead_situacion` | **Mapeo situación → Status / `Validacion_Prospecto__c`** |
| 1160 | `_call_rr_agente_flow` | **Nombre del Flow (`RRAgenteIACLEBER`)** |
| 1257 | `_handle_cita_rr` | Owner de BDC fuera de horario |
| 1273 | `_update_lead_on_handoff` | Status destino (`Contactado`) |
| 1191 | `_update_lead_on_stop` | Valor destino (`Finalizado por cliente`) |
| 1227 | `_reset_lead_sin_respuesta` | Valores de cierre por inactividad |

#### Handoff con semántica de Lead (3)

| L | Función | Nota |
|---|---|---|
| 1326 | `_respond_handoff_no_lead` | No escala si no hay `leadId` |
| 863 | `_handoff_lead_seminuevo` | Destino `lead`: saca la conversación del bot |
| 298 | `_block_handoff_out_of_hours` | **Mixta**: el gate de horario es núcleo (`core/handoff.py`), dejar el lead con el owner de BDC es Ventas |

#### Contacto programado (3)

| L | Función | Config que hay que extraerle |
|---|---|---|
| 3766 | `_handle_scheduled_contact` | — |
| 1549 | `_clear_scheduled_contact` | — |
| 1480 | `_parse_scheduled_contact_time` | **Zona horaria UTC-6** |

> ⚠️ **Confirmar antes de portar:** si el contacto programado resulta ser genérico (agendar un recordatorio no es propio de Ventas), estas tres suben a `core/`. Decisión de diseño pendiente de leer los cuerpos.

### 3.6 Entry points (3)

| L | Función | Destino | Nota |
|---|---|---|---|
| 4502 | `lead_webhook` | `main.py` + `modules/ventas.py` | **Se reimplementa sobre el contrato de entrada de la Fase 2**, no se porta tal cual |
| 4699 | `assign_agent_by_lead` | `main.py` | ⚠️ No aparece en los comandos de deploy documentados. **Confirmar si está en uso** |
| 4713 | `process` | — | Anidada dentro de `assign_agent_by_lead` |

---

## 4. Exclusivas de Servicio (7)

**Cero son lógica de negocio de Servicio.** Las siete son capacidades de plataforma que a Comercial le faltan.

| L | Función | Destino | Nota |
|---|---|---|---|
| 249 | `_next_round_robin_agent` | `core/handoff.py` | Round robin transaccional. **Comercial no lo tiene** |
| 1408 | `_process_twilio_status` | `channels/twilio_wa.py` | Delivery tracking (sent/delivered/read/failed). **Comercial no lo tiene** |
| 719 | `set_conversation_outcome` | `core/outcomes.py` | Base del contrato de salida de la Fase 6 |
| 706 | `_set_conversation_outcome_txn` | `core/outcomes.py` | Transacción de lo anterior |
| 682 | `get_ai_outcome_action` | `ai/parsing.py` | **Colapsan juntas** en la estrategia `workflow` (§2-bis). Lee `response.segments[].id == "action"`, no `segments[].title` |
| 747 | `get_broadcast_response_action` | `ai/parsing.py` | Idéntica a la anterior salvo el vocabulario que valida |
| 762 | `record_broadcast_response` | `core/broadcasts.py` | Primer action gana |

**Nivel 1 que sale de aquí:** las constantes `AI_OUTCOME_ACTIONS` y `BROADCAST_RESPONSE_ACTIONS` están hardcodeadas a nivel de módulo. Son **vocabularios configurables**, el equivalente exacto de los nombres de tool en ChatLLM.

---

## 5. La configuración que sale del código (nivel 1)

Todo esto hoy está hardcodeado y debe nacer como documento de Firestore:

| Config | Hoy está en | Dónde debe vivir |
|---|---|---|
| Nombres de tools (`Crear_Lead`, `Actualizar_Lead`, `Crear_Cita_Ventas_Salesforce`, `Agendar_Recordatorio`, `Cancelar_Recordatorio`) | 6 funciones `check_*` | `bots/{id}.tools[]` |
| Vocabularios `AI_OUTCOME_ACTIONS` y `BROADCAST_RESPONSE_ACTIONS` | Constantes de módulo en Servicio | `bots/{id}` — equivalente a los nombres de tool en ChatLLM |
| **Motor del bot** (`chatllm` / `workflow` / `vertex_ai` / `external`) | Ya es config: `bots/{id}.type` | ✅ **Ya resuelto.** Los dos repos lo soportan (§2-bis) |
| Nombre del Flow de round robin (`RRAgenteIACLEBER`) | `_call_rr_agente_flow` | `organizations/{id}.salesforceConfig` |
| Mapeo situación → `Status` / `Validacion_Prospecto__c` | `_patch_lead_situacion`, `_reset_lead_sin_respuesta` | Config del módulo Ventas |
| `RecordTypeId` de Lead y de Event, owners, owner de BDC | `create_salesforce_lead`, `create_salesforce_appointment`, `_handle_cita_rr` | `organizations/{id}.salesforceConfig` |
| Zona horaria UTC-6 | `_parse_appointment_datetime`, `_parse_scheduled_contact_time` | `organizations/{id}` |
| Vocabulario de outcomes y de respuesta a broadcast | `set_conversation_outcome`, `record_broadcast_response` | Config del módulo |

---

## 6. Lo que cada plataforma le falta a la otra

Verificado por conteo sobre los dos `main.py`. **La unificación no es copiar una sobre la otra: cada lado gana capacidades.**

| Capacidad | Comercial | Servicio | Consecuencia al unificar |
|---|---|---|---|
| **Detección de opt-out** (`_is_stop_message`) | ✅ | ❌ **0 coincidencias** | 🔴 Servicio no respeta "STOP" hoy. Es un tema de cumplimiento, no de funcionalidad — **conviene verificarlo con el equipo de Servicio antes de la Fase 1**, por si lo resuelven en otra capa |
| **Situaciones / routing entre bots** | ✅ 6 funciones | ❌ 0 coincidencias | Servicio gana el ruteo; es la base de la transferencia entre módulos |
| **Bot externo** (`type: "external"`) | ✅ | ❌ 0 coincidencias | Es el gancho de Valuación |
| **Outcomes de conversación** | ❌ 0 coincidencias | ✅ 4 funciones | Comercial gana el cierre de ciclo |
| **Delivery tracking de Twilio** | ❌ 0 coincidencias | ✅ 6 coincidencias | Comercial gana saber si el mensaje llegó |
| **Round robin transaccional** | ❌ 0 coincidencias | ✅ | Comercial gana asignación sin condiciones de carrera |

---

## 7. Cómo se trabaja este inventario

1. **Confirmar las ⚠️** leyendo los cuerpos: `get_whatsapp_number_by_brand`, `send_lead_template`, `assign_agent_by_lead`, el trío de contacto programado, y las dos mixtas de `claim`.
2. **Verificar el opt-out de Servicio** con su equipo antes de asumir que es un hueco.
3. **Levantar el inventario del dashboard TypeScript**, que este documento no cubre.
4. **Extraer la configuración de §5 primero.** Un handler se escribe mucho más limpio cuando los valores ya salieron.
5. **Empezar por el detector genérico** (§3.3): ocho funciones menos, y deja montado el registro de §4 del plan para todo lo demás.
6. **Portar el núcleo antes que los handlers.** Las 40 de núcleo + CRM + routing no dependen de decisiones de negocio; las 19 de Ventas sí.

### Criterio de salida de la Fase 1, medido contra este inventario

- [ ] Las 18 de núcleo y las 6 de routing en `core/`, sin referencia a vertical
- [ ] Las 8 detectoras reemplazadas por `detect(api_result, bot_type, tool_name)` con estrategia por motor, y los tools/vocabularios como config
- [ ] Prueba que cubra la trampa de los dos segmentos de Abacus (§2-bis)
- [ ] Las 5 de CRM en `crm/`, con `send_lead_template` renombrada a lo que de verdad hace
- [ ] Las 19 de Ventas en `modules/ventas.py`, cada una registrada contra el núcleo
- [ ] `core/` sin un solo `if vertical == ...` y sin importar de `modules/`
- [ ] Config de §5 en Firestore, no en el código
