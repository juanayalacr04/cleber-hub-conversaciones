# Diseño — El hub sobre PostgreSQL

**Fecha:** 12 de noviembre de 2026 · **Estado:** diseño aprobado en sesión (Q1–Q33; Q34–Q39 agregadas después), pendiente de revisión escrita.

Corresponde a la **Fase 2** de `toma-unidades-en-taller/docs/plan-de-trabajo.md` ("Diseño de la migración del hub, sin ejecutar"). Reemplaza lo que dicen sobre Firestore [`PLAN_TRABAJO_CENTRALIZACION.md`](PLAN_TRABAJO_CENTRALIZACION.md) §7.3 y §7.7, y `esquema-valuacion.md` §5 (conversaciones en Firestore).

Documentos relacionados:

- Convenciones Cleber: `GitLab/tools/template-para-desarrollo/docs/` (`arquitectura.md`, `infraestructura.md`, `autenticacion.md`, `convenciones-backend.md`, `convenciones-frontend.md`).
- Valuación: `toma-unidades-en-taller/docs/esquema-valuacion.md` (schemas `valuacion` y `clientes`) y `acciones-valuacion.md` (§1.4 seguridad).

---

## 1. Alcance y principios

1. **Todo se ajusta a las convenciones del template.** Login con NextAuth + Google, identidad del usuario validada en API Gateway, una API key por sistema, PostgreSQL solo vía PostgREST y lógica de estado en plpgsql.
2. **Excepción aceptada:** el backend del hub (Python) **se queda en Cloud Functions de GCP**. Entra a la plataforma de Cleber como un **cliente máquina** más. Replataformarlo a Lambdas Node.js no es parte de esta migración.
3. **El hub no está en producción.** Lo productivo son `cleber-bot-platform` (Servicio) y `cleber-bot-platform-comercial` (Comercial). Por eso esta "migración" no mueve datos vivos del hub: **se reescribe su capa de datos sobre PostgreSQL antes de la primera marca**. No hay doble escritura, corte ni rollback del hub.
4. **Firestore se queda solo para lo que exige tiempo real**: un documento de aviso por conversación y la copia de permisos que leen sus reglas. Ningún dato vive solo en Firestore.
5. **Una base PostgreSQL** con tres schemas: `hub_cleber`, `clientes` y `valuacion`. Sin FKs entre schemas (§5.1).

---

## 2. Decisiones

