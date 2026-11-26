-- Catálogo de roles de cada módulo (decisión Q37). El hub guarda qué roles existen para armar el editor de usuarios
-- y validar lo que se asigna; lo que PUEDE hacer cada rol lo define el módulo (valuación: valuacion.roles_permisos;
-- ventas y servicio: su código).
--
-- es_administrador: quien tiene este rol en una marca administra el módulo en esa marca (asigna y quita sus roles).
-- es_supervisor: ve las conversaciones del módulo de todos los equipos, solo de sus agencias (no necesita equipo).
--   Ej. GERENTE de valuación (2026-11-20). El administrador ya las ve todas, de todas las agencias.
-- SISTEMA no está en el catálogo: los usuarios de sistema se reconocen por usuarios.es_sistema.
CREATE TABLE IF NOT EXISTS hub_cleber.roles_modulo (
  modulo            text        NOT NULL,
  rol               text        NOT NULL,
  nombre            text        NOT NULL,                 -- etiqueta para el editor
  descripcion       text        NOT NULL DEFAULT '',
  es_administrador  boolean     NOT NULL DEFAULT false,
  es_supervisor     boolean     NOT NULL DEFAULT false,
  orden             smallint    NOT NULL DEFAULT 0,       -- orden en el selector (de más a menos permisos)
  creado_en         timestamptz NOT NULL DEFAULT now(),
  actualizado_en    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_roles_modulo PRIMARY KEY (modulo, rol),
  CONSTRAINT chk_roles_modulo_modulo CHECK (modulo IN ('ventas', 'servicio', 'valuacion', 'verificacion')),
  CONSTRAINT chk_roles_modulo_rol CHECK (rol ~ '^[A-Z][A-Z_]*$' AND rol <> 'SISTEMA')
);
