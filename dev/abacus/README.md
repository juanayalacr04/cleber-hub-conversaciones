# Tool de Abacus para pedir acciones al hub

`ejecutar_accion.py` es el tool de código que el ChatLLM (Ventas) usa para pedir cada acción a `hub-actions-execute`. Es **un solo tool
genérico**: la acción va como parámetro (`action`), no hay un tool por acción. Los IA Workflow no usan este código: llevan un paso HTTP al
mismo endpoint (ver abajo).

## Antes de crearlo en Abacus

1. Desplegar `hub-actions-execute` y obtener su URL: `gcloud functions describe hub-actions-execute --gen2 --region=us-central1 --project=ambiente-desarrollo-ti --format="value(serviceConfig.uri)"`.
   El endpoint está en la raíz de esa URL (no lleva `/actions/execute`).
2. Poner en el archivo `HUB_ACTIONS_URL` (o definirla en el entorno al correr `crear_tool.py`). No lleva `botId` ni clave: **es un solo tool para todos los
   bots** (Honda, Kia, Toyota; Ventas y Servicio). El hub saca el bot de la conversación (`activeBotId`, si no `assignedBotId`, si no `botId`) y
   aplica el `tools[]` de ese bot.
   - La clave de servicio va como **secreto de organización de Abacus** (Manage Profile → Secrets): nombre `HUB_ACTIONS_SERVICE_KEY`, valor =
     `ACTIONS_SERVICE_KEY` de `dev/env/actions-execute.yaml`. El tool la lee con `ApiClient().get_organization_secret(...)`; el valor solo llega
     dentro de un entorno administrado por Abacus (fuera de él viene enmascarado), y el tool corre como el usuario que chatea: el secreto no debe
     restringirse a un grupo que no lo incluya. **Sin probar:** que el tool lo lea así en producción.
3. Pegar el archivo como tool de código y declarar los parámetros: `conversation_id` (texto), `action` (texto), `data` (texto: objeto JSON serializado, porque Abacus no admite JSON en los tools) e
   `idempotency_key` (texto, opcional).

## Lo que hay que averiguar probando (tarea 1.47)

**Cómo conoce el tool el `conversation_id`.** El hub ya manda el id de la conversación a Abacus como `externalSessionId`, pero el tool no lo
recibe solo: hoy es un parámetro que el modelo debe llenar. Eso depende de que el modelo lo conozca. Orden de pruebas:

1. Ver si Abacus expone el id de sesión al tool (contexto o variable del tool). Si sí, se lee ahí y se quita de los parámetros.
2. Si no, hay que dárselo al modelo: anteponer `[conversationId: <id>]` al mensaje del cliente (cambio en `ai/service.py`, no hecho) e
   instruirlo en el prompt a pasarlo tal cual. Es lo menos robusto: el modelo puede equivocarse al copiarlo.
3. Si ninguna sirve, ChatLLM sigue con el camino viejo (`ai/parsing.py`) y solo migran los workflows.

Un `conversation_id` mal copiado no hace daño: el hub responde `conversacion_no_encontrada` o `no_autorizado` (la conversación debe ser de ese bot).

## Qué acciones puede pedir un bot

Las que estén en su `tools[]` en Firestore; si el bot no tiene `tools[]`, las de `DEFAULT_TOOLS` (`core/pipeline.py`): `Crear_Lead`,
`Guardar_Nombre_Cliente`, `Registrar_Cita`, `Actualizar_Lead`, `Crear_Cita_Ventas_Salesforce`, `Agendar_Recordatorio`, `Transferir_a_Asesor`,
`Clasificar_Motivo`. `action` acepta el nombre del tool o su evento. **Un bot con `tools[]` propio debe agregar `Transferir_a_Asesor` y
`Clasificar_Motivo`** para poder pedirlas. Una acción que el registro no expone a bots responde `accion_no_permitida`.

## Respuestas

- `ok: true`, `status: done`: hecho. `duplicate`: ya se había hecho con esa clave (devuelve el mismo resultado). `accepted`: en proceso (HTTP 202).
- `ok: false`: `error.code` dice por qué (`datos_invalidos`, `sin_disponibilidad`, `fuera_de_horario`, `precondicion_fallida`, `error_externo`...).
  Con `retryable: true` se puede repetir la misma llamada. `Transferir_a_Asesor` devuelve `escalado`, `ya_escalado` o `fuera_de_horario`
  (con el `mensaje` para el cliente); si falta crear el Lead devuelve `precondicion_fallida`: se crea y se vuelve a pedir.
- La clave de idempotencia se calcula de conversación + acción + datos: repetir exactamente la misma llamada no duplica el efecto.

## IA Workflow (Servicio)

Sin código: un paso HTTP `POST <URL de hub-actions-execute>` con los headers `Authorization: Bearer <clave de servicio>` y `Content-Type: application/json`,
y cuerpo `{"action": "...", "conversationId": "...", "idempotencyKey": "...", "data": {...}}`. El timeout del paso debe ser **mayor a 120 s**
(el del endpoint). Un workflow puede usar la misma clave de servicio (sin `X-Bot-Id`: el bot sale de la conversación) o su propio `X-Bot-Id` con una clave en `BOT_ACTION_KEYS` (opcional).
