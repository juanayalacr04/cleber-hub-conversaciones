# Guía — Montar el hub con Valuación en un ambiente nuevo (QA y producción)

**Fecha:** 23 de noviembre de 2026 · **Alcance:** núcleo del hub en AWS + módulo de Valuación (Fase 2). Ventas y Servicio no entran.

Esta guía junta en un solo orden lo que en dev se fue armando por partes. Sirve para **QA** y, con las diferencias de la [sección 11](#11-diferencias-para-producción), para **producción**. El detalle de cada pieza sigue en su guía:

| Pieza | Guía de detalle |
|---|---|
| Base `hub_cleber` | [`DB/Hub/README.md`](../DB/Hub/README.md) |
| API Gateway propio del hub | [`GUIA_API_HUB_CONVERSACIONES.md`](GUIA_API_HUB_CONVERSACIONES.md) |
| Authorizer de Google y PostgREST | [`GUIA_API_GATEWAY.md`](GUIA_API_GATEWAY.md) |
| Lambdas, cola SQS y webhook de Twilio | [`dev/DEPLOY_AWS.md`](../dev/DEPLOY_AWS.md) |
| Tiempo real (AppSync Events) | [`GUIA_TIEMPO_REAL.md`](GUIA_TIEMPO_REAL.md) |
| Bot de Abacus | [`abacus/docs/instrucciones_bot_valuacion.md`](../abacus/docs/instrucciones_bot_valuacion.md) |

En esta guía, `<amb>` es el ambiente: `qa` o `prd`. Todos los comandos se corren **desde la raíz del repo**, en PowerShell.

```
 Valuación (Lambda) ──invoca──► hub-entry-point-<amb> ──► Twilio (plantilla de la oferta) ──► cliente
                                                                                               │
 cliente ──► Twilio ──► API Gateway /webhook/twilio ──► hub-router-<amb> ──► SQS hub-entrantes-<amb>.fifo
                                                                                 │
                         Abacus (bot) ◄── hub-msj-entrantes-<amb> ◄──────────────┘
                                                │ eventos ③ a Valuación, aviso de tiempo real
 web (Vercel) ── API Gateway (/hub-cleber, /toma-unidades, /hub-acciones, /toma-unidades-acciones) ──► PostgREST / Lambdas
       └──── WebSocket ──► AppSync Events hub-eventos-<amb> (authorizer-appsync-<amb>)
```

---

## 0. Antes de empezar

### 0.1 Trámites que tardan: arráncalos primero

| Trámite | Quién | Para qué |
|---|---|---|
| **Número de WhatsApp de Twilio del ambiente** y su sender aprobado | Quien administra Twilio | Cada ambiente tiene **su propia cuenta de Twilio** y su número. No reuses el de dev: un sender tiene un solo webhook, y dev dejaría de recibir |
| **Plantilla de la oferta aprobada** por WhatsApp en esa cuenta (Content SID `HX…`) | Quien administra Twilio | Sin plantilla, el envío de la oferta queda *Fallido* |
| **Cliente OAuth de Google** del ambiente (`hub-conversaciones-<amb>`) | Tú, en Google Cloud Console | Inicio de sesión de la web y audiencia del authorizer |
| **Deployment de Abacus** del bot de Valuación para el ambiente | Tú, en Abacus | El bot que contesta en ese ambiente |
| **Base de datos y PostgREST** del ambiente | Quien administra la base | Ver sección 2 |
| **Valuación** (`toma-unidades-en-taller`) desplegado en el ambiente: schema `valuacion`, su Lambda y ofertas para probar | Equipo de Valuación | Sin ofertas no hay nada que enviar |

### 0.2 Valores del ambiente

Llena la columna antes de empezar; los pasos los usan. La columna de dev es de referencia.

| Valor | dev (referencia) | `<amb>` |
|---|---|---|
| Cuenta de AWS / región | `807746362931` / `us-east-1` | QA: `807746362931` (la de dev, compartida) · prd: `386458449724` |
| Perfil de AWS CLI | el de la cuenta de dev | |
| VPC, subnets y security group de las Lambdas | los de `hub-entry-point-dev` (`vpc-9edb67e4`) | QA: los mismos que dev (se configuran en la consola de cada Lambda, ver 4) · prd: `vpc-562fec33` |
| URL de PostgREST (`URL_API_DB`) | `http://ec2-3-89-235-189.compute-1.amazonaws.com:3000/` | QA: EC2 `ec2-100-25-32-68.compute-1.amazonaws.com` (IP elástica `100.25.32.68`, misma VPC que dev). En las Lambdas, la **IP privada** de esa instancia: `http://<ip privada>:3000/`. En el API Gateway, el nombre público |
| Rol de las Lambdas del hub | `cleber-hub-lambdas-dev` | `cleber-hub-lambdas-<amb>` |
| Rol de los authorizers | el de `authorizer-google-dev` | |
| API Gateway del hub (id / stage) | `4ebqh3k28i` / `dev` | |
| Secreto del ambiente | `hub/dev/entorno` | `hub/<amb>/entorno` |
| Cola | `hub-entrantes-dev.fifo` | `hub-entrantes-<amb>.fifo` |
| AppSync Events | `hub-eventos-dev` | `hub-eventos-<amb>` |
| Lambda de Valuación | `toma-unidades-en-taller-api-dev` | |
| Cliente OAuth de Google | `hub-conversaciones-dev` | `hub-conversaciones-<amb>` |
| URL de la web | Vercel de dev | |

**QA comparte la cuenta de AWS de dev** (`807746362931`, decisión del 23 de noviembre de 2026): todo lleva el sufijo `-qa` (Lambdas, colas, secretos, roles, AppSync, authorizers) y el API Gateway del hub se crea como uno nuevo (`API CLEBER - Hub Conversaciones QA`) para no mezclar stages ni API keys con dev. Ojo al desplegar: el perfil de AWS es el mismo que el de dev, así que lo único que separa los ambientes es el `<amb>` del comando.

### 0.3 Nombres

| Recurso | Nombre |
|---|---|
| Lambdas del hub | `hub-entry-point-<amb>`, `hub-acciones-usuario-<amb>`, `hub-router-<amb>`, `hub-msj-entrantes-<amb>` |
| Authorizers | `authorizer-google-<amb>` y `authorizer-appsync-<amb>`; en prd sin sufijo (`authorizer-google`, `authorizer-appsync`) |
| Secretos | `hub/<amb>/entorno` (y el prefijo `hub/<amb>` para números y bots) |

---

## 1. Código

1. Rama del ambiente. Propuesta: una rama `qa` que se actualiza desde `dev` con merge, y `main` para producción.
   ```powershell
   git checkout dev; git pull
   git checkout -b qa      # la primera vez; después: git checkout qa; git merge dev
   git push -u origin qa
   ```
2. Pruebas antes de desplegar. Todas deben pasar:
   ```powershell
   python -m pytest -q
   cd infra\authorizer-google;  node --test; cd ..\..
   cd infra\authorizer-appsync; node --test; cd ..\..
   cd apps\web; npm ci; npm run typecheck; npm run build; cd ..\..
   ```
3. Requisitos de la máquina: Python 3.12 con pip, Node.js 24, AWS CLI v2 con sesión en la cuenta del ambiente (`aws sts get-caller-identity` debe mostrar la cuenta correcta) y `psql`.

---

## 2. Base de datos

Los scripts los corres tú con `psql`. Los grants los das tú, como en dev.

### 2.1 Requisitos, en este orden

| # | Schema | De dónde | Para qué |
|---|---|---|---|
| 1 | `cleber` | repo `api`, `DB/Cleber` | `construye_respuesta_exitosa` / `construye_respuesta_fallida` |
| 2 | `clientes` | `toma-unidades-en-taller`, `DB/Clientes` | `clientes.normaliza_telefono` |
| 3 | `hub_cleber` | este repo, `DB/Hub` | El hub |
| 4 | `valuacion` | `toma-unidades-en-taller`, `DB/Valuacion` y sus migraciones (incluida `001_vobo_margen_ajuste.sql`) | Valuación. Usa `hub_cleber.usuarios_contexto` y `hub_cleber.emails_con_rol`: va **después** del hub. Confirma el orden con el README de ese repo |

### 2.2 Alta del hub

En una base nueva **no hacen falta** las migraciones de `DB/Hub/Migraciones` (las tablas ya nacen con esas columnas):

```powershell
cd DB\Hub
psql -h <host> -p <puerto> -U <usuario> -d <database> -f Alta_db.sql -q
cd ..\..
```

En una base que ya tenía el hub (p. ej. al **actualizar** QA después), primero las migraciones nuevas, en orden, y después `Alta_db.sql`:

```powershell
psql ... -f Migraciones\00X_<nombre>.sql -q
psql ... -f Alta_db.sql -q
```

### 2.3 Pruebas de la base (solo QA)

Corren dentro de una transacción con `ROLLBACK`: no dejan datos. **No las corras en producción.**

```powershell
cd DB\Hub
psql ... -f Pruebas\pruebas_flujo.sql -q
psql ... -f Pruebas\pruebas_conversaciones.sql -q
cd ..\..
```

### 2.4 Grants y PostgREST

- Ejecución de las funciones de `hub_cleber` (y de `valuacion`) para el rol de PostgREST, como en dev. Incluye `hub_cleber.autoriza_canal(jsonb)`, que usa el tiempo real.
- PostgREST del ambiente con `hub_cleber` y `valuacion` en sus schemas expuestos. Recarga su caché de schema después de cada `Alta_db.sql`.

### 2.5 Primer super admin

Una base nueva solo tiene los usuarios de sistema. Para entrar y dar de alta todo desde las pantallas:

```powershell
psql ... -v email=<tu correo de Google> -f dev\alta_super_admin.sql
```

### 2.6 Valuación autoriza al hub

En `valuacion`, el usuario `sistema@hub-conversaciones.internal` debe tener permiso de sistema (`valuacion.exige_permiso(..., 'sistema')`). Sin eso, los eventos ③ fallan con `SIN_PERMISO` (`turno.evento_error` en los registros). Lo configura el equipo de Valuación.

### 2.7 QA arranca vacío: solo el super admin

En QA no se precarga nada de usuarios, marcas, agencias, equipos, números ni bots: todo se da de alta desde las pantallas (sección 8), como en producción.

**Lo que sí trae `Alta_db.sql`** (es catálogo, no datos de negocio, y el hub no funciona sin él):
- `hub_cleber.roles_modulo`: los 10 roles de Ventas, Servicio y Valuación.
- Los dos usuarios de sistema (`sistema@hub-conversaciones.internal` y `sistema@toma-unidades.internal`), que usan las Lambdas.

**Lo que no se debe correr en QA:**

| Script | Por qué no |
|---|---|
| `dev/carga_usuarios_hub.py` y el `carga_hub.sql` que genera | Copia usuarios y marcas de Firestore (dev) |
| `dev/cambia_rol.sql` | Cambia el rol de un usuario para probar permisos: es solo de dev |
| `dev/seed.py`, `dev/migrate_secrets.py` | Son del hub anterior en GCP |
| `dev/alta_numero_valuacion.sql` y `dev/alta_bot_valuacion.sql` | Solo si las pantallas del paso 8 no están disponibles, y después de crear la marca |
| `DB/Hub/Pruebas/*.sql` **al final** | Corren con `ROLLBACK`, pero córrelas **antes** de crear el super admin y revisa el conteo de abajo |

**La base de QA es una base distinta a la de dev** (confirmado el 23 de noviembre de 2026; en producción también va una propia). Si el PostgREST de QA apuntara a la misma base que dev, QA tendría todos sus datos. Antes del alta, verifica que estás conectado a la correcta:

```sql
SELECT current_database(), inet_server_addr();
```

El nombre de la base no debe ser `db_dev_01` (o el de dev).

**Verificar que quedó vacía**, después del super admin (2.5):

```sql
SELECT 'usuarios'               AS tabla, count(*) FROM hub_cleber.usuarios
UNION ALL SELECT 'roles_modulo',          count(*) FROM hub_cleber.roles_modulo
UNION ALL SELECT 'marcas',                count(*) FROM hub_cleber.marcas
UNION ALL SELECT 'usuarios_marcas',       count(*) FROM hub_cleber.usuarios_marcas
UNION ALL SELECT 'usuarios_roles_modulo', count(*) FROM hub_cleber.usuarios_roles_modulo
UNION ALL SELECT 'equipos',               count(*) FROM hub_cleber.equipos
UNION ALL SELECT 'bots',                  count(*) FROM hub_cleber.bots
UNION ALL SELECT 'numeros',               count(*) FROM hub_cleber.numeros
UNION ALL SELECT 'conversaciones',        count(*) FROM hub_cleber.conversaciones
UNION ALL SELECT 'mensajes',              count(*) FROM hub_cleber.mensajes
UNION ALL SELECT 'bitacora',              count(*) FROM hub_cleber.bitacora
UNION ALL SELECT 'notas',                 count(*) FROM hub_cleber.notas;
```

| Tabla | Debe dar |
|---|---|
| `usuarios` | **3** (2 de sistema y el super admin) |
| `roles_modulo` | **10** |
| Todas las demás | **0** |

```sql
SELECT email, es_super_admin, es_sistema FROM hub_cleber.usuarios ORDER BY es_sistema, email;
```

Debe mostrar exactamente tu correo como super admin y los dos `.internal` como sistema.

**Agencias:** el hub no las guarda ni las precarga; la pantalla las lee del API de agencias (`CLEBER_API_DB_URL` en Vercel). Lo que se vea en QA es lo que ese API devuelva. La configuración por agencia de Valuación (`valuacion.configuraciones_agencias`, margen y VoBo) vive en el schema `valuacion`: que también quede vacía lo cubre la guía de Valuación.

**Probar:** PostgREST responde como el sistema del hub.
```powershell
curl.exe -s -X POST "<URL_API_DB>/rpc/consulta_usuario_actual" -H "Content-Type: application/json" `
  -H "Content-Profile: hub_cleber" -H "Prefer: params=single-object" -H "X-User-Email: <tu correo>" -d "{}"
```
Debe regresar `successful: true` con tu usuario y `esSuperAdmin: true`.

---

## 3. AWS: identidad y secreto

### 3.1 Roles de IAM

| Rol | Políticas |
|---|---|
| `cleber-hub-lambdas-<amb>` | `AWSLambdaBasicExecutionRole`, `AWSLambdaVPCAccessExecutionRole` (si van en VPC), `secretsmanager:GetSecretValue` sobre `hub/<amb>/*`. La de SQS (3.4) y la de AppSync (sección 5) se agregan después |
| Rol de los authorizers | Solo `AWSLambdaBasicExecutionRole`. Los authorizers van **sin VPC** (salen a internet por las llaves de Google) |

**Red de las Lambdas del hub:** si van en VPC (para llegar a PostgREST por la red interna), las subnets necesitan **salida a internet por NAT**: llaman a Twilio, Abacus, AppSync y el correo.

**En QA:** el EC2 de PostgREST de QA está en la misma VPC que dev (`vpc-9edb67e4`), así que las Lambdas de QA usan las mismas subnets y security group que `hub-entry-point-dev`. Los ves en la consola de esa Lambda: *Configuration → VPC*. Como la instancia está en la VPC, `URL_API_DB` va con su **IP privada** (EC2 → la instancia → Networking → Private IPv4): el tráfico no sale a internet y no depende de la IP pública.

### 3.2 Secreto `hub/<amb>/entorno`

Secrets Manager → *Store a new secret* → *Other type of secret* → JSON plano:

| Llave | Valor |
|---|---|
| `TWILIO_ACCOUNT_SID` | Cuenta de Twilio del ambiente |
| `TWILIO_AUTH_TOKEN` | Token de esa cuenta (envío y firma del webhook) |
| `ABACUS_API_KEY` | Llave de API de la organización de Abacus |
| `ABACUS_DEPLOYMENT_TOKEN_VALUACION` | Token del deployment del bot de Valuación del ambiente |
| `CLEBER_API_KEY` | `x-api-key` de PostgREST, si la ruta la pide (vacía si no) |
| `INVITE_EMAIL_WEBHOOK_URL` | URL de `Cleber.enviarEmail` del ambiente (correos de invitación) |
| `INVITE_EMAIL_API_KEY` | Su `x-api-key`, si la pide |
| `APPSYNC_EVENTS_URL` | Se agrega en la sección 5: `https://<id>.appsync-api.<región>.amazonaws.com/event` |

Las Lambdas leen el secreto **al arrancar**: después de cambiarlo, vuelve a desplegar o espera a que se renueven las instancias.

### 3.3 Variables de las Lambdas

Los scripts de despliegue solo reciben el ARN del rol (sección 4). **Las variables y la VPC se configuran en la consola**, en cada Lambda: *Configuration → Environment variables* y *Configuration → VPC*. Al crear la función, el script fija por su cuenta `SECRETOS_EN=aws` y `SECRETOS_PREFIJO=hub/<amb>`; en una función que ya existe no toca nada de esto.

Comunes a las cuatro Lambdas:

| Variable | Valor |
|---|---|
| `SECRET_NAME` | `hub/<amb>/entorno` |
| `SECRETOS_EN` | `aws` (ya la pone el script) |
| `SECRETOS_PREFIJO` | `hub/<amb>` (ya la pone el script) |
| `URL_API_DB` | PostgREST del ambiente (en QA, la IP privada: `http://<ip privada>:3000/`) |
| `AMBIENTE` | `qa` en QA · **`prd` en producción (obligatoria)**. Fuera de `prd`, quien envía una oferta elige el teléfono de prueba o el cliente |

Propias:

| Lambda | Variable | Valor |
|---|---|---|
| `hub-router-<amb>` | `COLA_ENTRANTES_URL` | URL de `hub-entrantes-<amb>.fifo` |
| `hub-router-<amb>` | `PUBLIC_BASE_URL` | Invoke URL del stage del API del hub, sin barra final ni `/webhook/twilio` (p. ej. `https://<id>.execute-api.us-east-1.amazonaws.com/qa`). Se pone después de la sección 6, cuando el API ya existe |
| `hub-msj-entrantes-<amb>` | `LOG_CONTENIDO` | `true` durante las pruebas de QA para ver los textos; apagada en producción |

**VPC** de las cuatro (como en dev): la VPC, las subnets y el security group de `hub-entry-point-dev`. Las subnets necesitan salida por NAT.

### 3.4 Cola SQS (una sola vez)

1. **DLQ** `hub-entrantes-<amb>-dlq.fifo`: FIFO, retención 14 días.
2. **Cola** `hub-entrantes-<amb>.fifo`: FIFO, visibilidad **330 s**, retención 4 días, deduplicación por contenido **apagada**, *High throughput FIFO* encendido, DLQ la anterior con **3** recepciones máximas.
3. Política en línea `policy-hub-<amb>-sqs` en `cleber-hub-lambdas-<amb>`: la de `dev/DEPLOY_AWS.md` §5, con la cuenta y el nombre de la cola del ambiente.

---

## 4. AWS: Lambdas del hub

**1. Crear las cuatro Lambdas.** Cada comando recibe solo el ARN del rol. Crea la función con el código, el handler, el tiempo y la memoria de la tabla de `dev/DEPLOY_AWS.md`, y sin variables propias ni VPC (esas van en el paso 2):

```powershell
$p = '-Perfil', '<perfil>'   # o quita -Perfil si usas el perfil por omisión
$rol = 'arn:aws:iam::<cuenta>:role/cleber-hub-lambdas-<amb>'

.\dev\deploy_aws.ps1 entry-point <amb> @p -RolArn $rol
.\dev\deploy_aws.ps1 acciones-usuario <amb> @p -RolArn $rol
.\dev\deploy_aws.ps1 msj-entrantes <amb> @p -RolArn $rol
.\dev\deploy_aws.ps1 router <amb> @p -RolArn $rol
```

En `prd` el script pide escribir `prd` para confirmar.

**2. Configurar cada Lambda en la consola** (Lambda → la función → *Configuration*):

| Pestaña | Qué poner |
|---|---|
| **Environment variables** | Las de la sección 3.3 (comunes, y las propias de cada una). Falta `PUBLIC_BASE_URL` del router hasta la sección 6 |
| **VPC** | *Edit*: la VPC, las subnets y el security group de 3.3. El rol necesita `AWSLambdaVPCAccessExecutionRole` (3.1) o no deja guardar |

**3. Disparador de la cola:** `hub-msj-entrantes-<amb>` → *Configuration → Triggers → Add trigger → SQS*: cola `hub-entrantes-<amb>.fifo`, **Batch size = 1**, **Report batch item failures** encendido, *Enabled*.

Después, para subir código nuevo basta con el comando sin `-RolArn` (sección 10): actualiza el código y deja intactas las variables y la VPC.

**Probar:** en la consola de Lambda, cada función existe con su handler, arm64, Python 3.12, las variables de 3.3 y la VPC. Un *Test* con evento `{}` sobre `hub-entry-point-<amb>` debe regresar `successful: false` con un error de validación del contrato. Si regresa `CONFIGURACION`, la función no pudo leer el secreto o sus variables (ver su log).

---

## 5. AWS: tiempo real

Detalle en `GUIA_TIEMPO_REAL.md`. Resumen:

1. **Authorizer de AppSync:**
   ```powershell
   cd infra\authorizer-appsync
   .\deploy.ps1 <amb> @p -RolArn <rol de los authorizers>
   cd ..\..
   ```
   Variables, en la consola (*Configuration → Environment variables*): `GOOGLE_CLIENT_IDS` (el client id del ambiente), `ALLOWED_EMAIL_DOMAINS` (igual que el authorizer de Google), `NAMESPACES` = `{"hub":{"schema":"hub_cleber","accion":"Hub.autorizaCanal"}}`, `URL_API_DB`, `CLEBER_API_KEY` si aplica, `TTL_SEGUNDOS` = `300`. Esta Lambda va sin VPC.
2. **API de AppSync Events** `hub-eventos-<amb>`: modos AWS_IAM y AWS_LAMBDA (con `authorizer-appsync-<amb>`), sin API_KEY. Conexión y suscripción por AWS_LAMBDA, publicación por AWS_IAM. Namespace `hub`.
3. **Permiso** `appsync:EventPublish` sobre `arn:aws:appsync:<región>:<cuenta>:apis/<apiId>/channelNamespace/hub` en `cleber-hub-lambdas-<amb>`.
4. **Secreto:** agrega `APPSYNC_EVENTS_URL` a `hub/<amb>/entorno` y vuelve a desplegar las cuatro Lambdas (`.\dev\deploy_aws.ps1 <función> <amb> @p`) para que lo lean.
5. Anota el host HTTP (`<id>.appsync-api.<región>.amazonaws.com`) para la web.

---

## 6. AWS: API Gateway del hub

Detalle en `GUIA_API_HUB_CONVERSACIONES.md` (pasos 1 a 7) y `GUIA_API_GATEWAY.md` (paso 1).

1. **API** REST regional `API CLEBER - Hub Conversaciones QA` en QA (comparte cuenta con dev); `API CLEBER - Hub Conversaciones` en producción.
2. **Authorizer de Google:**
   ```powershell
   cd infra\authorizer-google
   .\deploy.ps1 <amb> @p -RolArn <rol de los authorizers>
   cd ..\..
   ```
   Variables, en la consola (*Configuration → Environment variables*): `GOOGLE_CLIENT_IDS` (el client id del ambiente) y `ALLOWED_EMAIL_DOMAINS` (opcional, p. ej. `cleber.com`). **Mientras `GOOGLE_CLIENT_IDS` no exista, el authorizer rechaza todo.** El permiso para que el API lo invoque lo ofrece la consola al guardar el authorizer; si no, `aws lambda add-permission` de `GUIA_API_HUB_CONVERSACIONES.md` paso 2.
   En el API: authorizer `google-id-token-<amb>`, tipo Lambda, payload **Token**, token source `X-Id-Token`, validación `^[-0-9A-Za-z\._]+$`, caché 300 s.
3. **Rutas:**

   | Ruta | Integración | Seguridad |
   |---|---|---|
   | `/hub-cleber/{proxy+}` POST | HTTP proxy a `<PostgREST>/{proxy}` (QA: `http://ec2-100-25-32-68.compute-1.amazonaws.com:3000/{proxy}`, integración HTTP directa como en dev); headers `X-User-Email` ← `context.authorizer.email`, `Content-Profile` y `Accept-Profile` = `'hub_cleber'` | Authorizer + API key |
   | `/toma-unidades/{proxy+}` POST | Igual, con `'valuacion'` | Authorizer + API key |
   | `/toma-unidades-acciones` POST | Lambda proxy → Lambda de Valuación del ambiente | Authorizer + API key |
   | `/hub-acciones` POST | Lambda proxy → `hub-acciones-usuario-<amb>` | Authorizer + API key |
   | `/webhook/{proveedor}` POST | Lambda proxy → `hub-router-<amb>` | **NONE**, sin API key (valida la firma de Twilio) |

4. **Deploy API** al stage `<amb>`. Cada cambio de recursos o métodos requiere volver a desplegar.
5. **Usage plan** `hub-conversaciones-<amb>` con el stage, y API key `hub-conversaciones-dashboard-<amb>` asociada.

**Riesgo conocido en QA (S1):** el security group de PostgREST admite `0.0.0.0/0` en el puerto 3000, así que alguien que conozca la URL puede llamarlo sin pasar por el API Gateway ni el authorizer y mandar el `X-User-Email` que quiera. En QA se acepta mientras solo haya datos de prueba y teléfonos propios. **No cargues clientes reales en QA** mientras siga abierto. Se cierra con el pendiente I1 de `PENDIENTES_INFRA_DEV.md` (NLB interno + VPC Link) y es requisito antes de producción.

**Valuación necesita** (lo hace su equipo): variable `HUB_ENTRY_POINT` = `hub-entry-point-<amb>` en su Lambda, y en su rol `lambda:InvokeFunction` sobre `arn:aws:lambda:<región>:<cuenta>:function:hub-entry-point-<amb>`.

**Probar:**
```powershell
$u = "https://<id del API>.execute-api.<región>.amazonaws.com/<amb>"
# Sin API key → 403 Forbidden
curl.exe -i -X POST "$u/hub-cleber/rpc/consulta_usuario_actual" -H "Content-Type: application/json" -d "{}"
# Con API key y sin token → 401 Unauthorized
curl.exe -i -X POST "$u/hub-cleber/rpc/consulta_usuario_actual" -H "Content-Type: application/json" -H "x-api-key: <key>" -d "{}"
# Webhook sin firma → 403 Forbidden (el router responde y rechaza la falta de firma)
curl.exe -i -X POST "$u/webhook/twilio" -d "Body=hola"
```
En el webhook, `Missing Authentication Token` = la ruta no está desplegada; 500 = revisar el log de `hub-router-<amb>`.

---

## 7. Web en Vercel

1. **Proyecto:** el de la web (raíz `apps/web`). QA es el ambiente **Preview** ligado a la rama `qa` (ya configurado), con variables solo para esa rama. Su URL fija (`<proyecto>-git-qa-<equipo>.vercel.app`) es la que va en el cliente OAuth. Producción es el ambiente **Production** (rama `main`).
2. **Cliente OAuth** `hub-conversaciones-<amb>`: origen `https://<url de la web>` y redirección `https://<url de la web>/api/auth/callback/google`.
3. **Variables** (Settings → Environment Variables, en el ambiente y la rama que correspondan):

   | Variable | Valor |
   |---|---|
   | `NEXT_PUBLIC_AMBIENTE` | `qa` · **`prd` solo en producción** |
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Del cliente OAuth del ambiente |
   | `AUTH_SECRET` | Uno nuevo por ambiente: `[Convert]::ToBase64String((1..32 \| ForEach-Object { Get-Random -Maximum 256 }))` |
   | `API_GATEWAY_URL` | `https://<id del API>.execute-api.<región>.amazonaws.com/<amb>` |
   | `API_GATEWAY_KEY` | La key `hub-conversaciones-dashboard-<amb>` |
   | `NEXT_PUBLIC_APPSYNC_EVENTS_HOST` | Host HTTP de `hub-eventos-<amb>` |
   | `CLEBER_API_DB_URL` / `CLEBER_API_DB_KEY` | API de agencias del ambiente (equipo del API de Cleber) |
   | `ABACUS_API_KEY` | La de Abacus (pestaña ChatLLM de la pantalla de Bots) |
   | `DEMO_VALUACION` | Vacía |

   Las `NEXT_PUBLIC_*` se fijan al compilar: si cambian, vuelve a desplegar.
4. **Desplegar** con un push a la rama (`git push origin qa`). Las Lambdas van **antes o junto** con la web: una Lambda vieja responde `ACCION_INVALIDA` a las acciones del asesor.

**Probar:** entras con Google y ves el hub vacío como super admin. En DevTools → Network → WS hay conexión a `appsync-realtime-api` con `connection_ack`.

---

## 8. Configuración desde las pantallas (como super admin)

En este orden:

1. **Marca** (p. ej. `TO`, Toyota).
2. **Usuarios:** invita a quienes van a probar, con su rol de Valuación (`ADMINISTRADOR`, `GERENTE`, `VALUADOR`, `CONSULTA`), sus agencias y su equipo. Debe llegar el correo de invitación.
3. **Equipo de Valuación** de la marca, con su modo de asignación (round robin o menos ocupado) y sus valuadores.
4. **Número de WhatsApp:** el del ambiente, proveedor Twilio, con el equipo. En la plantilla, el Content SID de la oferta. **Consultar** debe mostrar la vista previa de la plantilla (prueba la cuenta de Twilio del secreto).
5. **Bot** (Valuación → Administración → Bots):
   - Crear con el **Deployment ID** del ambiente.
   - Pestaña Avanzado → "Acciones de clasificación de motivo": `oferta_aceptada_venta, oferta_aceptada_venta_y_compra, oferta_rechazada, contacto_futuro`.
   - En **WhatsApp**, ponerlo como bot por defecto del número.
   - Si las pantallas aún no están, `dev/alta_numero_valuacion.sql` y `dev/alta_bot_valuacion.sql` hacen lo mismo.
6. **Configuración de agencias** de Valuación: margen de ajuste (± $15,000) y quién da el VoBo.

**Bot en Abacus** (`instrucciones_bot_valuacion.md`, pasos 1 a 5): base de conocimiento `conocimiento_bot_valuacion.md`, bloques 2.1 y 2.2, herramienta `Ejecutar_Accion_Externo`, y el deployment cuyo token va en `ABACUS_DEPLOYMENT_TOKEN_VALUACION`.

**Twilio:** en el sender del ambiente, *Webhook URL for incoming messages* = `https://<id del API>.execute-api.<región>.amazonaws.com/<amb>/webhook/twilio`, método **HTTP Post**, sin Messaging Service asociado.

---

## 9. Pruebas de punta a punta

Con `LOG_CONTENIDO=true` en `hub-msj-entrantes-<amb>`. Usa dos navegadores: uno como administrador o gerente y otro como valuador del equipo.

| # | Prueba | Qué debe pasar |
|---|---|---|
| 1 | Entrar con un usuario invitado | Entra y ve solo su marca, su módulo y sus agencias |
| 2 | Ofertas → **Enviar**, eligiendo tu teléfono de prueba | Llega la plantilla a WhatsApp; la oferta queda enviada |
| 3 | Contestar por WhatsApp con una duda | El bot responde con el nombre del cliente y su vehículo (`turno.bot_llamada ... preambulo=True`) |
| 4 | Preguntas de la base y de la sección 4 de `instrucciones_bot_valuacion.md` | Responde con la base; documentos, tal cual |
| 5 | "Sí me interesa" | Se clasifica `oferta_aceptada_venta` y Valuación lo registra (`turno.evento_enviado`) |
| 6 | "Quiero vender y comprar uno nuevo" | Se clasifica `oferta_aceptada_venta_y_compra` y pasa a asesor |
| 7 | Pregunta fuera de la base | Mensaje literal de paso a asesor; la conversación pasa a espera y se asigna según el equipo |
| 8 | Tiempo real | La bandeja y el chat del otro navegador se actualizan en menos de un segundo; suena el aviso de asignación y de mensaje nuevo |
| 9 | El valuador responde, devuelve al bot, cierra | Llega al cliente; al cerrar se elige el estatus de la oferta |
| 10 | Un valuador de otro equipo | No ve la conversación (y `subscribe_error` en WS si intenta) |
| 11 | Monto fuera del margen | La oferta queda pendiente de VoBo, llega el correo al gerente; al autorizar se puede enviar |
| 12 | Conversación con más de 24 h sin mensaje del cliente | El envío del valuador se bloquea con aviso en pantalla |
| 13 | Baja de un usuario (super admin) | Ya no entra ni recibe asignaciones |

**Registros** (CloudWatch Logs Insights sobre `/aws/lambda/hub-msj-entrantes-<amb>`):
```
fields @timestamp, @message | filter @message like /conv=<idConversacion>/ | sort @timestamp asc
```
La tabla de síntomas de `dev/DEPLOY_AWS.md` §7 aplica igual cambiando `dev` por `<amb>`.

---

## 10. Actualizar un ambiente ya montado

Cada vez que se sube una versión nueva:

1. `git checkout qa; git merge dev; git push` (en prd, el merge a `main`).
2. Pruebas de la sección 1.
3. Base: migraciones nuevas de `DB/Hub/Migraciones` (las que no se hayan corrido), después `Alta_db.sql`, después los grants de funciones nuevas y la recarga de PostgREST. Lo mismo con las migraciones de Valuación.
4. Lambdas: las cuatro, o solo las que cambiaron (tabla "Qué desplegar" de `dev/DEPLOY_AWS.md` §1):
   ```powershell
   foreach ($f in 'entry-point','acciones-usuario','router','msj-entrantes') { .\dev\deploy_aws.ps1 $f <amb> @p }
   ```
5. Authorizers, solo si cambiaron (`infra\authorizer-*\deploy.ps1 <amb>`).
6. Web: sale sola con el push de la rama.
7. Si cambió el bot: volver a cargar la base y las instrucciones en Abacus.
8. Repetir las pruebas de la sección 9 que toquen lo que cambió.

---

## 11. Diferencias para producción

| Tema | En producción |
|---|---|
| Base | `Alta_db.sql` y migraciones **con aprobación explícita**. Sin `Pruebas/`. Respaldo antes de cada actualización |
| PostgREST | Solo privado: el API Gateway por **VPC Link** (`g55dvn` → NLB) y las Lambdas por VPC. Nada abierto a internet (pendientes S1 a S3 e I1 de `PENDIENTES_INFRA_DEV.md` resueltos antes de copiar el patrón) |
| `AMBIENTE` | `prd` en las cuatro Lambdas. Sin ella, rechazan los envíos (`DESTINO_REQUERIDO`) |
| `NEXT_PUBLIC_AMBIENTE` | `prd` en Vercel Production: **Enviar** manda al cliente en automático |
| `LOG_CONTENIDO` | Apagada (son datos personales) |
| Twilio | Número y plantilla de cada marca piloto, aprobados |
| Abacus | Un deployment por marca, con la base de conocimiento final |
| Alarmas | CloudWatch: mensajes en la DLQ, errores de `hub-msj-entrantes`, `hub-router` y `hub-entry-point` |
| Despliegues | Los scripts piden escribir `prd`. Prueba primero la misma versión en QA |
| Primer recorrido | Prueba 2 a 9 con un teléfono propio registrado como cliente de una oferta de prueba, antes de abrir a clientes reales |

---

## 12. Lista para marcar

- [ ] 0 · Twilio (cuenta, número, plantilla), OAuth, Abacus, base y Valuación del ambiente pedidos
- [ ] 1 · Rama y pruebas en verde
- [ ] 2 · `cleber`, `clientes`, `hub_cleber`, `valuacion`; grants; PostgREST; super admin; permiso del sistema del hub en Valuación
- [ ] 3 · Roles, secreto `hub/<amb>/entorno`, cola y DLQ
- [ ] 4 · Cuatro Lambdas y disparador de la cola
- [ ] 5 · Tiempo real (authorizer, AppSync, permiso, `APPSYNC_EVENTS_URL`)
- [ ] 6 · API Gateway, authorizer de Google, rutas, stage, API key; Valuación con `HUB_ENTRY_POINT`
- [ ] 7 · Vercel y cliente OAuth
- [ ] 8 · Marca, usuarios, equipo, número, bot, agencias; bot en Abacus; webhook en Twilio
- [ ] 9 · Pruebas de punta a punta