| # | Tema | Decisión |
|---|------|----------|
| Q1 | Conectividad GCP → AWS | Por el **API Gateway de Cleber** (REST v1) → VPC Link → NLB → PostgREST. Sin Cloud SQL ni red privada |
| Q2 | Login del dashboard | **NextAuth v5 + Google**. El navegador abre además la sesión de Firebase con el mismo `id_token` (`signInWithCredential`), solo para leer Firestore |
| Q3 | Identidad en plpgsql | Solo `X-User-Email` inyectado por API Gateway. Roles por marca y módulo, equipos y agencias se leen del schema `hub_cleber`. **Se elimina `X-User-Contexto`** |
| Q4 | Orden | **Usuarios y organizaciones** en `hub_cleber` (con las agencias de cada usuario por valor) se adelantan a la Fase 3 (antes de las pantallas de valuación). El resto en la Fase 4 |
| Q34 | Catálogo de agencias | **No vive en el hub**: viene de un API externo (2026-11-12). El hub guarda solo los ids de agencia del usuario, por valor; el editor de usuarios muestra y valida las opciones contra ese API |
| Q35 | Nombre del schema | **`hub_cleber`** (2026-11-12). Las acciones conservan el prefijo `Hub.*` (`Content-Profile: hub_cleber`) |
| Q36 | Roles | **Por marca y módulo** (2026-11-13): un rol por (usuario, marca, módulo). **Se elimina el rol global** (`admin`/`agent`/`viewer` del usuario); solo `es_super_admin` vale en todo. Tener rol en un módulo de una marca es lo que da acceso a él |
| Q37 | Catálogo de roles | **`hub_cleber.roles_modulo`**: qué roles existen en cada módulo, para el editor y para validar. Qué permite cada rol lo define el módulo (valuación: `valuacion.roles_permisos`). Códigos en mayúsculas: ventas y servicio `ADMINISTRADOR`/`AGENTE`/`CONSULTA`; valuación `ADMINISTRADOR`/`GERENTE`/`VALUADOR`/`CONSULTA`. `SISTEMA` no está en el catálogo: cada módulo reconoce su email de servicio |
| Q38 | Equipo y agencias | **Equipo por marca y módulo** (junto al rol: alguien puede estar en un equipo de ventas y en otro de servicio de la misma marca). **Agencias por marca**, las mismas para todos sus módulos |
| Q39 | Quién edita a quién | Super admin: todo. **Administrador de un módulo en una marca** (rol con `es_administrador` en el catálogo): los roles y equipos de ese módulo en esa marca. Agencias de un usuario en una marca: cualquier administrador de algún módulo de la marca. Invitar = dar el primer rol en un módulo de una marca |
| Q5 | Backend del hub | Se queda en GCP como cliente máquina (excepción, §1) |
| Q6 | Dónde vive el DDL | **Provisional:** `DB/Hub/` de este repo. Se mueve cuando se decida la ubicación final (candidato: `GitLab/api`, el repo central `api-cleber`) |
| Q7 | Conversaciones y mensajes | **A PostgreSQL.** Firestore queda como **canal de aviso** (§6.1) |
| Q8, Q24 | Permisos en Firestore | Copia mínima derivada **`accesos/{email}`**; las reglas usan `request.auth.token.email` con `email_verified`. Sin custom claims |
| Q9 | Configuración en el dashboard | Sin tiempo real: consulta al cargar y tras guardar. Avance de campañas por **polling** |
| Q10 | Caché del backend | Configuración en memoria por instancia, **TTL 60 s** |
| Q11 | Backend como máquina | Ruta `/internal` con **`AWS_IAM`**; SigV4 con credenciales temporales por **federación OIDC** (cuenta de servicio de GCP → `AssumeRoleWithWebIdentity`) + API key del hub. Rol `SISTEMA` |
| Q12 | Colecciones técnicas | `secrets` → **GCP Secret Manager**. `processed_events` → restricción única en `hub_cleber.mensajes`. `actionLog` → `hub_cleber.bitacora` |
| Q13 | Fase 4 | Se reescribe como **"capa de datos del hub sobre PostgreSQL"**; termina **antes del primer corte de marca** |
| Q14, Q28, Q29 | Qué se migra de las plataformas productivas | **Configuración + conversaciones activas** (no cerradas, o cerradas dentro de su ventana de reapertura) **con todos sus mensajes**. Lo histórico se queda en las plataformas viejas |
| Q16 | Orden del corte | Reapuntar webhook → importar → reimportar (idempotente) |
| Q17 | Imágenes del bot | Se copian al Storage del hub y el mensaje guarda la URL nueva |
| Q19 | Dónde vive la lógica | **Estado y atomicidad en plpgsql** (`Hub.*`); orquestación externa (WhatsApp, Abacus, Salesforce, Firestore) en Python |
| Q20 | Quién escribe desde el dashboard | Configuración: **Next.js → API Gateway (JWT) → PostgREST**. Lo que toca Firestore o un externo: por el backend |
| Q21 | Backend actuando por un usuario | **Reenvía el `id_token` del usuario** a la ruta con authorizer. `/internal` solo sin usuario (webhooks, bot, jobs) |
| Q22 | Schemas | Un solo schema **`hub_cleber`**; `clientes` y `valuacion` aparte |
| Q25 | Capa de datos en Python | `core/postgrest.py` (único cliente) + `core/datos/` por entidad + `core/aviso.py` (Firestore), con prueba de arquitectura |
| Q26 | Authorizer en REST v1 | **Lambda authorizer** que valida el `id_token` de Google e inyecta `X-User-Email`; `/internal` con IAM nativo |
| Q27 | Dueño del authorizer | Pieza **compartida de la plataforma** en `GitLab/api/API/authorizer-google/`; se acuerda con el responsable del API Gateway (`z66x2zyooj`) |
| Q30 | Ficha de cliente | `customers` → `clientes.clientes`, `summaries` → `clientes.resumenes` **sin cambios** (`resumen NOT NULL`, sin backfill) |
| Q31 | Ambientes | **dev** (= QA): `db_dev_01`, GCP `ambiente-desarrollo-ti`, Firestore `dev-hub-conversaciones`. **prod**: RDS de producción, proyecto GCP de prod del hub (por crear), Vercel de prod. Un client de Google OAuth y una API key por ambiente |

Q15 (importar sin resumen) quedó sin efecto al limitar la migración a conversaciones activas; Q23 se revirtió (Q30).

---

## 3. Arquitectura

