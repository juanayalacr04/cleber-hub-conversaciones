-- Log de errores no controlados (ERROR_INTERNO). Lo escribe hub_cleber.registra_error.
CREATE TABLE IF NOT EXISTS hub_cleber.log_errores (
  id_log_error    bigint      GENERATED ALWAYS AS IDENTITY,
  id_correlacion  uuid        NOT NULL DEFAULT gen_random_uuid(),
  peticion        jsonb,
  sqlstate        text,
  mensaje         text,
  contexto        text,
  ocurrido_en     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_log_errores PRIMARY KEY (id_log_error),
  CONSTRAINT uq_log_errores_correlacion UNIQUE (id_correlacion)
);
