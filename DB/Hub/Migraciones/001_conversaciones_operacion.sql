/*
 * 001_conversaciones_operacion.sql — columnas de operación del asesor en hub_cleber.conversaciones
 *
 * Para bases donde conversaciones ya existe (Alta_db.sql no cambia tablas existentes). En una base nueva no hace
 * falta: Tables/conversaciones.sql ya las trae. Es re-ejecutable.
 *
 * Orden: correr esta migración y después Alta_db.sql (que crea notas y reemplaza las funciones).
 *   psql -h <host> -p <puerto> -U <usuario> -d <database> -f Migraciones/001_conversaciones_operacion.sql -q
 */

\encoding UTF8
\set ON_ERROR_STOP on

BEGIN;

ALTER TABLE hub_cleber.conversaciones
  ADD COLUMN IF NOT EXISTS motivo_cierre        text,
  ADD COLUMN IF NOT EXISTS asignada_en          timestamptz,
  ADD COLUMN IF NOT EXISTS espera_desde         timestamptz,
  ADD COLUMN IF NOT EXISTS primera_respuesta_en timestamptz,
  ADD COLUMN IF NOT EXISTS tiempos_respuesta    integer[] NOT NULL DEFAULT '{}';

COMMIT;

\echo 'Migración 001 aplicada.'