```
                         ┌──────────────── AWS (us-east-1) ───────────────────────────────┐
Navegador                │  API Gateway REST v1 (z66x2zyooj)                             │
 ├─ NextAuth (Google) ──►│   /hub/{proxy+}        Lambda authorizer (Google) + API key ─┐ │
 │   Next.js (Vercel)    │   /clientes/{proxy+}   idem                                  │ │
 │                       │   /toma-unidades/...   idem                                  ├─► VPC Link → NLB → PostgREST
 │                       │   /internal/{proxy+}   AWS_IAM + API key ───────────────────┘ │      │
 │                       └─────────────────────────────────────────────────────────────┬─┘      ▼
 │                                    ▲ SigV4 (federación OIDC)  ▲ id_token del usuario │   PostgreSQL
 │                                    │                          │                      │   hub · clientes · valuacion
 │                         ┌──────────┴──────────────────────────┴──┐                    │
 │                         │ Backend del hub (Cloud Functions, GCP) │◄── webhooks WhatsApp
 │                         │ router · reglas · bot · jobs           │◄── crons de Vercel
 │                         └──────────┬─────────────────────────────┘──► Abacus, Salesforce, Twilio/Meta/ValueText
 │                                    │ escribe avisos y accesos
 │                                    ▼
 └─ Firebase (signInWithCredential) ─► Firestore: conversations/{id} (aviso) · accesos/{email}   (solo lectura desde el navegador)
```

### 3.1 Rutas de API Gateway

| Ruta | Authorizer | Quién la usa | `Content-Profile` |
|------|-----------|--------------|-------------------|
| `/hub/{proxy+}` | Lambda authorizer (Google) + API key | Dashboard (Next.js server), backend reenviando el token del usuario | `hub_cleber` |
| `/clientes/{proxy+}` | Lambda authorizer (Google) + API key | Dashboard (ficha), cuando los permisos por usuario estén en plpgsql | `clientes` |
| `/toma-unidades/{proxy+}` | Lambda authorizer (Google) + API key | Pantallas de valuación | `valuacion` (o Lambda `TomaUnidades.*`) |
| `/internal/{proxy+}` | `AWS_IAM` + API key | Backend del hub (webhooks, bot, jobs, importación), Lambdas de valuación | según el schema |

Los nombres finales de las rutas se acuerdan con el responsable del API Gateway.

---

## 4. Autenticación

### 4.1 Usuarios (dashboard)

```
1. Login con Google (NextAuth v5). La sesión guarda el id_token (cookie HttpOnly).
2. El navegador abre Firebase con signInWithCredential(GoogleAuthProvider.credential(idToken)), solo para Firestore.
3. Server Components / Route Handlers de Next.js llaman a API Gateway con el id_token + x-api-key.
4. El Lambda authorizer valida el token y devuelve el email en el contexto.
5. La integración mapea X-User-Email ← context.authorizer.email (sobrescribe lo que mande el cliente).
6. plpgsql: hub_cleber.usuario_actual() lee X-User-Email y busca al usuario en hub_cleber.usuarios.
```

- Las plataformas productivas ya entran con Google (`signInWithPopup` + `GoogleAuthProvider`), así que nadie se queda fuera. Los usuarios se identifican **por email**.
- **El authorizer.** No existe todavía en la plataforma: es una pieza nueva y compartida (Q26, Q27).
  - **Validación:** `iss` = `https://accounts.google.com`, `aud` = client ID del ambiente, firma con las JWKS de Google, `exp` y `email_verified`.
  - **Caché:** el resultado se guarda en caché ~5 min por token.
  - **Verificar en dev:** que el mapeo de `X-User-Email` sobrescribe el header del cliente antes de darlo por bueno.
- **Expiración:** el `id_token` de Google dura 1 h. Se maneja como dice `autenticacion.md`: un 401 lleva a `/login`.
- **Firebase:** la sesión de Firebase solo da lectura de Firestore según `accesos/{email}`. Firebase Auth deja de ser el proveedor de identidad.

### 4.2 Permisos en plpgsql

Helpers del schema `hub_cleber` (mismo patrón que `valuacion`):

| Helper | Uso |
|--------|-----|
| `hub_cleber.usuario_actual()` | `X-User-Email` → fila de `hub_cleber.usuarios` (activo). Sin header o sin usuario → `SIN_PERMISO` |
| `hub_cleber.exige_organizacion(id_organizacion)` | La organización está entre las del usuario |
| `hub_cleber.rol_modulo(id_organizacion, modulo)` | Rol del usuario en ese módulo de esa marca, ej. (`marca-a`, `valuacion`) → `VALUADOR` |
| `hub_cleber.exige_administrador_modulo(id_organizacion, modulo)` | Administra el módulo en la marca (Q39) o super admin |
| `hub_cleber.exige_administrador_organizacion(id_organizacion)` | Administra algún módulo de la marca (para sus agencias) o super admin |
| `hub_cleber.agencias_permitidas(id_organizacion)` | Agencias del usuario en esa marca; `NULL` = sin restricción (super admin y sistema) |

