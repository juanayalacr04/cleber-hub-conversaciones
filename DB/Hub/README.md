# DB — schema `hub_cleber` (adelanto de identidad)

Usuarios y organizaciones del hub en PostgreSQL. Es el **adelanto de la Fase 3** del plan de valuación (`toma-unidades-en-taller/docs/plan-de-trabajo.md`): valuación deja de recibir `X-User-Contexto` y obtiene el rol y las agencias del usuario con `hub_cleber.usuarios_contexto`.

**Roles por marca y módulo (Q36–Q39).** No hay rol global: cada usuario tiene un rol en cada módulo (`ventas`, `servicio`, `valuacion`) de cada marca, tomado del catálogo `hub_cleber.roles_modulo`. Tener rol en un módulo de una marca es lo que da acceso a él. Lo que puede hacer cada rol lo define el módulo (valuación: `valuacion.roles_permisos`). Solo `es_super_admin` vale en todo.

**El catálogo de agencias no vive en el hub**: viene de un API externo (Q34). El hub solo guarda, por valor, los ids de agencia asignados a cada usuario en cada marca (los mismos para todos los módulos de la marca); el editor de usuarios consulta ese API para mostrarlas y validarlas. El resto del schema (equipos, números, bots, conversaciones, mensajes…) entra en la Fase 4.

Diseño: [`Arquitectura/DISENO_MIGRACION_POSTGRES.md`](../../Arquitectura/DISENO_MIGRACION_POSTGRES.md) §4.2 y §5. Mismas convenciones que `DB/Valuacion` y `DB/Clientes` de `toma-unidades-en-taller` (envelope, errores, un archivo por acción). Ubicación **provisional** (Q6): se mueve cuando se decida dónde vive el DDL.

## Estructura

```
DB/Hub/
├── Alta_db.sql                 Script maestro (una transacción; re-ejecutable)
├── Tables/                     log_errores, organizaciones, usuarios, usuarios_organizaciones, roles_modulo, usuarios_roles_modulo
├── Functions/
│   ├── Helpers/                errores, peticion, seguridad (identidad y permisos), usuario_json
│   └── Acciones/               consulta_usuario_actual, importa_usuarios
├── Datos_maestros/             roles_modulo (catálogo), usuarios_sistema (emails de servicio)
├── Migraciones/                cambios de estructura sobre una base ya dada de alta
└── Pruebas/                    pruebas_flujo.sql (en una transacción con ROLLBACK)
```

## Alta, pruebas y carga (solo desarrollo/QA)

Requiere el schema `cleber` del repo `api`. Desde una base de desarrollo:

```
cd <ruta del repo>/DB/Hub
psql -h <host> -p <puerto> -U <usuario> -d <database> -f Alta_db.sql -q
psql -h <host> -p <puerto> -U <usuario> -d <database> -f Pruebas/pruebas_flujo.sql -q
```

`Alta_db.sql` crea las tablas con `IF NOT EXISTS`, así que **no cambia la estructura de una tabla que ya existe**. Esos cambios van en `Migraciones/`, y se corren **antes** de `Alta_db.sql`:

| Migración | Para una base dada de alta antes de… | Qué hace |
|-----------|--------------------------------------|----------|
| `001_roles_por_marca_y_modulo.sql` | 2026-11-13 (con `usuarios.rol`) | Catálogo de roles; rol por marca y módulo; copia `usuarios.rol` a ventas y servicio en cada marca y los roles de módulo anteriores a cada marca del usuario. Los equipos no se copian: se llenan con la carga. Re-ejecutable |

Carga de los usuarios y las organizaciones actuales de Firestore (dev). El script solo lee Firestore y **genera** un `.sql`; no se conecta a PostgreSQL:

```
$env:GOOGLE_CLOUD_PROJECT="ambiente-desarrollo-ti"; $env:FIRESTORE_DATABASE="dev-hub-conversaciones"
python dev/carga_usuarios_hub.py --salida <fuera del repo>/carga_hub.sql
psql -h <host> -p <puerto> -U <usuario> -d <database> -f <fuera del repo>/carga_hub.sql
```

- El rol de Firestore (`role`, uno por usuario) se carga como rol de **ventas y servicio** en cada marca del usuario: `admin` → `ADMINISTRADOR`, `agent` → `AGENTE`, `viewer` → `CONSULTA`. El equipo de la marca va al módulo de su vertical.
- La carga maneja solo ventas y servicio (`modulos`): **no toca los roles de valuación**. Esos se asignan en el editor de usuarios (mientras no exista, a mano en dev).
- De agencias se copian los ids de `orgAgencies` si existen (hoy no existen en Firestore, así que quedan vacías).

## Identidad

| Quién | Ruta | `X-User-Email` | En `hub_cleber.usuarios` |
|-------|------|----------------|-------------------|
| Usuario del dashboard | `/hub` (Lambda authorizer de Google) | Lo inyecta API Gateway desde el token | `es_sistema = false`; roles en `usuarios_roles_modulo` |
| Backend del hub | `/internal` (`AWS_IAM`) | `sistema@hub-conversaciones.internal` | `es_sistema = true`, sin roles del catálogo |
| Lambda de valuación | `/internal` | `sistema@toma-unidades.internal` | `es_sistema = true`, sin roles del catálogo; valuación le da `SISTEMA` por su email |

