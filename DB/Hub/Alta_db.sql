/*
 * Alta_db.sql — schema hub_cleber (adelanto de la Fase 3: identidad)
 * Script maestro: ejecuta todo el paquete en orden, dentro de una transacción; se detiene al primer error.
 *
 * Este adelanto crea solo lo que necesita valuación para saber quién es el usuario: organizaciones, usuarios,
 * sus marcas (con sus agencias por valor), el catálogo de roles de cada módulo y el rol del usuario en cada módulo
 * de cada marca, los helpers de identidad y hub_cleber.usuarios_contexto.
 * El catálogo de agencias NO vive en el hub: viene de un API externo.
 * El resto del schema (equipos, números, bots, conversaciones, ...) entra en la Fase 4.
 * Diseño: Arquitectura/DISENO_MIGRACION_POSTGRES.md §4.2 y §5.
 *
 * Es re-ejecutable: tablas con IF NOT EXISTS, funciones con CREATE OR REPLACE y datos maestros idempotentes.
 * Un cambio de estructura en una tabla que ya existe NO se aplica aquí: va en Migraciones/ (ver README).
 *
 * Requisitos:
 *   - PostgreSQL 13+ (gen_random_uuid nativo)
 *   - Schema cleber instalado (cleber.construye_respuesta_exitosa / construye_respuesta_fallida), repo api → DB/Cleber
 *
 * Ejecución (solo desarrollo/QA; producción requiere aprobación explícita):
 *   1.- cd <ruta>/DB/Hub
 *   2.- psql -h <host> -p <puerto> -U <usuario> -d <database> -f Alta_db.sql -q
 */

\encoding UTF8
\set ON_ERROR_STOP on

BEGIN;

\echo '================================================================================'
\echo 'INICIANDO ALTA DEL SCHEMA hub_cleber ...'

\echo '================================================================================'
\echo 'VERIFICANDO REQUISITOS ...'
DO $$
BEGIN
  IF to_regprocedure('cleber.construye_respuesta_exitosa(jsonb)') IS NULL
     OR to_regprocedure('cleber.construye_respuesta_fallida(text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Falta el schema cleber (construye_respuesta_exitosa / construye_respuesta_fallida). Instalar DB/Cleber del repo api.';
  END IF;
END;
$$;

-- 1. Schema
\echo '================================================================================'
\echo 'CREANDO SCHEMA ...'
CREATE SCHEMA IF NOT EXISTS hub_cleber;

-- 2. Tablas (en orden de dependencias)
\echo '================================================================================'
\echo 'CREANDO TABLAS ...'
\echo 'Tables/log_errores.sql'
\i Tables/log_errores.sql
\echo 'Tables/organizaciones.sql'
\i Tables/organizaciones.sql
\echo 'Tables/usuarios.sql'
\i Tables/usuarios.sql
\echo 'Tables/usuarios_organizaciones.sql'
\i Tables/usuarios_organizaciones.sql
\echo 'Tables/roles_modulo.sql'
\i Tables/roles_modulo.sql
\echo 'Tables/usuarios_roles_modulo.sql'
\i Tables/usuarios_roles_modulo.sql

-- 3. Funciones auxiliares (en orden: las funciones LANGUAGE sql validan sus dependencias al crearse)
\echo '================================================================================'
\echo 'CREANDO FUNCIONES AUXILIARES ...'
\echo 'Functions/Helpers/errores.sql'
\i Functions/Helpers/errores.sql
\echo 'Functions/Helpers/peticion.sql'
\i Functions/Helpers/peticion.sql
\echo 'Functions/Helpers/seguridad.sql'
\i Functions/Helpers/seguridad.sql
\echo 'Functions/Helpers/usuario_json.sql'
\i Functions/Helpers/usuario_json.sql
\echo 'Functions/Helpers/editor_usuarios.sql'
\i Functions/Helpers/editor_usuarios.sql

-- 4. Funciones de acciones
\echo '================================================================================'
\echo 'CREANDO FUNCIONES DE ACCIONES ...'
\echo 'Functions/Acciones/consulta_usuario_actual.sql'
\i Functions/Acciones/consulta_usuario_actual.sql
\echo 'Functions/Acciones/importa_usuarios.sql'
\i Functions/Acciones/importa_usuarios.sql
\echo 'Functions/Acciones/consulta_roles_modulo.sql'
\i Functions/Acciones/consulta_roles_modulo.sql
\echo 'Functions/Acciones/consulta_usuarios.sql'
\i Functions/Acciones/consulta_usuarios.sql
\echo 'Functions/Acciones/invita_usuario.sql'
\i Functions/Acciones/invita_usuario.sql
\echo 'Functions/Acciones/guarda_usuario.sql'
\i Functions/Acciones/guarda_usuario.sql
\echo 'Functions/Acciones/quita_usuario_de_organizacion.sql'
\i Functions/Acciones/quita_usuario_de_organizacion.sql
\echo 'Functions/Acciones/cambia_disponibilidad.sql'
\i Functions/Acciones/cambia_disponibilidad.sql
\echo 'Functions/Acciones/registra_inicio_sesion.sql'
\i Functions/Acciones/registra_inicio_sesion.sql

-- 5. Datos maestros
\echo '================================================================================'
\echo 'CARGANDO DATOS MAESTROS ...'
\echo 'Datos_maestros/roles_modulo.sql'
\i Datos_maestros/roles_modulo.sql
\echo 'Datos_maestros/usuarios_sistema.sql'
\i Datos_maestros/usuarios_sistema.sql

COMMIT;

\echo '================================================================================'
\echo 'ALTA DEL SCHEMA hub_cleber COMPLETADA'
\echo '================================================================================'
