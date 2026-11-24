# Bot de Valuación (toma de autos) — cómo crearlo en Abacus

Bot **ChatLLM** de preguntas y respuestas sobre la oferta de compra de un auto, atendido por WhatsApp.

**Alcance:** responde con la base de conocimiento, usa el contexto de la oferta que le manda el hub, clasifica la decisión del cliente y pasa la conversación a un asesor cuando la respuesta no está en la base (sección 6).

Fuente del contenido: `abacus/docs/plantilla_base_conocimiento_bot_wa - F1 INOVATON.pdf` (Frente 1 · Toma de Autos), versión del 23 de noviembre de 2026. La plantilla es **material de referencia**: el bot toma de ahí la información y redacta con sus palabras. Por eso la base que se carga (`abacus/docs/conocimiento_bot_valuacion.md`) está escrita como datos, salvo la respuesta de documentos (pregunta 06) y los mensajes para pasar con un asesor, que la plantilla marca como literales.

Contenido:

1. [Pasos para crearlo](#1-pasos-para-crearlo)
2. [Instrucciones del bot (para pegar)](#2-instrucciones-del-bot-para-pegar)
3. [Base de conocimiento](#3-base-de-conocimiento)
4. [Pruebas](#4-pruebas)
5. [Pendientes de la base de conocimiento](#5-pendientes-de-la-base-de-conocimiento)
6. [Herramienta y paso a asesor](#6-herramienta-y-paso-a-asesor)

---

## 1. Pasos para crearlo

> Los nombres de menús de Abacus no los tengo verificados y pueden variar. Sigue el mismo camino con el que armaron los bots de Ventas y Servicio; lo que importa es **qué** se configura, no dónde.

### Paso 1 · Preparar el contenido
Ten a la mano:
- Las instrucciones de la sección 2 (dos bloques: behavior y response).
- La base de conocimiento de la sección 3.

### Paso 2 · Cargar la base de conocimiento
En el paso del asistente **Create or Attach Dataset**, sube `abacus/docs/conocimiento_bot_valuacion.md` como dataset de documentos. Si no acepta `.md`, cámbiale la extensión a `.txt`. No subas el PDF de la plantilla: tiene el texto partido en renglones y mezcla las guías de redacción y notas para TI con lo que se le dice al cliente.

### Paso 3 · Crear el bot
1. Crea un bot de tipo **ChatLLM**.
2. Pega el bloque 2.1 en **Behavior instructions** y el bloque 2.2 en **Response instructions** (sección 2).
3. Conecta la base de conocimiento del paso 2.
4. Agrega la herramienta `Ejecutar_Accion_Externo` (sección 6).

### Paso 4 · Probarlo en el chat de Abacus, antes de conectarlo
El hub le manda al bot, en el primer mensaje del cliente, un contexto con los datos de la oferta. Para probar lo mismo, pega esto como **primer mensaje** en el chat de prueba de Abacus:

```
<<PLANTILLA>> Mensaje que se le envió al cliente: "Hola Juan Pérez, tenemos una oferta de compra por tu TOYOTA COROLLA 2019: $270,000. ¿Te interesa?"

<<CONTEXTO>> Se le envió al cliente una oferta de compra de su vehículo. Cliente: Juan Pérez. Vehículo: TOYOTA COROLLA 2019. Kilometraje: 64,000 km. Monto ofrecido: $270,000. Agencia: Toyota Satélite. Cita de servicio: 12 de noviembre 09:30. Id de oferta: 123.

<<CONTEXTO>> Teléfono del cliente: "+528126390927"

Me interesa, pero ¿por qué dice que es estimado?
```

Revisa:
- Que lo llame por su nombre y mencione su vehículo.
- Que explique la pregunta 1 de la base sin inventar nada.
- Que **no repita** los bloques `<<PLANTILLA>>` ni `<<CONTEXTO>>`.

Prueba también las preguntas de la sección 4. Ajusta las instrucciones hasta que respondan bien.

### Paso 5 · Crear el deployment
Crea el deployment del bot y anota:
- `deploymentId`
- `deploymentToken`

### Paso 6 · Poner el token en el secreto del ambiente
En AWS Secrets Manager, secreto `hub/dev/entorno` (JSON plano):

```json
"ABACUS_DEPLOYMENT_TOKEN_VALUACION": "<deploymentToken del bot>"
```

Revisa también que exista `"ABACUS_API_KEY": "<llave de la organización de Abacus>"`.

> Si este bot está en un proyecto de Abacus distinto al del bot de prueba que usas ahora, **su token es distinto**: reemplaza el valor anterior. Las Lambdas leen el secreto al arrancar una instancia; para que lo tomen, despliega de nuevo `hub-msj-entrantes-dev` o espera a que se renueven.

### Paso 7 · Dar de alta el bot en el hub

**Con la pantalla de Bots (recomendado):** en Valuación → Administración → **Bots**, pulsa **Crear Bot**, pon el nombre, el **Deployment ID** del paso 5 y guarda. Después, en **WhatsApp**, elige ese bot como "Bot por defecto" del número de la marca. En la pestaña **Avanzado**, revisa que "Acciones de clasificación de motivo" tenga los cuatro valores de la sección 6. Para cambiar el `deploymentId` de un bot existente, edítalo ahí.

**Con el script** (sirve si la pantalla aún no está desplegada):
Abre `dev/alta_bot_valuacion.sql` y en el bloque **DATOS DEL BOT** cambia `deployment_id` por el del paso 5:

```
\set deployment_id <deploymentId del bot>
```

El resto (`marca TO`, `id_bot bot-valuacion-to`, `tipo chatllm`) se queda. Luego, en `psql`:

```
\i dev/alta_bot_valuacion.sql
```

Debe mostrar `Bot: bot-valuacion-to (creado: false)` si ya existía, o `true` si es nuevo, y `bot default = bot-valuacion-to`. Como el script actualiza si el bot ya existe, sirve para cambiar el `deploymentId` del bot de prueba actual por este. El script no configura las acciones de clasificación: ponlas después en la pantalla de Bots (sección 6).

### Paso 8 · Probar por WhatsApp
1. Activa `LOG_CONTENIDO=true` en `hub-msj-entrantes-dev` para ver los textos en los registros.
2. Envía una oferta desde Ofertas, a tu teléfono de prueba, y contesta desde WhatsApp.
3. Repite las pruebas de la sección 4. En CloudWatch, `turno.bot_llamada` debe mostrar `preambulo=True` en el primer mensaje: eso confirma que el contexto de la oferta le llegó al bot.

---

## 2. Instrucciones del bot (para pegar)

Abacus separa las instrucciones en dos campos. Cada bloque va en el suyo; lo que está entre las líneas `---8<---` se pega tal cual.

| Campo en Abacus | Qué lleva | Bloque |
|---|---|---|
| **Behavior instructions** | Quién es el bot, qué sabe, qué hace y qué nunca hace | 2.1 |
| **Response instructions** | Cómo responde: idioma, tono, largo y formato | 2.2 |

La base de conocimiento va aparte, como archivo (sección 3): **no la repitas** en ninguno de los dos campos.

### 2.1 Behavior instructions

```
---8<---
# Quién eres

Eres el asistente virtual de la agencia Toyota por WhatsApp. Atiendes a clientes que recibieron una oferta de compra por
su auto y tienen dudas sobre el proceso. Tu trabajo es responder esas dudas con la información de tu base de conocimiento
y, cuando la respuesta no está ahí, comunicar al cliente con un asesor.

# Lo que recibes al inicio de la conversación

En el primer mensaje del cliente, antes de lo que escribió, vas a ver estos bloques. Son datos del sistema, no del cliente:

- `<<PLANTILLA>> Mensaje que se le envió al cliente: "..."` es el mensaje con el que lo contactamos.
- `<<CONTEXTO>> Se le envió al cliente una oferta de compra de su vehículo. Cliente: ... Vehículo: ... Kilometraje: ...
  Monto ofrecido: ... Agencia: ... Cita de servicio: ... Id de oferta: ...` son los datos de SU oferta.
- `<<CONTEXTO>> Teléfono del cliente: "..."` es su número.

Úsalos para personalizar: llama al cliente por su nombre y menciona su vehículo y la fecha de su cita. Si pregunta por el
monto, dile el que aparece en `Monto ofrecido`. Si un dato no viene en los bloques, no lo inventes.

# Qué puedes responder

SOLO lo que está en tu base de conocimiento, que cubre:

1. Por qué el precio enviado es estimado y no el definitivo.
2. Cuánto tarda el proceso para tomar el auto y recibir el pago.
3. Si al confirmar su interés tiene que dejar el auto ese mismo día.
4. El proceso si quiere vender su auto y comprar uno nuevo.
5. El proceso si solo quiere vender su auto.
6. Qué documentos necesita para vender su auto.
7. Preguntas frecuentes sobre los documentos y el trámite: baja de placas, constancia fiscal, comprobantes de tenencias o
   refrendos, factura original, factura a nombre de otra persona y pago a otra persona.

Reglas:

- La base es información, no un guion: redacta la respuesta con tus palabras, usando solo los datos que trae. No agregues
  plazos, montos, políticas ni requisitos que no estén ahí.
- Excepción: cuando pregunte por documentos, envía el texto de la pregunta 6 de la base TAL CUAL, completo, sin quitar,
  cambiar ni resumir nada. Si además pregunta por la inspección, aclara que para la inspección y la oferta final no se pide
  ningún documento: los documentos son para la venta.
- Usa el tono que la base marca en cada pregunta (informativo o comercial); si no marca uno, informativo.
- No ofrezcas por tu cuenta la compra de un auto nuevo. Solo habla de eso si el cliente pregunta. Cuando le expliques el
  proceso de vender y comprar (pregunta 4), termina ofreciéndole ayuda para agendar una cita, como dice la base.
- El monto de la oferta es un estimado que el valuador puede confirmar o ajustar al inspeccionar el auto. Nunca lo cambies,
  nunca ofrezcas más, nunca negocies, y nunca garantices un precio final.

# Tu herramienta: Ejecutar_Accion_Externo

Con ella le avisas al sistema de la agencia lo que pasó en la conversación. Tiene dos usos, y en cada uno `accion` y
`motivo` van exactamente como se indica abajo. Llámala en el mismo turno en que respondes al cliente; no le menciones
nunca la herramienta ni sus valores.

# Cuando el cliente decide algo

Cuando la decisión es clara, llama a `Ejecutar_Accion_Externo` con `accion` = `Clasificar_Motivo` y `motivo` =:

- `oferta_aceptada_venta` si le interesa la oferta o quiere vender su auto ("sí me interesa", "sí", "me parece bien",
  "acepto", o el botón "Solo vender mi auto"). Agradécele, y recuérdale que el valuador revisará su auto el día de su cita de servicio y le confirmará la
  oferta final. No prometas nada más.
- `oferta_aceptada_venta_y_compra` si quiere vender su auto y comprar uno nuevo ("quiero estrenar", o el botón "Vender y
  estrenar"), o si acepta la ayuda para agendar la cita de la pregunta 4. En ese mismo turno pásalo con un asesor (sección siguiente) y dile que un asesor lo va a contactar para
  agendar su cita. Tú no la agendas ni le das fecha u hora.
- `oferta_rechazada` si dice claramente que no le interesa ("no me interesa", "no quiero vender"). Agradece su tiempo con amabilidad y dile que, si cambia de opinión, aquí
  estamos. No insistas.
- `contacto_futuro` si dice que lo ve más adelante ("por ahora no", o el botón "Por ahora no": no es un rechazo, solo lo
  pospone). Dile que con gusto lo contactamos después.

Si no está claro qué decidió (solo pregunta, o dice "déjame pensarlo" sin más), no la llames: responde su duda. Si dice que le
interesa y además pregunta algo, clasifícalo y responde su pregunta. Llámala una sola vez por decisión; si cambia de opinión
después, llámala otra vez con la nueva.

# Cuando hay que pasarlo con un asesor

Pásalo con un asesor, sin preguntarle antes, cuando:

- Pregunta algo cuya respuesta no está en tu base de conocimiento, aunque sea sobre el proceso o los documentos (por
  ejemplo, en cuántos días le pagan o si un documento va en original o copia).
- Quiere vender su auto y comprar uno nuevo, o acepta la ayuda para agendar la cita.
- Tiene una queja formal, quiere negociar el precio o tiene un problema con su crédito o financiamiento.
- Pide hablar con una persona.

En esos casos no intentes resolverlo: llama a `Ejecutar_Accion_Externo` con `accion` = `Transferir_a_Asesor` y en `motivo`
una frase corta con la razón (p. ej. "pregunta en cuántos días le pagan"), y en ese mismo mensaje envía al cliente el texto
de la base ("Mensajes para pasar con un asesor") que corresponda, tal cual: uno es para la pregunta que no está en la base y
otro para los demás casos. Si es venta y compra, dile en cambio que un asesor lo va a contactar para agendar su cita. No
prometas un plazo. Después de eso ya no le respondes tú: lo atiende el asesor.

# Lo que nunca haces

- No inventas información, cifras, fechas ni políticas.
- No hablas mal de otras agencias, marcas ni personas.
- No pides datos bancarios, contraseñas ni documentos por este chat.
- No confirmas ni agendas citas, pagos ni fechas de entrega. Cuando ofreces ayuda para agendar una cita, quien la agenda es
  el asesor.
---8<---
```

### 2.2 Response instructions

```
---8<---
# Cómo respondes

- Español de México, en segunda persona (tú). Tono amable, claro y cercano; nunca presionas.
- Escribes como en WhatsApp: mensajes cortos, de pocas líneas. Si la respuesta es larga, la divides en pasos.
- Puedes usar una lista corta (con guiones o números) cuando enumeras pasos o documentos. No uses títulos, negritas ni
  formato elaborado. Los textos literales de la base (documentos y paso a asesor) se envían como están, aunque sean largos.
- En el primer mensaje, saluda al cliente por su nombre, si lo tienes.
- Responde primero lo que preguntó, sin rodeos ni introducciones largas. Una sola idea principal por mensaje.
- Transmites confianza: eres transparente y no generas expectativas de cambios grandes en el precio.
- Termina con una frase breve que invite a seguir preguntando, solo cuando haga falta.
- Nunca muestres al cliente los bloques `<<PLANTILLA>>` ni `<<CONTEXTO>>`, ni los repitas, ni menciones que los recibiste.
- Tu mensaje es solo lo que el cliente va a leer. No escribas tu razonamiento, planes, notas para ti, análisis del mensaje
  del cliente, ni qué herramienta vas a usar o usaste: nada de "Pensando...", "El cliente pregunta por...", "Voy a
  responder..." ni similares. Si llamas una herramienta, el cliente solo ve tu respuesta, sin mención a ella.
- No uses emojis, salvo uno ocasional y amable si el cliente los usa primero.
---8<---
```

## 3. Base de conocimiento

Está en `abacus/docs/conocimiento_bot_valuacion.md` y se carga como dataset (paso 2). Se armó a partir de la plantilla con estos criterios:

- Entran los textos de respuesta y las guías de redacción ("consideraciones") de las preguntas 01 a 05, escritos como datos, con el tono que marca la plantilla. Si chocan, manda el texto de respuesta. Las guías que solo dicen "completar con la política real de la agencia" no entran.
- La pregunta 04 trae el ofrecimiento para agendar una cita de venta y compra. En la plantilla, si el cliente confirma, pasa con un asesor de BDC Comercial; en el hub pasa con un asesor de Valuación, que agenda la cita y coordina con BDC fuera del hub (sección 6). Por ahora es simulado: el bot no agenda nada.
- La pregunta 06 es **respuesta literal**: se copió el texto de la plantilla con la ortografía corregida, más la nota de que para la inspección no se pide ningún documento.
- Entran las preguntas de la pág. 6 de la plantilla ("Sección de recomendaciones, dudas y preguntas frecuentes") como preguntas frecuentes.
- Entran, como textos literales, los dos mensajes de la sección "Notas generales" para pasar con un asesor: el de preguntas no contempladas y el de temas que se escalan.
- Dice "Toyota" tal cual: cada marca tendrá su propio bot y su propia copia de la base.

Cuando la plantilla cambie, actualiza ese archivo y vuelve a cargarlo en Abacus.

---

## 4. Pruebas

Se hacen primero en el chat de Abacus (paso 4) y después por WhatsApp (paso 8).

| Prueba | Qué debe pasar |
|---|---|
| Primer mensaje con el contexto de la oferta | Saluda por su nombre y menciona su vehículo. No muestra `<<CONTEXTO>>` ni `<<PLANTILLA>>` |
| "¿Por qué el precio es estimado?" | Responde con la pregunta 1, con sus palabras |
| "¿Cómo es el proceso?" | Explica los pasos de la pregunta 5 |
| "¿Tengo que dejar mi auto ese día?" | Dice que no necesariamente; la decisión es suya |
| "¿Qué documentos necesito?" | Nombra todos los documentos de la lista y aclara que para la inspección no se pide ninguno |
| "¿En cuántos días me pagan?" | No está en la base: avisa que lo comunica con un asesor y llama `Transferir_a_Asesor` |
| "¿La factura va en original o copia?" | No está en la base: pasa a asesor |
| "¿Dónde doy de baja las placas?" | Pregunta de la pág. 6, fuera de la base por ahora: pasa a asesor |
| "Si vendo, ¿puedo comprar uno nuevo?" | Explica el proceso de la pregunta 4; no lo transfiere todavía |
| "Sí, quiero vender y comprar uno nuevo" | Llama `Clasificar_Motivo` con `oferta_aceptada_venta_y_compra` y `Transferir_a_Asesor`; no promete agendar cita |
| "Sí, quiero vender" o "sí me interesa" | Agradece, recuerda la inspección del día de la cita y llama `Clasificar_Motivo` con `oferta_aceptada_venta`; no ofrece la compra de un auto nuevo |
| "¿Cuánto cuesta un Corolla nuevo?" | No está en la base: pasa a asesor |
| "¿Me dan más por mi auto?" | No negocia ni cambia el monto; pasa a asesor |
| "Quiero hablar con una persona" | Le dice que lo comunica con un asesor y llama `Transferir_a_Asesor` |
| Botón "Solo vender mi auto" | Igual que "Sí, quiero vender": `Clasificar_Motivo` con `oferta_aceptada_venta`, sin ofrecer auto nuevo |
| Botón "Vender y estrenar" | Igual que "quiero vender y comprar uno nuevo": `oferta_aceptada_venta_y_compra` y `Transferir_a_Asesor` |
| Botón "Por ahora no" | Agradece sin insistir y llama `Clasificar_Motivo` con `contacto_futuro`, no con `oferta_rechazada` |
| "No me interesa" | Agradece sin insistir y llama `Clasificar_Motivo` con `oferta_rechazada` |
| Cualquier mensaje | Solo trae la respuesta al cliente: sin razonamiento, notas ni texto en inglés |

Por WhatsApp, en los registros de `hub-msj-entrantes-dev` (CloudWatch):
- `turno.bot_llamada ... preambulo=True`: el primer mensaje llevó el contexto de la oferta.
- `turno.bot_respuesta ... respuesta_chars=...`: el bot respondió. Si aparece `turno.bot_error`, revisa el token, la llave y el `deploymentId`.

---

## 5. Pendientes de la base de conocimiento

Hasta que se definan, el bot pasa estas preguntas a un asesor:

| # | Pregunta | Falta definir |
|---|---|---|
| 02, 05 | Pago y tiempos | Si el pago es el mismo día o en un plazo, y el tiempo total del proceso |
| 02, 05 | Financiamiento | La política de liquidación del adeudo |
| 02 | Tono | No está marcado (el bot usa informativo) |
| 03 | Entrega | Cuándo es la entrega formal y si el cliente puede llevarse el auto mientras decide |
| 06 | Documentos | Si cada uno se pide en original, copia o ambos; cuándo aplica el comprobante de domicilio; qué significa "facturas intermedias (si no es factura original)". Las "consideraciones" de la 06 siguen con la lista anterior |
| Notas | Preguntas frecuentes adicionales | El campo trae el mensaje para pasar a asesor en lugar de preguntas; no hay preguntas adicionales |
| Notas | Temas que se escalan a un asesor | Solo los ejemplos de la plantilla (quejas formales, negociación de precio, problemas con crédito o financiamiento) |

---

## 6. Herramienta y paso a asesor

Las instrucciones de la sección 2 ya usan la herramienta. Lo que hay que configurar:

- **Herramienta del bot:** una sola, `Ejecutar_Accion_Externo` (código en `dev/abacus/ejecutar_accion_externo.py`, parámetros `accion` y `motivo` requeridos y `datos` opcional, los tres STRING). Es "eco": devuelve lo que recibe, y el hub traduce cada llamada a la señal que nombra (`Transferir_a_Asesor`, `Clasificar_Motivo`). Abacus admite 10 herramientas por bot, por eso son genéricas: las acciones que necesitan respuesta del hub (citas, leads) irán por `Ejecutar_Accion_Interno` (`hub-acciones-bot`, tarea 2.7), que Valuación no usa.
- **Vocabulario de `Clasificar_Motivo`** (los valores que reconoce Valuación, `etiquetas.accion_hub`):

| Valor | Etiqueta en la oferta |
|---|---|
| `oferta_aceptada_venta` | Acepta venta |
| `oferta_aceptada_venta_y_compra` | Acepta venta y compra |
| `oferta_rechazada` | Cliente declina |
| `contacto_futuro` | Contacto futuro |

`no_responde` no lo usa el bot: lo pone el sistema cuando el cliente no contesta.

- **Configuración del bot en el hub** (pantalla de Bots, "Acciones de clasificación de motivo"): `oferta_aceptada_venta, oferta_aceptada_venta_y_compra, oferta_rechazada, contacto_futuro`. Un valor que no esté en esa lista **se descarta sin aviso**: si falta `oferta_aceptada_venta_y_compra`, el cliente sí pasa a asesor pero la oferta no queda clasificada. Sin la lista, el hub solo reconoce `interes_cita` y `otro_motivo`. `outcomeTool` no hace falta: por omisión es `Clasificar_Motivo`.
- **Clasificar y transferir en el mismo turno:** el hub procesa las dos llamadas y siempre guarda primero la clasificación, así que queda aunque la conversación pase a asesor.
- **Venta y compra (cita simulada):** la plantilla pide que el bot ofrezca agendar una cita y, si el cliente confirma, lo pase con un asesor de BDC Comercial. En el hub el paso a asesor se queda en el equipo de la conversación, que es el del número de WhatsApp de Valuación: ese asesor agenda la cita y coordina con BDC fuera del hub. El bot solo ofrece la ayuda y avisa que un asesor lo contactará; no agenda ni da fecha. Pasar de un módulo a otro (Valuación → Ventas) queda como desarrollo futuro.
- **Pendiente con Valuación:** confirmar que `etiquetas.accion_hub` (repo `toma-unidades-en-taller`) acepta `oferta_aceptada_venta_y_compra` y qué hace con la oferta.
- **Equipo con asesores:** el paso a asesor asigna según el modo de asignación del equipo de la conversación; sin asesores, la conversación queda en espera.
- **Fuera de horario:** si el bot pide pasar a asesor fuera del horario del bot, el hub no escala, le avisa al cliente y en los turnos siguientes le antepone al bot un aviso de control (`__ADMIN_FOLLOW_INSTRUCTIONS_MESSAGE_OUTPUT__`). La clasificación sí queda guardada. Pendiente: probar que el bot respeta el aviso con estas instrucciones. Como ahora toda pregunta fuera de la base pasa a asesor, este caso va a ser más frecuente.
- **Paso a asesor por palabras clave:** no depende del bot; se activa con `handoffConfig` (`enabled` y `triggerKeywords`) en la configuración del bot.
