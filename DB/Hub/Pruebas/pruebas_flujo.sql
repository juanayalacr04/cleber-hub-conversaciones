/*
 * pruebas_flujo.sql — pruebas del schema hub_cleber, adelanto de identidad y roles por marca y módulo (solo desarrollo/QA)
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
  v_valuador jsonb;
  i          jsonb;
BEGIN
  v_usuarios := jsonb_build_array(
    -- El invitado va ANTES que quien lo invitó: invitadoPor se resuelve al final
    jsonb_build_object('idOrigen', 'uid-valuador', 'email', 'Valuador@Prueba-Hub.invalid ', 'nombre', 'Vale Valuador',
      'invitadoPor', 'uid-admin',
      'organizaciones', jsonb_build_array(jsonb_build_object('idOrganizacion', 'prueba-hub-a',
        'agencias', jsonb_build_array('prueba-ag-a2', 'prueba-ag-a1', 'prueba-ag-a1'),
        'modulos', jsonb_build_object('ventas',    jsonb_build_object('rol', 'AGENTE', 'idEquipo', 'equipo-a-ventas'),
                                      'valuacion', jsonb_build_object('rol', 'VALUADOR'))))),
    -- Rol distinto por marca: administra ventas en A; en B es agente de ventas y gerente de valuación
    jsonb_build_object('idOrigen', 'uid-admin', 'email', c_admin, 'nombre', 'Ada Admin', 'estado', 'online',
      'ultimoAccesoEn', '2026-11-01T10:00:00-06:00',
      'organizaciones', jsonb_build_array(
        jsonb_build_object('idOrganizacion', 'prueba-hub-a', 'modulos', jsonb_build_object('ventas', jsonb_build_object('rol', 'ADMINISTRADOR'))),
        jsonb_build_object('idOrganizacion', 'prueba-hub-b', 'modulos', jsonb_build_object(
          'ventas', jsonb_build_object('rol', 'AGENTE', 'idEquipo', 'equipo-b'), 'valuacion', jsonb_build_object('rol', 'GERENTE'))))),
    jsonb_build_object('idOrigen', 'uid-super', 'email', c_super, 'esSuperAdmin', true, 'organizaciones', '[]'::jsonb),
    jsonb_build_object('idOrigen', 'uid-baja', 'email', 'baja@prueba-hub.invalid', 'esActivo', false,
      'organizaciones', jsonb_build_array(jsonb_build_object('idOrganizacion', 'prueba-hub-a',
        'modulos', jsonb_build_object('ventas', jsonb_build_object('rol', 'AGENTE'))))));

  v_carga := jsonb_build_object(
    'organizaciones', jsonb_build_array(
      jsonb_build_object('idOrganizacion', 'prueba-hub-a', 'nombre', 'Marca A (prueba)', 'sfCodigoMarca', 'PRUEBAHA', 'plan', 'enterprise',
                         'horario', jsonb_build_object('businessHours', jsonb_build_object('start', '09:00', 'end', '19:00')),
                         'salesforceConfig', jsonb_build_object('marcaRR', 'HA')),
      jsonb_build_object('idOrganizacion', 'prueba-hub-b', 'nombre', 'Marca B (prueba)')),
    'usuarios', v_usuarios);

  RAISE NOTICE '--- 1. Seguridad y catálogo ---------------------------------------------';
  PERFORM pg_temp.sin_usuario();
  PERFORM pg_temp.error(pg_temp.llama('Hub.consultaUsuarioActual', '{}'), 'SIN_PERMISO', '1.1 Sin X-User-Email no hay acceso');
  PERFORM pg_temp.como('nadie@prueba-hub.invalid');
  PERFORM pg_temp.error(pg_temp.llama('Hub.consultaUsuarioActual', '{}'), 'SIN_PERMISO', '1.2 Email no registrado');
  PERFORM pg_temp.error(pg_temp.llama('Hub.importaUsuarios', v_carga), 'SIN_PERMISO', '1.3 importaUsuarios sin usuario registrado');
  PERFORM pg_temp.como('sistema@toma-unidades.internal');
  i := pg_temp.ok(pg_temp.llama('Hub.consultaUsuarioActual', '{}'), '1.4 El sistema de valuación existe (datos maestros)');
  PERFORM pg_temp.igual(i#>>'{usuario,esSistema}', 'true', '1.5 ... es de sistema');
  PERFORM pg_temp.igual(i#>>'{usuario,organizaciones}', '[]', '1.6 ... sin marcas ni roles del catálogo');
  PERFORM pg_temp.igual((SELECT string_agg(rol, ',' ORDER BY orden) FROM hub_cleber.roles_modulo WHERE modulo = 'valuacion'),
                        'ADMINISTRADOR,GERENTE,VALUADOR,CONSULTA', '1.7 Catálogo de roles de valuación');
  PERFORM pg_temp.igual((SELECT string_agg(rol, ',') FROM hub_cleber.roles_modulo WHERE es_administrador), 'ADMINISTRADOR,ADMINISTRADOR,ADMINISTRADOR',
                        '1.8 Un rol administrador por módulo');

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
  PERFORM pg_temp.igual((SELECT count(*)::text FROM hub_cleber.usuarios_roles_modulo rm JOIN hub_cleber.usuarios u USING (id_usuario)
                          WHERE u.email LIKE '%@prueba-hub.invalid'), '6', '2.10 Idempotente: mismos roles');
  i := hub_cleber.usuarios_contexto(c_admin, 'ventas');
  PERFORM pg_temp.igual((i#>>'{marcas,prueba-hub-a,rol}') || '/' || (i#>>'{marcas,prueba-hub-b,rol}'), 'ADMINISTRADOR/AGENTE',
                        '2.11 Rol distinto por marca en el mismo módulo');
  PERFORM pg_temp.igual(i#>>'{marcas,prueba-hub-b,idEquipo}', 'equipo-b', '2.12 Equipo por marca y módulo');

  -- Reemplazo: el admin queda solo en A; el valuador pierde el rol de ventas; el email del valuador cambia (mismo uid)
  v_usuarios := jsonb_set(v_usuarios, '{1,organizaciones}', jsonb_build_array(v_usuarios #> '{1,organizaciones,0}'));
  v_usuarios := jsonb_set(v_usuarios, '{0,organizaciones,0,modulos}', jsonb_build_object('valuacion', jsonb_build_object('rol', 'VALUADOR')));
  v_usuarios := jsonb_set(v_usuarios, '{0,email}', '"valuador2@prueba-hub.invalid"');
  PERFORM pg_temp.ok(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object('usuarios', v_usuarios)), '2.13 Carga solo de usuarios');
  PERFORM pg_temp.igual((SELECT string_agg(id_organizacion, ',') FROM hub_cleber.usuarios_organizaciones uo JOIN hub_cleber.usuarios u USING (id_usuario)
                          WHERE u.email = c_admin), 'prueba-hub-a', '2.14 Las marcas se reemplazan');
  PERFORM pg_temp.igual((SELECT string_agg(rm.id_organizacion || ':' || rm.modulo, ',') FROM hub_cleber.usuarios_roles_modulo rm
                          JOIN hub_cleber.usuarios u USING (id_usuario) WHERE u.email = c_admin), 'prueba-hub-a:ventas',
                        '2.15 ... y los roles de la marca quitada se borran');
  PERFORM pg_temp.igual((SELECT string_agg(modulo, ',') FROM hub_cleber.usuarios_roles_modulo rm JOIN hub_cleber.usuarios u USING (id_usuario)
                          WHERE u.id_origen = 'uid-valuador'), 'valuacion', '2.16 Los roles de la marca se reemplazan');
  PERFORM pg_temp.igual((SELECT email FROM hub_cleber.usuarios WHERE id_origen = 'uid-valuador'), 'valuador2@prueba-hub.invalid',
                        '2.17 Email cambiado: se encuentra por idOrigen');
  PERFORM pg_temp.igual((SELECT count(*)::text FROM hub_cleber.usuarios WHERE email = c_valuador), '0', '2.18 ... sin duplicar al usuario');
  -- Se regresa al email original para el resto de las pruebas
  v_usuarios := jsonb_set(v_usuarios, '{0,email}', to_jsonb(c_valuador));
  PERFORM pg_temp.ok(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object('usuarios', v_usuarios)), '2.19 Email de vuelta');

  -- Carga que maneja solo ventas y servicio (como la de Firestore): el rol de valuación no se toca
  v_valuador := jsonb_set(v_usuarios -> 0, '{organizaciones,0,modulos}',
                          jsonb_build_object('servicio', jsonb_build_object('rol', 'CONSULTA', 'idEquipo', 'equipo-a-servicio')));
  PERFORM pg_temp.ok(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object(
            'modulos', jsonb_build_array('ventas', 'servicio'), 'usuarios', jsonb_build_array(v_valuador))), '2.20 Carga de ventas y servicio');
  PERFORM pg_temp.igual((SELECT string_agg(modulo || '=' || rol, ',' ORDER BY modulo) FROM hub_cleber.usuarios_roles_modulo rm
                          JOIN hub_cleber.usuarios u USING (id_usuario) WHERE u.email = c_valuador),
                        'servicio=CONSULTA,valuacion=VALUADOR', '2.21 ... conserva el rol de valuación');

  RAISE NOTICE '--- 3. Validaciones de la carga (todo o nada) --------------------------';
  i := pg_temp.error(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object(
         'organizaciones', jsonb_build_array(jsonb_build_object('idOrganizacion', 'prueba-hub-c', 'nombre', 'C')),
         'usuarios', jsonb_build_array(
           jsonb_build_object('email', 'x@prueba-hub.invalid', 'organizaciones', '[]'::jsonb),
           jsonb_build_object('email', 'x2@prueba-hub.invalid',
             'organizaciones', jsonb_build_array(jsonb_build_object('idOrganizacion', 'prueba-hub-a', 'agencias', jsonb_build_array(''))))))),
       'CAMPO_INVALIDO', '3.1 Agencia vacía');
  PERFORM pg_temp.igual(i->>'lista' || '[' || (i->>'indice') || ']', 'usuarios[1]', '3.2 info trae lista e índice');
  PERFORM pg_temp.igual(i->>'campo', 'agencias', '3.3 ... y el campo');
  PERFORM pg_temp.igual((SELECT count(*)::text FROM hub_cleber.organizaciones WHERE id_organizacion = 'prueba-hub-c'), '0',
                        '3.4 Todo o nada: la organización de la carga fallida no quedó');
  PERFORM pg_temp.error(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object('usuarios', jsonb_build_array(
         jsonb_build_object('email', 'y@prueba-hub.invalid', 'organizaciones', jsonb_build_array(jsonb_build_object('idOrganizacion', 'no-existe')))))),
       'CAMPO_INVALIDO', '3.5 Organización inexistente');
  PERFORM pg_temp.error(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object('usuarios', jsonb_build_array(
         jsonb_build_object('email', 'z@prueba-hub.invalid', 'organizaciones', '[]'::jsonb),
         jsonb_build_object('email', 'Z@prueba-hub.invalid', 'organizaciones', '[]'::jsonb)))),
       'CAMPO_INVALIDO', '3.6 Usuario repetido en la carga');
  i := pg_temp.error(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object('usuarios', jsonb_build_array(
         jsonb_build_object('email', 'w@prueba-hub.invalid', 'organizaciones', jsonb_build_array(jsonb_build_object('idOrganizacion', 'prueba-hub-a',
           'modulos', jsonb_build_object('ventas', jsonb_build_object('rol', 'VALUADOR')))))))),
       'CAMPO_INVALIDO', '3.7 Rol que no existe en ese módulo');
  PERFORM pg_temp.igual(i->>'modulo', 'ventas', '3.8 ... info trae el módulo');
  PERFORM pg_temp.error(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object('usuarios', jsonb_build_array(
         jsonb_build_object('email', 'otro@algo.internal', 'organizaciones', '[]'::jsonb)))),
       'CAMPO_INVALIDO', '3.9 No se importan emails de sistema');
  PERFORM pg_temp.error(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object('usuarios', jsonb_build_array(
         jsonb_build_object('email', 'v@prueba-hub.invalid', 'organizaciones', jsonb_build_array(jsonb_build_object('idOrganizacion', 'prueba-hub-a',
           'modulos', jsonb_build_object('valuacion', jsonb_build_object('rol', 'SISTEMA')))))))),
       'CAMPO_INVALIDO', '3.10 El rol SISTEMA no está en el catálogo');
  PERFORM pg_temp.error(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object('modulos', jsonb_build_array('ventas'),
         'usuarios', jsonb_build_array(jsonb_build_object('email', 'u@prueba-hub.invalid', 'organizaciones', jsonb_build_array(
           jsonb_build_object('idOrganizacion', 'prueba-hub-a', 'modulos', jsonb_build_object('valuacion', jsonb_build_object('rol', 'VALUADOR')))))))),
       'CAMPO_INVALIDO', '3.11 Rol de un módulo que la carga no maneja');
  PERFORM pg_temp.error(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object('modulos', jsonb_build_array('marketing'))),
       'CAMPO_INVALIDO', '3.12 Módulo desconocido');
  PERFORM pg_temp.error(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object('usuarios', jsonb_build_array(
         jsonb_build_object('email', 't@prueba-hub.invalid', 'organizaciones', jsonb_build_array(jsonb_build_object('idOrganizacion', 'prueba-hub-a',
           'modulos', jsonb_build_object('ventas', '"AGENTE"'::jsonb))))))),
       'CAMPO_INVALIDO', '3.13 El rol del módulo va como objeto { rol, idEquipo? }');
  PERFORM pg_temp.error(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object('usuarios', jsonb_build_array(
         jsonb_build_object('email', 'sin-orgs@prueba-hub.invalid')))),
       'CAMPO_REQUERIDO', '3.14 organizaciones es obligatorio por usuario');
  PERFORM pg_temp.error(pg_temp.llama('Hub.importaUsuarios', jsonb_build_object('organizaciones', jsonb_build_array(
         jsonb_build_object('idOrganizacion', 'prueba-hub-b', 'nombre', 'B', 'sfCodigoMarca', 'PRUEBAHA')))),
       'CAMPO_INVALIDO', '3.15 Código de marca de Salesforce repetido');
  PERFORM pg_temp.como(c_admin);
  PERFORM pg_temp.error(pg_temp.llama('Hub.importaUsuarios', v_carga), 'SIN_PERMISO', '3.16 Un admin humano no importa');

  RAISE NOTICE '--- 4. consultaUsuarioActual ------------------------------------------';
  PERFORM pg_temp.como(upper(c_admin));
  i := pg_temp.ok(pg_temp.llama('Hub.consultaUsuarioActual', NULL), '4.1 El email del header no distingue mayúsculas');
  PERFORM pg_temp.igual(i#>>'{usuario,organizaciones,0,modulos,ventas,rol}', 'ADMINISTRADOR', '4.2 Rol por marca y módulo');
  PERFORM pg_temp.igual(jsonb_path_query_array(i, '$.organizacionesVisibles[*].idOrganizacion')::text, '["prueba-hub-a"]',
                        '4.3 Solo ve sus marcas');
  PERFORM pg_temp.igual(i#>>'{usuario,rol}', NULL, '4.4 Sin rol global');
  PERFORM pg_temp.como(c_super);
  i := pg_temp.ok(pg_temp.llama('Hub.consultaUsuarioActual', '{}'), '4.5 Super admin');
  PERFORM pg_temp.igual((jsonb_path_query_array(i, '$.organizacionesVisibles[*].idOrganizacion') @> '["prueba-hub-a","prueba-hub-b"]')::text,
                        'true', '4.6 El super admin ve todas las marcas');
  PERFORM pg_temp.como(c_valuador);
  i := pg_temp.ok(pg_temp.llama('Hub.consultaUsuarioActual', '{}'), '4.7 Valuador');
  PERFORM pg_temp.igual(i#>>'{usuario,organizaciones,0,modulos,servicio,idEquipo}', 'equipo-a-servicio', '4.8 Equipo por módulo');
  PERFORM pg_temp.igual(i#>>'{usuario,organizaciones,0,modulos,valuacion}', '{"rol": "VALUADOR", "idEquipo": null}', '4.9 Rol de valuación');
  PERFORM pg_temp.igual(i#>>'{usuario,organizaciones,0,agencias}', '["prueba-ag-a1", "prueba-ag-a2"]', '4.10 Agencias de la marca');
  PERFORM pg_temp.como('baja@prueba-hub.invalid');
  PERFORM pg_temp.error(pg_temp.llama('Hub.consultaUsuarioActual', '{}'), 'SIN_PERMISO', '4.11 Un usuario inactivo no entra');

  RAISE NOTICE '--- 5. usuarios_contexto (para valuación) -----------------------------';
  i := hub_cleber.usuarios_contexto(' VALUADOR@prueba-hub.invalid', 'valuacion');
  PERFORM pg_temp.igual(i#>>'{marcas,prueba-hub-a,rol}', 'VALUADOR', '5.1 Rol del módulo en la marca');
  PERFORM pg_temp.igual(i#>>'{marcas,prueba-hub-a,agencias}', '["prueba-ag-a1", "prueba-ag-a2"]', '5.2 Agencias de la marca');
  PERFORM pg_temp.igual(i->>'esSuperAdmin', 'false', '5.3 esSuperAdmin');
  PERFORM pg_temp.igual(hub_cleber.usuarios_contexto(c_valuador, 'ventas')->>'marcas', '{}', '5.4 Sin rol en el módulo → sin marcas');
  PERFORM pg_temp.igual(hub_cleber.usuarios_contexto('nadie@prueba-hub.invalid', 'valuacion')::text, NULL, '5.5 Usuario inexistente → NULL');
  PERFORM pg_temp.igual(hub_cleber.usuarios_contexto('baja@prueba-hub.invalid', 'valuacion')::text, NULL, '5.6 Usuario inactivo → NULL');
  i := hub_cleber.usuarios_contexto('sistema@toma-unidades.internal', 'valuacion');
  PERFORM pg_temp.igual((i->>'esSistema') || '/' || (i->>'marcas'), 'true/{}', '5.7 Sistema de valuación: esSistema, sin marcas');

  RAISE NOTICE '--- 6. Helpers de permisos --------------------------------------------';
  PERFORM pg_temp.igual(hub_cleber.agencias_permitidas(hub_cleber.busca_usuario(c_super), 'prueba-hub-a')::text, NULL,
                        '6.1 Super admin: NULL = sin restricción');
  PERFORM pg_temp.igual(hub_cleber.agencias_permitidas(hub_cleber.busca_usuario(c_valuador), 'prueba-hub-a')::text, '{prueba-ag-a1,prueba-ag-a2}',
                        '6.2 Agencias asignadas');
  PERFORM pg_temp.igual(hub_cleber.agencias_permitidas(hub_cleber.busca_usuario(c_valuador), 'prueba-hub-b')::text, '{}', '6.3 Marca ajena: ninguna');
  PERFORM pg_temp.igual(hub_cleber.tiene_organizacion(hub_cleber.busca_usuario(c_valuador), 'prueba-hub-b')::text, 'false', '6.4 tiene_organizacion');
  PERFORM pg_temp.igual(hub_cleber.rol_modulo(hub_cleber.busca_usuario(c_valuador), 'prueba-hub-a', 'valuacion'), 'VALUADOR', '6.5 rol_modulo');
  PERFORM pg_temp.igual(hub_cleber.es_administrador_modulo(hub_cleber.busca_usuario(c_admin), 'prueba-hub-a', 'ventas')::text, 'true',
                        '6.6 Administra el módulo donde su rol es de administrador');
  PERFORM pg_temp.igual(hub_cleber.es_administrador_modulo(hub_cleber.busca_usuario(c_admin), 'prueba-hub-a', 'servicio')::text, 'false',
                        '6.7 ... y no otro módulo de la misma marca');
  PERFORM pg_temp.igual(hub_cleber.es_administrador_modulo(hub_cleber.busca_usuario(c_super), 'prueba-hub-b', 'valuacion')::text, 'true',
                        '6.8 El super admin administra todo');
  PERFORM pg_temp.igual(hub_cleber.es_administrador_organizacion(hub_cleber.busca_usuario(c_admin), 'prueba-hub-a')::text, 'true',
                        '6.9 Administrador de la marca: administra algún módulo');
  PERFORM pg_temp.igual(hub_cleber.es_administrador_organizacion(hub_cleber.busca_usuario(c_valuador), 'prueba-hub-a')::text, 'false',
                        '6.10 Un valuador no administra la marca');

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
