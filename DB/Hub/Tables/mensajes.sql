-- Mensaje de una conversación (sale de conversations/{id}/messages de Firestore).
--
-- remitente: customer · bot · agent · system (system = contexto para el bot, p. ej. <<CONTEXTO>>; no cuenta como
-- último mensaje de la conversación).
-- id_mensaje_proveedor es UNIQUE: hace idempotente el registro de un mensaje (sustituye processed_events).
-- id_origen: id del documento de Firestore en los importados (importación idempotente).
CREATE TABLE IF NOT EXISTS hub_cleber.mensajes (
  id_mensaje            bigint      GENERATED ALWAYS AS IDENTITY,
  id_conversacion       text        NOT NULL,
  remitente             text        NOT NULL,
  id_agente             uuid,
  texto                 text,
  media_url             text,
  es_plantilla          boolean     NOT NULL DEFAULT false,
  id_mensaje_proveedor  text,
  id_origen             text,
  creado_en             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_mensajes PRIMARY KEY (id_mensaje),
  CONSTRAINT fk_mensajes_conversacion FOREIGN KEY (id_conversacion) REFERENCES hub_cleber.conversaciones (id_conversacion),
  CONSTRAINT chk_mensajes_remitente CHECK (remitente IN ('customer', 'bot', 'agent', 'system')),
  CONSTRAINT chk_mensajes_contenido CHECK (texto IS NOT NULL OR media_url IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_mensajes_proveedor ON hub_cleber.mensajes (id_mensaje_proveedor) WHERE id_mensaje_proveedor IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_mensajes_origen ON hub_cleber.mensajes (id_origen) WHERE id_origen IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_mensajes_conversacion ON hub_cleber.mensajes (id_conversacion, id_mensaje);
