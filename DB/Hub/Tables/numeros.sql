-- Número de WhatsApp (sale de whatsappNumbers de Firestore).
--
-- Cada módulo tiene su propio número en cada marca (decisión A8, 2026-11-17): a lo más un número activo por
-- (marca, módulo), y un teléfono no puede estar activo en dos números.
-- telefono en E.164 tal como está registrado en el proveedor (en México puede ser +521...), sin "whatsapp:";
-- hub_cleber.telefono_numero, no la regla de clientes (que quita el 1).
-- config_proveedor: ids no secretos del proveedor (metaPhoneNumberId, valuetextSenderId). Twilio no lleva nada: todos los
-- números están en una sola cuenta, que el backend toma del secreto del ambiente (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN).
-- plantillas: plantillas por uso (handoff de servicio, cierre por inactividad, situación, oferta de valuación...).
-- Los tokens de Meta (acceso y verificación del webhook) van en Secrets Manager; secretos_configurados dice cuáles ya
-- están puestos.
CREATE TABLE IF NOT EXISTS hub_cleber.numeros (
  id_numero                  text        NOT NULL DEFAULT gen_random_uuid()::text,
  id_marca                   text        NOT NULL,
  modulo                     text        NOT NULL,
  telefono                   text        NOT NULL,
  nombre                     text        NOT NULL,
  proveedor                  text        NOT NULL,
  id_equipo                  text,
  id_bot_default             text,
  ventana_reapertura_horas   integer     NOT NULL DEFAULT 96,   -- 0 = no se reabren conversaciones cerradas
  horas_cierre_inactividad   integer,
  webhook_cierre_url         text,
  plantillas                 jsonb       NOT NULL DEFAULT '{}',
  config_proveedor           jsonb       NOT NULL DEFAULT '{}',
  secretos_configurados      text[]      NOT NULL DEFAULT '{}',
  es_activo                  boolean     NOT NULL DEFAULT true,
  creado_en                  timestamptz NOT NULL DEFAULT now(),
  actualizado_en             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_numeros PRIMARY KEY (id_numero),
  CONSTRAINT fk_numeros_marca FOREIGN KEY (id_marca) REFERENCES hub_cleber.marcas (id_marca),
  CONSTRAINT fk_numeros_equipo FOREIGN KEY (id_equipo) REFERENCES hub_cleber.equipos (id_equipo),
  CONSTRAINT fk_numeros_bot FOREIGN KEY (id_bot_default) REFERENCES hub_cleber.bots (id_bot),
  CONSTRAINT chk_numeros_modulo CHECK (modulo IN ('ventas', 'servicio', 'valuacion')),
  CONSTRAINT chk_numeros_proveedor CHECK (proveedor IN ('twilio', 'meta', 'valuetext')),
  CONSTRAINT chk_numeros_telefono CHECK (telefono ~ '^\+[0-9]{8,15}$'),
  CONSTRAINT chk_numeros_ventana CHECK (ventana_reapertura_horas >= 0),
  CONSTRAINT chk_numeros_cierre CHECK (horas_cierre_inactividad > 0),
  CONSTRAINT chk_numeros_plantillas CHECK (jsonb_typeof(plantillas) = 'object'),
  CONSTRAINT chk_numeros_config CHECK (jsonb_typeof(config_proveedor) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_numeros_telefono_activo ON hub_cleber.numeros (telefono) WHERE es_activo;
CREATE UNIQUE INDEX IF NOT EXISTS ux_numeros_marca_modulo_activo ON hub_cleber.numeros (id_marca, modulo) WHERE es_activo;
CREATE UNIQUE INDEX IF NOT EXISTS ux_numeros_meta_activo ON hub_cleber.numeros ((config_proveedor->>'metaPhoneNumberId'))
  WHERE es_activo AND config_proveedor ? 'metaPhoneNumberId';
