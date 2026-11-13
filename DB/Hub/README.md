# DB — schema `hub_cleber` (adelanto de identidad)

Usuarios y organizaciones del hub en PostgreSQL. Es el **adelanto de la Fase 3** del plan de valuación (`toma-unidades-en-taller/docs/plan-de-trabajo.md`): valuación deja de recibir `X-User-Contexto` y obtiene el rol y las agencias del usuario con `hub_cleber.usuarios_contexto`.

**El catálogo de agencias no vive en el hub**: viene de un API externo (decisión Q34). El hub solo guarda, por valor, los ids de agencia asignados a cada usuario en cada marca; el editor de usuarios consulta ese API para mostrarlas y validarlas. El resto del schema (equipos, números, bots, conversaciones, mensajes…) entra en la Fase 4.

Diseño: [`Arquitectura/DISENO_MIGRACION_POSTGRES.md`](../../Arquitectura/DISENO_MIGRACION_POSTGRES.md) §4.2 y §5. Mismas convenciones que `DB/Valuacion` y `DB/Clientes` de `toma-unidades-en-taller` (envelope, errores, un archivo por acción). Ubicación **provisional** (Q6): se mueve cuando se decida dónde vive el DDL.

## Estructura

```
DB/Hub/
├── Alta_db.sql                 Script maestro (una transacción; re-ejecutable)
├── Tables/                     log_errores, organizaciones, usuarios, usuarios_organizaciones, usuarios_roles_modulo
├── Functions/
│   ├── Helpers/                errores, peticion, seguridad (identidad y permisos), usuario_json
│   └── Acciones/               consulta_usuario_actual, importa_usuarios
├── Datos_maestros/             usuarios_sistema (emails de servicio)
└── Pruebas/                    pruebas_flujo.sql (en una transacción con ROLLBACK)
```

## Alta, pruebas y carga (solo desarrollo/QA)

Requiere el schema `cleber` del repo `api`. Desde una base de desarrollo:

```
cd <ruta del repo>/DB/Hub
psql -h <host> -p <puerto> -U <usuario> -d <database> -f Alta_db.sql -q
psql -h <host> -p <puerto> -U <usuario> -d <database> -f Pruebas/pruebas_flujo.sql -q
```

Carga de los usuarios y las organizaciones actuales de Firestore (dev). El script solo lee Firestore y **genera** un `.sql`; no se conecta a PostgreSQL:

```
$env:GOOGLE_CLOUD_PROJECT="ambiente-desarrollo-ti"; $env:FIRESTORE_DATABASE="dev-hub-conversaciones"
python dev/carga_usuarios_hub.py --salida <fuera del repo>/carga_hub.sql
psql -h <host> -p <puerto> -U <usuario> -d <database> -f <fuera del repo>/carga_hub.sql
```

Del usuario se copian los ids de `orgAgencies` si existen (hoy no existen en Firestore, así que quedan vacías).

Después de la carga, para darse de alta en valuación hay que asignar el rol del módulo (hoy no existe `moduleRoles` en Firestore). Mientras no exista el editor de usuarios, se hace con otra carga que traiga `rolesModulo`, o a mano en dev.

## Identidad

| Quién | Ruta | `X-User-Email` | En `hub_cleber.usuarios` |
|-------|------|----------------|-------------------|
| Usuario del dashboard | `/hub` (Lambda authorizer de Google) | Lo inyecta API Gateway desde el token | `es_sistema = false`, `rol` global |
| Backend del hub | `/internal` (`AWS_IAM`) | `sistema@hub-conversaciones.internal` | `es_sistema = true`, sin rol global |
| Lambda de valuación | `/internal` | `sistema@toma-unidades.internal` | `es_sistema = true`, rol `SISTEMA` en `valuacion` |

Helpers (`Functions/Helpers/seguridad.sql`):

| Helper | Uso |
|--------|-----|
| `hub_cleber.usuario_actual()` | Fila de `hub_cleber.usuarios` del `X-User-Email` (activo). Sin header, sin usuario o inactivo → `SIN_PERMISO` |
| `hub_cleber.exige_sistema(usuario)` | Solo emails de servicio |
| `hub_cleber.exige_rol(usuario, roles[])` | Rol global (`admin` / `agent` / `viewer`); el super admin pasa siempre |
| `hub_cleber.tiene_organizacion` / `hub_cleber.exige_organizacion(usuario, idOrganizacion)` | Super admin y sistema: todas |
| `hub_cleber.rol_modulo(usuario, modulo)` | Rol por módulo o `NULL` |
| `hub_cleber.agencias_permitidas(usuario, idOrganizacion)` | Ids asignados; `NULL` = sin restricción (super admin y sistema), `{}` = ninguna |
| `hub_cleber.usuarios_contexto(email, modulo)` | Para **valuación**, por valor: `{ email, rol, esSuperAdmin, esSistema, agencias: { idOrganizacion: [idAgencia] } }`; `NULL` si no existe o está inactivo. `SECURITY DEFINER` |

## Acciones

| Acción | Función | Quién | Info |
|--------|---------|-------|------|
| `Hub.consultaUsuarioActual` | `consulta_usuario_actual` | Cualquier usuario activo | `{ usuario, organizacionesVisibles }` |
| `Hub.importaUsuarios` | `importa_usuarios` | Sistema | `{ organizaciones, usuarios: { creados, actualizados } }`. Idempotente, todo o nada; lo que viene reemplaza lo guardado (incluidas las marcas y roles del usuario), lo que no viene no se toca |

Objeto `Usuario`: `idUsuario`, `email`, `nombre`, `fotoUrl`, `rol`, `esSuperAdmin`, `esSistema`, `esActivo`, `esDisponible`, `estado`, `ultimoAccesoEn`, `creadoEn`, `organizaciones` (`[{ idOrganizacion, nombre, idEquipo, agencias }]`), `rolesModulo` (`{ modulo: ROL }`).

## Diferencias con el diseño

- **`usuarios_organizaciones.id_equipo` es `text` sin FK**: los equipos siguen en Firestore hasta la Fase 4. Ahí se decide si `hub_cleber.equipos` conserva el id de Firestore (y esta columna pasa a FK tal cual) o usa `bigint` (y se migra la columna).
- **Email sin `citext`**: se guarda en minúsculas con un `CHECK`, sin depender de la extensión.
- **`es_activo`** (nuevo) separa "puede entrar" de `estado`, que sigue siendo la presencia (`online` / `away` / `offline`).
- La acción es **`Hub.consultaUsuarioActual`** (no `usuarioActual`) para no chocar con el helper `hub_cleber.usuario_actual()`.

## Pendientes

- Grants del rol de PostgREST sobre `hub_cleber` en un script versionado (igual que en valuación) y no exponer los helpers.
- Definir el API del catálogo de agencias y qué id expone (debe coincidir con `valuacion.configuraciones_agencias.id_agencia`).
- El editor de usuarios (`consultaUsuarios`, `invitaUsuario`, `guardaUsuario`, …) y la copia `accesos/{email}` en Firestore.
- Que un email de servicio solo valga por `/internal` depende de API Gateway; plpgsql no ve la ruta (diseño §4.3).