**Valuación** deja de recibir `X-User-Contexto`:
- `valuacion.usuario_actual()` lee `X-User-Email` y consulta `hub_cleber.usuarios_contexto(email)`. Es una función de `hub_cleber` que devuelve super admin, sistema y las marcas donde el usuario tiene rol en el módulo, cada una con `{ rol, idEquipo, agencias }`; se llama por valor, sin join a tablas ajenas. El permiso se evalúa con la marca del recurso (la de la oferta).
- Es la segunda dependencia permitida entre schemas, junto a `clientes.normaliza_telefono`.

### 4.3 Máquinas

| Cliente | Ruta | Credencial | Identidad en plpgsql |
|---------|------|-----------|----------------------|
| Backend del hub (GCP) sin usuario | `/internal` | SigV4 con rol de AWS asumido por **federación OIDC** desde su cuenta de servicio + API key del hub | `X-User-Email: sistema@hub-conversaciones.internal`, rol `SISTEMA` |
| Backend del hub actuando por un usuario | `/hub` | **El `id_token` del usuario** que le mandó el dashboard + API key | El usuario real |
| Lambdas de valuación | `/internal` (o NLB interno dentro de la VPC) | Rol IAM de la Lambda | `sistema@toma-unidades.internal`, rol `SISTEMA` |

**Federación, en concreto:**
- AWS confía en el proveedor OIDC `accounts.google.com`, con el `sub` de la cuenta de servicio de las Cloud Functions como condición.
- La Cloud Function pide un ID token a su metadata server y lo cambia con `AssumeRoleWithWebIdentity` por credenciales de 1 h.
- No hay llaves de AWS guardadas.
- El rol solo tiene `execute-api:Invoke` sobre `/internal/*`.

**Plan B** si infraestructura no puede configurar la federación a tiempo: un usuario IAM con llaves en GCP Secret Manager, temporal y con rotación.

**Headers de identidad en `/internal`.** Que la ruta exija IAM no impide que quien llama mande `X-User-Email` con el valor que quiera. Dos condiciones lo mantienen acotado:
- Solo principales de IAM pueden llamar a `/internal`.
- plpgsql solo acepta en `/internal` los emails de servicio registrados (`hub_cleber.usuarios` con `es_sistema`).

### 4.4 Webhooks y crons (sin cambio)

- Los webhooks de WhatsApp siguen entrando al backend en GCP con validación de firma.
- Los crons de Vercel siguen llamando al backend con `X-Cron-Secret`.
- El backend llama a `/internal`.

---

## 5. Modelo de datos

### 5.1 Schemas

| Schema | Dueño | Contenido |
|--------|-------|-----------|
| `hub_cleber` | Hub | Organizaciones, usuarios, catálogo de roles por módulo, equipos, números, bots, plantillas, etiquetas, conversaciones, mensajes, notas, campañas, bitácora |
| `clientes` | Hub | Ficha única (ya creado en `db_dev_01`; `DB/Clientes/` de `toma-unidades-en-taller`) |
| `valuacion` | Valuación | Ofertas (ya creado en `db_dev_01`) |

Reglas que se mantienen (`esquema-valuacion.md` §1):
- Cada schema se modifica solo con sus funciones.
- No hay FKs entre schemas; las relaciones son por valor.
- Cada schema replica sus helpers (`log_errores`, `registra_error`, `construye_respuesta_de_excepcion`).

### 5.2 Entidades del schema `hub_cleber`

Ids: los documentos migrados conservan su id de Firestore como `id_origen` (único) para la importación idempotente. Las llaves nuevas son `bigint identity` salvo donde se indica `text`.

