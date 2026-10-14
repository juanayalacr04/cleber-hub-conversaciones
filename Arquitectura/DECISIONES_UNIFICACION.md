# Decisiones de unificación del núcleo

**Fecha: 14 de octubre de 2026**
Resultado de portar las funciones comunes de Comercial y Servicio (Fase 1, tarea 1.5 y el pipeline único). Donde las dos plataformas hacían cosas distintas hubo que elegir. **Esta lista es para que la revises:** cada fila es un cambio de comportamiento respecto a alguna de las dos plataformas, o una decisión que dejé como configuración.

Las filas marcadas ⚠️ **cambian el comportamiento de producción actual de alguna plataforma** si no se configuran al migrar.

## Dónde quedó cada cosa

| Pieza | Archivo |
|---|---|
| Pipeline único de mensajes (reemplaza los tres `_process_*_message`) | `core/pipeline.py` |
| Registro de handlers por vertical y eventos del pipeline | `core/tools.py`, `core/default_tools.py` |
| Parseo por motor (`chatllm`, `workflow`, `external`) | `ai/parsing.py` |
| Envío al bot por motor | `ai/engine.py` |
| Conversaciones, mensajes, reapertura | `core/conversations.py` |
| Números y bots | `core/numbers.py` |
| Handoff, horarios, asignación | `core/handoff.py` |
| Claims, idempotencia | `core/claims.py`, `core/idempotency.py` |
| Campañas y outcomes | `core/broadcasts.py`, `core/outcomes.py` |
| Canales (Twilio, Meta, ValueText) y webhooks | `channels/` |

## Cambios respecto a cada plataforma

| # | Tema | Comercial | Servicio | Ahora | Configuración |
|---|---|---|---|---|---|
| 1 ⚠️ | **Opt-out ("stop")** | Twilio y Meta cierran la conversación. ValueText la **escala a un asesor** ("nunca se cierra sola") | No lo respeta | Cierra la conversación en todos los módulos y despacha el evento `opt_out` | `bots/{id}.optOutAction`: `"close"` (por defecto) o `"handoff"`. **Los bots de Ventas por ValueText deben tener `"handoff"`** para conservar su comportamiento |
| 2 ⚠️ | **Handoff fuera de horario** | Aviso fijo. Solo ValueText marca `handoffBlockedAt` | El bot redacta el aviso. No marca nada | Aviso y `handoffBlockedAt` en todos los proveedores | `scheduleConfig.viaBot: true` para que lo redacte el bot (como Servicio) |
| 3 | Texto al escalar y mientras espera | "…Un asesor te atenderá pronto." | "…Alguien de nuestro equipo te contactará pronto. 😊" | Texto de Comercial por defecto | `handoffConfig.handoffMessage` y `handoffConfig.waitingMessage` |
| 4 | Nombre capturado por el tool | Pisa el del perfil de WhatsApp si difiere | Solo si no había nombre | Pisa (es la fuente autoritativa) | — |
| 5 | Cita registrada | Marca `appointmentStatus` | Marca `appointmentStatus` **y** el outcome `cita_bot` | Ambos, en todos los módulos | Handler `registrar_cita` por vertical |
| 6 | Teléfono como contexto en la primera respuesta | Solo Twilio | No | Solo Twilio, como hoy | `bots/{id}.injectPhoneContext` |
| 7 | Imágenes `[IMG]url[/IMG]` | Twilio las envía. Meta y ValueText mandaban el marcador como texto literal | Twilio las envía | El marcador se quita siempre. Donde no hay soporte de media, la URL queda al final del texto | — |
| 8 ⚠️ | **Host de ChatLLM** | `cleber.abacus.ai` (cuenta dedicada) | `api.abacus.ai` | `cleber.abacus.ai` por defecto | `abacusConfig.apiHost` por bot, o `ABACUS_CHATLLM_HOST`. **Confirmar que la cuenta de Servicio también está en el host dedicado** |
| 9 | Reapertura de conversaciones | Sella `closedAt` y respeta `statusBeforeClose` | Filtra por organización y limpia el outcome "inactividad" | Las cuatro cosas | — |
| 10 | Asignación de agentes | `least_busy` / `round_robin` no transaccional, con tope `maxConversationsPerAgent` | Round robin transaccional, `orgTeams` autoritativo, sin tope | La de Servicio; el tope solo aplica si el equipo lo define | `teams/{id}.maxConversationsPerAgent` |
| 11 | Detección de handoff | Tool + segmentos de ChatLLM | Tool + acciones de workflow (`handoff`, `pre_registro`) | Todas | Nombre del tool y acciones por bot |
| 12 | Recontacto programado | Solo Meta lo limpiaba cuando el cliente respondía | — | Evento `customer_replied` para todos; el módulo Ventas lo limpia | — |
| 13 | Idempotencia de eventos | Colecciones `lead_processed_ids` y `valuetext_processed_ids` | — | Una sola: `processed_events/{source}__{externalId}` | — |
| 14 | `get_whatsapp_number_by_brand` | `.limit(1)` sin orden: elegía un número arbitrario | — | Elige por vertical y de forma determinista; un `sfBrandCode` duplicado lanza error | — |
| 15 | Parámetros anidados de un tool call (ChatLLM) | Se perdían (regex cortaba en la primera `}`) | — | Se decodifican completos | — |

## Pendiente de estas decisiones

- **Handlers de Ventas** (tarea 1.18): crear y actualizar Lead, cita, recontacto, el gate que exige Lead para escalar, el aviso de "primera respuesta". Hoy el pipeline despacha los eventos y no hay quien los atienda.
- Los handlers de Ventas deben **auto-excluirse** cuando el bot no tiene `salesforceConfig` (un bot de Twilio sin Salesforce no crea Leads). Es la guarda que evita que el gate de Lead bloquee escalamientos que hoy funcionan.
- Verificar con las dos plataformas en producción los puntos 1, 2 y 8 antes de migrar.
