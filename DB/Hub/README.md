# DB — schema `hub_cleber`

Usuarios y marcas del hub en PostgreSQL. Es el **adelanto de la Fase 3** del plan de valuación (`toma-unidades-en-taller/docs/plan-de-trabajo.md`): valuación deja de recibir `X-User-Contexto` y obtiene el rol y las agencias del usuario con `hub_cleber.usuarios_contexto`.

**Roles por marca y módulo (Q36–Q39).** No hay rol global: cada usuario tiene un rol en cada módulo (`ventas`, `servicio`, `valuacion`) de cada marca, tomado del catálogo `hub_cleber.roles_modulo`. Tener rol en un módulo de una marca es lo que da acceso a él. Lo que puede hacer cada rol lo define el módulo (valuación: `valuacion.roles_permisos`). Solo `es_super_admin` vale en todo.

**El catálogo de agencias no vive en el hub**: viene de un API externo (Q34). El hub solo guarda, por valor, los ids de agencia asignados a cada usuario en cada marca (los mismos para todos los módulos de la marca); el editor de usuarios consulta ese API para mostrarlas y validarlas. El resto del schema (equipos, números, bots, conversaciones, mensajes…) entra en la Fase 4.

Diseño: [`Arquitectura/DISENO_MIGRACION_POSTGRES.md`](../../Arquitectura/DISENO_MIGRACION_POSTGRES.md) §4.2 y §5. Mismas convenciones que `DB/Valuacion` y `DB/Clientes` de `toma-unidades-en-taller` (envelope, errores, un archivo por acción). Ubicación **provisional** (Q6): se mueve cuando se decida dónde vive el DDL.

## Estructura

```
DB/Hub/
├── Alta_db.sql                 Script maestro (una transacción; re-ejecutable)
├── Tables/                     log_errores, marcas, usuarios, usuarios_marcas, roles_modulo, usuarios_roles_modulo,
│                               equipos, bots, numeros, conversaciones, mensajes, bitacora, notas
├── Functions/
│   ├── Helpers/                errores, peticion, seguridad (identidad y permisos), usuario_json, marca_json, editor_usuarios,
│   │                           conversaciones (permisos por módulo y equipo, teléfono, forma JSON)
│   └── Acciones/               consulta_usuario_actual, importa_usuarios, consulta_marcas, guarda_marca, las del editor de usuarios
│                               y las del núcleo de conversaciones
├── Migraciones/               cambios de estructura en tablas que ya existen (numerados; re-ejecutables)
├── Datos_maestros/             roles_modulo (catálogo), usuarios_sistema (emails de servicio)
└── Pruebas/                    pruebas_flujo.sql y pruebas_conversaciones.sql (en una transacción con ROLLBACK)
```

## Alta, pruebas y carga (solo desarrollo/QA)

Requiere el schema `cleber` del repo `api` y `clientes.normaliza_telefono` (`DB/Clientes` de `toma-unidades-en-taller`). Desde una base de desarrollo:

```
cd <ruta del repo>/DB/Hub
psql -h <host> -p <puerto> -U <usuario> -d <database> -f Alta_db.sql -q
psql -h <host> -p <puerto> -U <usuario> -d <database> -f Pruebas/pruebas_flujo.sql -q
psql -h <host> -p <puerto> -U <usuario> -d <database> -f Pruebas/pruebas_conversaciones.sql -q
```

`Alta_db.sql` crea las tablas con `IF NOT EXISTS`, así que **no cambia la estructura de una tabla que ya existe**. No hay migraciones: una base con la estructura anterior (`organizaciones`, `usuarios_organizaciones` o `usuarios.rol`) se da de alta de nuevo y se vuelve a correr la carga.

Carga de los usuarios y las marcas actuales de Firestore (dev). El script solo lee Firestore y **genera** un `.sql`; no se conecta a PostgreSQL:

```
$env:GOOGLE_CLOUD_PROJECT="ambiente-desarrollo-ti"; $env:FIRESTORE_DATABASE="dev-hub-conversaciones"
python dev/carga_usuarios_hub.py --salida <fuera del repo>/carga_hub.sql
psql -h <host> -p <puerto> -U <usuario> -d <database> -f <fuera del repo>/carga_hub.sql
```

- El id de cada marca en el hub es su **código** (`sfBrandCode` de Firestore, en mayúsculas: `TO`, `HO`…). Una marca sin `sfBrandCode` no se carga, ni las membresías de sus usuarios (salen en los avisos).
- El rol de Firestore (`role`, uno por usuario) se carga como rol de **ventas y servicio** en cada marca del usuario: `admin` → `ADMINISTRADOR`, `agent` → `AGENTE`, `viewer` → `CONSULTA`. El equipo de la marca va al módulo de su vertical.
- La carga maneja solo ventas y servicio (`modulos`): **no toca los roles de valuación**. Esos se asignan en el editor de usuarios (mientras no exista, a mano en dev).
- De agencias se copian los ids de `orgAgencies` si existen (hoy no existen en Firestore, así que quedan vacías).

## Identidad

| Quién | Ruta | `X-User-Email` | En `hub_cleber.usuarios` |
|-------|------|----------------|-------------------|
| Usuario del dashboard | `/hub-cleber` (Lambda authorizer de Google) | Lo inyecta API Gateway desde el token | `es_sistema = false`; roles en `usuarios_roles_modulo` |
| Backend del hub | `/internal` (`AWS_IAM`) | `sistema@hub-conversaciones.internal` | `es_sistema = true`, sin roles del catálogo |
| Lambda de valuación | `/internal` | `sistema@toma-unidades.internal` | `es_sistema = true`, sin roles del catálogo; valuación le da `SISTEMA` por su email |

## Roles

Catálogo (`Datos_maestros/roles_modulo.sql`):

| Módulo | Roles (el primero administra el módulo en la marca) |
|--------|-------|
| `ventas` | `ADMINISTRADOR`, `AGENTE`, `CONSULTA` |
| `servicio` | `ADMINISTRADOR`, `AGENTE`, `CONSULTA` |
| `valuacion` | `ADMINISTRADOR`, `GERENTE`, `VALUADOR`, `CONSULTA` |

Quién edita a quién (Q39; lo aplican las acciones del editor de usuarios):
- **Super admin**: todo.
- **Administrador de un módulo en una marca** (rol con `es_administrador`): asigna y quita los roles de ese módulo en esa marca, incluido el equipo.
- **Agencias** del usuario en una marca: cualquier administrador de algún módulo de esa marca.
- **Sacar a alguien de una marca**: hay que administrar todos los módulos donde tiene rol en ella.
- Solo un super admin modifica a un super admin. Nadie (salvo el super admin) se quita a sí mismo la administración de un módulo ni se saca de una marca.

## Helpers

`Functions/Helpers/seguridad.sql`:

| Helper | Uso |
|--------|-----|
| `hub_cleber.usuario_actual()` | Fila de `hub_cleber.usuarios` del `X-User-Email` (activo). Sin header, sin usuario o inactivo → `SIN_PERMISO` |
| `hub_cleber.exige_sistema(usuario)` | Solo emails de servicio |
| `hub_cleber.tiene_marca` / `hub_cleber.exige_marca(usuario, idMarca)` | Super admin y sistema: todas |
| `hub_cleber.rol_modulo(usuario, idMarca, modulo)` | Rol del módulo en la marca, o `NULL` |
| `hub_cleber.es_administrador_modulo` / `exige_administrador_modulo(usuario, idMarca, modulo)` | Su rol en ese módulo de la marca es de administrador; super admin siempre |
| `hub_cleber.es_administrador_marca` / `exige_administrador_marca(usuario, idMarca)` | Administra algún módulo de la marca; super admin siempre |
| `hub_cleber.agencias_permitidas(usuario, idMarca)` | Ids asignados; `NULL` = sin restricción (super admin y sistema), `{}` = ninguna |
| `hub_cleber.usuarios_contexto(email, modulo)` | Para **valuación**, por valor: `{ email, esSuperAdmin, esSistema, marcas: { idMarca: { rol, idEquipo, agencias } } }`, solo las marcas donde tiene rol en el módulo; `NULL` si no existe o está inactivo. `SECURITY DEFINER` |