| Tabla | Sale de (Firestore) | Columnas clave | Notas |
|-------|---------------------|----------------|-------|
| `organizaciones` | `organizations` | `id_organizacion text` PK (= `organizationId`, se conserva), `nombre`, `zona_horaria`, `horario` jsonb, `sf_codigo_marca` **UNIQUE**, `sf_calendario`, `salesforce_config` jsonb (no secretos), `plan` | Los secretos de Salesforce van a Secret Manager (`DECISIONES_UNIFICACION.md`) |
| `usuarios` | `users` | `id_usuario`, `email` **UNIQUE** (citext), `nombre`, `foto_url`, `es_super_admin`, `es_sistema`, `es_disponible`, `estado`, `invitado_por`, `ultimo_acceso_en` | El email es la identidad (authorizer). Sin rol global (Q36) |
| `usuarios_organizaciones` | `users.organizationIds`, `orgAgencies` | (`id_usuario`, `id_organizacion`) PK, `agencias text[]` | Marcas del usuario. Agencias por valor, las mismas para todos los módulos de la marca: el catálogo viene de un API (Q34, Q38) |
| `roles_modulo` | nueva | (`modulo`, `rol`) PK, `nombre`, `descripcion`, `es_administrador`, `orden` | Catálogo de roles de cada módulo (Q37) |
| `usuarios_roles_modulo` | `users.role`, `orgTeams` | (`id_usuario`, `id_organizacion`, `modulo`) PK, `rol` FK al catálogo, `id_equipo` FK nullable | Ej. (`juan`, `marca-a`, `valuacion`, `VALUADOR`) y (`juan`, `marca-b`, `valuacion`, `GERENTE`). FK a `usuarios_organizaciones`: al salir de la marca se borran sus roles (Q36, Q38) |
| `equipos` | `teams` | `id_equipo`, `id_organizacion` FK, `nombre`, `vertical` (`ventas`/`servicio`/`valuacion`), `modo_asignacion`, `max_conversaciones_agente`, `accion_opt_out`, `umbrales_semaforo` jsonb, `estado` | `activeConversations` se calcula, no se guarda |
| `numeros` | `whatsappNumbers` | `id_numero`, `id_organizacion`, `telefono` UNIQUE entre activos, `nombre`, `proveedor` (`twilio`/`meta`/`valuetext`), `id_equipo`, `id_bot_default`, `ventana_reapertura_horas`, `horas_cierre_inactividad`, `webhook_cierre_url`, `plantillas` jsonb, `ids_proveedor` jsonb (no secretos), `estado` | Tokens de Twilio/Meta en Secret Manager |
| `bots` | `bots` | `id_bot`, `id_organizacion`, `nombre`, `tipo` (`chatllm`/`workflow`/`vertex_ai`/`external`), `vertical`, `categoria`, `estado`, `config` jsonb (`abacusConfig` sin token, `handoffConfig`, `inactivityConfig`, `scheduleConfig`, `situationRouting`, `outcomeActions`, …), `herramientas text[]`, `accion_opt_out`, `inyecta_contexto_telefono` | Configuración variable en jsonb; tokens en Secret Manager |
| `plantillas` | `templates` | `id_plantilla`, `id_organizacion`, `nombre`, `contenido`, `categoria`, `vertical` | |
| `etiquetas` | `labels` | `id_etiqueta`, `id_organizacion`, `id_equipo`, `nombre`, `color` | |
| `conversaciones` | `conversations` | `id_conversacion text` PK (id de Firestore = id del documento de aviso), `id_organizacion`, `id_equipo`, `id_numero`, `id_bot`, `vertical`, `canal`, `direccion`, `telefono_cliente`, `nombre_cliente`, `clave_cliente` (= `clientes.clave`), `estado` (`bot`/`waiting_agent`/`with_agent`/`closed`), `id_agente_asignado`, `prioridad`, `etiquetas text[]`, `fuente`, `id_externo`, `id_campana`, `resultado` + `resultado_en`, `resultado_ia`, `ultimo_mensaje_en`, `ultimo_mensaje_cliente_en`, `ultima_plantilla_en`, `recordatorios_inactividad`, `fecha_cita`, `metadatos` jsonb, `cerrada_en`, `version`, `id_origen` | Índices de la bandeja por (`id_organizacion`, `id_equipo`, `estado`, `ultimo_mensaje_en`). UNIQUE (`fuente`, `id_externo`) para el contrato ① |
| `conversaciones_resultados` | `conversationOutcomeHistory` | `id_conversacion` FK, `resultado`, `registrado_en` | |
| `mensajes` | `conversations/{id}/messages` | `id_mensaje`, `id_conversacion` FK, `remitente` (`customer`/`bot`/`agent`), `id_agente`, `texto`, `media_url`, `id_mensaje_proveedor` **UNIQUE** (idempotencia, ex `processed_events`), `creado_en`, `id_origen` | Índice (`id_conversacion`, `creado_en`) |
| `notas` | `conversations/{id}/notes` | `id_nota`, `id_conversacion` FK, `autor`, `texto`, `creado_en` | |
| `bitacora` | `conversations/{id}/actionLog` | `id_bitacora`, `id_conversacion`, `accion`, `origen`, `usuario`, `datos` jsonb, `registrado_en` | Solo inserción |
| `campanas` | `broadcasts` | `id_campana`, `id_organizacion`, `nombre`, `id_numero`, `id_bot`, `plantilla` jsonb (nombre, idioma, componentes, `contentSid`, ValueText), `instrucciones_bot`, `mapeo_variables`, `estado`, `creado_por`, `completada_en` | Contadores se calculan desde destinatarios |
| `campanas_destinatarios` | `broadcasts/{id}/recipients` | `id_destinatario`, `id_campana` FK, `telefono`, `nombre`, `variables` jsonb, `id_salesforce`, `id_conversacion`, `estado`, `error`, `id_mensaje_proveedor`, `enviado_en`, `respuesta` | |
| `procesos_pendientes` | (claims de Firestore, `core/claims.py`) | Se resuelven con `SELECT … FOR UPDATE SKIP LOCKED` o bloqueos asesores dentro de cada acción | No es una tabla si no hace falta |

