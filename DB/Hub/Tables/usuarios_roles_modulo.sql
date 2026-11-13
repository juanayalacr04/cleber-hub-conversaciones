-- Rol del usuario en cada módulo de cada marca (Q36). Ej.: (juan, marca-a, valuacion, VALUADOR) y
-- (juan, marca-b, valuacion, GERENTE). No hay rol global: tener una fila aquí es lo que da acceso al módulo en la marca.
--
-- El rol debe existir en el catálogo hub_cleber.roles_modulo; sus permisos los define el módulo.
-- id_equipo (Q38) va por valor (id del documento teams/{id} de Firestore) mientras los equipos sigan en Firestore;
-- en la Fase 4, al crear hub_cleber.equipos, se convierte en FK.
-- Si el usuario sale de la marca (usuarios_organizaciones), sus roles en ella se borran en cascada.
-- Los usuarios de sistema no tienen filas: se reconocen por usuarios.es_sistema.
CREATE TABLE IF NOT EXISTS hub_cleber.usuarios_roles_modulo (
  id_usuario        bigint      NOT NULL,
  id_organizacion   text        NOT NULL,
  modulo            text        NOT NULL,
  rol               text        NOT NULL,
  id_equipo         text,
  creado_en         timestamptz NOT NULL DEFAULT now(),
  actualizado_en    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_usuarios_roles_modulo PRIMARY KEY (id_usuario, id_organizacion, modulo),
  CONSTRAINT fk_usuarios_roles_modulo_membresia FOREIGN KEY (id_usuario, id_organizacion)
    REFERENCES hub_cleber.usuarios_organizaciones (id_usuario, id_organizacion) ON DELETE CASCADE,
  CONSTRAINT fk_usuarios_roles_modulo_rol FOREIGN KEY (modulo, rol) REFERENCES hub_cleber.roles_modulo (modulo, rol)
);

CREATE INDEX IF NOT EXISTS ix_usuarios_roles_modulo_organizacion ON hub_cleber.usuarios_roles_modulo (id_organizacion, modulo);
