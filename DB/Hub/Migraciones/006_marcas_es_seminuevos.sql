/*
 * 006_marcas_es_seminuevos.sql — agrega hub_cleber.marcas.es_seminuevos
 *
 * Una marca con es_seminuevos arma su catálogo de agencias con las de todas las marcas que traen seminuevo = true.
 * Para bases donde la tabla ya existe (Alta_db.sql no cambia tablas existentes). Es re-ejecutable.
 *
 * Orden: correr esta migración y después Alta_db.sql (guarda_marca, marca_json y consulta_usuario_actual).
 *   psql -h <host> -p <puerto> -U <usuario> -d <database> -f Migraciones/006_marcas_es_seminuevos.sql -q
 */

\encoding UTF8
\set ON_ERROR_STOP on

BEGIN;

ALTER TABLE hub_cleber.marcas
  ADD COLUMN IF NOT EXISTS es_seminuevos boolean NOT NULL DEFAULT false;

COMMIT;