`webChannels` no se migra (no hay código que la use). `DailyStats` se calcula con vistas o consultas, no se guarda.

### 5.3 Acciones `Hub.*`

Envelope y errores de la convención. Las llama PostgREST por `POST rpc/<funcion>`, con `Content-Profile: hub_cleber` y `Prefer: params=single-object`. Agrupadas:

| Grupo | Acciones | Quién llama |
|-------|----------|-------------|
| Identidad | `consultaUsuarioActual`, `registraInicioSesion`, `usuarios_contexto` (función, para valuación) | Dashboard, `valuacion` |
| Configuración | `consulta*` / `guarda*` / `elimina*` de organizaciones, equipos, números, bots, plantillas, etiquetas | Dashboard (directo) |
| Usuarios | `consultaRolesModulo`, `consultaUsuarios` | Dashboard (directo) |
| Usuarios (escritura) | `invitaUsuario`, `guardaUsuario`, `quitaUsuarioDeOrganizacion`, `cambiaDisponibilidad` (reglas de Q39) | **Backend** (también escribe `accesos`, valida agencias contra su API y manda el correo de invitación) |
| Conversaciones (pipeline) | `resuelveNumero` (número + equipo + bot + org, para la caché), `obtieneOAbreConversacion` (incluye reapertura por ventana), `guardaMensaje` (idempotente por `id_mensaje_proveedor`), `consultaHistorial` (para el bot) | Backend (`/internal`) |
| Conversaciones (operación) | `asignaConversacion`, `reclamaConversacion`, `transfiereConversacion`, `cierraConversacion`, `registraResultado`, `agregaNota`, `agregaEtiqueta` | Backend (por usuario o sistema) |
| Consultas del dashboard | `consultaConversaciones` (bandeja/kanban), `consultaMensajes` (`desde` para incremental), `consultaNotas`, `consultaBitacora`, `consultaEstadisticas` | Dashboard (directo) |
| Jobs | `conversacionesInactivas`, `contactosProgramados`, `recordatoriosCitas` | Backend (`/internal`) |
| Campañas | `guardaCampana`, `agregaDestinatarios`, `marcaDestinatario`, `consultaCampana` (con conteos) | Dashboard (borrador) / backend (envío) |
| Contrato ① | `abreConversacionExterna` (idempotente por `fuente` + `id_externo`) | Backend |
| Importación | `importaConfiguracion`, `importaConversaciones` (upsert por `id_origen`) | Script de migración (`/internal`) |

Cada acción que cambia una conversación devuelve el estado necesario para que el backend actualice el documento de aviso (§6.1).

---

## 6. Lo que queda en Firestore

### 6.1 Documento de aviso — `conversations/{id}`

Mismo id que `hub_cleber.conversaciones.id_conversacion`. Lo escribe **solo el backend** (`core/aviso.py`), **después** de que la acción `Hub.*` confirma. Contiene solo lo que la bandeja, el kanban, el semáforo y las notificaciones necesitan mostrar sin abrir la conversación:

`organizationId`, `teamId`, `vertical`, `status`, `assignedAgentId`, `priority`, `tags`, `customerName`, `customerPhone`, `botName`, `lastMessageAt`, `lastMessagePreview`, `lastMessageSender`, `lastCustomerMessageAt`, `conversationOutcome`, `version`, `actualizadoEn`.

- **No hay subcolecciones.** Mensajes, notas y bitácora viven solo en PostgreSQL.
- **El chat** escucha el documento de la conversación abierta. Cuando cambia `version`, pide `Hub.consultaMensajes` con `desde` = el último mensaje que ya tiene.
- **Notificaciones**: dejan de usar `collectionGroup("messages")` y escuchan los avisos con `lastMessageSender == "customer"`.
- **Si falla la escritura del aviso** después de confirmar en PostgreSQL: se reintenta. Como el aviso lleva `version`, gana la escritura más reciente. Un aviso perdido se corrige con el siguiente cambio de la conversación, o con un job de reconciliación que compara `version`.
- **Conversaciones cerradas**: el aviso se conserva mientras sea visible en la bandeja. Se puede depurar por TTL de Firestore sin perder nada, porque la fuente es PostgreSQL.

