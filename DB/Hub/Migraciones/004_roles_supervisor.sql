/*
 * 004_roles_supervisor.sql — roles supervisores en hub_cleber.roles_modulo
 *
 * Un rol con es_supervisor ve las conversaciones del módulo de todos los equipos, filtradas por sus agencias, sin
 * necesitar equipo. Primero: GERENTE de valuación (2026-11-20), que supervisa las ofertas de sus agencias.
 *
 * Para bases donde roles_modulo ya existe (Alta_db.sql no cambia tablas existentes). En una base nueva no hace falta:
 * Tables/roles_modulo.sql ya trae la columna. Es re-ejecutable.
 *
 * Orden: correr esta migración y después Alta_db.sql (helpers y Datos_maestros/roles_modulo.sql, que marca a GERENTE).
 *   psql -h <host> -p <puerto> -U <usuario> -d <database> -f Migraciones/004_roles_supervisor.sql -q
 */

\encoding UTF8
\set ON_ERROR_STOP on

BEGIN;

ALTER TABLE hub_cleber.roles_modulo
  ADD COLUMN IF NOT EXISTS es_supervisor boolean NOT NULL DEFAULT false;

COMMIT;

\echo 'Migración 004 aplicada. Corre ahora Alta_db.sql.'
