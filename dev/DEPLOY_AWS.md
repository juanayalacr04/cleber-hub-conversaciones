# Despliegue en AWS (dev)

Comandos y pasos de consola para desplegar las Lambdas del hub. Todo se corre **desde la raíz del repo**, en PowerShell, con sesión de AWS iniciada (cuenta `807746362931`, región `us-east-1`).

El script `dev/deploy_aws.ps1` empaqueta el código (Python 3.12, arm64) y crea o actualiza la Lambda `hub-<función>-<ambiente>`. Es la única fuente del handler, el tiempo máximo y la memoria de cada una.

| Función (parámetro) | Lambda | Handler | Tiempo | Memoria | Para qué |
|---|---|---|---|---|---|
| `entry-point` | `hub-entry-point-dev` | `handlers.entry_point` | 60 s | 512 MB | Contrato ①: Valuación abre una conversación |
| `acciones-usuario` | `hub-acciones-usuario-dev` | `handlers.acciones_usuario` | 29 s | 512 MB | Acciones del dashboard (vista previa de plantilla) |
| `router` | `hub-router-dev` | `handlers.router` | 15 s | 512 MB | Webhooks de Twilio: valida la firma y publica en la cola |
| `msj-entrantes` | `hub-msj-entrantes-dev` | `handlers.entrantes` | 300 s | 512 MB | Consume la cola: el turno completo con el bot |

## 1. Actualizar el código de una Lambda que ya existe

Sube el código nuevo y deja el handler, el tiempo y la memoria como dice la tabla. **No cambia las variables de entorno.**

```powershell
.\dev\deploy_aws.ps1 router dev
.\dev\deploy_aws.ps1 msj-entrantes dev
.\dev\deploy_aws.ps1 entry-point dev
.\dev\deploy_aws.ps1 acciones-usuario dev
```

Qué desplegar según lo que cambió:

| Cambió... | Desplegar |
|---|---|
| Firma de Twilio, `ButtonPayload`, publicación a la cola (`channels/`, `contracts/`) | `router` |
| El turno, el bot, los registros, los eventos a Valuación (`core/entrada_mensajes.py`, `core/datos/`, `modules/`) | `msj-entrantes` |
| Contrato ① (`core/contrato_entrada.py`) | `entry-point` |
| Acciones del dashboard (`core/acciones_usuario.py`) | `acciones-usuario` |
| Código compartido (`core/postgrest.py`, `core/credentials.py`, `core/entorno.py`) | Las que lo usen: normalmente todas |

## 2. Crear una Lambda que no existe

Si no se indica `-RolArn`, el script copia el rol, las variables de entorno y la VPC de `hub-entry-point-dev`.

```powershell
# Consumidor de la cola. No necesita variables propias.
.\dev\deploy_aws.ps1 msj-entrantes dev

# Router. Lleva dos variables propias.
.\dev\deploy_aws.ps1 router dev -Var "COLA_ENTRANTES_URL=https://sqs.us-east-1.amazonaws.com/807746362931/hub-entrantes-dev.fifo","PUBLIC_BASE_URL=https://4ebqh3k28i.execute-api.us-east-1.amazonaws.com/dev"
```

`PUBLIC_BASE_URL` termina en `/dev`, sin barra final y sin `/webhook/twilio`: el router le suma la ruta. Twilio firma la URL exacta, así que debe coincidir con la que está configurada en el sender.

Para solo generar el .zip sin desplegar:

```powershell
.\dev\deploy_aws.ps1 router dev -SoloEmpaquetar
```

Otros parámetros: `-Perfil <perfil-aws>`, `-Region <región>`, `-RolArn`, `-Secret`, `-SecretosPrefijo`, `-EnvFile`, `-SubnetIds`, `-SecurityGroupIds`. Las variables, la VPC y los secretos **solo se fijan al crear**; en una función existente se cambian en la consola (Configuration → Environment variables).

