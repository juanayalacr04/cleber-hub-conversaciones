# Montar el hub y Valuación en QA — paso a paso

**Fecha:** 23 de noviembre de 2026 · **Ambiente:** QA · **Cuenta AWS:** `807746362931` (compartida con dev) · **Región:** `us-east-1`

Una sola secuencia: haz los pasos **en orden** y no pases al siguiente sin la comprobación del actual. Todo lleva el sufijo `qa`. Los scripts de despliegue solo reciben el ARN del rol; **las variables de entorno, la VPC y los disparadores se configuran en la consola de AWS**. Los `GRANT` los das tú.

Marcado **(por confirmar)**: pasos de Valuación cuyo nombre exacto de script no está en este repo; se confirman en el README de `toma-unidades-en-taller`.

---

## Valores de QA

| Dato | Valor |
|---|---|
| Base de datos | Una base **propia de QA** (no la de dev) |
| PostgREST | EC2 `ec2-100-25-32-68.compute-1.amazonaws.com` · config en `/opt/postgrest/postgrest.conf` · IP privada: `<ip privada>` |
| VPC de las Lambdas | La de dev: `vpc-9edb67e4`, con las mismas subnets y security group que `hub-entry-point-dev` |
| Lambdas del hub | `hub-entry-point-qa`, `hub-acciones-usuario-qa`, `hub-msj-entrantes-qa`, `hub-router-qa` |
| Authorizers | `authorizer-google-qa`, `authorizer-appsync-qa` |
| Roles | `cleber-hub-lambdas-qa`, `cleber-hub-authorizers-qa` |
| Secreto | `hub/qa/entorno` |
| Cola | `hub-entrantes-qa.fifo` y `hub-entrantes-qa-dlq.fifo` |
| AppSync Events | `hub-eventos-qa` |
| API Gateway | `API CLEBER - Hub Conversaciones QA`, stage `qa` |
| Web | Vercel, ambiente Preview de la rama `qa` |

---

## Parte 0 — Antes de empezar

**0.1** Ten listo, porque algunos tardan:
- Cuenta de Twilio de QA, con su número de WhatsApp y la **plantilla de la oferta aprobada** (Content SID `HX…`). No uses el número de dev: un número tiene un solo webhook.
- Cliente OAuth de Google `hub-conversaciones-qa` (Google Cloud Console → proyecto `ambiente-desarrollo-ti` → Credenciales). Origen: `https://<url fija de la web en Vercel QA>`; redirección: `https://<url>/api/auth/callback/google`. Anota el **Client ID** y el **Client secret**.
- Deployment de Abacus del bot de Valuación para QA (token y llave).
- Valuación con su schema, su Lambda y ofertas de prueba para QA.

**0.2** Pruebas locales, desde la raíz del repo. Todas deben pasar:

```powershell
python -m pytest -q
cd infra\authorizer-google;  node --test; cd ..\..
cd infra\authorizer-appsync; node --test; cd ..\..
cd apps\web; npm ci; npm run typecheck; cd ..\..
```

**0.3** Verifica que la sesión de AWS es la cuenta correcta: `aws sts get-caller-identity` debe mostrar `807746362931`.

---

## Parte 1 — Base de datos

En PowerShell, con el cliente `psql`. Define la conexión una vez:

```powershell
$psql = '-h','<host>','-p','<puerto>','-U','<usuario>','-d','<base_qa>'
```

**1.** Confirma que estás en la base de QA y no en la de dev:
```powershell
psql @psql -c "SELECT current_database(), inet_server_addr();"
```
El nombre **no** debe ser `db_dev_01`.

**2.** Ejecuta el alta de `cleber` (repo `api`, `DB/Cleber`), solo si esa base aún no la tiene.
Comprobación: `psql @psql -c "SELECT to_regprocedure('cleber.construye_respuesta_exitosa(jsonb)');"` no regresa vacío.

**3.** Ejecuta el alta de `clientes` (`toma-unidades-en-taller`, `DB/Clientes`). **(por confirmar el script)**
Comprobación: `psql @psql -c "SELECT clientes.normaliza_telefono('8112345678');"` regresa `+528112345678`.

**4.** Ejecuta el alta del hub:
```powershell
cd DB\Hub
psql @psql -f Alta_db.sql -q
cd ..\..
```
Comprobación: termina sin errores. En una base nueva no corras `Migraciones/`.