## Acciones

| Acción | Función | Quién | Info |
|--------|---------|-------|------|
| `Hub.consultaUsuarioActual` | `consulta_usuario_actual` | Cualquier usuario activo | `{ usuario, marcasVisibles }` |
| `Hub.importaUsuarios` | `importa_usuarios` | Sistema | `{ marcas, usuarios: { creados, actualizados } }`. Idempotente, todo o nada. Lo que viene reemplaza lo guardado (marcas del usuario y, en cada marca, los roles de los módulos que maneja la carga: param `modulos`); lo que no viene no se toca |
| `Hub.registraInicioSesion` | `registra_inicio_sesion` | El propio usuario, al entrar | `{ usuario }`. Último acceso, `online`, y nombre y foto de Google si vienen. Entrar por primera vez es "aceptar la invitación" |

**Editor de usuarios** (decisión Q39). Las que escriben las llama el **backend** con el token del usuario, porque después actualiza `accesos/{email}` en Firestore con el `usuario` de la respuesta (diseño §6.2):

| Acción | Función | Quién | Params → Info |
|--------|---------|-------|---------------|
| `Hub.consultaRolesModulo` | `consulta_roles_modulo` | Cualquier usuario activo | `modulo?` → `{ roles: [{ modulo, rol, nombre, descripcion, esAdministrador }] }` |
| `Hub.consultaUsuarios` | `consulta_usuarios` | Administrador de algún módulo de la marca | `idMarca`, `modulo?`, `incluyeInactivos?` → `{ usuarios: [UsuarioEnMarca], permisos: { modulos, agencias } }` |
| `Hub.invitaUsuario` | `invita_usuario` | Administrador del módulo en la marca | `email`, `idMarca`, `modulo`, `rol`, `idEquipo?`, `agencias?`, `nombre?` → `{ usuario, creado }`. Crea al usuario como invitado si no existe; el correo lo manda el backend. `ESTADO_INVALIDO`: `YA_TIENE_ROL`, `USUARIO_INACTIVO` |
| `Hub.guardaUsuario` | `guarda_usuario` | Administrador del módulo (roles) / de algún módulo (agencias) | `idUsuario`, `idMarca`, `agencias?`, `modulos?: { modulo: { rol, idEquipo? } \| null }` → `{ usuario }`. Solo toca lo que viene; `null` quita el rol. `ESTADO_INVALIDO`: `PROPIO_ADMINISTRADOR` |
| `Hub.quitaUsuarioDeMarca` | `quita_usuario_de_marca` | Administrador de todos los módulos donde el usuario tiene rol en la marca | `idUsuario`, `idMarca` → `{ usuario }`. `ESTADO_INVALIDO`: `PROPIA_MEMBRESIA` |
| `Hub.cambiaDisponibilidad` | `cambia_disponibilidad` | El propio usuario, o un administrador de una marca que compartan | `esDisponible`, `idUsuario?` → `{ idUsuario, esDisponible }` |

Las agencias se guardan por valor: **el backend las valida contra el API de agencias** antes de llamar (plpgsql no tiene el catálogo). Dar de baja a un usuario en todo el hub (`es_activo`) queda para el super admin, sin acción todavía.

