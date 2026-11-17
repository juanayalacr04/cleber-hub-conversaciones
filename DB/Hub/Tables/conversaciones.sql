-- Conversación (sale de conversations de Firestore).
--
-- Se identifica por número + teléfono del cliente: solo puede haber UNA abierta (estado <> 'closed') por pareja
-- (decisión A8). El número dice la marca y el módulo; id_bot es el bot que contesta ahora (el default del número
-- o el que dejó un cambio de bot).
-- El id es text: las importadas conservan el id de Firestore; las nuevas reciben un UUID en texto.
--
-- Estados: bot · waiting_agent · with_agent · closed (los mismos de Firestore; los usan el pipeline y el dashboard).
-- fuente + id_externo: conversación abierta por el contrato ① (p. ej. valuacion + idOferta); únicos juntos.
-- estado_antes_cierre / agente_antes_cierre / cierre_manual: para la reapertura (core/conversations.py).
-- version sube con cada cambio: el aviso de tiempo real la lleva para descartar avisos viejos.
CREATE TABLE IF NOT EXISTS hub_cleber.conversaciones (
  id_conversacion             text        NOT NULL DEFAULT gen_random_uuid()::text,
  id_marca                    text        NOT NULL,
  modulo                      text        NOT NULL,
  id_numero                   text        NOT NULL,
  id_equipo                   text,
  id_bot                      text,
  canal                       text        NOT NULL DEFAULT 'whatsapp',
  direccion                   text        NOT NULL DEFAULT 'inbound',
  telefono_cliente            text        NOT NULL,
  nombre_cliente              text,
  clave_cliente               text,                                -- clientes.clientes, por valor
  estado                      text        NOT NULL DEFAULT 'bot',
  id_agente                   uuid,                                -- hub_cleber.usuarios, por valor
  prioridad                   text        NOT NULL DEFAULT 'normal',
  etiquetas                   text[]      NOT NULL DEFAULT '{}',
  fuente                      text,
  id_externo                  text,
  resultado                   text,
  resultado_en                timestamptz,
  motivo_handoff              text,
  id_sesion_bot               text,                                -- abacusConversationId
  ultimo_mensaje_en           timestamptz NOT NULL DEFAULT now(),
  ultimo_mensaje_texto        text,
  ultimo_remitente            text,
  ultimo_mensaje_cliente_en   timestamptz,
  ultima_plantilla_en         timestamptz,
  recordatorios_inactividad   integer     NOT NULL DEFAULT 0,
  estado_antes_cierre         text,
  agente_antes_cierre         uuid,
  cierre_manual               boolean     NOT NULL DEFAULT false,
  metadatos                   jsonb       NOT NULL DEFAULT '{}',   -- contexto externo, contexto de campaña, ...
  cerrada_en                  timestamptz,
  creado_en                   timestamptz NOT NULL DEFAULT now(),
  actualizado_en              timestamptz NOT NULL DEFAULT now(),
  version                     integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_conversaciones PRIMARY KEY (id_conversacion),
  CONSTRAINT fk_conversaciones_marca FOREIGN KEY (id_marca) REFERENCES hub_cleber.marcas (id_marca),
  CONSTRAINT fk_conversaciones_numero FOREIGN KEY (id_numero) REFERENCES hub_cleber.numeros (id_numero),
  CONSTRAINT fk_conversaciones_equipo FOREIGN KEY (id_equipo) REFERENCES hub_cleber.equipos (id_equipo),
  CONSTRAINT fk_conversaciones_bot FOREIGN KEY (id_bot) REFERENCES hub_cleber.bots (id_bot),
  CONSTRAINT chk_conversaciones_modulo CHECK (modulo IN ('ventas', 'servicio', 'valuacion')),
  CONSTRAINT chk_conversaciones_direccion CHECK (direccion IN ('inbound', 'outbound')),
  CONSTRAINT chk_conversaciones_estado CHECK (estado IN ('bot', 'waiting_agent', 'with_agent', 'closed')),
  CONSTRAINT chk_conversaciones_remitente CHECK (ultimo_remitente IN ('customer', 'bot', 'agent')),
  CONSTRAINT chk_conversaciones_externa CHECK ((fuente IS NULL) = (id_externo IS NULL)),
  CONSTRAINT chk_conversaciones_metadatos CHECK (jsonb_typeof(metadatos) = 'object')
);

-- Una sola abierta por número + cliente
CREATE UNIQUE INDEX IF NOT EXISTS ux_conversaciones_abierta ON hub_cleber.conversaciones (id_numero, telefono_cliente)
  WHERE estado <> 'closed';
-- Contrato ①: idempotencia
CREATE UNIQUE INDEX IF NOT EXISTS ux_conversaciones_externa ON hub_cleber.conversaciones (fuente, id_externo)
  WHERE fuente IS NOT NULL;
-- Reapertura: la cerrada más reciente del número + cliente
CREATE INDEX IF NOT EXISTS ix_conversaciones_cerradas ON hub_cleber.conversaciones (id_numero, telefono_cliente, cerrada_en DESC)
  WHERE estado = 'closed';
-- Bandeja
CREATE INDEX IF NOT EXISTS ix_conversaciones_bandeja ON hub_cleber.conversaciones (id_marca, modulo, estado, ultimo_mensaje_en DESC);
CREATE INDEX IF NOT EXISTS ix_conversaciones_agente ON hub_cleber.conversaciones (id_agente) WHERE estado <> 'closed';
CREATE INDEX IF NOT EXISTS ix_conversaciones_cliente ON hub_cleber.conversaciones (id_marca, telefono_cliente);
