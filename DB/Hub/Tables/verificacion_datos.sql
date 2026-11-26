-- Verificación de un dato del cliente que pide otro sistema (Salesforce): hoy el teléfono de WhatsApp; el correo está previsto.
-- id_externo es el ID opaco que manda el sistema origen (el hub no sabe a qué objeto pertenece) y es único: el mismo ID es la misma
-- verificación. id_conversacion es opcional porque la verificación de un correo no pasa por una conversación de WhatsApp.
-- estado: pendiente (sin respuesta; el sistema origen conserva su estatus) | valido | no_valido.
-- callback_*: entrega del resultado al sistema origen. NULL mientras la verificación esté pendiente; después pendiente | enviado | fallido.
CREATE TABLE IF NOT EXISTS hub_cleber.verificacion_datos (
  id_verificacion        bigint      GENERATED ALWAYS AS IDENTITY,
  id_marca               text        NOT NULL,
  tipo                   text        NOT NULL DEFAULT 'telefono',
  valor                  text        NOT NULL,
  id_externo             text        NOT NULL,
  id_conversacion        text,
  estado                 text        NOT NULL DEFAULT 'pendiente',
  resuelto_en            timestamptz,
  callback_estado        text,
  callback_intentos      integer     NOT NULL DEFAULT 0,
  callback_ultimo_error  text,
  callback_ultimo_intento_en timestamptz,
  callback_enviado_en    timestamptz,
  creado_en              timestamptz NOT NULL DEFAULT now(),
  actualizado_en         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_verificacion_datos PRIMARY KEY (id_verificacion),
  CONSTRAINT fk_verificacion_datos_marca FOREIGN KEY (id_marca) REFERENCES hub_cleber.marcas (id_marca),
  CONSTRAINT fk_verificacion_datos_conversacion FOREIGN KEY (id_conversacion) REFERENCES hub_cleber.conversaciones (id_conversacion),
  CONSTRAINT chk_verificacion_datos_tipo CHECK (tipo IN ('telefono', 'correo')),
  CONSTRAINT chk_verificacion_datos_estado CHECK (estado IN ('pendiente', 'valido', 'no_valido')),
  CONSTRAINT chk_verificacion_datos_callback CHECK (callback_estado IS NULL OR callback_estado IN ('pendiente', 'enviado', 'fallido')),
  CONSTRAINT chk_verificacion_datos_resuelto CHECK ((estado = 'pendiente') = (resuelto_en IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_verificacion_datos_externo ON hub_cleber.verificacion_datos (id_externo);
CREATE INDEX IF NOT EXISTS ix_verificacion_datos_marca ON hub_cleber.verificacion_datos (id_marca, creado_en DESC);
CREATE INDEX IF NOT EXISTS ix_verificacion_datos_conversacion ON hub_cleber.verificacion_datos (id_conversacion) WHERE id_conversacion IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_verificacion_datos_callback ON hub_cleber.verificacion_datos (callback_estado) WHERE callback_estado IN ('pendiente', 'fallido');