Objeto `Usuario`: `idUsuario`, `email`, `nombre`, `fotoUrl`, `esSuperAdmin`, `esSistema`, `esActivo`, `esDisponible`, `estado`, `ultimoAccesoEn`, `creadoEn`, `marcas` (`[{ idMarca, nombre, agencias, modulos: { modulo: { rol, idEquipo } } }]`).

Objeto `UsuarioEnMarca` (una marca): `idUsuario`, `email`, `nombre`, `fotoUrl`, `esSuperAdmin`, `esActivo`, `esDisponible`, `estado`, `ultimoAccesoEn`, `esInvitado`, `agencias`, `modulos`.

## Diferencias con el diseño

- **`usuarios_roles_modulo.id_equipo` es `text` sin FK**: los equipos siguen en Firestore hasta la Fase 4. Ahí se decide si `hub_cleber.equipos` conserva el id de Firestore (y esta columna pasa a FK tal cual) o usa `bigint` (y se migra la columna).
- **Email sin `citext`**: se guarda en minúsculas con un `CHECK`, sin depender de la extensión.
- **`es_activo`** (nuevo) separa "puede entrar" de `estado`, que sigue siendo la presencia (`online` / `away` / `offline`).
- La acción es **`Hub.consultaUsuarioActual`** (no `usuarioActual`) para no chocar con el helper `hub_cleber.usuario_actual()`.

## Núcleo de conversaciones (rebanada 1 de la mudanza a AWS)

Equipos, bots, números, conversaciones, mensajes y bitácora, con las acciones que usa el backend del hub en AWS (pipeline, contrato ①) y las del dashboard (configuración, bandeja, chat). Diseño: [`Arquitectura/DISENO_BACKEND_AWS.md`](../../Arquitectura/DISENO_BACKEND_AWS.md). Requiere `clientes.normaliza_telefono` (`DB/Clientes` de `toma-unidades-en-taller`).

Reglas:
- **Un número por módulo y marca** (A8): a lo más uno activo por (marca, módulo), y un teléfono activo en un solo número.
- **Una conversación abierta por número + cliente**. El número dice la marca y el módulo; `id_bot` es el bot que contesta ahora.
- Ids `text` en equipos, bots, números y conversaciones: lo importado de Firestore conserva su id (sin traducir referencias); lo nuevo recibe un UUID en texto. Mensajes y bitácora: `bigint` (en JSON van como texto).
- Teléfonos en E.164. Los de **clientes** con la regla de `clientes.normaliza_telefono` (`+52` + 10 dígitos; quita el 1 de `+521…`). Los de los **números propios** (remitentes) tal como están registrados en el proveedor (`hub_cleber.telefono_numero`): Twilio rechaza el envío (63007) si el `From` no es exactamente el remitente, y en México suele estar registrado como `+521…`.
- **Ninguna credencial en la base**: `config` de bots y `configProveedor` / `plantillas` de números rechazan llaves de credenciales; van en Secrets Manager y `secretos_configurados` solo dice cuáles están puestas.
- Cada cambio de una conversación sube `version` (el aviso de tiempo real la lleva).

Permisos: configurar un módulo = administrador del módulo en la marca (o super admin; el sistema para importar). Ver conversaciones: el administrador del módulo ve todas las de la marca; los demás roles, solo las de su equipo en ese módulo (como `canAccessTeam` de las reglas de Firestore).