### 6.2 Permisos — `accesos/{email}`

Copia mínima derivada de `hub_cleber.usuarios*`: `isSuperAdmin`, `organizationIds` y `modulos` (`{ "<idOrganizacion>": { "<modulo>": { rol, teamId } } }`, Q36 y Q38).
- **Quién la escribe:** el backend, cada vez que cambia un usuario (acciones de Usuarios, §5.3).
- **Qué la lee:** las reglas de Firestore, con `request.auth.token.email` y `email_verified == true`, para decidir lectura de `conversations/{id}` con la lógica del `canAccessTeam` actual, aplicada al rol y al equipo del usuario en el módulo (`vertical`) y la marca de la conversación.
- `firestore.rules` sigue siendo **solo lectura** para el navegador (tarea 1.40).

### 6.3 Lo que sale de Firestore

| Colección | Destino |
|-----------|---------|
| `organizations`, `teams`, `whatsappNumbers`, `bots`, `templates`, `labels`, `users`, `broadcasts` (+ `recipients`) | `hub_cleber` |
| `conversations/{id}/messages`, `notes`, `actionLog` | `hub_cleber.mensajes`, `hub_cleber.notas`, `hub_cleber.bitacora` |
| `customers`, `summaries` | `clientes.clientes`, `clientes.resumenes` |
| `secrets` | GCP Secret Manager |
| `processed_events` | `hub_cleber.mensajes.id_mensaje_proveedor` UNIQUE |
| `webChannels` | No se migra |

---

## 7. Backend (Python)

- **`core/postgrest.py`**: el único cliente HTTP hacia API Gateway.
  - Dos modos: **sistema** (SigV4 por federación, ruta `/internal`) y **usuario** (reenvía el `id_token`, ruta `/hub`).
  - Agrega API key, `Content-Profile`, `Prefer: params=single-object` y el envelope `{action, params}`.
  - Traduce `successful: false` a excepciones con `errorCode`.
- **`core/datos/`**: un módulo por entidad (`conversaciones.py`, `mensajes.py`, `equipos.py`, `numeros.py`, `bots.py`, `usuarios.py`, `campanas.py`, …). Es lo único que llama el resto del código y reemplaza los ~36 archivos que hoy usan `get_db().collection(...)`.
- **`core/aviso.py`**: escribe el documento de aviso y `accesos`. Es lo único que sigue usando Firestore. `core/db.py` queda reducido a esto.
- **Caché**: lo que lee el pipeline por mensaje (`resuelveNumero`, bot, equipo, organización) se guarda en memoria por instancia con TTL de 60 s.
- **Transacciones**: las de Firestore (`run_transaction`, claims, idempotencia) pasan a ser **una sola acción plpgsql por operación**. La atomicidad queda en la base.
- **Prueba de arquitectura**: amplía `tests/test_architecture_rules.py`. Nadie fuera de `core/postgrest.py` hace HTTP a API Gateway, y nadie fuera de `core/aviso.py` usa Firestore.
- **Latencia**: cada mensaje entrante agrega llamadas GCP → us-east-1, aproximadamente:
  - `obtieneOAbreConversacion`
  - `guardaMensaje`
  - `consultaHistorial`
  - `guardaMensaje` de la respuesta

  `resuelveNumero` sale de caché. Se mide en dev contra el tiempo actual de respuesta del bot. Si hace falta, `obtieneOAbreConversacion` + `guardaMensaje` + `consultaHistorial` se combinan en una sola acción (`Hub.recibeMensaje`).

---

## 8. Frontend (`apps/web`)

| Fase | Cambios |
|------|---------|
| **Fase 3** (con valuación) | **Login con NextAuth v5 + Google** en todo el dashboard (reemplaza `signInWithPopup`) y puente `signInWithCredential` a Firebase · cliente HTTP de la convención (`lib/api.ts`: `id_token`, API key, 401/403) · **editor de usuarios** sobre `hub_cleber` (rol y equipo por marca y módulo, agencias por marca; guarda por el backend) · organizaciones y agencias desde `hub_cleber` · reglas de Firestore a `accesos/{email}` · pantallas de valuación contra su API (reemplaza `lib/valuacion/store.ts`) |
| **Fase 4** | Pantallas de configuración (equipos, bots, números, plantillas, etiquetas) de `onSnapshot` a consultas a la API · campañas con polling del avance · conversaciones (lista, kanban, chat, notificaciones, semáforo) sobre el documento de aviso + `Hub.consultaMensajes` · rutas API de Next.js (`salesforce/*`, `abacus-config`) sin Admin SDK de Firestore |
| Cortes por marca | Sin cambios |

