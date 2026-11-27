-- Marca. El id es el CÓDIGO de la marca (TO, HO...; el sfBrandCode de Firestore): es el que filtra el catálogo de
-- agencias de Cleber y el que guardan por valor clientes.clientes y valuacion.*. No cambia después del alta.
-- Las credenciales de Salesforce NO van aquí: son globales por variables de entorno / Secret Manager
-- (DECISIONES_UNIFICACION.md). salesforce_config solo guarda la configuración por marca (marcaRR, RecordTypeId, owners...).
CREATE TABLE IF NOT EXISTS hub_cleber.marcas (
  id_marca          text        NOT NULL,                -- código de la marca (sfBrandCode), en mayúsculas
  nombre            text        NOT NULL,
  horario           jsonb       NOT NULL DEFAULT '{}',   -- resto de settings (businessHours, ...)
  sf_calendario     text,                                -- sfCalendario
  salesforce_config jsonb       NOT NULL DEFAULT '{}',   -- sin secretos
  id_salesforce     text,                                -- ID de la marca en Salesforce (opcional, editable)
  es_activa         boolean     NOT NULL DEFAULT true,
  es_seminuevos     boolean     NOT NULL DEFAULT false,  -- su catálogo de agencias trae las de todas las marcas con seminuevo = true
  simular_callback_sf boolean   NOT NULL DEFAULT false,  -- el callback de verificación a Salesforce no sale a la red (QA)
  creado_en         timestamptz NOT NULL DEFAULT now(),
  actualizado_en    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_marcas PRIMARY KEY (id_marca),
  CONSTRAINT chk_marcas_horario CHECK (jsonb_typeof(horario) = 'object'),
  CONSTRAINT chk_marcas_salesforce_config CHECK (jsonb_typeof(salesforce_config) = 'object')
);
