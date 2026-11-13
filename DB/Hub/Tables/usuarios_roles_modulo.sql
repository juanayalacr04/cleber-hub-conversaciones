-- Rol del usuario en cada módulo (moduleRoles). Ej.: (juan, valuacion, VALUADOR).
-- Los códigos de rol los define cada módulo (valuación: valuacion.roles_permisos); aquí solo se guardan.
-- Para valuación cuenta solo este rol, no el global (acciones-valuacion.md §1.4).
CREATE TABLE IF NOT EXISTS hub_cleber.usuarios_roles_modulo (
  id_usuario        bigint      NOT NULL,
  modulo            text        NOT NULL,
  rol               text        NOT NULL,
  creado_en         timestamptz NOT NULL DEFAULT now(),
  actualizado_en    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_usuarios_roles_modulo PRIMARY KEY (id_usuario, modulo),
  CONSTRAINT fk_usuarios_roles_modulo_usuario FOREIGN KEY (id_usuario) REFERENCES hub_cleber.usuarios (id_usuario) ON DELETE CASCADE,
  CONSTRAINT chk_usuarios_roles_modulo_modulo CHECK (modulo IN ('ventas', 'servicio', 'valuacion')),
  CONSTRAINT chk_usuarios_roles_modulo_rol CHECK (rol ~ '^[A-Z][A-Z_]*$')
);
