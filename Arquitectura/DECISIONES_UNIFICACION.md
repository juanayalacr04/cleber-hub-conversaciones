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
| 1 ⚠️ | **Opt-out ("stop")** | Twilio y Meta cierran la conversación. ValueText la **escala a un asesor** ("nunca se cierra sola") | No lo respeta | Cierra la conversación en todos los módulos y despacha el evento `opt_out` | `optOutAction`: `"close"` (por defecto) o `"handoff"`. Se lee primero de `bots/{id}.optOutAction` y, si el bot no lo define, de `teams/{id}.optOutAction` (la política es del equipo, así que lo normal es ponerla ahí). **El equipo de Ventas que atiende por ValueText debe tener `"handoff"`** para conservar su comportamiento. Hoy se edita directo en el documento de Firestore; la pantalla de Equipos lo expondrá al portarla |
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
| 16 ⚠️ | **Credenciales de Salesforce** | Cada organización guarda las suyas en `organizations/{id}.salesforceConfig`, con contraseña y secreto en claro | Igual | Son las mismas para todas, así que salen de variables de entorno globales (Secret Manager). `organizations/{id}.salesforceConfig` conserva solo lo que cambia por marca y no es secreto | Ver abajo |

## Credenciales de Salesforce

Una sola conexión para todas las organizaciones, por variables de entorno (`SF_INSTANCE_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SF_USERNAME`, `SF_PASSWORD`). Si algún módulo necesita otro usuario de Salesforce, se agrega la variable con el prefijo del módulo y gana solo para ese módulo: `SF_VENTAS_USERNAME`, `SF_VENTAS_PASSWORD`, `SF_SERVICIO_USERNAME`... El resto cae a la global.

- **Qué se queda en Firestore** (`organizations/{id}.salesforceConfig`): `marcaRR`, `RecordTypeId` de Lead y Event, owners, owner de BDC (`bdcFallbackOwnerId`) y el nombre del Flow de round robin. Es config por marca y no es secreta.
- **Migración:** mientras las variables de entorno no existan, se siguen usando las credenciales que ya están en Firestore y se registra una advertencia. En cuanto se definen, ganan sobre las de Firestore.
- **Seguridad:** las reglas de Firestore dejan leer `organizations/{id}` a cualquier usuario de la organización, o sea que hoy un agente puede leer la contraseña de Salesforce desde el navegador. Al migrar, **borrar** `clientSecret`, `password`, `username`, `clientId` e `instanceUrl` de cada `salesforceConfig`.
- **Dónde se definen:** local en `.env` (ver `.env.example`); en GCP como secretos de Secret Manager montados con `--set-secrets` al desplegar cada función. Los valores no pasan por el repositorio ni por la conversación.

## Pendiente de estas decisiones

- **Handlers de Ventas** (tarea 1.18): crear y actualizar Lead, cita, recontacto, el gate que exige Lead para escalar, el aviso de "primera respuesta". Hoy el pipeline despacha los eventos y no hay quien los atienda.
- Los handlers de Ventas deben **auto-excluirse** cuando el bot no tiene `salesforceConfig` (un bot de Twilio sin Salesforce no crea Leads). Es la guarda que evita que el gate de Lead bloquee escalamientos que hoy funcionan.
- Verificar con las dos plataformas en producción los puntos 1, 2 y 8 antes de migrar.

## Cambios adicionales al portar el routing y Ventas

| # | Tema | Antes | Ahora |
|---|---|---|---|
| 17 ⚠️ | **Cambio de bot por situación** | Tras cambiar al bot destino se descartaba su respuesta y se enviaba al cliente la del bot de ventas original (parece un fallo: el comentario del código dice lo contrario) | Se envía la respuesta del bot nuevo. Si hay algún flujo que dependa de la conducta anterior, hay que revisarlo |
| 18 | Vertical al cambiar de bot | `vertical` no existía | Se redenormaliza al cambiar de bot: los tools siguientes despachan al módulo nuevo |
| 19 | Zona horaria de recordatorios y citas | Offset fijo UTC-6 en el código | `organizations/{id}.settings.timezone` (México por defecto) |
| 20 | Contacto programado | Parte de Ventas (y solo Meta lo limpiaba) | Genérico, en el núcleo. Lo limpia cualquier respuesta del cliente |
| 21 | Cancelar_Recordatorio | Detección por mención en varios lugares de la respuesta | Se conserva, como `match: "mention"` en la config del tool |
| 22 | Reintento ante token de Salesforce vencido | Solo al enviar SMS | En toda llamada a Salesforce (una vez) |
| 23 | Orden de escrituras del turno | El mensaje del cliente y el reinicio de inactividad se escribían en paralelo con la llamada al bot | Se espera a que terminen antes de llamar al bot (evita carreras con handlers que tocan los mismos campos) |
| 24 | Plantilla de notificación interna | Solo ValueText | Igual: con Twilio o Meta devuelve error y la situación no se resuelve. Generalizar es la Fase 5 |

Configuración de Salesforce que salió del código a `salesforceConfig`: `rrFlowName` (Flow de round robin), `seminuevoOwnerId`, `seminuevoRecordTypeId`, `defaultTemplateId` y `situationMap`. Los IDs de Salesforce que siguen como valor por omisión en `modules/ventas.py` (`DEFAULT_SEMINUEVO_OWNER_ID` y `DEFAULT_SEMINUEVO_RECORD_TYPE_ID`) conviene moverlos a cada organización antes de producción.
