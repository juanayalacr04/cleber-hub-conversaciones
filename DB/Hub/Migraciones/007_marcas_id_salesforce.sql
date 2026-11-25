/*
 * 007_marcas_id_salesforce.sql — agrega hub_cleber.marcas.id_salesforce
 *
 * ID de la marca en Salesforce (opcional, editable). El id_marca es texto libre; este es el identificador sin espacios.
 * Para bases donde la tabla ya existe (Alta_db.sql no cambia tablas existentes). Es re-ejecutable.
 *
 * Orden: correr esta migración y después Alta_db.sql (guarda_marca y marca_json).
 *   psql -h <host> -p <puerto> -U <usuario> -d <database> -f Migraciones/007_marcas_id_salesforce.sql -q
 */

\encoding UTF8
\set ON_ERROR_STOP on

BEGIN;

ALTER TABLE hub_cleber.marcas
  ADD COLUMN IF NOT EXISTS id_salesforce text;

COMMIT;
