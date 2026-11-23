/*
 * 003_conversaciones_agencia.sql — agencia de la conversación en hub_cleber.conversaciones
 *
 * Valuación atiende por agencia: un valuador que no administra el módulo solo ve y recibe las conversaciones de sus
 * agencias (usuarios_marcas.agencias). La agencia la manda el sistema que abre la conversación (contrato ①, idAgencia);
 * las conversaciones sin agencia (Ventas, Servicio, o las que abre el cliente) no se filtran por agencia.
 *
 * Para bases donde conversaciones ya existe (Alta_db.sql no cambia tablas existentes). En una base nueva no hace falta:
 * Tables/conversaciones.sql ya trae la columna. Es re-ejecutable.
 *
 * Las conversaciones de Valuación que ya existen se llenan con la agencia de su oferta (valuacion.ofertas, por idExterno),
 * si el schema valuacion está en la misma base.
 *
 * Orden: correr esta migración y después Alta_db.sql.
 *   psql -h <host> -p <puerto> -U <usuario> -d <database> -f Migraciones/003_conversaciones_agencia.sql -q
 */

\encoding UTF8
\set ON_ERROR_STOP on

BEGIN;

ALTER TABLE hub_cleber.conversaciones
  ADD COLUMN IF NOT EXISTS id_agencia text;

DO $$
BEGIN
  IF to_regclass('valuacion.ofertas') IS NOT NULL THEN
    UPDATE hub_cleber.conversaciones c
       SET id_agencia = o.id_agencia
      FROM valuacion.ofertas o
     WHERE c.fuente = 'valuacion' AND c.id_agencia IS NULL
       AND c.id_externo ~ '^[0-9]{1,18}$' AND o.id_oferta = c.id_externo::bigint;
  END IF;
END $$;

COMMIT;

\echo 'Migración 003 aplicada.'