**5.** (Solo QA, opcional) Pruebas SQL del hub. Corren con `ROLLBACK` y no dejan datos:
```powershell
cd DB\Hub
psql @psql -f Pruebas\pruebas_flujo.sql -q
psql @psql -f Pruebas\pruebas_conversaciones.sql -q
cd ..\..
```

**6.** Ejecuta el alta de `valuacion` y todas sus migraciones en orden, incluida `001_vobo_margen_ajuste.sql` (`toma-unidades-en-taller`, `DB/Valuacion`). Va **después** del hub. **(por confirmar scripts y orden)**
Comprobación: el script termina sin errores.

**7.** Agrega los schemas nuevos a PostgREST. En el EC2 de QA (Session Manager o SSH):
```bash
sudo cp /opt/postgrest/postgrest.conf /opt/postgrest/postgrest.conf.bak
sudo nano /opt/postgrest/postgrest.conf
```
Deja `db-schemas = "hub_cleber,valuacion"` (y los que ya tenga). Confirma que `db-uri` apunta a la base de QA y anota el valor de `db-anon-role`. Si el archivo se abre con el aviso de `vim` sobre un archivo de intercambio, sal con `Q`.
Luego reinicia PostgREST: mira antes cómo corre con `ps aux | grep [p]ostgrest` (guarda esa línea) y reinicia de la misma forma, o con `sudo systemctl restart postgrest` si es servicio.

**8.** **Tú das los `GRANT`** al `db-anon-role` del paso 7 sobre los schemas `cleber`, `clientes`, `hub_cleber` y `valuacion`. Compruébalos con estas consultas, cambiando `<rol>`:
```sql
SELECT s, has_schema_privilege('<rol>', s, 'USAGE') FROM unnest(ARRAY['cleber','clientes','hub_cleber','valuacion']) s;
SELECT n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('cleber','clientes','hub_cleber','valuacion') AND NOT has_function_privilege('<rol>', p.oid, 'EXECUTE');
SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN ('r','p') AND n.nspname IN ('hub_cleber','valuacion')
   AND NOT (has_table_privilege('<rol>',c.oid,'SELECT') AND has_table_privilege('<rol>',c.oid,'INSERT') AND has_table_privilege('<rol>',c.oid,'UPDATE'));
SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind='S' AND n.nspname IN ('hub_cleber','valuacion') AND NOT has_sequence_privilege('<rol>',c.oid,'USAGE');
```
Comprobación: el primero da `true` en los cuatro y los otros tres no regresan filas. Compara contra dev si dudas.

**9.** Crea el super admin (tu correo de Google):
```powershell
psql @psql -v email=<tu correo> -f dev\alta_super_admin.sql
```

**10.** Verifica que QA quedó vacía:
```sql
SELECT 'usuarios' t, count(*) FROM hub_cleber.usuarios
UNION ALL SELECT 'roles_modulo', count(*) FROM hub_cleber.roles_modulo
UNION ALL SELECT 'marcas', count(*) FROM hub_cleber.marcas
UNION ALL SELECT 'usuarios_marcas', count(*) FROM hub_cleber.usuarios_marcas
UNION ALL SELECT 'usuarios_roles_modulo', count(*) FROM hub_cleber.usuarios_roles_modulo
UNION ALL SELECT 'equipos', count(*) FROM hub_cleber.equipos
UNION ALL SELECT 'bots', count(*) FROM hub_cleber.bots
UNION ALL SELECT 'numeros', count(*) FROM hub_cleber.numeros
UNION ALL SELECT 'conversaciones', count(*) FROM hub_cleber.conversaciones
UNION ALL SELECT 'mensajes', count(*) FROM hub_cleber.mensajes
UNION ALL SELECT 'bitacora', count(*) FROM hub_cleber.bitacora
UNION ALL SELECT 'notas', count(*) FROM hub_cleber.notas;
```
Comprobación: `usuarios` = **3** (2 de sistema y tú), `roles_modulo` = **10**, todo lo demás **0**.
**No corras en QA:** `dev/carga_usuarios_hub.py`, `dev/cambia_rol.sql`, `dev/seed.py` ni `dev/migrate_secrets.py`.