## 3. Variables de entorno de cada Lambda

Las cuatro comparten estas (las copia `hub-entry-point-dev`):

| Variable | Valor en dev |
|---|---|
| `SECRET_NAME` | `hub/dev/entorno` |
| `SECRETOS_EN` | `aws` |
| `SECRETOS_PREFIJO` | `hub/dev` |
| `URL_API_DB` | `http://ec2-3-89-235-189.compute-1.amazonaws.com:3000/` |

`TELEFONO_PRUEBAS` ya no se usa: fuera de producción el destino del envío lo elige quien pulsa **Enviar** (teléfono de prueba o cliente). Si la Lambda aún la trae, se puede borrar.

| Variable | Valor | Para qué |
|---|---|---|
| `AMBIENTE` | `prd` en producción; `dev` (o vacía) en los demás | Contrato ①. En `prd`, las ofertas se envían siempre al cliente, en automático, y un teléfono de prueba se ignora. Fuera de `prd`, el envío exige indicar a quién va. **En las Lambdas de producción es obligatoria**: sin ella, se tratan como no productivas y rechazan los envíos (`DESTINO_REQUERIDO`). |

Además:

| Lambda | Variable | Valor |
|---|---|---|
| `hub-router-dev` | `COLA_ENTRANTES_URL` | `https://sqs.us-east-1.amazonaws.com/807746362931/hub-entrantes-dev.fifo` |
| `hub-router-dev` | `PUBLIC_BASE_URL` | `https://4ebqh3k28i.execute-api.us-east-1.amazonaws.com/dev` |
| `hub-msj-entrantes-dev` | `LOG_CONTENIDO` | `true` para ver el texto de los mensajes en los registros (apagado por omisión: son datos personales) |

## 4. Secreto del ambiente: `hub/dev/entorno`

JSON plano. Las Lambdas lo leen **al arrancar una instancia**: después de cambiarlo, despliega de nuevo o espera a que se renueven las instancias.

| Llave | Para qué |
|---|---|
| `TWILIO_ACCOUNT_SID` | Cuenta de Twilio (una por ambiente) |
| `TWILIO_AUTH_TOKEN` | Token de Twilio: envío y validación de la firma del webhook |
| `ABACUS_DEPLOYMENT_TOKEN_VALUACION` | Token de Abacus del módulo Valuación (uno por módulo; `_VENTAS`, `_SERVICIO` cuando entren) |
| `ABACUS_API_KEY` | Llave de API de Abacus (una por organización, la comparten todos los módulos) |
| `CLEBER_API_KEY` | `x-api-key` del API de dev (hoy vacía; revisar) |

## 5. Consola de AWS

### SQS (una sola vez)

1. **DLQ** `hub-entrantes-dev-dlq.fifo`: tipo FIFO, retención 14 días, sin DLQ propia.
2. **Cola** `hub-entrantes-dev.fifo`: tipo FIFO, visibilidad **330 s**, retención 4 días, deduplicación por contenido **apagada**, *High throughput FIFO* encendido (ámbito por grupo de mensajes), DLQ `hub-entrantes-dev-dlq.fifo` con **3** recepciones máximas.

### IAM (una sola vez)

