-- Marcas a las que pertenece el usuario. Reemplaza users.organizationIds + orgAgencies.
-- Sus roles y equipos en cada módulo de la marca van en usuarios_roles_modulo (Q36, Q38).
--
-- agencias: ids de agencia por valor, los mismos para todos los módulos de la marca (Q38). El catálogo NO vive en
-- el hub (viene de un API externo, Q34); el editor de usuarios muestra y valida las opciones contra ese API.
CREATE TABLE IF NOT EXISTS hub_cleber.usuarios_marcas (
  id_usuario        bigint      NOT NULL,
  id_marca          text        NOT NULL,
  agencias          text[]      NOT NULL DEFAULT '{}',
  creado_en         timestamptz NOT NULL DEFAULT now(),
  actualizado_en    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_usuarios_marcas PRIMARY KEY (id_usuario, id_marca),
  CONSTRAINT fk_usuarios_marcas_usuario FOREIGN KEY (id_usuario) REFERENCES hub_cleber.usuarios (id_usuario) ON DELETE CASCADE,
  CONSTRAINT fk_usuarios_marcas_marca FOREIGN KEY (id_marca) REFERENCES hub_cleber.marcas (id_marca)
);

CREATE INDEX IF NOT EXISTS ix_usuarios_marcas_marca ON hub_cleber.usuarios_marcas (id_marca);
