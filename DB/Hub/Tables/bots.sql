-- Bot (sale de bots de Firestore). La configuración que lee el pipeline (abacusConfig sin tokens, handoffConfig,
-- scheduleConfig, inactivityConfig, situationRouting, tools, outcomeActions, ...) va en config tal como la usa el
-- backend: varía por tipo de bot y la interpreta Python, no plpgsql.
--
-- Los tokens (Abacus, bot externo, Vertex) NO van aquí: viven en Secrets Manager. secretos_configurados solo dice
-- cuáles ya están puestos, para que la pantalla muestre "configurado" (antes secretsSet).
-- Id text por la misma razón que equipos.
CREATE TABLE IF NOT EXISTS hub_cleber.bots (
  id_bot                 text        NOT NULL DEFAULT gen_random_uuid()::text,
  id_marca               text        NOT NULL,
  modulo                 text        NOT NULL,
  nombre                 text        NOT NULL,
  tipo                   text        NOT NULL DEFAULT 'chatllm',
  categoria              text,
  config                 jsonb       NOT NULL DEFAULT '{}',
  secretos_configurados  text[]      NOT NULL DEFAULT '{}',
  es_activo              boolean     NOT NULL DEFAULT true,
  creado_en              timestamptz NOT NULL DEFAULT now(),
  actualizado_en         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_bots PRIMARY KEY (id_bot),
  CONSTRAINT fk_bots_marca FOREIGN KEY (id_marca) REFERENCES hub_cleber.marcas (id_marca),
  CONSTRAINT chk_bots_modulo CHECK (modulo IN ('ventas', 'servicio', 'valuacion', 'verificacion')),
  CONSTRAINT chk_bots_tipo CHECK (tipo IN ('chatllm', 'workflow', 'vertex_ai', 'external')),
  CONSTRAINT chk_bots_config CHECK (jsonb_typeof(config) = 'object')
);

CREATE INDEX IF NOT EXISTS ix_bots_marca_modulo ON hub_cleber.bots (id_marca, modulo);
