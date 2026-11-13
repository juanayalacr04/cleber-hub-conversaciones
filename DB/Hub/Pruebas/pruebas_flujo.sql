/*
 * pruebas_flujo.sql — pruebas del schema hub_cleber, adelanto de identidad (solo desarrollo/QA)
 *
 * Llama a las acciones como lo haría PostgREST detrás de API Gateway (simula X-User-Email con request.headers)
 * y valida cada resultado.
 *
 * Todo corre en UNA transacción que termina en ROLLBACK: no deja datos.
 * Usa las marcas 'prueba-hub-a' / 'prueba-hub-b' y emails @prueba-hub.invalid (no chocan con datos reales).
 *
 * Ejecución, desde psql conectado a la base:
 *   \cd '<ruta del repo>/DB/Hub'
 *   \i Pruebas/pruebas_flujo.sql
 *
 * Cada caso imprime "OK  <caso>". Si uno falla, el script se detiene con "FALLÓ <caso>" y la respuesta
 * recibida; en ese caso escribe ROLLBACK; para cerrar la transacción.
 */

\encoding UTF8
\set ON_ERROR_STOP on
\set VERBOSITY terse

BEGIN;

-- ============================================================================
-- Helpers de prueba (temporales; desaparecen con el ROLLBACK)
-- ============================================================================

