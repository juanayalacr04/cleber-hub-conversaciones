# Variables de entorno de las funciones

Una plantilla por función (`<nombre>.example.yaml`). Para desplegar:

1. Copia `<nombre>.example.yaml` a `<nombre>.yaml` (los `.yaml` sin `example` están fuera de git: llevan secretos).
2. Llena los `<...>`. `deploy.ps1` se niega a desplegar con alguno sin llenar.
3. `.\dev\deploy.ps1 -Function <nombre> -Project ambiente-desarrollo-ti` lo aplica solo.

`--env-vars-file` **reemplaza todas** las variables de la función: cada archivo debe traer el conjunto completo. Sin archivo, un
redeploy no toca las que ya tiene.

## Qué necesita cada función

| Variable | router | queue-incoming | bot | actions-execute | user-actions-execute | situacion-detectada | close-by-phone | inactivity-followup | jobs-run |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `FIRESTORE_DATABASE`, `GOOGLE_CLOUD_PROJECT` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `SF_*` (Salesforce) | sin cola | ✔ | | ✔ | ✔ | ✔ | | ✔ | ✔ |
| `PUBLIC_BASE_URL`, `META_APP_SECRET`, `VALUETEXT_WEBHOOK_SECRET` | ✔ | | | | | | | | |
| `INCOMING_TOPIC` | con cola | | | | | | | | |
| `QUEUE_PUSH_SECRET` | | ✔ | | | | | | | |
| `BOT_FUNCTION_SECRET` | | | ✔ | | | | | | ✔ |
| `BOT_FUNCTION_URL` | | | | | | | | | ✔ |
| `BOT_ACTION_KEYS` | | | | ✔ | | | | | |
| `ALLOWED_ORIGINS`, `APP_URL`, `INVITE_EMAIL_*` | | | | | ✔ | | | | |
| `SITUACION_API_SECRET` | | | | | | ✔ | | | |
| `EXTERNAL_API_SECRET` | | | | | | | ✔ | | |
| `CRON_SECRET` | | | | | | | | ✔ | ✔ |

El **router sin cola** (hasta que exista Pub/Sub, 1.34) procesa el mensaje en proceso, así que necesita también lo de `queue-incoming`
(las `SF_*`; `TWILIO_STATUS_CALLBACK_URL` si manda campañas).

## Secretos que deben coincidir en los dos extremos

| Secreto | Dónde va |
|---|---|
| `BOT_FUNCTION_SECRET` | La función `bot` y quien la llama (`jobs-run` hoy; `queue-incoming` cuando el turno pase a la función 3) |
| `QUEUE_PUSH_SECRET` | La función `queue-incoming` y `?secret=` en la URL del push de la suscripción de Pub/Sub |
| `VALUETEXT_WEBHOOK_SECRET` | El router y `?secret=` en la URL del Outbound Message de Salesforce |
| `EXTERNAL_API_SECRET` | `close-by-phone` y `?secret=` en la URL del Outbound Message que cierra por teléfono |
| `SITUACION_API_SECRET` | `situacion-detectada` y el `X-Api-Secret` que manda el bot de Ventas |
| `CRON_SECRET` | `jobs-run` / `inactivity-followup` y el `X-Cron-Secret` de cada Cloud Scheduler o del cron del dashboard |
| `BOT_ACTION_KEYS` | JSON `{botId: clave}`; la clave de cada bot es el `Bearer` que manda su tool de Abacus (con `X-Bot-Id`) |

Para generar un secreto: `python -c "import secrets; print(secrets.token_hex(32))"`

## Lo que NO se pone aquí

- **`ALLOW_UNAUTHENTICATED_*`** (`WEBHOOKS`, `QUEUE`, `BOT`, `INTEGRATIONS`, `CRON`): saltan la autenticación. Solo para pruebas locales; sin
  ellas las funciones fallan cerradas si falta el secreto. No las pongas en una función desplegada.
- **Credenciales de Twilio y de los bots:** viven en Firestore (`bots`, números), no en el entorno.
- **Opcionales con default** (no hace falta ponerlas): `MAX_HISTORY_MESSAGES` (10), `SESSION_TIMEOUT_HOURS` (24), `EXECUTOR_WORKERS` (8),
  `ABACUS_CHATLLM_HOST`, `PUBSUB_REGION` (us-central1), `FIREBASE_PROJECT_ID` (= `GOOGLE_CLOUD_PROJECT`).
- **El dashboard (Vercel)** tiene sus propias variables (`NEXT_PUBLIC_FIREBASE_*`, `NEXT_PUBLIC_FIRESTORE_DATABASE`, `NEXT_PUBLIC_HUB_ACTIONS_URL`,
  `FIREBASE_SERVICE_ACCOUNT_KEY`, `ABACUS_API_KEY`, `SF_*`): no se despliegan con este script.

## Pendiente (0.22 y 1.41)

Estos archivos dejan los secretos en texto plano en tu disco y en la configuración de la función. Es aceptable para desarrollo; para
producción hay que pasar los secretos a Secret Manager (`--set-secrets`), que `deploy.ps1` todavía no soporta.
