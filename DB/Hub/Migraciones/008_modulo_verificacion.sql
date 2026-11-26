/*
 * 008_modulo_verificacion.sql — agrega el módulo verificacion a los catálogos cerrados de hub_cleber
 *
 * Verificación de datos del cliente (Salesforce) es un módulo más, como ventas, servicio y valuación: reemplaza los
 * CHECK de módulo de bots, conversaciones, equipos, numeros y roles_modulo para aceptarlo.
 * La tabla hub_cleber.verificacion_datos NO se crea aquí: la crea Alta_db.sql (Tables/verificacion_datos.sql), como
 * notas, porque es una tabla nueva y no un cambio de una que ya existe.
 * Para bases donde las tablas ya existen (Alta_db.sql no cambia tablas existentes). Es re-ejecutable.
 *
 * Orden: correr esta migración y después Alta_db.sql (tabla verificacion_datos, helper verificacion_json y las acciones
 * registra_verificacion y actualiza_verificacion).
 *   psql -h <host> -p <puerto> -U <usuario> -d <database> -f Migraciones/008_modulo_verificacion.sql -q
 */

\encoding UTF8
\set ON_ERROR_STOP on

BEGIN;

ALTER TABLE hub_cleber.bots
  DROP CONSTRAINT IF EXISTS chk_bots_modulo,
  ADD CONSTRAINT chk_bots_modulo CHECK (modulo IN ('ventas', 'servicio', 'valuacion', 'verificacion'));

ALTER TABLE hub_cleber.conversaciones
  DROP CONSTRAINT IF EXISTS chk_conversaciones_modulo,
  ADD CONSTRAINT chk_conversaciones_modulo CHECK (modulo IN ('ventas', 'servicio', 'valuacion', 'verificacion'));

ALTER TABLE hub_cleber.equipos
  DROP CONSTRAINT IF EXISTS chk_equipos_modulo,
  ADD CONSTRAINT chk_equipos_modulo CHECK (modulo IN ('ventas', 'servicio', 'valuacion', 'verificacion'));

ALTER TABLE hub_cleber.numeros
  DROP CONSTRAINT IF EXISTS chk_numeros_modulo,
  ADD CONSTRAINT chk_numeros_modulo CHECK (modulo IN ('ventas', 'servicio', 'valuacion', 'verificacion'));

ALTER TABLE hub_cleber.roles_modulo
  DROP CONSTRAINT IF EXISTS chk_roles_modulo_modulo,
  ADD CONSTRAINT chk_roles_modulo_modulo CHECK (modulo IN ('ventas', 'servicio', 'valuacion', 'verificacion'));

COMMIT;
