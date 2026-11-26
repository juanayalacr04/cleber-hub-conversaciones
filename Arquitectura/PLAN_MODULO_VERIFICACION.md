# Plan — Módulo Verificación de datos del cliente

**Fecha:** 25 de noviembre de 2026 · **Estado:** Fase 1 (núcleo) implementada el 26 de noviembre de 2026: migración 008, tabla `verificacion_datos`, acciones `Hub.registraVerificacion` y `Hub.actualizaVerificacion`, `modules/verificacion.py` y pruebas Python. Las pruebas SQL (`DB/Hub/Pruebas/pruebas_verificacion.sql`) están escritas pero no se han corrido. Fases 2 a 5 pendientes.

Rama de trabajo: `modulo-verificacion` (parte de `dev`).

---

## 1. Objetivo

Salesforce (SF) pide a la plataforma verificar que el número de WhatsApp de un cliente es correcto. La plataforma manda una plantilla con un botón de confirmación, un bot de Abacus recibe la respuesta y devuelve una acción con un booleano, y la plataforma notifica el resultado a SF.

## 2. Decisiones acordadas

| # | Tema | Decisión |
|---|------|----------|
| D1 | Asincronía | La petición de SF solo recibe un acuse; el resultado llega en una llamada posterior de la plataforma a SF |
| D2 | Resultado | Solo `valido` (true) o `no valido` (false). Sin respuesta = **pendiente**: no se llama a SF y SF conserva su estatus |
| D3 | Plantilla | Sin datos del cliente; solo pide confirmar que el número es el correcto. Botón "Confirmo" (quick reply) |
| D4 | Bot | Recibe el botón o el texto libre. La lógica del bot la lleva otra persona; aquí solo se implementa cómo se recibe su acción |
| D5 | Acción del bot | `Ejecutar_Accion_Externo` con acción `Verificar_Telefono` y `datos` con un booleano real: `{"valido": true}` / `{"valido": false}`. `motivo` lleva un valor fijo y no decide el resultado |
| D6 | Identificador | ID opaco enviado por SF (el HUB no sabe a qué objeto pertenece) + teléfono del cliente |
| D7 | Idempotencia | Mismo ID = misma verificación, sin reenviar plantilla. Mismo ID con otro teléfono: rechazo. Otro ID con una verificación pendiente para ese teléfono y número: rechazo |
| D8 | Cierre | Con una decisión válida se guarda el resultado, se cierra la conversación y se solicita el callback a SF |
| D9 | Callback | Se guarda el resultado y se reintenta ante fallos temporales, con entrega idempotente; si se agotan los reintentos queda un estado de error visible |
| D10 | Pantallas | Dashboard, Conversaciones (solo consulta) y configuración como en Valuación (WhatsApp, bots, usuarios, etc.) |
| D11 | Convenciones | Auth, rutas y datos según el template del HUB. Destino del envío por ambiente (`AMBIENTE=prd` siempre al cliente). Una cuenta Twilio por ambiente |

## 3. Pendientes con terceros (no bloquean el diseño)

- **SF:** URL, autenticación y body definitivos del endpoint de entrada y del callback; campo de SF que se enviará como ID.
- **Bot:** nombre y contrato final de la acción `Verificar_Telefono`; ya hay un tool genérico `ejecutar_accion_externo` (`dev/abacus/`).
- **Plantilla:** nombre y SID/ID aprobado por proveedor (Twilio/Meta) para cada marca.
- **Correo (fase futura):** si SF mandará una sola solicitud con teléfono y correo o una por tipo, y si el callback llevará ambos resultados juntos o por separado. Hoy el callback es solo `{ id opaco, valido }`.
- **Vigencia:** tiempo de validez de una verificación pendiente (hoy no existe; la verificación queda pendiente sin vencer).

## 4. Flujo

```
SF (trigger) ──► POST /internal (contrato ①) ──► hub-entry-point
                   { fuente: "verificacion", idExterno: <ID SF>, idMarca, modulo, telefono, ... }
   ◄── acuse inmediato { idConversacion, enviada, ... }

hub-entry-point: abre conversación saliente (idempotente) ─► plantilla WhatsApp con botón "Confirmo"

Cliente pulsa el botón / escribe ─► webhook ─► SQS ─► msj-entrantes ─► bot (Abacus)
Bot ─► Ejecutar_Accion_Externo { accion: Verificar_Telefono, datos: { valido: true|false } }

Hub: valida acción y booleano ─► guarda resultado ─► cierra conversación ─► evento de salida (contrato ③)
   └─► callback a SF { id opaco, valido }  (con reintentos)
```

## 5. Cambios por capa

### 5.1 Base de datos (`DB/Hub/`)
- **Esquema:** todo vive en `hub_cleber`; no se crea un esquema nuevo. La conversación ya está ahí, los roles por módulo están en `hub_cleber.roles_modulo` y no hay dominio de negocio propio que justifique separar (sin otra exposición en PostgREST ni otros grants).
- Migración nueva (siguiente número de `Migraciones/`): el módulo `verificacion` como módulo válido de números/conversaciones/roles, y la tabla **`hub_cleber.verificacion_datos`**.
- **`hub_cleber.verificacion_datos`** es una entidad propia (no `metadatos` de la conversación), porque el alcance incluirá el correo, que no encaja en una conversación de WhatsApp:
  - `tipo` (`telefono` | `correo`), valor verificado, ID externo opaco de SF (único) y marca.
  - `id_conversacion` **opcional** (en la primera fase siempre se llena, porque el teléfono va por WhatsApp).
  - Estado de la verificación y resultado (pendiente | válido | no válido).
  - Estado del callback a SF: pendiente, enviado o fallido, con conteo de intentos, último error y fechas.
