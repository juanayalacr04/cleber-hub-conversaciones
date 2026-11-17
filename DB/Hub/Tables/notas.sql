-- Nota interna de una conversación (sale de conversations/{id}/notes de Firestore). No la ve el cliente.
-- nombre_autor se guarda por valor: la nota conserva quién la escribió aunque el usuario cambie de nombre.
CREATE TABLE IF NOT EXISTS hub_cleber.notas (
  id_nota          bigint      GENERATED ALWAYS AS IDENTITY,
  id_conversacion  text        NOT NULL,
  id_autor         uuid        NOT NULL,
  nombre_autor     text        NOT NULL,
  texto            text        NOT NULL,
  id_origen        text,
  creado_en        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_notas PRIMARY KEY (id_nota),
  CONSTRAINT fk_notas_conversacion FOREIGN KEY (id_conversacion) REFERENCES hub_cleber.conversaciones (id_conversacion),
  CONSTRAINT chk_notas_texto CHECK (btrim(texto) <> '')
);

CREATE INDEX IF NOT EXISTS ix_notas_conversacion ON hub_cleber.notas (id_conversacion, id_nota);
CREATE UNIQUE INDEX IF NOT EXISTS ux_notas_origen ON hub_cleber.notas (id_origen) WHERE id_origen IS NOT NULL;