**11.** Que Valuación autorice al usuario de sistema del hub (`sistema@hub-conversaciones.internal`) con permiso de sistema en `valuacion`, y que su schema quede sin datos de negocio precargados. **(por confirmar el script)**

**12.** Prueba que PostgREST responde con la identidad del sistema:
```powershell
curl.exe -s -X POST "http://ec2-100-25-32-68.compute-1.amazonaws.com:3000/rpc/consulta_usuario_actual" -H "Content-Type: application/json" -H "Content-Profile: hub_cleber" -H "Prefer: params=single-object" -H "X-User-Email: <tu correo>" -d "{}"
```
Comprobación: `successful: true`, con `esSuperAdmin: true`. Si da `42501`, falta un `GRANT` (vuelve al paso 8).

---

## Parte 2 — AWS: identidad y secreto

**13.** IAM → Roles → crea los dos roles (consola):

| Rol | Políticas |
|---|---|
| `cleber-hub-lambdas-qa` | `AWSLambdaBasicExecutionRole`, `AWSLambdaVPCAccessExecutionRole` y una política en línea con `secretsmanager:GetSecretValue` sobre `arn:aws:secretsmanager:us-east-1:807746362931:secret:hub/qa/*` |
| `cleber-hub-authorizers-qa` | `AWSLambdaBasicExecutionRole` |

Anota los dos ARN.

**14.** Secrets Manager → *Store a new secret* → *Other type of secret* → nombre `hub/qa/entorno`, JSON plano:

| Llave | Valor |
|---|---|
| `TWILIO_ACCOUNT_SID` | Cuenta de Twilio de QA |
| `TWILIO_AUTH_TOKEN` | Su token |
| `ABACUS_API_KEY` | Llave de API de Abacus |
| `ABACUS_DEPLOYMENT_TOKEN_VALUACION` | Token del deployment de QA |
| `CLEBER_API_KEY` | `x-api-key` de PostgREST si la pide (si no, vacía) |
| `INVITE_EMAIL_WEBHOOK_URL` | URL de `Cleber.enviarEmail` de QA |
| `INVITE_EMAIL_API_KEY` | Su `x-api-key` si la pide |

`APPSYNC_EVENTS_URL` se agrega en el paso 19.

**15.** SQS → crea las colas (consola):
1. `hub-entrantes-qa-dlq.fifo`: FIFO, retención 14 días.
2. `hub-entrantes-qa.fifo`: FIFO, visibilidad **330 s**, retención 4 días, deduplicación por contenido **apagada**, *High throughput FIFO* encendido, DLQ la anterior con **3** recepciones máximas.

Después, IAM → `cleber-hub-lambdas-qa` → política en línea `policy-hub-qa-sqs`:
```json
{"Version":"2012-10-17","Statement":[
 {"Sid":"RouterPublica","Effect":"Allow","Action":"sqs:SendMessage",
  "Resource":"arn:aws:sqs:us-east-1:807746362931:hub-entrantes-qa.fifo"},
 {"Sid":"EntrantesConsume","Effect":"Allow",
  "Action":["sqs:ReceiveMessage","sqs:DeleteMessage","sqs:GetQueueAttributes","sqs:ChangeMessageVisibility"],
  "Resource":"arn:aws:sqs:us-east-1:807746362931:hub-entrantes-qa.fifo"}]}
```

---

## Parte 3 — AWS: tiempo real

**16.** Despliega el authorizer de AppSync:
```powershell
cd infra\authorizer-appsync
.\deploy.ps1 qa -RolArn <arn de cleber-hub-authorizers-qa>
cd ..\..
```
En la consola, Lambda `authorizer-appsync-qa` → *Configuration → Environment variables*:

| Variable | Valor |
|---|---|
| `GOOGLE_CLIENT_IDS` | Client ID del paso 0.1 |
| `ALLOWED_EMAIL_DOMAINS` | Igual que en el authorizer de Google (o vacía) |
| `NAMESPACES` | `{"hub":{"schema":"hub_cleber","accion":"Hub.autorizaCanal"}}` |
| `URL_API_DB` | `http://<ip privada>:3000/` |
| `CLEBER_API_KEY` | Si PostgREST la pide |
| `TTL_SEGUNDOS` | `300` |

Esta Lambda va **sin VPC**.

