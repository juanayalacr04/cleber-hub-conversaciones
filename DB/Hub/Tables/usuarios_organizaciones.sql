-- Marcas a las que pertenece el usuario. Reemplaza users.organizationIds + orgAgencies.
-- Sus roles y equipos en cada módulo de la marca van en usuarios_roles_modulo (Q36, Q38).
--
-- agencias: ids de agencia por valor, los mismos para todos los módulos de la marca (Q38). El catálogo NO vive en
-- el hub (viene de un API externo, Q34); el editor de usuarios muestra y valida las opciones contra ese API.
CREATE TABLE IF NOT EXISTS hub_cleber.usuarios_organizaciones (
  id_usuario        bigint      NOT NULL,
  id_organizacion   text        NOT NULL,
  agencias          text[]      NOT NULL DEFAULT '{}',
  creado_en         timestamptz NOT NULL DEFAULT now(),
  actualizado_en    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_usuarios_organizaciones PRIMARY KEY (id_usuario, id_organizacion),
  CONSTRAINT fk_usuarios_organizaciones_usuario FOREIGN KEY (id_usuario) REFERENCES hub_cleber.usuarios (id_usuario) ON DELETE CASCADE,
  CONSTRAINT fk_usuarios_organizaciones_organizacion FOREIGN KEY (id_organizacion) REFERENCES hub_cleber.organizaciones (id_organizacion)
);

CREATE INDEX IF NOT EXISTS ix_usuarios_organizaciones_organizacion ON hub_cleber.usuarios_organizaciones (id_organizacion);