| Acción | Función | Quién | Params → Info |
|--------|---------|-------|---------------|
| `Hub.guardaEquipo` | `guarda_equipo` | Administrador del módulo / sistema | `idEquipo?`, `idMarca`, `modulo`, `nombre`, `modoAsignacion?`, `maxConversacionesAgente?`, `accionOptOut?`, `umbralesSemaforo?`, `esActivo?` → `{ equipo, creado }` |
| `Hub.guardaBot` | `guarda_bot` | Administrador del módulo / sistema | `idBot?`, `idMarca`, `modulo`, `nombre`, `tipo?`, `categoria?`, `config?`, `esActivo?` → `{ bot, creado }` |
| `Hub.guardaNumero` | `guarda_numero` | Administrador del módulo / sistema | `idNumero?`, `idMarca`, `modulo`, `telefono`, `nombre`, `proveedor`, `idEquipo?`, `idBotDefault?`, `ventanaReaperturaHoras?`, `horasCierreInactividad?`, `webhookCierreUrl?`, `plantillas?`, `configProveedor?`, `esActivo?` → `{ numero, creado }`. `ESTADO_INVALIDO`: `TELEFONO_EN_USO`, `NUMERO_EXISTENTE` |
| `Hub.marcaSecretosConfigurados` | `marca_secretos_configurados` | Sistema | `tipo` (numero/bot), `id`, `secretos[]` → `{ numero }` o `{ bot }` |
| `Hub.consultaConfiguracionModulo` | `consulta_configuracion_modulo` | Cualquier rol del módulo / sistema | `idMarca`, `modulo` → `{ equipos, numeros, bots, puedeEditar }` |
| `Hub.resuelveNumero` | `resuelve_numero` | Sistema | `telefono` o `metaPhoneNumberId` o `idMarca` + `modulo` → `{ numero, botDefault, equipo, marca }` |
| `Hub.obtieneOAbreConversacion` | `obtiene_o_abre_conversacion` | Sistema | `idNumero`, `telefonoCliente`, `nombreCliente?`, `claveCliente?`, `horasSesion?` (24), `limiteHistorial?` (40) → `{ conversacion, origen: abierta/reabierta/nueva, historial }` |
| `Hub.guardaMensaje` | `guarda_mensaje` | Sistema | `idConversacion`, `remitente`, `texto?`, `mediaUrl?`, `idMensajeProveedor?`, `idAgente?`, `esPlantilla?` → `{ mensaje, conversacion, duplicado }`. Idempotente por `idMensajeProveedor` |
| `Hub.actualizaConversacion` | `actualiza_conversacion` | Sistema | `idConversacion` + los campos que cambian (estado, agente, equipo, bot, sesión del bot, resultado, metadatos…), `versionEsperada?` → `{ conversacion, anterior }`. `CONFLICTO_VERSION`; `ESTADO_INVALIDO`: `CONVERSACION_ABIERTA` |
| `Hub.abreConversacionExterna` | `abre_conversacion_externa` | Sistema (contrato ①) | `fuente`, `idExterno`, `idMarca`, `modulo`, `telefono`, `nombreCliente?`, `claveCliente?`, `contexto?` → `{ conversacion, numero, creada }`. Idempotente por `fuente` + `idExterno`. `ESTADO_INVALIDO`: `SIN_NUMERO`, `CONVERSACION_ABIERTA` |
| `Hub.registraBitacora` | `registra_bitacora` | Sistema | `idConversacion`, `accion`, `origen`, `idUsuario?`, `idTurno?`, `datos?` → `{ idBitacora }` |
| `Hub.consultaConversaciones` | `consulta_conversaciones` | Rol del módulo (por equipo) / sistema | `idMarca`, `modulo`, `estados?`, `idEquipo?`, `idAgente?`, `busqueda?`, `antesDe?`, `limite?` → `{ conversaciones, hayMas }` |
| `Hub.consultaMensajes` | `consulta_mensajes` | Quien ve la conversación / sistema | `idConversacion`, `desdeIdMensaje?` o `antesDeIdMensaje?`, `limite?`, `incluyeSistema?` → `{ conversacion, mensajes, hayMas }` |

Pruebas: `Pruebas/pruebas_conversaciones.sql` (misma forma que `pruebas_flujo.sql`).

### Operación del asesor

