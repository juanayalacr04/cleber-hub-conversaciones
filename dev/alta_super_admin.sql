/*
 * alta_super_admin.sql — da de alta el primer super admin del hub en una base nueva (QA o producción).
 *
 * En una base recién creada con DB/Hub/Alta_db.sql solo existen los usuarios de sistema, y para crear marcas, usuarios y
 * roles desde el dashboard hace falta un super admin. Este script lo crea (o marca como super admin a un usuario que ya
 * existe y lo reactiva). Después, todo lo demás se hace desde las pantallas del hub.
 *
 * Re-ejecutable. No toca a los demás usuarios.
 *
 * Variables (psql -v):
 *   email   correo de Google con el que va a entrar (se guarda en minúsculas)
 *   nombre  opcional; Google lo actualiza en el primer inicio de sesión
 *
 * Ejemplo:
 *   psql -h <host> -U <usuario> -d <database> -v email=nombre.apellido@cleber.com -f dev/alta_super_admin.sql
 */

\encoding UTF8
\set ON_ERROR_STOP on
\if :{?email}
\else
\echo 'Falta -v email=<correo>'
\quit
\endif
\if :{?nombre}
\else
\set nombre ''
\endif

BEGIN;

INSERT INTO hub_cleber.usuarios (email, nombre, es_super_admin, es_sistema, es_activo)
VALUES (lower(btrim(:'email')), :'nombre', true, false, true)
ON CONFLICT (email) DO UPDATE
  SET es_super_admin = true, es_activo = true, actualizado_en = now();

SELECT email, es_super_admin, es_activo, ultimo_acceso_en
  FROM hub_cleber.usuarios
 WHERE email = lower(btrim(:'email'));

COMMIT;