## Roles

Catálogo (`Datos_maestros/roles_modulo.sql`):

| Módulo | Roles (el primero administra el módulo en la marca) |
|--------|-------|
| `ventas` | `ADMINISTRADOR`, `AGENTE`, `CONSULTA` |
| `servicio` | `ADMINISTRADOR`, `AGENTE`, `CONSULTA` |
| `valuacion` | `ADMINISTRADOR`, `GERENTE`, `VALUADOR`, `CONSULTA` |

Quién edita a quién (Q39; lo aplicarán las acciones del editor de usuarios):
- **Super admin**: todo.
- **Administrador de un módulo en una marca** (rol con `es_administrador`): asigna y quita los roles de ese módulo en esa marca, incluido el equipo.
- **Agencias** del usuario en una marca: cualquier administrador de algún módulo de esa marca.

## Helpers

`Functions/Helpers/seguridad.sql`:

| Helper | Uso |
|--------|-----|
| `hub_cleber.usuario_actual()` | Fila de `hub_cleber.usuarios` del `X-User-Email` (activo). Sin header, sin usuario o inactivo → `SIN_PERMISO` |
| `hub_cleber.exige_sistema(usuario)` | Solo emails de servicio |
| `hub_cleber.tiene_organizacion` / `hub_cleber.exige_organizacion(usuario, idOrganizacion)` | Super admin y sistema: todas |
| `hub_cleber.rol_modulo(usuario, idOrganizacion, modulo)` | Rol del módulo en la marca, o `NULL` |
| `hub_cleber.es_administrador_modulo` / `exige_administrador_modulo(usuario, idOrganizacion, modulo)` | Su rol en ese módulo de la marca es de administrador; super admin siempre |
| `hub_cleber.es_administrador_organizacion` / `exige_administrador_organizacion(usuario, idOrganizacion)` | Administra algún módulo de la marca; super admin siempre |
| `hub_cleber.agencias_permitidas(usuario, idOrganizacion)` | Ids asignados; `NULL` = sin restricción (super admin y sistema), `{}` = ninguna |
| `hub_cleber.usuarios_contexto(email, modulo)` | Para **valuación**, por valor: `{ email, esSuperAdmin, esSistema, marcas: { idOrganizacion: { rol, idEquipo, agencias } } }`, solo las marcas donde tiene rol en el módulo; `NULL` si no existe o está inactivo. `SECURITY DEFINER` |

## Acciones

| Acción | Función | Quién | Info |
|--------|---------|-------|------|
| `Hub.consultaUsuarioActual` | `consulta_usuario_actual` | Cualquier usuario activo | `{ usuario, organizacionesVisibles }` |
| `Hub.importaUsuarios` | `importa_usuarios` | Sistema | `{ organizaciones, usuarios: { creados, actualizados } }`. Idempotente, todo o nada. Lo que viene reemplaza lo guardado (marcas del usuario y, en cada marca, los roles de los módulos que maneja la carga: param `modulos`); lo que no viene no se toca |

Objeto `Usuario`: `idUsuario`, `email`, `nombre`, `fotoUrl`, `esSuperAdmin`, `esSistema`, `esActivo`, `esDisponible`, `estado`, `ultimoAccesoEn`, `creadoEn`, `organizaciones` (`[{ idOrganizacion, nombre, agencias, modulos: { modulo: { rol, idEquipo } } }]`).

## Diferencias con el diseño

- **`usuarios_roles_modulo.id_equipo` es `text` sin FK**: los equipos siguen en Firestore hasta la Fase 4. Ahí se decide si `hub_cleber.equipos` conserva el id de Firestore (y esta columna pasa a FK tal cual) o usa `bigint` (y se migra la columna).
- **Email sin `citext`**: se guarda en minúsculas con un `CHECK`, sin depender de la extensión.
- **`es_activo`** (nuevo) separa "puede entrar" de `estado`, que sigue siendo la presencia (`online` / `away` / `offline`).
- La acción es **`Hub.consultaUsuarioActual`** (no `usuarioActual`) para no chocar con el helper `hub_cleber.usuario_actual()`.

## Pendientes

- **Valuación** (`toma-unidades-en-taller`): adaptar `valuacion.contexto_usuario` y los permisos al nuevo `usuarios_contexto` (rol por marca: el permiso se evalúa con la marca de la oferta), y definir en `valuacion.roles_permisos` los permisos de `GERENTE`.
- Definir el API del catálogo de agencias y qué id expone (debe coincidir con `valuacion.configuraciones_agencias.id_agencia`).
- El editor de usuarios (`consultaUsuarios`, `consultaRolesModulo`, `invitaUsuario`, `guardaUsuario`, …) y la copia `accesos/{email}` en Firestore.
- Que un email de servicio solo valga por `/internal` depende de API Gateway; plpgsql no ve la ruta (diseño §4.3).