Las llama el **backend con el token del usuario** (Q21), porque después publica el aviso de tiempo real y, en el caso del mensaje, lo manda al proveedor. Reglas de `core/authz.py`:
- **Leer**: quien ve la conversación (administrador del módulo: toda la marca; los demás: su equipo).
- **Escribir**: rol del módulo que no sea `CONSULTA`. Si está `with_agent`, solo su asesor o un administrador del módulo.
- **Tomar, asignar y transferir de equipo**: administrador del módulo.

Todas aceptan `versionEsperada?` (→ `CONFLICTO_VERSION`), regresan `{ conversacion }` salvo que se diga otra cosa, y dejan su entrada en la bitácora (origen `usuario`). Un estado que no corresponde da `ESTADO_INVALIDO` con `motivo: ESTADO_ACTUAL` y el `estado`.

| Acción | Función | Quién | Params / efecto |
|--------|---------|-------|-----------------|
| `Hub.tomaConversacion` | `toma_conversacion` | Administrador | `waiting_agent` → `with_agent` con él; empieza a medir la espera |
| `Hub.asignaConversacion` | `asigna_conversacion` | Administrador | `idAgente` (activo, rol que escribe, ve la conversación) → `with_agent` |
| `Hub.transfiereEquipo` | `transfiere_equipo` | Administrador | `idEquipo` (mismo módulo y marca, activo) → `waiting_agent` sin asesor |
| `Hub.devuelveAlBot` | `devuelve_al_bot` | Escribe | `with_agent` → `bot` sin asesor |
| `Hub.cierraConversacion` | `cierra_conversacion` | Escribe | `motivo` → `closed`, cierre manual (si el cliente vuelve, se abre otra) |
| `Hub.reabreConversacion` | `reabre_conversacion` | Escribe | `closed` → `bot`. `ESTADO_INVALIDO` con `CONVERSACION_ABIERTA` si el cliente ya tiene otra abierta en el número |
| `Hub.renombraCliente` | `renombra_cliente` | Escribe | `nombreCliente` (null lo borra) |
| `Hub.agregaNota` | `agrega_nota` | Escribe | `texto` → `{ nota }` |
| `Hub.consultaNotas` | `consulta_notas` | Lee | → `{ notas }` |
| `Hub.autorizaMensajeAgente` | `autoriza_mensaje_agente` | Escribe | Paso 1, antes de mandar al proveedor → `{ conversacion, numero }` |
| `Hub.registraMensajeAgente` | `registra_mensaje_agente` | Escribe | Paso 2, ya enviado: `texto?`, `mediaUrl?` (https), `idMensajeProveedor?` → `{ mensaje, conversacion, duplicado }`. Si estaba con el bot o esperando, el asesor la toma; la primera respuesta del ciclo guarda su tiempo en `tiemposRespuesta` |

**Migración** para bases donde `conversaciones` ya existía: `Migraciones/001_conversaciones_operacion.sql` (columnas `motivo_cierre`, `asignada_en`, `espera_desde`, `primera_respuesta_en`, `tiempos_respuesta`). Se corre **antes** de `Alta_db.sql`, que crea `notas` y reemplaza las funciones.

Falta: etiquetas (catálogo `hub_cleber.etiquetas`) y la cita con agente de Ventas, que van con la rebanada de Ventas y Servicio; y la FK de `usuarios_roles_modulo.id_equipo` a `equipos` (en `Migraciones/` cuando los equipos de los usuarios existan en la tabla).

## Pendientes

- **Valuación** (`toma-unidades-en-taller`): definir en `valuacion.roles_permisos` los permisos de `GERENTE`.
- Editor de usuarios: falta mandar el **correo de invitación** al dar de alta a alguien (la pantalla es `apps/web/src/components/hub/UsuariosView.tsx`; las acciones, `apps/web/src/lib/hub/usuarios.ts`).
- Bitácora de cambios de usuarios (la tabla `hub_cleber.bitacora` ya existe, pero es por conversación).
- Que un email de servicio solo valga por `/internal` depende de API Gateway; plpgsql no ve la ruta (diseño §4.3).