- Función(es) `Hub.*` para registrar el resultado y el estado del callback, y para consultar verificaciones (Dashboard).
- Regla D7: validar que un mismo ID no cambie de teléfono. La restricción de una conversación abierta por número + teléfono ya existe (`CONVERSACION_ABIERTA`).
- Apertura idempotente: se apoya en `Hub.abreConversacionExterna` (idempotente por `fuente` + `idExterno`) y registra la fila en `verificacion_datos` en la misma operación.
- Pruebas SQL en `DB/Hub/Pruebas/`.
- Los grants de PostgREST los da el usuario (no se escriben scripts de GRANT).

### 5.2 Backend (Python)
- **`modules/verificacion.py`** (nuevo, patrón de `modules/valuacion.py`):
  - Registra la fuente `verificacion` en el contrato ① (`registra_fuente`) con su preparador: plantilla configurada en el número del módulo (`plantillas.<llave>`), sin variables del cliente.
  - Tool del pipeline para recibir la acción `Verificar_Telefono`: valida acción y booleano, ignora resultados que no cumplan el contrato, guarda el resultado y cierra la conversación.
  - Registra el destino del contrato ③ para entregar el resultado a SF.
- **Contrato ①** (`core/contrato_entrada.py`): reutilizar tal cual. Revisar que el rechazo de D7 (ID con otro teléfono) pase como error propio y que el acuse a SF sea claro.
- **Callback a SF** (`crm/salesforce.py` o módulo propio): cliente HTTP al endpoint de SF con autenticación configurable, entrega idempotente y reintentos con estado persistido. Mecanismo de reintento a definir según la infraestructura existente (`hub-jobs` con EventBridge ya existe); no se crea infraestructura AWS desde aquí.
- **Entrada de mensajes** (`core/entrada_mensajes.py`, `ai/parsing.py`): comprobar cómo `expande_acciones_externas` y `detect_action` exponen la acción `Verificar_Telefono` y su `datos`, y ajustar solo lo necesario.
- **`handlers.py`**: sin entrada nueva si SF usa `/internal` (contrato ①); confirmar con la configuración de API Gateway del equipo.
- Pruebas en `tests/` (contrato de entrada, idempotencia, acción del bot, callback y reintentos).

### 5.3 Web (`apps/web/`)
- **`src/lib/modules.ts`**: alta del módulo `verificacion` (id, etiqueta, icono) con su `nav`: Dashboard, Conversaciones (operación); Configuración, WhatsApp, Bots, Usuarios (administración); Marcas (plataforma, si aplica como en Valuación).
- **`globals.css`**: color del módulo (`--<color>`, `--<color>-soft`, `body[data-mod]`).
- **Dashboard**: mensajes enviados, estados (solicitud recibida, plantilla enviada/fallida, pendiente de respuesta, válida, inválida) y estado del callback (enviado/fallido). Sin datos sensibles innecesarios.
- **Conversaciones**: consulta del detalle (mensajes, ID recibido de SF, resultado, estado del callback). **Sin** controles para que un agente responda o cambie el resultado.
- **Configuración**: reutiliza las pantallas ya portadas (WhatsApp, Bots, Usuarios, Equipos si aplica) y agrega los parámetros propios: plantilla del módulo y datos del callback a SF.
- El panel de conversación compartido se extiende con una entrada del registro `conversationPanels`.

### 5.4 Bot (Abacus)
- Solo se documenta el contrato para quien configura el bot: acción `Verificar_Telefono`, `datos: {"valido": boolean}`, y `motivo` fijo. Se usa el tool genérico `Ejecutar_Accion_Externo`; la token del módulo viaja como `ABACUS_DEPLOYMENT_TOKEN_<MODULO>`.

### 5.5 Despliegue y documentación
- Entregar pasos de consola para AWS (no se ejecutan comandos de AWS): variables nuevas (p. ej. credenciales del callback a SF en el secreto del ambiente), permisos y, si hace falta, regla de reintentos.
- Documentar el contrato con SF (request, acuse, callback) y actualizar `Arquitectura/TAREAS_PENDIENTES.md`.

## 6. Fases propuestas

1. **Núcleo:** migración de BD, `modules/verificacion.py`, recepción de la acción del bot, cierre y resultado, con pruebas.
2. **Callback a SF:** entrega idempotente y reintentos, con estado persistido.
3. **Web:** alta del módulo, Dashboard y Conversaciones de consulta.
4. **Configuración:** pantallas de configuración y parámetros propios del módulo.
5. **Documentación y pasos de despliegue** para el equipo de AWS.

## 7. Fuera de alcance

- **Verificación de correo.** Está planeada, pero en esta primera fase solo se verifica el **número de teléfono**. El `tipo` de `verificacion_datos` queda previsto; no se construye nada específico de correo (envío, pantalla, acción del bot) hasta que se pida.
- Lógica conversacional del bot (la lleva otra persona).
- Vencimiento automático de verificaciones pendientes (no hay plazo definido).
- Marcar "no válido" por falta de respuesta.
- Respuestas manuales de agentes desde el HUB.
- Cambios o comandos en AWS y conexión directa a la base de datos desde aquí.

## 8. Riesgos y puntos de atención

- Una conversación abierta por número + teléfono: una verificación pendiente bloquea otra del mismo teléfono hasta cerrarse. Sin vencimiento, una verificación sin respuesta puede bloquear reintentos; conviene definir el plazo pronto.
- Un callback que falla tras cerrar la conversación necesita persistencia propia; hoy `contrato_salida` solo registra fallos en bitácora sin reintentar.
- Ambientes: en no-producción el destino lo decide quien llama (`telefonoDestino` / `alCliente`); SF debe respetarlo en dev y qa.
