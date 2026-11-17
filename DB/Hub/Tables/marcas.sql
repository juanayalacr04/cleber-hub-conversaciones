-- Marca (organizations de Firestore). El id se conserva: es el organizationId que guardan por valor
-- clientes.clientes, valuacion.* y los documentos de aviso de Firestore.
-- Las credenciales de Salesforce NO van aquí: son globales por variables de entorno / Secret Manager
-- (DECISIONES_UNIFICACION.md). salesforce_config solo guarda la configuración por marca (marcaRR, RecordTypeId, owners...).
CREATE TABLE IF NOT EXISTS hub_cleber.marcas (
  id_marca          text        NOT NULL,                -- = organizationId (id del documento en Firestore)
  nombre            text        NOT NULL,
  zona_horaria      text        NOT NULL DEFAULT 'America/Mexico_City',   -- settings.timezone
  horario           jsonb       NOT NULL DEFAULT '{}',   -- resto de settings (businessHours, ...)
  sf_codigo_marca   text,                                -- sfBrandCode
  sf_calendario     text,                                -- sfCalendario
  salesforce_config jsonb       NOT NULL DEFAULT '{}',   -- sin secretos
  plan              text        NOT NULL DEFAULT 'free',
  es_activa         boolean     NOT NULL DEFAULT true,
  creado_en         timestamptz NOT NULL DEFAULT now(),
  actualizado_en    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_marcas PRIMARY KEY (id_marca),
  CONSTRAINT uq_marcas_sf_codigo_marca UNIQUE (sf_codigo_marca),
  CONSTRAINT chk_marcas_id CHECK (id_marca ~ '^[A-Za-z0-9_-]+$'),
  CONSTRAINT chk_marcas_plan CHECK (plan IN ('free', 'pro', 'enterprise')),
  CONSTRAINT chk_marcas_horario CHECK (jsonb_typeof(horario) = 'object'),
  CONSTRAINT chk_marcas_salesforce_config CHECK (jsonb_typeof(salesforce_config) = 'object')
);
