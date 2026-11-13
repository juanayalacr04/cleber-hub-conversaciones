/*
 * 001_roles_por_marca_y_modulo.sql — de rol global a rol por marca y módulo (decisiones Q36–Q39)
 *
 * Para una base donde ya se corrió el Alta_db.sql anterior (con usuarios.rol). En una base nueva no hace falta:
 * Alta_db.sql ya crea la estructura nueva. Es re-ejecutable: si ya se aplicó, no hace nada.
 *
 * Qué hace, en una transacción:
 *   1. Crea el catálogo hub_cleber.roles_modulo con sus datos.
 *   2. Rehace hub_cleber.usuarios_roles_modulo con la marca y el equipo (llave: usuario, marca, módulo).
 *   3. Copia los roles:
 *        - usuarios.rol → rol en ventas y en servicio en cada marca del usuario
 *          (admin → ADMINISTRADOR, agent → AGENTE, viewer → CONSULTA).
 *        - Roles por módulo anteriores (ej. valuacion → VALUADOR) → el mismo rol en cada marca del usuario,
 *          si existe en el catálogo; los que no existen se listan y se omiten. SISTEMA no se copia.
 *   4. Quita usuarios.rol y usuarios_organizaciones.id_equipo.
 *
 * Los equipos NO se copian: el equipo anterior era por marca y no se sabe de qué módulo es (la vertical del equipo
 * está en Firestore). Para llenarlos, después de esta migración y de Alta_db.sql se vuelve a generar y correr la
 * carga (dev/carga_usuarios_hub.py), que maneja solo ventas y servicio y no toca los roles de valuación.
 *
 * Ejecución (solo desarrollo/QA), desde DB/Hub:
 *   psql -h <host> -p <puerto> -U <usuario> -d <database> -f Migraciones/001_roles_por_marca_y_modulo.sql
 *   psql -h <host> -p <puerto> -U <usuario> -d <database> -f Alta_db.sql -q
 */

\encoding UTF8
\set ON_ERROR_STOP on

BEGIN;

SELECT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'hub_cleber' AND table_name = 'usuarios' AND column_name = 'rol') AS pendiente \gset

\if :pendiente

\echo '1. Catálogo de roles por módulo'
\i Tables/roles_modulo.sql
\i Datos_maestros/roles_modulo.sql

\echo '2. usuarios_roles_modulo con marca y equipo'
ALTER TABLE hub_cleber.usuarios_roles_modulo RENAME TO usuarios_roles_modulo_anterior;
ALTER TABLE hub_cleber.usuarios_roles_modulo_anterior RENAME CONSTRAINT pk_usuarios_roles_modulo TO pk_usuarios_roles_modulo_anterior;
\i Tables/usuarios_roles_modulo.sql

\echo '3. Copia de roles'
INSERT INTO hub_cleber.usuarios_roles_modulo (id_usuario, id_organizacion, modulo, rol)
SELECT uo.id_usuario, uo.id_organizacion, m.modulo,
       CASE u.rol WHEN 'admin' THEN 'ADMINISTRADOR' WHEN 'agent' THEN 'AGENTE' ELSE 'CONSULTA' END
  FROM hub_cleber.usuarios_organizaciones uo
  JOIN hub_cleber.usuarios u ON u.id_usuario = uo.id_usuario
 CROSS JOIN (VALUES ('ventas'), ('servicio')) m (modulo)
 WHERE NOT u.es_sistema AND u.rol IS NOT NULL;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT u.email, a.modulo, a.rol
             FROM hub_cleber.usuarios_roles_modulo_anterior a
             JOIN hub_cleber.usuarios u ON u.id_usuario = a.id_usuario
            WHERE NOT u.es_sistema
              AND NOT EXISTS (SELECT 1 FROM hub_cleber.roles_modulo c WHERE c.modulo = a.modulo AND c.rol = a.rol)
            ORDER BY u.email, a.modulo LOOP
    RAISE NOTICE 'Se omite el rol % en % de %: no existe en el catálogo', r.rol, r.modulo, r.email;
  END LOOP;
END;
$$;

-- El rol del módulo, si vino explícito, gana sobre el que se dedujo de usuarios.rol
INSERT INTO hub_cleber.usuarios_roles_modulo (id_usuario, id_organizacion, modulo, rol)
SELECT a.id_usuario, uo.id_organizacion, a.modulo, a.rol
  FROM hub_cleber.usuarios_roles_modulo_anterior a
  JOIN hub_cleber.usuarios u ON u.id_usuario = a.id_usuario AND NOT u.es_sistema
  JOIN hub_cleber.usuarios_organizaciones uo ON uo.id_usuario = a.id_usuario
  JOIN hub_cleber.roles_modulo c ON c.modulo = a.modulo AND c.rol = a.rol
ON CONFLICT (id_usuario, id_organizacion, modulo) DO UPDATE SET rol = EXCLUDED.rol, actualizado_en = now();

DROP TABLE hub_cleber.usuarios_roles_modulo_anterior;

\echo '4. Sin rol global ni equipo por marca'
ALTER TABLE hub_cleber.usuarios
  DROP CONSTRAINT chk_usuarios_sistema,
  DROP CONSTRAINT chk_usuarios_rol,
  DROP COLUMN rol,
  ADD CONSTRAINT chk_usuarios_sistema CHECK (
    (es_sistema AND NOT es_super_admin AND email LIKE '%.internal')
    OR (NOT es_sistema AND email NOT LIKE '%.internal'));
ALTER TABLE hub_cleber.usuarios_organizaciones DROP COLUMN id_equipo;

SELECT modulo, rol, count(*) AS usuarios_marcas
  FROM hub_cleber.usuarios_roles_modulo GROUP BY modulo, rol ORDER BY modulo, rol;

\echo 'Migración aplicada. Sigue: Alta_db.sql (funciones) y, para los equipos, la carga desde Firestore.'

\else
\echo 'La migración ya estaba aplicada (usuarios.rol no existe); no se hizo nada.'
\endif

COMMIT;
