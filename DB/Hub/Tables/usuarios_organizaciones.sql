-- Marcas a las que pertenece el usuario. Reemplaza users.organizationIds + orgTeams + orgAgencies.
--
-- id_equipo va por valor (id del documento teams/{id} de Firestore) mientras los equipos sigan en Firestore.
-- En la Fase 4, al crear hub_cleber.equipos, se convierte en FK.
-- agencias: ids de agencia por valor. El catálogo NO vive en el hub (viene de un API externo); quien edita al usuario
-- (editor de usuarios) muestra y valida las opciones contra ese API.
CREATE TABLE IF NOT EXISTS hub_cleber.usuarios_organizaciones (
  id_usuario        bigint      NOT NULL,
  id_organizacion   text        NOT NULL,
  id_equipo         text,
  agencias          text[]      NOT NULL DEFAULT '{}',
  creado_en         timestamptz NOT NULL DEFAULT now(),
  actualizado_en    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_usuarios_organizaciones PRIMARY KEY (id_usuario, id_organizacion),
  CONSTRAINT fk_usuarios_organizaciones_usuario FOREIGN KEY (id_usuario) REFERENCES hub_cleber.usuarios (id_usuario) ON DELETE CASCADE,
  CONSTRAINT fk_usuarios_organizaciones_organizacion FOREIGN KEY (id_organizacion) REFERENCES hub_cleber.organizaciones (id_organizacion)
);

CREATE INDEX IF NOT EXISTS ix_usuarios_organizaciones_organizacion ON hub_cleber.usuarios_organizaciones (id_organizacion);