Política en línea `policy-hub-dev-sqs` en el rol `cleber-hub-lambdas-dev`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {"Sid": "RouterPublica", "Effect": "Allow", "Action": "sqs:SendMessage",
     "Resource": "arn:aws:sqs:us-east-1:807746362931:hub-entrantes-dev.fifo"},
    {"Sid": "EntrantesConsume", "Effect": "Allow",
     "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"],
     "Resource": "arn:aws:sqs:us-east-1:807746362931:hub-entrantes-dev.fifo"}
  ]
}
```

### Disparador de `hub-msj-entrantes-dev` (una sola vez)

Configuration → Triggers → Add trigger → SQS: cola `hub-entrantes-dev.fifo`, **Batch size = 1**, **Report batch item failures** encendido. Verifica que quede *Enabled*.

### API Gateway `4ebqh3k28i` (una sola vez)

1. Recurso `/webhook` (sin proxy).
2. Dentro, recurso `{proveedor}` (con llaves).
3. Método **POST** en `/webhook/{proveedor}`: integración Lambda, **Lambda proxy integration** encendido, función `hub-router-dev`, autorización **NONE**, **API key required** apagado.
4. **Deploy API** al stage `dev`.

### Twilio

En el sender de WhatsApp: *Webhook URL for incoming messages* = `https://4ebqh3k28i.execute-api.us-east-1.amazonaws.com/dev/webhook/twilio`, método **HTTP Post**. Sin Messaging Service asociado. El cambio puede tardar unos minutos en aplicarse.

## 6. Orden recomendado para una puesta en marcha desde cero

1. Secreto `hub/dev/entorno` con las llaves de la sección 4.
2. Colas (DLQ primero) y la política IAM.
3. `.\dev\deploy_aws.ps1 msj-entrantes dev` y su disparador SQS.
4. `.\dev\deploy_aws.ps1 router dev -Var ...` (comando de la sección 2).
5. Ruta `/webhook/{proveedor}` en el API Gateway y **Deploy API**.
6. Webhook en Twilio.
7. En la base: `dev/alta_bot_valuacion.sql` (el bot y su asignación al número de Valuación).

## 7. Comprobaciones

Con el router y el API desplegados, esta llamada sin firma debe responder **403 Forbidden** (la ruta y el router funcionan; rechazó la falta de firma):

```powershell
curl.exe -i -X POST "https://4ebqh3k28i.execute-api.us-east-1.amazonaws.com/dev/webhook/twilio" -d "Body=hola"
```

| Respuesta | Qué significa |
|---|---|
| 403 `Forbidden` | Todo bien |
| 403 `Missing Authentication Token` | La ruta o el método no están desplegados en el stage `dev` |
| 500 | El router falló: ver `/aws/lambda/hub-router-dev` (falta `COLA_ENTRANTES_URL` o `TWILIO_AUTH_TOKEN`) |

Para seguir una conversación en **CloudWatch Logs Insights**, sobre el grupo `/aws/lambda/hub-msj-entrantes-dev`:

```
fields @timestamp, @message | filter @message like /conv=<idConversacion>/ | sort @timestamp asc
```

Líneas que registra cada turno: `turno.inicio`, `turno.conversacion`, `turno.bot_llamada`, `turno.bot_respuesta` (con los tools que pidió el bot), `turno.bot_error`, `turno.tool_revisado`, `turno.tool_detectado`, `turno.motivo_clasificado`, `turno.handoff_revisado`, `turno.handoff_aplicado`, `turno.handoff_bloqueado`, `turno.respuesta_enviada`, `turno.evento_enviado` y `turno.evento_error`.

| Síntoma | Qué revisar |
|---|---|
| El mensaje no llega al router | URL del webhook en Twilio; Messaging Service asociado al sender; esperar unos minutos |
| 403 del router con una firma válida | `PUBLIC_BASE_URL` o `TWILIO_AUTH_TOKEN` |
| El mensaje se queda en la cola | Disparador de `hub-msj-entrantes-dev` desactivado, o la Lambda falla |
| Mensajes en la DLQ | Log de `hub-msj-entrantes-dev`: es un mensaje que falló 3 veces |
| La Lambda corre pero no contesta | `turno.inicio` sin `bot=`: el número no tiene bot activo (correr `dev/alta_bot_valuacion.sql`) |
| `turno.bot_error` | Token o llave de Abacus en el secreto, o `deploymentId` incorrecto |
| `turno.evento_error` con `SIN_PERMISO` | Valuación no autorizó a `sistema@hub-conversaciones.internal` en `valuacion.contexto_usuario` |