CREATE FUNCTION pg_temp.como(p_email text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.headers', jsonb_build_object('x-user-email', p_email)::text, true);
END $$;

CREATE FUNCTION pg_temp.sin_usuario() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.headers', '{}', true);
END $$;

-- Llama la función de una acción, como lo hace PostgREST con rpc/<funcion> y Prefer: params=single-object
CREATE FUNCTION pg_temp.llama(p_accion text, p_params jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_funcion text := CASE p_accion
    WHEN 'Hub.consultaUsuarioActual' THEN 'consulta_usuario_actual'
    WHEN 'Hub.importaUsuarios'       THEN 'importa_usuarios'
  END;
  v_resultado jsonb;
BEGIN
  IF v_funcion IS NULL THEN
    RAISE EXCEPTION 'Acción sin función en las pruebas: %', p_accion;
  END IF;
  EXECUTE format('SELECT hub_cleber.%I($1)', v_funcion)
    INTO v_resultado
    USING jsonb_build_object('action', p_accion, 'params', p_params);
  RETURN v_resultado;
END $$;

CREATE FUNCTION pg_temp.ok(r jsonb, p_caso text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce((r->>'successful')::boolean, false) THEN
    RAISE EXCEPTION 'FALLÓ %: se esperaba éxito y llegó %', p_caso, r;
  END IF;
  RAISE NOTICE 'OK  %', p_caso;
  RETURN r->'info';
END $$;

CREATE FUNCTION pg_temp.error(r jsonb, p_codigo text, p_caso text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce((r->>'successful')::boolean, true) OR r->>'errorCode' IS DISTINCT FROM p_codigo THEN
    RAISE EXCEPTION 'FALLÓ %: se esperaba % y llegó %', p_caso, p_codigo, r;
  END IF;
  RAISE NOTICE 'OK  %', p_caso;
  RETURN r->'info';
END $$;

CREATE FUNCTION pg_temp.igual(p_actual text, p_esperado text, p_caso text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_esperado THEN
    RAISE EXCEPTION 'FALLÓ %: se esperaba "%" y llegó "%"', p_caso, p_esperado, p_actual;
  END IF;
  RAISE NOTICE 'OK  %', p_caso;
END $$;

-- ============================================================================
-- Pruebas
-- ============================================================================
DO $$
DECLARE
  c_sistema  CONSTANT text := 'sistema@hub-conversaciones.internal';
  c_admin    CONSTANT text := 'admin@prueba-hub.invalid';
  c_valuador CONSTANT text := 'valuador@prueba-hub.invalid';
  c_super    CONSTANT text := 'super@prueba-hub.invalid';
  v_carga    jsonb;
  v_usuarios jsonb;
  i          jsonb;
BEGIN
  v_usuarios := jsonb_build_array(
    -- El invitado va ANTES que quien lo invitó: invitadoPor se resuelve al final
    jsonb_build_object('idOrigen', 'uid-valuador', 'email', 'Valuador@Prueba-Hub.invalid ', 'nombre', 'Vale Valuador', 'rol', 'agent',
      'invitadoPor', 'uid-admin',
      'organizaciones', jsonb_build_array(jsonb_build_object('idOrganizacion', 'prueba-hub-a', 'idEquipo', 'equipo-a-ventas',
                                                             'agencias', jsonb_build_array('prueba-ag-a2', 'prueba-ag-a1', 'prueba-ag-a1'))),
      'rolesModulo', jsonb_build_object('valuacion', 'VALUADOR', 'ventas', 'AGENTE')),
    jsonb_build_object('idOrigen', 'uid-admin', 'email', c_admin, 'nombre', 'Ada Admin', 'rol', 'admin', 'estado', 'online',
      'ultimoAccesoEn', '2026-11-01T10:00:00-06:00',
      'organizaciones', jsonb_build_array(jsonb_build_object('idOrganizacion', 'prueba-hub-a'),
                                          jsonb_build_object('idOrganizacion', 'prueba-hub-b', 'idEquipo', 'equipo-b'))),
    jsonb_build_object('idOrigen', 'uid-super', 'email', c_super, 'rol', 'admin', 'esSuperAdmin', true, 'organizaciones', '[]'::jsonb),
    jsonb_build_object('idOrigen', 'uid-baja', 'email', 'baja@prueba-hub.invalid', 'rol', 'agent', 'esActivo', false,
      'organizaciones', jsonb_build_array(jsonb_build_object('idOrganizacion', 'prueba-hub-a'))));

  v_carga := jsonb_build_object(
    'organizaciones', jsonb_build_array(
      jsonb_build_object('idOrganizacion', 'prueba-hub-a', 'nombre', 'Marca A (prueba)', 'sfCodigoMarca', 'PRUEBAHA', 'plan', 'enterprise',
                         'horario', jsonb_build_object('businessHours', jsonb_build_object('start', '09:00', 'end', '19:00')),
                         'salesforceConfig', jsonb_build_object('marcaRR', 'HA')),
      jsonb_build_object('idOrganizacion', 'prueba-hub-b', 'nombre', 'Marca B (prueba)')),
    'usuarios', v_usuarios);

  RAISE NOTICE '--- 1. Seguridad --------------------------------------------------------';
  PERFORM pg_temp.sin_usuario();
  PERFORM pg_temp.error(pg_temp.llama('Hub.consultaUsuarioActual', '{}'), 'SIN_PERMISO', '1.1 Sin X-User-Email no hay acceso');
  PERFORM pg_temp.como('nadie@prueba-hub.invalid');
  PERFORM pg_temp.error(pg_temp.llama('Hub.consultaUsuarioActual', '{}'), 'SIN_PERMISO', '1.2 Email no registrado');
  PERFORM pg_temp.error(pg_temp.llama('Hub.importaUsuarios', v_carga), 'SIN_PERMISO', '1.3 importaUsuarios sin usuario registrado');
  PERFORM pg_temp.como('sistema@toma-unidades.internal');
  i := pg_temp.ok(pg_temp.llama('Hub.consultaUsuarioActual', '{}'), '1.4 El sistema de valuación existe (datos maestros)');
  PERFORM pg_temp.igual(i#>>'{usuario,rolesModulo,valuacion}', 'SISTEMA', '1.5 ... con rol SISTEMA en valuacion');
  PERFORM pg_temp.igual(i#>>'{usuario,rol}', NULL, '1.6 ... y sin rol global');

  RAISE NOTICE '--- 2. importaUsuarios ------------------------------------------------';
  PERFORM pg_temp.como(c_sistema);
  i := pg_temp.ok(pg_temp.llama('Hub.importaUsuarios', v_carga), '2.1 Carga inicial');
  PERFORM pg_temp.igual(i::text, '{"usuarios": {"creados": 4, "actualizados": 0}, "organizaciones": 2}', '2.2 Conteos');
  PERFORM pg_temp.igual((SELECT email FROM hub_cleber.usuarios WHERE id_origen = 'uid-valuador'), c_valuador, '2.3 Email en minúsculas y sin espacios');
  PERFORM pg_temp.igual((SELECT agencias::text FROM hub_cleber.usuarios_organizaciones uo JOIN hub_cleber.usuarios u USING (id_usuario)
                          WHERE u.email = c_valuador), '{prueba-ag-a1,prueba-ag-a2}', '2.4 Agencias sin duplicados y ordenadas');
  PERFORM pg_temp.igual((SELECT inv.email FROM hub_cleber.usuarios u JOIN hub_cleber.usuarios inv ON inv.id_usuario = u.invitado_por
                          WHERE u.email = c_valuador), c_admin, '2.5 invitadoPor se resuelve aunque quien invitó venga después');
  PERFORM pg_temp.igual((SELECT horario#>>'{businessHours,start}' FROM hub_cleber.organizaciones WHERE id_organizacion = 'prueba-hub-a'),
                        '09:00', '2.6 Horario de la organización');

  i := pg_temp.ok(pg_temp.llama('Hub.importaUsuarios', v_carga), '2.7 Segunda carga igual');
  PERFORM pg_temp.igual(i#>>'{usuarios}', '{"creados": 0, "actualizados": 4}', '2.8 Idempotente: no crea de nuevo');
  PERFORM pg_temp.igual((SELECT count(*)::text FROM hub_cleber.usuarios_organizaciones uo JOIN hub_cleber.usuarios u USING (id_usuario)
                          WHERE u.email LIKE '%@prueba-hub.invalid'), '4', '2.9 Idempotente: mismas membresías');

  -- Reemplazo: el admin queda solo en B; el valuador pierde el rol de ventas; el email del valuador cambia (mismo uid)
  v_usuarios := jsonb_set(v_usuarios, '{1,organizaciones}', jsonb_build_array(jsonb_build_object('idOrganizacion', 'prueba-hub-b')));
  v_usuarios := jsonb_set(v_usuarios, '{0,rolesModulo}', jsonb_build_object('valuacion', 'VALUADOR'));
  v_usuarios := jsonb_set(v_usuarios, '{0,email}', '"valuador2@prueba-hub.invalid"');
  i := pg_temp.ok(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object('usuarios', v_usuarios)), '2.10 Carga solo de usuarios');
  PERFORM pg_temp.igual((SELECT string_agg(id_organizacion, ',') FROM hub_cleber.usuarios_organizaciones uo JOIN hub_cleber.usuarios u USING (id_usuario)
                          WHERE u.email = c_admin), 'prueba-hub-b', '2.11 Las marcas se reemplazan');
  PERFORM pg_temp.igual((SELECT string_agg(modulo, ',') FROM hub_cleber.usuarios_roles_modulo rm JOIN hub_cleber.usuarios u USING (id_usuario)
                          WHERE u.id_origen = 'uid-valuador'), 'valuacion', '2.12 Los roles por módulo se reemplazan');
  PERFORM pg_temp.igual((SELECT email FROM hub_cleber.usuarios WHERE id_origen = 'uid-valuador'), 'valuador2@prueba-hub.invalid',
                        '2.13 Email cambiado: se encuentra por idOrigen');
  PERFORM pg_temp.igual((SELECT count(*)::text FROM hub_cleber.usuarios WHERE email = c_valuador), '0', '2.14 ... sin duplicar al usuario');
  -- Se regresa al email original para el resto de las pruebas
  v_usuarios := jsonb_set(v_usuarios, '{0,email}', to_jsonb(c_valuador));
  PERFORM pg_temp.ok(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object('usuarios', v_usuarios)), '2.15 Email de vuelta');

  RAISE NOTICE '--- 3. Validaciones de la carga (todo o nada) --------------------------';
  i := pg_temp.error(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object(
         'organizaciones', jsonb_build_array(jsonb_build_object('idOrganizacion', 'prueba-hub-c', 'nombre', 'C')),
         'usuarios', jsonb_build_array(
           jsonb_build_object('email', 'x@prueba-hub.invalid', 'rol', 'agent', 'organizaciones', '[]'::jsonb),
           jsonb_build_object('email', 'x2@prueba-hub.invalid', 'rol', 'agent',
             'organizaciones', jsonb_build_array(jsonb_build_object('idOrganizacion', 'prueba-hub-a', 'agencias', jsonb_build_array(''))))))),
       'CAMPO_INVALIDO', '3.1 Agencia vacía');
  PERFORM pg_temp.igual(i->>'lista' || '[' || (i->>'indice') || ']', 'usuarios[1]', '3.2 info trae lista e índice');
  PERFORM pg_temp.igual(i->>'campo', 'agencias', '3.3 ... y el campo');
  PERFORM pg_temp.igual((SELECT count(*)::text FROM hub_cleber.organizaciones WHERE id_organizacion = 'prueba-hub-c'), '0',
                        '3.4 Todo o nada: la organización de la carga fallida no quedó');
  PERFORM pg_temp.error(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object('usuarios', jsonb_build_array(
         jsonb_build_object('email', 'y@prueba-hub.invalid', 'rol', 'agent',
           'organizaciones', jsonb_build_array(jsonb_build_object('idOrganizacion', 'no-existe')))))),
       'CAMPO_INVALIDO', '3.5 Organización inexistente');
  PERFORM pg_temp.error(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object('usuarios', jsonb_build_array(
         jsonb_build_object('email', 'z@prueba-hub.invalid', 'rol', 'agent', 'organizaciones', '[]'::jsonb),
         jsonb_build_object('email', 'Z@prueba-hub.invalid', 'rol', 'agent', 'organizaciones', '[]'::jsonb)))),
       'CAMPO_INVALIDO', '3.6 Usuario repetido en la carga');
  PERFORM pg_temp.error(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object('usuarios', jsonb_build_array(
         jsonb_build_object('email', 'w@prueba-hub.invalid', 'rol', 'jefe', 'organizaciones', '[]'::jsonb)))),
       'CAMPO_INVALIDO', '3.7 Rol global inválido');
  PERFORM pg_temp.error(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object('usuarios', jsonb_build_array(
         jsonb_build_object('email', 'otro@algo.internal', 'rol', 'agent', 'organizaciones', '[]'::jsonb)))),
       'CAMPO_INVALIDO', '3.8 No se importan emails de sistema');
  PERFORM pg_temp.error(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object('usuarios', jsonb_build_array(
         jsonb_build_object('email', 'v@prueba-hub.invalid', 'rol', 'agent', 'organizaciones', '[]'::jsonb,
                            'rolesModulo', jsonb_build_object('valuacion', 'SISTEMA'))))),
       'CAMPO_INVALIDO', '3.9 El rol SISTEMA no se asigna por carga');
  PERFORM pg_temp.error(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object('usuarios', jsonb_build_array(
         jsonb_build_object('email', 'sin-orgs@prueba-hub.invalid', 'rol', 'agent')))),
       'CAMPO_REQUERIDO', '3.10 organizaciones es obligatorio por usuario');
  PERFORM pg_temp.error(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object('organizaciones', jsonb_build_array(
         jsonb_build_object('idOrganizacion', 'prueba-hub-b', 'nombre', 'B', 'sfCodigoMarca', 'PRUEBAHA')))),
       'CAMPO_INVALIDO', '3.11 Código de marca de Salesforce repetido');
  PERFORM pg_temp.como(c_admin);
  PERFORM pg_temp.error(pg_temp.llama('Hub.importaUsuarios', v_carga), 'SIN_PERMISO', '3.12 Un admin humano no importa');

  RAISE NOTICE '--- 4. consultaUsuarioActual ------------------------------------------';
  PERFORM pg_temp.como(upper(c_admin));
  i := pg_temp.ok(pg_temp.llama('Hub.consultaUsuarioActual', NULL), '4.1 El email del header no distingue mayúsculas');
  PERFORM pg_temp.igual(i#>>'{usuario,rol}', 'admin', '4.2 Rol global');
  PERFORM pg_temp.igual(jsonb_path_query_array(i, '$.organizacionesVisibles[*].idOrganizacion')::text, '["prueba-hub-b"]',
                        '4.3 Solo ve sus marcas');
  PERFORM pg_temp.como(c_super);
  i := pg_temp.ok(pg_temp.llama('Hub.consultaUsuarioActual', '{}'), '4.4 Super admin');
  PERFORM pg_temp.igual((jsonb_path_query_array(i, '$.organizacionesVisibles[*].idOrganizacion') @> '["prueba-hub-a","prueba-hub-b"]')::text,
                        'true', '4.5 El super admin ve todas las marcas');
  PERFORM pg_temp.como(c_valuador);
  i := pg_temp.ok(pg_temp.llama('Hub.consultaUsuarioActual', '{}'), '4.6 Valuador');
  PERFORM pg_temp.igual(i#>>'{usuario,organizaciones,0,idEquipo}', 'equipo-a-ventas', '4.7 Equipo por marca');
  PERFORM pg_temp.igual(i#>>'{usuario,rolesModulo}', '{"valuacion": "VALUADOR"}', '4.8 Roles por módulo');
  PERFORM pg_temp.como('baja@prueba-hub.invalid');
  PERFORM pg_temp.error(pg_temp.llama('Hub.consultaUsuarioActual', '{}'), 'SIN_PERMISO', '4.9 Un usuario inactivo no entra');

  RAISE NOTICE '--- 5. usuarios_contexto (para valuación) -----------------------------';
  i := hub_cleber.usuarios_contexto(' VALUADOR@prueba-hub.invalid', 'valuacion');
  PERFORM pg_temp.igual(i->>'rol', 'VALUADOR', '5.1 Rol del módulo');
  PERFORM pg_temp.igual(i#>>'{agencias}', '{"prueba-hub-a": ["prueba-ag-a1", "prueba-ag-a2"]}', '5.2 Agencias por marca');
  PERFORM pg_temp.igual(i->>'esSuperAdmin', 'false', '5.3 esSuperAdmin');
  PERFORM pg_temp.igual(hub_cleber.usuarios_contexto(c_valuador, 'servicio')->>'rol', NULL, '5.4 Sin rol en otro módulo → rol null');
  PERFORM pg_temp.igual(hub_cleber.usuarios_contexto('nadie@prueba-hub.invalid', 'valuacion')::text, NULL, '5.5 Usuario inexistente → NULL');
  PERFORM pg_temp.igual(hub_cleber.usuarios_contexto('baja@prueba-hub.invalid', 'valuacion')::text, NULL, '5.6 Usuario inactivo → NULL');
  i := hub_cleber.usuarios_contexto('sistema@toma-unidades.internal', 'valuacion');
  PERFORM pg_temp.igual(i->>'rol' || '/' || (i->>'esSistema'), 'SISTEMA/true', '5.7 Sistema de valuación');

  RAISE NOTICE '--- 6. Helpers de permisos --------------------------------------------';
  PERFORM pg_temp.igual(hub_cleber.agencias_permitidas(hub_cleber.busca_usuario(c_super), 'prueba-hub-a')::text, NULL,
                        '6.1 Super admin: NULL = sin restricción');
  PERFORM pg_temp.igual(hub_cleber.agencias_permitidas(hub_cleber.busca_usuario(c_valuador), 'prueba-hub-a')::text, '{prueba-ag-a1,prueba-ag-a2}',
                        '6.2 Agencias asignadas');
  PERFORM pg_temp.igual(hub_cleber.agencias_permitidas(hub_cleber.busca_usuario(c_valuador), 'prueba-hub-b')::text, '{}', '6.3 Marca ajena: ninguna');
  PERFORM pg_temp.igual(hub_cleber.tiene_organizacion(hub_cleber.busca_usuario(c_valuador), 'prueba-hub-b')::text, 'false', '6.4 tiene_organizacion');
  PERFORM pg_temp.igual(hub_cleber.rol_modulo(hub_cleber.busca_usuario(c_valuador), 'valuacion'), 'VALUADOR', '6.5 rol_modulo');

  RAISE NOTICE '--- 7. Envelope ---------------------------------------------------------';
  PERFORM pg_temp.error(hub_cleber.consulta_usuario_actual('{"action": "Otra.accion"}'), 'ACCION_INVALIDA', '7.1 action ajena');
  PERFORM pg_temp.error(hub_cleber.consulta_usuario_actual('[]'), 'PETICION_INVALIDA', '7.2 El body debe ser un objeto');

  RAISE NOTICE '========================================================================';
  RAISE NOTICE 'TODAS LAS PRUEBAS PASARON';
  RAISE NOTICE '========================================================================';
END;
$$;

ROLLBACK;

\echo 'Pruebas terminadas; se hizo ROLLBACK (no quedan datos).'