**17.** AppSync → *Create API* → **Event API**, nombre `hub-eventos-qa`:
- *Settings → Authorization*: agrega **AWS_IAM** y **AWS_LAMBDA** (con `authorizer-appsync-qa`); quita **API_KEY** si se creó.
- Modos por defecto: conexión **AWS_LAMBDA**, publicar **AWS_IAM**, suscribirse **AWS_LAMBDA**.
- Namespace `hub`: publicar en AWS_IAM, suscribirse en AWS_LAMBDA. Borra `default`.

**18.** Anota los endpoints (Settings → DNS endpoints): el **HTTP** `<id>.appsync-api.us-east-1.amazonaws.com` y el **ApiId**.

**19.** Agrega a `hub/qa/entorno` la llave `APPSYNC_EVENTS_URL` = `https://<id>.appsync-api.us-east-1.amazonaws.com/event`.
Y a `cleber-hub-lambdas-qa` una política en línea:
```json
{"Effect":"Allow","Action":"appsync:EventPublish",
 "Resource":"arn:aws:appsync:us-east-1:807746362931:apis/<apiId>/channelNamespace/hub"}
```

---

## Parte 4 — AWS: Lambdas del hub

**20.** Crea las cuatro Lambdas. Cada comando recibe **solo el ARN del rol**:
```powershell
$rol = '<arn de cleber-hub-lambdas-qa>'
.\dev\deploy_aws.ps1 entry-point qa -RolArn $rol
.\dev\deploy_aws.ps1 acciones-usuario qa -RolArn $rol
.\dev\deploy_aws.ps1 msj-entrantes qa -RolArn $rol
.\dev\deploy_aws.ps1 router qa -RolArn $rol
```
El script fija solo `SECRETOS_EN=aws` y `SECRETOS_PREFIJO=hub/qa`. Si usas un perfil de AWS, agrega `-Perfil <perfil>`.

**21.** En la consola, en **cada una** de las cuatro, *Configuration → Environment variables*:

| Variable | Valor | Lambdas |
|---|---|---|
| `SECRET_NAME` | `hub/qa/entorno` | las 4 |
| `URL_API_DB` | `http://<ip privada>:3000/` | las 4 |
| `AMBIENTE` | `qa` | las 4 |
| `COLA_ENTRANTES_URL` | URL de `hub-entrantes-qa.fifo` | `hub-router-qa` |
| `LOG_CONTENIDO` | `true` | `hub-msj-entrantes-qa` |

`PUBLIC_BASE_URL` del router se agrega en el paso 26, cuando el API ya existe.

**22.** En las cuatro, *Configuration → VPC → Edit*: la VPC `vpc-9edb67e4` con las **mismas subnets y security group** que `hub-entry-point-dev` (míralos en esa Lambda). Las subnets deben tener salida por NAT.

**23.** `hub-msj-entrantes-qa` → *Configuration → Triggers → Add trigger → SQS*: cola `hub-entrantes-qa.fifo`, **Batch size = 1**, **Report batch item failures** encendido, *Enabled*.

Comprobación (consola, *Test* con evento `{}` sobre `hub-entry-point-qa`): regresa `successful: false` con un error de validación del contrato. Si regresa `CONFIGURACION`, revisa el secreto y las variables.

---

## Parte 5 — AWS: Valuación y API Gateway

**24.** Despliega la Lambda de Valuación en QA con su `deploy.ps1`. **(por confirmar que acepta `qa`)** Configura en su consola:
- Variable `HUB_ENTRY_POINT` = `hub-entry-point-qa`.
- Su rol con `lambda:InvokeFunction` sobre `arn:aws:lambda:us-east-1:807746362931:function:hub-entry-point-qa`.
- Sus demás variables (PostgREST, `URL_EMAIL` del aviso de VoBo, etc.). **(por confirmar)**

**25.** Despliega el authorizer de Google:
```powershell
cd infra\authorizer-google
.\deploy.ps1 qa -RolArn <arn de cleber-hub-authorizers-qa>
cd ..\..
```
En su consola, variables: `GOOGLE_CLIENT_IDS` = Client ID del paso 0.1 y `ALLOWED_EMAIL_DOMAINS` (opcional). Sin `GOOGLE_CLIENT_IDS`, rechaza todo. Va sin VPC.

