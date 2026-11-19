/*
 * 002_equipos_ultimo_agente.sql — puntero del round robin en hub_cleber.equipos
 *
 * Para bases donde equipos ya existe (Alta_db.sql no cambia tablas existentes). En una base nueva no hace falta:
 * Tables/equipos.sql ya trae la columna. Es re-ejecutable.
 *
 * Orden: correr esta migración y después Alta_db.sql (que crea Hub.asignaAgenteAutomatico).
 *   psql -h <host> -p <puerto> -U <usuario> -d <database> -f Migraciones/002_equipos_ultimo_agente.sql -q
 */

\encoding UTF8
\set ON_ERROR_STOP on

BEGIN;

ALTER TABLE hub_cleber.equipos
  ADD COLUMN IF NOT EXISTS ultimo_agente_asignado uuid;

COMMIT;

\echo 'Migración 002 aplicada.'
