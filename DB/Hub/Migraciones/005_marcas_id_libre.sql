/*
 * 005_marcas_id_libre.sql — quita la restricción de formato del código de marca (hub_cleber.marcas.id_marca)
 *
 * El código se guarda tal como se escribe (p. ej. "CLEBER Seminuevos"), sin mayúsculas forzadas ni límite de caracteres.
 * Para bases donde la tabla ya existe (Alta_db.sql no cambia tablas existentes). Es re-ejecutable.
 *
 * Orden: correr esta migración y después Alta_db.sql (funciones guarda_marca e importa_usuarios sin la validación).
 *   psql -h <host> -p <puerto> -U <usuario> -d <database> -f Migraciones/005_marcas_id_libre.sql -q
 */

\encoding UTF8
\set ON_ERROR_STOP on

BEGIN;

ALTER TABLE hub_cleber.marcas DROP CONSTRAINT IF EXISTS chk_marcas_id;

COMMIT;