---

## 9. Migración por marca

Aplica a las fases "Migrar Comercial" y "Migrar Servicio" de `PLAN_TRABAJO_CENTRALIZACION.md` (§10 y §11). Requisito: la capa de datos del hub sobre PostgreSQL ya terminada.

**Qué se migra:**

| Dato | Cómo |
|------|------|
| Configuración (organización, equipos, números, bots, plantillas, etiquetas, usuarios) | `Hub.importaConfiguracion`, traduciendo ids viejos a los del hub. Secretos a Secret Manager. Usuarios por email; `accesos` se genera al final |
| Conversaciones **activas** | No cerradas, o cerradas dentro de su `reopenWindowHours` (96 h por defecto) en el momento del corte. Se importan con **todos sus mensajes** y se crea su documento de aviso |
| Imágenes del bot de esas conversaciones | Se copian del Storage del proyecto viejo al del hub; `media_url` apunta a la copia |
| Fichas de cliente | `Clientes.obtieneOCrea` por cada conversación activa importada. Sin resúmenes históricos |
| Conversaciones cerradas fuera de ventana | **No se migran**; quedan en la plataforma vieja (solo lectura) |

**Orden del corte:**
1. Importar la configuración y validarla.
2. Reapuntar el webhook del número al hub.
3. Importar las conversaciones activas con `Hub.importaConversaciones` (upsert por `id_origen`).
4. Volver a correr la importación para recoger lo que entró a la plataforma vieja entre el paso 2 y el 3. Es idempotente.

**El script:**
- Lee el Firestore del proyecto viejo:
  - Servicio: `atomic-hybrid-482121-n7`, base `(default)`.
  - Comercial: `ia-chatbots-ventas`, base `chatbots-ventas`.
- Escribe por `/internal` en lotes.
- Cualquier escritura en producción requiere aprobación explícita de esa operación (regla del plan).

---

## 10. Ambientes

| | dev (también QA) | prod |
|---|---|---|
| PostgreSQL | `db_dev_01` | RDS de producción de Cleber |
| GCP / Firestore | `ambiente-desarrollo-ti` / `dev-hub-conversaciones` | Proyecto de prod del hub (por crear) |
| Vercel | Preview / dev | Producción |
| Google OAuth client | Uno (aud del authorizer) | Otro |
| API key del hub | Una | Otra |
| Rol IAM federado | Uno, confía en la cuenta de servicio de dev | Otro, confía en la de prod |

---

## 11. Dependencias externas

| Dependencia | De quién | Bloquea |
|-------------|----------|---------|
| Lambda authorizer de Google en `GitLab/api` y su asignación a las rutas nuevas | Responsable del API Gateway de Cleber | Pantallas de valuación y dashboard sobre PostgreSQL (Fase 3) |
| Rutas `/hub`, `/clientes`, `/toma-unidades`, `/internal` con sus API keys y usage plan | Idem | Fase 3 |
| Proveedor OIDC y rol federado en AWS (Q11) | Infraestructura AWS | Backend del hub contra PostgreSQL |
| Client de Google OAuth por ambiente | Administración de Google Workspace / GCP | Login NextAuth |
| Proyecto GCP de prod del hub | Plan de centralización | Producción |

---

## 12. Pendientes

- Verificar en dev que el mapeo `X-User-Email ← context.authorizer.email` de REST v1 sobrescribe el header enviado por el cliente.
- Medir la latencia GCP → API Gateway → PostgREST en el pipeline y decidir si se combina en `Hub.recibeMensaje` (§7).
- Nombres finales de las rutas y de las API keys con el responsable del API Gateway.
- Ubicación definitiva del DDL de `hub_cleber`, `clientes` y `valuacion` (hoy `DB/Hub/` aquí, `DB/Clientes/` y `DB/Valuacion/` en `toma-unidades-en-taller`).
- `infraestructura.md` del template es inconsistente (REST v1 vs ejemplo de HTTP API con JWT Authorizer): proponer la corrección al dueño del template con lo decidido aquí.
- Que el hub deje de usar `core/utils.py::normalize_phone` para la llave del cliente y use la regla de `clientes.normaliza_telefono` (`esquema-valuacion.md` §6). `core/schema.py::customer_id` hoy solo deja dígitos y no coincide con `clientes.clave` (`+52…`).
