/*
 * 009_verificacion_simulacion_y_consulta.sql — simulación del callback a Salesforce por marca y su marca en la verificación
 *
 * El callback a Salesforce se puede simular por marca (hub_cleber.marcas.simular_callback_sf): la entrega no sale a la red y
 * la verificación queda marcada como simulada (hub_cleber.verificacion_datos.callback_simulado), para no confundirla con una
 * entrega real. Las columnas se agregan aquí porque las tablas ya existen en las bases instaladas; las definiciones de
 * Tables/marcas.sql y Tables/verificacion_datos.sql ya las traen para las instalaciones nuevas.
 * Es re-ejecutable.
 *
 * Orden: correr esta migración y después Alta_db.sql (helpers marca_json y verificacion_json, acciones guarda_marca,
 * registra_callback_verificacion, consulta_verificaciones y resumen_verificaciones).
 *   psql -h <host> -p <puerto> -U <usuario> -d <database> -f Migraciones/009_verificacion_simulacion_y_consulta.sql -q
 */

\encoding UTF8
\set ON_ERROR_STOP on

BEGIN;

ALTER TABLE hub_cleber.marcas
  ADD COLUMN IF NOT EXISTS simular_callback_sf boolean NOT NULL DEFAULT false;

ALTER TABLE hub_cleber.verificacion_datos
  ADD COLUMN IF NOT EXISTS callback_simulado boolean NOT NULL DEFAULT false;

COMMIT;
