/*
 * Alta_db.sql — schema hub_cleber (adelanto de la Fase 3: identidad)
 * Script maestro: ejecuta todo el paquete en orden, dentro de una transacción; se detiene al primer error.
 *
 * Identidad: marcas, usuarios, sus marcas (con sus agencias por valor), el catálogo de roles de cada módulo y el rol
 * del usuario en cada módulo de cada marca, los helpers de identidad y hub_cleber.usuarios_contexto.
 * Núcleo de conversaciones (rebanada 1 de la mudanza a AWS): equipos, bots, números, conversaciones, mensajes y
 * bitácora, con las acciones del pipeline, del contrato ① y de la bandeja.
 * El catálogo de agencias NO vive en el hub: viene de un API externo.
 * Diseño: Arquitectura/DISENO_MIGRACION_POSTGRES.md §4.2 y §5, y Arquitectura/DISENO_BACKEND_AWS.md.
 *
 * Es re-ejecutable: tablas con IF NOT EXISTS, funciones con CREATE OR REPLACE y datos maestros idempotentes.
 * Un cambio de estructura en una tabla que ya existe NO se aplica aquí: va en Migraciones/ (ver README).
 *
 * Requisitos:
 *   - PostgreSQL 13+ (gen_random_uuid nativo)
 *   - Schema cleber instalado (cleber.construye_respuesta_exitosa / construye_respuesta_fallida), repo api → DB/Cleber
 *   - Schema clientes instalado (clientes.normaliza_telefono), toma-unidades-en-taller → DB/Clientes
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
  IF to_regprocedure('clientes.normaliza_telefono(text)') IS NULL THEN
    RAISE EXCEPTION 'Falta clientes.normaliza_telefono. Instalar DB/Clientes de toma-unidades-en-taller.';
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
\echo 'Tables/marcas.sql'
\i Tables/marcas.sql
\echo 'Tables/usuarios.sql'
\i Tables/usuarios.sql
\echo 'Tables/usuarios_marcas.sql'
\i Tables/usuarios_marcas.sql
\echo 'Tables/roles_modulo.sql'
\i Tables/roles_modulo.sql
\echo 'Tables/usuarios_roles_modulo.sql'
\i Tables/usuarios_roles_modulo.sql
\echo 'Tables/equipos.sql'
\i Tables/equipos.sql
\echo 'Tables/bots.sql'
\i Tables/bots.sql
\echo 'Tables/numeros.sql'
\i Tables/numeros.sql
\echo 'Tables/conversaciones.sql'
\i Tables/conversaciones.sql
\echo 'Tables/mensajes.sql'
\i Tables/mensajes.sql
\echo 'Tables/bitacora.sql'
\i Tables/bitacora.sql

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
\echo 'Functions/Helpers/marca_json.sql'
\i Functions/Helpers/marca_json.sql
\echo 'Functions/Helpers/conversaciones.sql'
\i Functions/Helpers/conversaciones.sql

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
\echo 'Functions/Acciones/quita_usuario_de_marca.sql'
\i Functions/Acciones/quita_usuario_de_marca.sql
\echo 'Functions/Acciones/cambia_disponibilidad.sql'
\i Functions/Acciones/cambia_disponibilidad.sql
\echo 'Functions/Acciones/registra_inicio_sesion.sql'
\i Functions/Acciones/registra_inicio_sesion.sql
\echo 'Functions/Acciones/consulta_marcas.sql'
\i Functions/Acciones/consulta_marcas.sql
\echo 'Functions/Acciones/guarda_marca.sql'
\i Functions/Acciones/guarda_marca.sql
\echo 'Functions/Acciones/guarda_equipo.sql'
\i Functions/Acciones/guarda_equipo.sql
\echo 'Functions/Acciones/guarda_bot.sql'
\i Functions/Acciones/guarda_bot.sql
\echo 'Functions/Acciones/guarda_numero.sql'
\i Functions/Acciones/guarda_numero.sql
\echo 'Functions/Acciones/marca_secretos_configurados.sql'
\i Functions/Acciones/marca_secretos_configurados.sql
\echo 'Functions/Acciones/consulta_configuracion_modulo.sql'
\i Functions/Acciones/consulta_configuracion_modulo.sql
\echo 'Functions/Acciones/resuelve_numero.sql'
\i Functions/Acciones/resuelve_numero.sql
\echo 'Functions/Acciones/obtiene_o_abre_conversacion.sql'
\i Functions/Acciones/obtiene_o_abre_conversacion.sql
\echo 'Functions/Acciones/guarda_mensaje.sql'
\i Functions/Acciones/guarda_mensaje.sql
\echo 'Functions/Acciones/actualiza_conversacion.sql'
\i Functions/Acciones/actualiza_conversacion.sql
\echo 'Functions/Acciones/abre_conversacion_externa.sql'
\i Functions/Acciones/abre_conversacion_externa.sql
\echo 'Functions/Acciones/registra_bitacora.sql'
\i Functions/Acciones/registra_bitacora.sql
\echo 'Functions/Acciones/consulta_conversaciones.sql'
\i Functions/Acciones/consulta_conversaciones.sql
\echo 'Functions/Acciones/consulta_mensajes.sql'
\i Functions/Acciones/consulta_mensajes.sql

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
