/*
 * 010_modulos_por_marca.sql — módulos activos por marca (hub_cleber.marcas_modulos)
 *
 * El super admin enciende o apaga cada módulo por marca (Hub.guardaModuloMarca); el selector de módulos de la web solo muestra
 * los activos de la marca. Para no ocultar nada al instalar, se encienden valuacion y verificacion en las marcas existentes.
 * Es re-ejecutable (no pisa lo que el super admin ya haya apagado).
 *
 * Orden: correr esta migración y después Alta_db.sql (acciones consulta_modulos_marca, guarda_modulo_marca y
 * consulta_usuario_actual), y dar los grants de las dos acciones nuevas.
 *   psql -h <host> -p <puerto> -U <usuario> -d <database> -f Migraciones/010_modulos_por_marca.sql -q
 */

\encoding UTF8
\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS hub_cleber.marcas_modulos (
  id_marca          text        NOT NULL,
  modulo            text        NOT NULL,
  es_activo         boolean     NOT NULL DEFAULT false,
  creado_en         timestamptz NOT NULL DEFAULT now(),
  actualizado_en    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_marcas_modulos PRIMARY KEY (id_marca, modulo),
  CONSTRAINT fk_marcas_modulos_marca FOREIGN KEY (id_marca) REFERENCES hub_cleber.marcas (id_marca),
  CONSTRAINT chk_marcas_modulos_modulo CHECK (modulo IN ('ventas', 'servicio', 'valuacion', 'verificacion'))
);

INSERT INTO hub_cleber.marcas_modulos (id_marca, modulo, es_activo)
SELECT m.id_marca, x.modulo, true
  FROM hub_cleber.marcas m CROSS JOIN (VALUES ('valuacion'), ('verificacion')) AS x(modulo)
ON CONFLICT (id_marca, modulo) DO NOTHING;

COMMIT;