**26.** API Gateway → *Create API* → **REST API** regional `API CLEBER - Hub Conversaciones QA`:
1. *Authorizers → Create*: `google-id-token-qa`, tipo Lambda, función `authorizer-google-qa`, payload **Token**, token source `X-Id-Token`, validación `^[-0-9A-Za-z\._]+$`, caché 300 s. Acepta el permiso que ofrece la consola.
2. Crea las rutas, todas con método **POST**:

| Ruta | Integración | Seguridad |
|---|---|---|
| `/hub-cleber/{proxy+}` | HTTP proxy a `http://ec2-100-25-32-68.compute-1.amazonaws.com:3000/{proxy}`. Headers: `X-User-Email` ← `context.authorizer.email`; `Content-Profile` y `Accept-Profile` = `'hub_cleber'`. Path `proxy` ← `method.request.path.proxy`. Borra el método `ANY` que crea la consola | Authorizer + API key |
| `/toma-unidades/{proxy+}` | Igual, con `'valuacion'` | Authorizer + API key |
| `/toma-unidades-acciones` | Lambda proxy → la Lambda de Valuación de QA | Authorizer + API key |
| `/hub-acciones` | Lambda proxy → `hub-acciones-usuario-qa` | Authorizer + API key |
| `/webhook/{proveedor}` | Lambda proxy → `hub-router-qa` | **NONE**, API key apagada |

3. *Deploy API* → stage nuevo `qa`. Anota el **Invoke URL** (`https://<id>.execute-api.us-east-1.amazonaws.com/qa`).
4. *Usage plans*: `hub-conversaciones-qa` (rate 50, burst 100) asociado al stage `qa`. *API keys*: `hub-conversaciones-dashboard-qa` asociada al plan. Anota su valor.

Comprobación:
```powershell
$u = "https://<id>.execute-api.us-east-1.amazonaws.com/qa"
curl.exe -i -X POST "$u/hub-cleber/rpc/consulta_usuario_actual" -H "Content-Type: application/json" -d "{}"          # 403 Forbidden
curl.exe -i -X POST "$u/hub-cleber/rpc/consulta_usuario_actual" -H "Content-Type: application/json" -H "x-api-key: <key>" -d "{}"   # 401 Unauthorized
curl.exe -i -X POST "$u/webhook/twilio" -d "Body=hola"                                                                  # 403 Forbidden
```
Si el webhook da `Missing Authentication Token`, la ruta no está desplegada en el stage.

**27.** Agrega a `hub-router-qa` la variable `PUBLIC_BASE_URL` = el Invoke URL del paso 26 (sin barra final ni `/webhook/twilio`).

---

## Parte 6 — Web, Twilio y Abacus

**28.** Vercel → proyecto de la web → *Settings → Environment Variables*, para el ambiente Preview de la rama `qa`:

| Variable | Valor |
|---|---|
| `NEXT_PUBLIC_AMBIENTE` | `qa` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Del cliente OAuth de QA |
| `AUTH_SECRET` | Uno nuevo: `[Convert]::ToBase64String((1..32 \| ForEach-Object { Get-Random -Maximum 256 }))` |
| `API_GATEWAY_URL` | El Invoke URL del paso 26 |
| `API_GATEWAY_KEY` | La key `hub-conversaciones-dashboard-qa` |
| `NEXT_PUBLIC_APPSYNC_EVENTS_HOST` | `<id>.appsync-api.us-east-1.amazonaws.com` |
| `CLEBER_API_DB_URL` / `CLEBER_API_DB_KEY` | Un API de agencias **de pruebas** (si no, se ven las de producción) |
| `ABACUS_API_KEY` | La de Abacus |

**29.** Publica la web (esto dispara el deploy de Vercel de la rama `qa`):
```powershell
git push origin qa
```
Comprobación: entras con Google y ves el hub vacío como super admin. En DevTools → Network → WS hay conexión a `appsync-realtime-api` con `connection_ack`.

**30.** Twilio → el sender de WhatsApp de QA → *Webhook URL for incoming messages* = `https://<id>.execute-api.us-east-1.amazonaws.com/qa/webhook/twilio`, método **HTTP Post**, sin Messaging Service.

**31.** Abacus: crea el bot de Valuación siguiendo `abacus/docs/instrucciones_bot_valuacion.md` (pasos 1 a 5): base `conocimiento_bot_valuacion.md`, bloques 2.1 y 2.2 y la herramienta `Ejecutar_Accion_Externo`. Anota el **Deployment ID**.

