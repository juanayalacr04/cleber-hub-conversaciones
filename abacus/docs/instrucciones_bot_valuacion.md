# Bot de Valuación (toma de autos) — cómo crearlo en Abacus

Bot **ChatLLM** de preguntas y respuestas sobre la oferta de compra de un auto, atendido por WhatsApp.

**Alcance de esta versión (de prueba):** responde con la base de conocimiento y usa el contexto de la oferta que le manda el hub. **Todavía no tiene herramientas**: no clasifica la decisión del cliente ni pasa la conversación a un asesor. Eso se agrega después (sección 6).

Fuente del contenido: `abacus/docs/plantilla_base_conocimiento_bot_wa - F1 INOVATON.pdf` (Frente 1 · Toma de Autos). Al 18 de noviembre de 2026 esa plantilla trae las 6 preguntas y sus guías de redacción, pero **los textos de respuesta están vacíos** y no se marcó el tono. Por eso hay un conocimiento provisional (sección 3).

Contenido:

1. [Pasos para crearlo](#1-pasos-para-crearlo)
2. [Instrucciones del bot (para pegar)](#2-instrucciones-del-bot-para-pegar)
3. [Conocimiento provisional](#3-conocimiento-provisional-hasta-que-la-base-esté-completa)
4. [Pruebas](#4-pruebas)
5. [Pendientes de la base de conocimiento](#5-pendientes-de-la-base-de-conocimiento)
6. [Para más adelante: herramientas y paso a asesor](#6-para-más-adelante-herramientas-y-paso-a-asesor)

---

## 1. Pasos para crearlo

> Los nombres de menús de Abacus no los tengo verificados y pueden variar. Sigue el mismo camino con el que armaron los bots de Ventas y Servicio; lo que importa es **qué** se configura, no dónde.

### Paso 1 · Preparar el contenido
Ten a la mano:
- Las instrucciones de la sección 2 (dos bloques: behavior y response).
- El conocimiento de la sección 3. Si la base ya trae los textos aprobados, usa esos; si no, el provisional.

### Paso 2 · Cargar la base de conocimiento
En el paso del asistente **Create or Attach Dataset**, sube `abacus/docs/conocimiento_bot_valuacion.md` (el mismo contenido de la sección 3, ya limpio) como dataset de documentos. Si no acepta `.md`, cámbiale la extensión a `.txt`. Es mejor que el PDF de la plantilla: el PDF tiene el texto partido en renglones y las respuestas vacías. Cuando la plantilla esté completa, se reemplaza por la versión final.

### Paso 3 · Crear el bot
1. Crea un bot de tipo **ChatLLM**.
2. Pega el bloque 2.1 en **Behavior instructions** y el bloque 2.2 en **Response instructions** (sección 2).
3. Conecta la base de conocimiento del paso 2.
4. **No agregues herramientas** por ahora.

### Paso 4 · Probarlo en el chat de Abacus, antes de conectarlo
El hub le manda al bot, en el primer mensaje del cliente, un contexto con los datos de la oferta. Para probar lo mismo, pega esto como **primer mensaje** en el chat de prueba de Abacus:

```
<<PLANTILLA>> Mensaje que se le envió al cliente: "Hola Juan Pérez, tenemos una oferta de compra por tu HONDA CIVIC 2019: $270,000. ¿Te interesa?"

<<CONTEXTO>> Se le envió al cliente una oferta de compra de su vehículo. Cliente: Juan Pérez. Vehículo: HONDA CIVIC 2019. Kilometraje: 64,000 km. Monto ofrecido: $270,000. Agencia: Honda Satélite. Cita de servicio: 12/11/2026 09:30. Id de oferta: 123.

<<CONTEXTO>> Teléfono del cliente: "+528126390927"

Me interesa, pero ¿por qué dice que es estimado?
```

Revisa:
- Que lo llame por su nombre y mencione su vehículo.
- Que explique el punto 1 de la base sin inventar nada.
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

**Con la pantalla de Bots (recomendado):** en Valuación → Administración → **Bots**, pulsa **Crear Bot**, pon el nombre, el **Deployment ID** del paso 5 y guarda. Después, en **WhatsApp**, elige ese bot como "Bot por defecto" del número de la marca. La pestaña **Avanzado** ya trae el vocabulario de resultados de Valuación. Para cambiar el `deploymentId` de un bot existente, edítalo ahí.

**Con el script** (sirve si la pantalla aún no está desplegada):
Abre `dev/alta_bot_valuacion.sql` y en el bloque **DATOS DEL BOT** cambia `deployment_id` por el del paso 5:

```
\set deployment_id <deploymentId del bot>
```

El resto (`marca TO`, `id_bot bot-valuacion-to`, `tipo chatllm`) se queda. Luego, en `psql`:

```
\i dev/alta_bot_valuacion.sql
```

Debe mostrar `Bot: bot-valuacion-to (creado: false)` si ya existía, o `true` si es nuevo, y `bot default = bot-valuacion-to`. Como el script actualiza si el bot ya existe, sirve para cambiar el `deploymentId` del bot de prueba actual por este.

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

Eres el asistente virtual de la agencia por WhatsApp. Atiendes a clientes que recibieron una oferta de compra por su auto
y tienen dudas sobre el proceso. Tu único trabajo es responder esas dudas con la información de tu base de conocimiento.

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

Reglas:

- Responde con la información de la base. No agregues plazos, montos, políticas ni requisitos que no estén ahí.
- Si el cliente pregunta algo que la base no cubre, o la base no trae ese dato, dilo con naturalidad ("ese dato lo confirma el
  valuador el día de tu cita") y no improvises una respuesta.
- El monto de la oferta es un estimado que el valuador puede confirmar o ajustar al inspeccionar el auto. Nunca lo cambies,
  nunca ofrezcas más, nunca negocies, y nunca garantices un precio final.
- Responde solo sobre este proceso. Si preguntan otra cosa (otro tema, otro trámite, otro vehículo), explica amablemente
  que solo puedes ayudar con la oferta de compra de su auto.

# Cuando el cliente decide algo

- Si dice que le interesa: agradécele, y recuérdale que el valuador revisará su auto el día de su cita de servicio y le
  confirmará la oferta final. No prometas nada más.
- Si dice que no le interesa: agradece su tiempo con amabilidad y dile que, si cambia de opinión, aquí estamos. No insistas.
- Si dice que lo ve más adelante: dile que con gusto lo contactamos después.
- Si quiere vender y comprar uno nuevo: explícale ese proceso (punto 4).

# Lo que no puedes resolver por este medio

Quejas formales, negociación del precio y problemas con su crédito o financiamiento, o cuando pide hablar con una persona.
En esos casos no intentes resolverlo. Dile con amabilidad que por este medio no puedes atender eso, que lo verá directamente
el personal de la agencia, y que el valuador lo atiende el día de su cita. No prometas que alguien lo contactará ni un plazo.

# Lo que nunca haces

- No inventas información, cifras, fechas ni políticas.
- No hablas mal de otras agencias, marcas ni personas.
- No pides datos bancarios, contraseñas ni documentos por este chat.
- No confirmas citas, pagos ni fechas de entrega: eso lo confirma el valuador.
---8<---
```

### 2.2 Response instructions

```
---8<---
# Cómo respondes

- Español de México, en segunda persona (tú). Tono amable, claro y cercano; nunca presionas.
- Escribes como en WhatsApp: mensajes cortos, de pocas líneas. Si la respuesta es larga, la divides en pasos.
- Puedes usar una lista corta (con guiones o números) cuando enumeras pasos o documentos. No uses títulos, negritas ni
  formato elaborado.
- En el primer mensaje, saluda al cliente por su nombre, si lo tienes.
- Responde primero lo que preguntó, sin rodeos ni introducciones largas. Una sola idea principal por mensaje.
- Transmites confianza: si no sabes algo, lo dices con naturalidad, sin disculpas excesivas.
- Termina con una frase breve que invite a seguir preguntando, solo cuando haga falta.
- Nunca muestres al cliente los bloques `<<PLANTILLA>>` ni `<<CONTEXTO>>`, ni los repitas, ni menciones que los recibiste.
- No uses emojis, salvo uno ocasional y amable si el cliente los usa primero.
---8<---
```

## 3. Conocimiento provisional (hasta que la base esté completa)

Mientras la plantilla no traiga los textos de respuesta, este es el contenido que el bot puede usar. **Solo incluye lo que las guías de la plantilla afirman**. Lo que las guías dejan a "completar con la política real" no está aquí: el bot debe decir que lo confirma el valuador. Cuando la base esté completa, esta sección se reemplaza por ella.

Se carga como base de conocimiento del bot (o al final de las instrucciones).

```
---8<---
# Conocimiento (provisional)

## 1. ¿Por qué el precio que me enviaron es estimado y no el definitivo?
- El precio se calculó de forma automática con datos del sistema: modelo, año, kilometraje e historial de servicio
  registrado en la agencia.
- El día de la cita, el valuador inspecciona físicamente el auto y puede confirmar o ajustar el valor según su condición
  real: carrocería, interiores, neumáticos, cristales y mecánica.
- El precio estimado es el punto de partida, no una promesa que se vaya a romper. Queremos ser honestos desde el primer mensaje.
- El valuador es certificado y el proceso es objetivo y transparente.

## 2. ¿Cuánto tarda el proceso para tomar mi auto y recibir mi pago?
- Pasos: inspección el día de la cita → oferta final → firma de documentos → entrega del auto → pago.
- Se agiliza con la documentación completa y con el auto sin adeudo financiero.
- Si el auto tiene financiamiento vigente, hay que liquidar el adeudo antes o durante el proceso.
- Los tiempos exactos y si el pago es el mismo día no están definidos: dile que lo confirma el valuador el día de la cita.

## 3. Si confirmo que me interesa, ¿tengo que dejar mi auto ese mismo día?
- El día de la cita de servicio, el valuador inspecciona el auto y entrega la oferta final.
- El cliente no necesariamente entrega el auto ese mismo día.
- No hay presión: el cliente decide con calma.
- Cuándo ocurre la entrega formal y si puede llevarse el auto mientras decide no está definido: dile que lo confirma el
  valuador el día de la cita.

## 4. ¿Cuál es el proceso si quiero vender mi auto y comprar uno nuevo?
1. Inspección del auto actual.
2. Oferta final del valuador.
3. El valor se aplica como parte de pago o enganche del auto nuevo.
4. Selección y prueba de manejo del auto nuevo con un asesor.
5. Cierre y firma de documentos.
- El mismo día de la cita puede iniciar el contacto con el asesor de autos nuevos, si lo desea.
- La prueba de manejo se puede agendar el mismo día o en otro momento conveniente.
- Te atiende el valuador para la toma de tu auto y un asesor de autos nuevos para la compra.

## 5. ¿Cuál es el proceso si solo quiero vender mi auto?
1. Inspección durante la cita de servicio.
2. Oferta final del valuador.
3. Aceptación y firma de documentos.
4. Entrega del auto.
5. Pago.
- A diferencia de venta + compra, el cliente solo recibe el pago: no necesita pasar con el área de autos nuevos.
- Si el auto tiene un adeudo financiero vigente, se debe liquidar. El tiempo total y la política de liquidación no están
  definidos: dile que lo confirma el valuador el día de la cita.

## 6. ¿Qué documentos necesito para vender mi auto?
- Factura original del vehículo.
- Identificación oficial vigente (INE o pasaporte).
- Tarjeta de circulación.
- Juego completo de llaves.
- Comprobante de domicilio reciente (si aplica).
- Si el auto está financiado: estado de cuenta del crédito o carta de saldo del banco.
- Si es persona moral: acta constitutiva, poder notarial y RFC.
- Opcionales que agilizan el proceso: póliza de seguro, manual del vehículo y facturas de servicios previos.
- Cierre sugerido: "Si tienes duda sobre algún documento, escríbenos y con gusto te orientamos."
- Si cada documento se pide en original o en copia no está definido: dile que lo confirma el valuador el día de la cita.

## Temas que el bot no resuelve
Quejas formales, negociaciones de precio fuera del rango autorizado y problemas con crédito o financiamiento.
---8<---
```

---

## 4. Pruebas

Se hacen primero en el chat de Abacus (paso 4) y después por WhatsApp (paso 8).

| Prueba | Qué debe pasar |
|---|---|
| Primer mensaje con el contexto de la oferta | Saluda por su nombre y menciona su vehículo. No muestra `<<CONTEXTO>>` ni `<<PLANTILLA>>` |
| "¿Por qué el precio es estimado?" | Responde con el punto 1 |
| "¿Cuánto tardan en pagarme?" | Explica los pasos y dice que el plazo lo confirma el valuador |
| "¿Qué documentos necesito?" | Lista los documentos |
| "Si quiero vender y comprar uno nuevo, ¿cómo es?" | Explica los 5 pasos |
| "¿Cuánto cuesta un Corolla nuevo?" | Dice que solo puede ayudar con la oferta de su auto |
| "¿Me dan más por mi auto?" | No negocia ni cambia el monto |
| "Quiero hablar con una persona" | No inventa que lo van a contactar; explica que por este medio no puede y que el valuador lo atiende en su cita |
| "Sí, quiero vender" | Agradece y recuerda la inspección del día de la cita |
| "No me interesa" | Agradece sin insistir |

Por WhatsApp, en los registros de `hub-msj-entrantes-dev` (CloudWatch):
- `turno.bot_llamada ... preambulo=True`: el primer mensaje llevó el contexto de la oferta.
- `turno.bot_respuesta ... respuesta_chars=...`: el bot respondió. Si aparece `turno.bot_error`, revisa el token, la llave y el `deploymentId`.

---

## 5. Pendientes de la base de conocimiento

La plantilla se entrega a TI con estos huecos. Hasta que se llenen, el bot deriva estas preguntas al valuador:

| # | Pregunta | Falta definir |
|---|---|---|
| Todas | Texto de respuesta | Los 6 campos "RESPUESTA DEL BOT" están vacíos. El conocimiento provisional sale de las guías de redacción, no de textos aprobados |
| Todas | Tono | No marcaron Informativo / Empático / Comercial en ninguna |
| General | Trato | La plantilla dice "tú/usted según política interna". Estas instrucciones usan **tú** (como en el ejemplo "te orientamos"); si la política es "usted", se cambia en la sección "Cómo hablas" |
| 02 | Pago y tiempos | Si el pago es el mismo día o en un plazo, y el tiempo estimado total |
| 02, 05 | Financiamiento | La política de liquidación del adeudo |
| 03 | Entrega | Cuándo es la entrega formal y si el cliente puede llevarse el auto tras la inspección |
| 06 | Documentos | Si cada uno se pide en original, copia o ambos |
| Notas | Preguntas frecuentes adicionales | Vacío |
| Notas | Temas que se escalan a un asesor | Vacío (solo trae los ejemplos de la plantilla: quejas formales, negociación de precio fuera del rango, problemas con crédito o financiamiento) |

---

## 6. Para más adelante: herramientas y paso a asesor

Esta versión no las usa. Cuando se agreguen, el bot podrá registrar la decisión del cliente y pasar la conversación a un asesor. Lo que habrá que hacer:

- **Herramientas del bot:** dos, `Clasificar_Motivo` (parámetro `motivo`) y `Transferir_a_Asesor` (parámetro `motivo`). Las dos son "eco": devuelven lo que reciben, y el hub detecta que se llamaron. Hay otro camino, un tool genérico que le pide la acción al hub (`dev/abacus/ejecutar_accion.py`, decisión D14), que depende de construir `hub-acciones-bot` en AWS (tarea 2.7).
- **Vocabulario de `Clasificar_Motivo`** (los valores que reconoce Valuación, `etiquetas.accion_hub`):

| Valor | Etiqueta en la oferta |
|---|---|
| `oferta_aceptada_venta` | Acepta venta |
| `oferta_aceptada_venta_y_compra` | Acepta venta y compra |
| `oferta_rechazada` | Cliente declina |
| `contacto_futuro` | Contacto futuro |

`no_responde` no lo usa el bot: lo pone el sistema cuando el cliente no contesta.

- **Configuración del bot en el hub** (`config` en `hub_cleber`): `outcomeActions` con los cuatro valores y `outcomeTool: "Clasificar_Motivo"`. Sin eso, el hub solo reconoce `interes_cita` y `otro_motivo` y descarta las clasificaciones de Valuación.
- **Instrucciones:** agregar las secciones de cuándo llamar a cada herramienta, y el manejo del mensaje de control `__ADMIN_FOLLOW_INSTRUCTIONS_MESSAGE_OUTPUT__` (fuera de horario). Cambiar la sección "Lo que no puedes resolver por este medio" por el paso a un asesor.
- **Paso a asesor por palabras clave:** no depende del bot; se activa con `handoffConfig` (`enabled` y `triggerKeywords`) en la configuración del bot.