---

## Parte 7 — Configuración desde las pantallas (como super admin)

**32.** En este orden:
1. **Marca** (p. ej. `TO`).
2. **Usuarios**: invita a quienes prueben, con rol de Valuación, agencias y equipo. Debe llegar el correo.
3. **Equipo de Valuación** de la marca, con su modo de asignación.
4. **Número de WhatsApp**: el de QA, proveedor Twilio, con el equipo y el Content SID de la plantilla. **Consultar** debe mostrar la vista previa.
5. **Bot**: Deployment ID del paso 31; en Avanzado, "Acciones de clasificación de motivo": `oferta_aceptada_venta, oferta_aceptada_venta_y_compra, oferta_rechazada, contacto_futuro`. Luego, en el número, ponlo como bot por defecto.
6. **Configuración de agencias** de Valuación (margen de ajuste y VoBo).

---

## Parte 8 — Pruebas de punta a punta

Usa dos navegadores: administrador o gerente, y valuador del equipo.

| # | Prueba | Debe pasar |
|---|---|---|
| 1 | Entrar con un usuario invitado | Ve solo su marca, módulo y agencias |
| 2 | Ofertas → **Enviar** a tu teléfono de prueba | Llega la plantilla; la oferta queda enviada |
| 3 | Responder por WhatsApp con una duda | El bot contesta con tu nombre y el vehículo |
| 4 | "Sí me interesa" | Se clasifica `oferta_aceptada_venta` y Valuación lo registra |
| 5 | "Quiero vender y comprar uno nuevo" | Se clasifica `oferta_aceptada_venta_y_compra` y pasa a asesor |
| 6 | Pregunta fuera de la base | Mensaje literal de paso a asesor; la conversación se asigna |
| 7 | Tiempo real | Los dos navegadores se actualizan al instante y suena el aviso |
| 8 | El valuador responde, devuelve al bot y cierra | Llega al cliente; al cerrar se elige el estatus |
| 9 | Valuador de otro equipo | No ve la conversación |
| 10 | Monto fuera del margen | Queda pendiente de VoBo y llega el correo al gerente |

**Registros:** CloudWatch Logs Insights sobre `/aws/lambda/hub-msj-entrantes-qa`:
```
fields @timestamp, @message | filter @message like /conv=<idConversacion>/ | sort @timestamp asc
```
Si algo falla, la tabla de síntomas de `dev/DEPLOY_AWS.md` (sección 7) aplica igual cambiando `dev` por `qa`.

---

## Actualizar QA después

1. `git switch qa` y `git merge dev`; pruebas del paso 0.2.
2. Base: migraciones nuevas de `DB/Hub/Migraciones` (las que falten), luego `Alta_db.sql`, luego `GRANT` de lo nuevo y reinicio de PostgREST si cambian los schemas.
3. Lambdas (no tocan variables ni VPC):
   ```powershell
   foreach ($f in 'entry-point','acciones-usuario','router','msj-entrantes') { .\dev\deploy_aws.ps1 $f qa }
   ```
4. Authorizers, solo si cambiaron: `infra\authorizer-*\deploy.ps1 qa`.
5. Web: sale sola con `git push origin qa`.
6. Bot: si cambió, vuelve a cargar la base y las instrucciones en Abacus.

---

## Producción: qué cambia

- Cuenta `386458449724`; sin sufijo en los authorizers (`authorizer-google`, `authorizer-appsync`); `prd` en lugar de `qa` en los demás nombres y comandos. Los scripts piden escribir `prd` para confirmar.
- `AMBIENTE=prd` en las cuatro Lambdas (obligatoria) y `NEXT_PUBLIC_AMBIENTE=prd` en Vercel Production: **Enviar** manda al cliente en automático.
- `LOG_CONTENIDO` apagada.
- PostgREST solo privado (VPC Link y NLB), con los pendientes S1 a S3 e I1 de `Arquitectura/PENDIENTES_INFRA_DEV.md` resueltos.
- Base y PostgREST propios, con aprobación explícita para los scripts; respaldo antes de cada actualización. Sin pruebas SQL (paso 5).
- Número y plantilla de cada marca piloto aprobados, y un deployment de Abacus por marca con la base final.
- Alarmas de CloudWatch: mensajes en la DLQ y errores de las cuatro Lambdas.
