/*
 * pruebas_verificacion.sql — pruebas del módulo verificacion de hub_cleber (solo desarrollo/QA)
 *
 * Alta idempotente de una verificación (ID opaco + teléfono), rechazo del mismo ID con otro teléfono, resultado válido / no
 * válido, primera decisión manda y permisos (solo el sistema). Callback al sistema origen (enviado, fallido, simulado, ya
 * enviado y pendiente), consulta y resumen del dashboard con sus permisos, la simulación por marca en Hub.guardaMarca y los módulos activos por marca.
 * Requiere haber corrido Migraciones/008, 009 y 010 y Alta_db.sql.
 *
 * Todo corre en UNA transacción que termina en ROLLBACK: no deja datos. Usa la marca 'PRUEBAVER'.
 *
 * Ejecución, desde psql conectado a la base:
 *   \cd '<ruta del repo>/DB/Hub'
 *   \i Pruebas/pruebas_verificacion.sql
 */

\encoding UTF8
\set ON_ERROR_STOP on
\set VERBOSITY terse

BEGIN;

CREATE FUNCTION pg_temp.como(p_email text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.headers', jsonb_build_object('x-user-email', p_email)::text, true);
END $$;

-- Hub.algoAsi → hub_cleber.algo_asi, como rpc/<funcion> de PostgREST con Prefer: params=single-object
CREATE FUNCTION pg_temp.llama(p_accion text, p_params jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_funcion text := lower(regexp_replace(substr(p_accion, 5), '([A-Z])', '_\1', 'g'));
  v_resultado jsonb;
BEGIN
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

DO $$
DECLARE
  c_sistema CONSTANT text := 'sistema@hub-conversaciones.internal';
  c_admin   CONSTANT text := 'admin@prueba-ver.invalid';
  c_sin     CONSTANT text := 'sin-rol@prueba-ver.invalid';
  c_super   CONSTANT text := 'super@prueba-ver.invalid';
  c_marca   CONSTANT text := 'PRUEBAVER';
  v_admin   uuid;
  v_numero  text;
  v_conv    text;
  v_antes   text;
  i         jsonb;
BEGIN
  INSERT INTO hub_cleber.marcas (id_marca, nombre) VALUES (c_marca, 'Marca de prueba de verificación');
  INSERT INTO hub_cleber.usuarios (email, nombre) VALUES (c_admin, 'Admin') RETURNING id_usuario INTO v_admin;
  INSERT INTO hub_cleber.usuarios_marcas (id_usuario, id_marca) VALUES (v_admin, c_marca);
  INSERT INTO hub_cleber.usuarios_roles_modulo (id_usuario, id_marca, modulo, rol) VALUES (v_admin, c_marca, 'verificacion', 'ADMINISTRADOR');
  INSERT INTO hub_cleber.usuarios (email, nombre) VALUES (c_sin, 'Sin rol');
  INSERT INTO hub_cleber.usuarios_marcas (id_usuario, id_marca)
    SELECT id_usuario, c_marca FROM hub_cleber.usuarios WHERE email = c_sin;
  INSERT INTO hub_cleber.usuarios (email, nombre, es_super_admin) VALUES (c_super, 'Super', true);

  -- 1. Módulo
  PERFORM pg_temp.como(c_admin);
  i := pg_temp.ok(pg_temp.llama('Hub.guardaNumero', jsonb_build_object('idMarca', c_marca, 'modulo', 'verificacion', 'telefono', '55 1234 5678',
                                'nombre', 'Verificación prueba', 'proveedor', 'twilio')), '1.1 El módulo verificacion acepta un número');
  v_numero := i#>>'{numero,idNumero}';

  -- 2. Alta
  PERFORM pg_temp.como(c_sistema);
  i := pg_temp.ok(pg_temp.llama('Hub.abreConversacionExterna', jsonb_build_object('fuente', 'verificacion', 'idExterno', 'SF-1', 'idMarca', c_marca,
                                'modulo', 'verificacion', 'telefono', '5511112222')), '2.1 Se abre la conversación de la verificación');
  v_conv := i#>>'{conversacion,idConversacion}';
  i := pg_temp.ok(pg_temp.llama('Hub.registraVerificacion', jsonb_build_object('idExterno', 'SF-1', 'idMarca', c_marca,
                                'valor', '5511112222', 'idConversacion', v_conv)), '2.2 Se registra la verificación');
  PERFORM pg_temp.igual((i->>'creada') || '/' || (i#>>'{verificacion,estado}') || '/' || (i#>>'{verificacion,tipo}') || '/' || (i#>>'{verificacion,valor}'),
                        'true/pendiente/telefono/+525511112222', '2.3 ... pendiente, de teléfono y normalizada a E.164');
  i := pg_temp.ok(pg_temp.llama('Hub.registraVerificacion', jsonb_build_object('idExterno', 'SF-1', 'idMarca', c_marca,
                                'valor', '+52 55 1111 2222', 'idConversacion', v_conv)), '2.4 El mismo ID con el mismo teléfono');
  PERFORM pg_temp.igual(i->>'creada', 'false', '2.5 ... es idempotente');
  i := pg_temp.error(pg_temp.llama('Hub.registraVerificacion', jsonb_build_object('idExterno', 'SF-1', 'idMarca', c_marca,
                                   'valor', '5599998888')), 'ESTADO_INVALIDO', '2.6 El mismo ID con otro teléfono');
  PERFORM pg_temp.igual(i->>'motivo', 'ID_CON_OTRO_VALOR', '2.7 ... motivo ID_CON_OTRO_VALOR');
  PERFORM pg_temp.error(pg_temp.llama('Hub.registraVerificacion', jsonb_build_object('idExterno', 'SF-2', 'idMarca', c_marca,
                                      'valor', 'no-es-telefono')), 'CAMPO_INVALIDO', '2.8 Un teléfono inválido');
  PERFORM pg_temp.error(pg_temp.llama('Hub.registraVerificacion', jsonb_build_object('idExterno', 'SF-2', 'idMarca', 'NOEXISTE',
                                      'valor', '5511112222')), 'RECURSO_NO_ENCONTRADO', '2.9 Una marca inexistente');

  -- 3. Resultado
  PERFORM pg_temp.error(pg_temp.llama('Hub.actualizaVerificacion', jsonb_build_object('idExterno', 'SF-1', 'valido', 'true')),
                        'CAMPO_INVALIDO', '3.1 El resultado debe ser un booleano real, no texto');
  PERFORM pg_temp.error(pg_temp.llama('Hub.actualizaVerificacion', jsonb_build_object('idExterno', 'NO-HAY', 'valido', true)),
                        'RECURSO_NO_ENCONTRADO', '3.2 Una verificación inexistente');
  i := pg_temp.ok(pg_temp.llama('Hub.actualizaVerificacion', jsonb_build_object('idExterno', 'SF-1', 'valido', true)), '3.3 El bot confirma el teléfono');
  PERFORM pg_temp.igual((i->>'aplicada') || '/' || (i#>>'{verificacion,estado}') || '/' || (i#>>'{verificacion,callback,estado}'),
                        'true/valido/pendiente', '3.4 ... queda válida con el callback pendiente');
  i := pg_temp.ok(pg_temp.llama('Hub.actualizaVerificacion', jsonb_build_object('idExterno', 'SF-1', 'valido', false)), '3.5 Una segunda decisión');
  PERFORM pg_temp.igual((i->>'aplicada') || '/' || (i#>>'{verificacion,estado}'), 'false/valido', '3.6 ... no cambia el resultado (la primera manda)');

  PERFORM pg_temp.ok(pg_temp.llama('Hub.registraVerificacion', jsonb_build_object('idExterno', 'SF-3', 'idMarca', c_marca, 'valor', '5533334444')),
                     '3.7 Otra verificación');
  i := pg_temp.ok(pg_temp.llama('Hub.actualizaVerificacion', jsonb_build_object('idExterno', 'SF-3', 'valido', false)), '3.8 El cliente dice que no es su número');
  PERFORM pg_temp.igual((i->>'aplicada') || '/' || (i#>>'{verificacion,estado}'), 'true/no_valido', '3.9 ... queda no válida');

  -- 4. Permisos
  PERFORM pg_temp.como(c_admin);
  PERFORM pg_temp.error(pg_temp.llama('Hub.registraVerificacion', jsonb_build_object('idExterno', 'SF-9', 'idMarca', c_marca, 'valor', '5511112222')),
                        'SIN_PERMISO', '4.1 Registrar es solo del sistema');
  PERFORM pg_temp.error(pg_temp.llama('Hub.actualizaVerificacion', jsonb_build_object('idExterno', 'SF-1', 'valido', true)),
                        'SIN_PERMISO', '4.2 Resolver es solo del sistema');

  -- 5. Callback
  PERFORM pg_temp.como(c_sistema);
  i := pg_temp.ok(pg_temp.llama('Hub.registraCallbackVerificacion', jsonb_build_object('idExterno', 'SF-1', 'entregado', true)),
                  '5.1 El callback entregado');
  PERFORM pg_temp.igual((i->>'aplicada') || '/' || (i#>>'{verificacion,callback,estado}') || '/' || (i#>>'{verificacion,callback,intentos}')
                        || '/' || (i#>>'{verificacion,callbackSimulado}'), 'true/enviado/1/false', '5.2 ... queda enviado, un intento y no simulado');
  i := pg_temp.ok(pg_temp.llama('Hub.registraCallbackVerificacion', jsonb_build_object('idExterno', 'SF-1', 'entregado', false, 'error', 'HTTP 500')),
                  '5.3 Un callback ya enviado');
  PERFORM pg_temp.igual((i->>'aplicada') || '/' || (i#>>'{verificacion,callback,estado}') || '/' || (i#>>'{verificacion,callback,intentos}'),
                        'false/enviado/1', '5.4 ... no cambia');
  i := pg_temp.ok(pg_temp.llama('Hub.registraCallbackVerificacion', jsonb_build_object('idExterno', 'SF-3', 'entregado', false, 'error', 'HTTP 500')),
                  '5.5 Un callback fallido');
  PERFORM pg_temp.igual((i#>>'{verificacion,callback,estado}') || '/' || (i#>>'{verificacion,callback,ultimoError}') || '/'
                        || (i#>>'{verificacion,callback,intentos}'), 'fallido/HTTP 500/1', '5.6 ... queda fallido con el último error');
  i := pg_temp.ok(pg_temp.llama('Hub.registraCallbackVerificacion', jsonb_build_object('idExterno', 'SF-3', 'entregado', true, 'simulado', true)),
                  '5.7 Un callback simulado');
  PERFORM pg_temp.igual((i#>>'{verificacion,callback,estado}') || '/' || (i#>>'{verificacion,callbackSimulado}') || '/'
                        || (i#>>'{verificacion,callback,intentos}'), 'enviado/true/2', '5.8 ... queda enviado, simulado y con dos intentos');
  PERFORM pg_temp.ok(pg_temp.llama('Hub.registraVerificacion', jsonb_build_object('idExterno', 'SF-4', 'idMarca', c_marca, 'valor', '5544445555')),
                     '5.9 Otra verificación, pendiente');
  PERFORM pg_temp.error(pg_temp.llama('Hub.registraCallbackVerificacion', jsonb_build_object('idExterno', 'SF-4', 'entregado', true)),
                        'ESTADO_INVALIDO', '5.10 Una verificación pendiente no tiene nada que entregar');
  PERFORM pg_temp.error(pg_temp.llama('Hub.registraCallbackVerificacion', jsonb_build_object('idExterno', 'NO-HAY', 'entregado', true)),
                        'RECURSO_NO_ENCONTRADO', '5.11 Un callback de una verificación inexistente');

  -- 6. Consulta
  -- now() es la fecha de la transacción: se separan los creado_en para probar el orden y la paginación
  WITH orden AS (
    SELECT id_verificacion, row_number() OVER (ORDER BY id_verificacion) AS n
      FROM hub_cleber.verificacion_datos WHERE id_marca = c_marca)
  UPDATE hub_cleber.verificacion_datos vd
     SET creado_en = timestamptz '2026-01-01 10:00:00+00' + o.n * interval '1 minute'
    FROM orden o
   WHERE o.id_verificacion = vd.id_verificacion;

  PERFORM pg_temp.como(c_admin);
  i := pg_temp.ok(pg_temp.llama('Hub.consultaVerificaciones', jsonb_build_object('idMarca', c_marca)),
                  '6.1 El administrador consulta las verificaciones de la marca');
  PERFORM pg_temp.igual((jsonb_array_length(i->'verificaciones'))::text || '/' || (i->>'hayMas') || '/'
                        || (i#>>'{verificaciones,0,idExterno}') || '/' || coalesce(i#>>'{verificaciones,0,conversacion,estado}', 'sin'),
                        '3/false/SF-4/sin', '6.2 ... las tres, la más nueva primero y la pendiente sin conversación');
  i := pg_temp.ok(pg_temp.llama('Hub.consultaVerificaciones', jsonb_build_object('idMarca', c_marca, 'estados', jsonb_build_array('valido'))),
                  '6.3 Filtro por estado');
  PERFORM pg_temp.igual((jsonb_array_length(i->'verificaciones'))::text || '/' || (i#>>'{verificaciones,0,idExterno}') || '/'
                        || (i#>>'{verificaciones,0,conversacion,estado}'), '1/SF-1/bot', '6.4 ... solo la válida, con su conversación');
  i := pg_temp.ok(pg_temp.llama('Hub.consultaVerificaciones', jsonb_build_object('idMarca', c_marca, 'callbackEstados', jsonb_build_array('enviado'))),
                  '6.5 Filtro por estado del callback');
  PERFORM pg_temp.igual((jsonb_array_length(i->'verificaciones'))::text, '2', '6.6 ... las dos enviadas');
  i := pg_temp.ok(pg_temp.llama('Hub.consultaVerificaciones', jsonb_build_object('idMarca', c_marca, 'busqueda', 'SF-3')),
                  '6.7 Búsqueda por ID externo');
  PERFORM pg_temp.igual((jsonb_array_length(i->'verificaciones'))::text || '/' || (i#>>'{verificaciones,0,idExterno}'), '1/SF-3',
                        '6.8 ... solo la que coincide');
  i := pg_temp.ok(pg_temp.llama('Hub.consultaVerificaciones', jsonb_build_object('idMarca', c_marca, 'limite', 1)), '6.9 Paginación');
  PERFORM pg_temp.igual((jsonb_array_length(i->'verificaciones'))::text || '/' || (i->>'hayMas') || '/' || (i#>>'{verificaciones,0,idExterno}'),
                        '1/true/SF-4', '6.10 ... una y hay más');
  v_antes := i#>>'{verificaciones,0,creadoEn}';
  i := pg_temp.ok(pg_temp.llama('Hub.consultaVerificaciones', jsonb_build_object('idMarca', c_marca, 'limite', 1, 'antesDe', v_antes)),
                  '6.11 La página siguiente');
  PERFORM pg_temp.igual((jsonb_array_length(i->'verificaciones'))::text || '/' || (i->>'hayMas') || '/' || (i#>>'{verificaciones,0,idExterno}'),
                        '1/true/SF-3', '6.12 ... la anterior y todavía hay más');
  PERFORM pg_temp.error(pg_temp.llama('Hub.consultaVerificaciones', jsonb_build_object('idMarca', c_marca, 'estados', jsonb_build_array('otro'))),
                        'CAMPO_INVALIDO', '6.13 Un estado que no existe');
  PERFORM pg_temp.como(c_sin);
  PERFORM pg_temp.error(pg_temp.llama('Hub.consultaVerificaciones', jsonb_build_object('idMarca', c_marca)),
                        'SIN_PERMISO', '6.14 Sin rol del módulo no se consulta');

  -- 7. Resumen
  PERFORM pg_temp.como(c_admin);
  i := pg_temp.ok(pg_temp.llama('Hub.resumenVerificaciones', jsonb_build_object('idMarca', c_marca)), '7.1 El resumen de la marca');
  PERFORM pg_temp.igual((i->>'total') || '/' || (i->>'pendientes') || '/' || (i->>'validas') || '/' || (i->>'noValidas') || '/'
                        || (i#>>'{callback,pendiente}') || '/' || (i#>>'{callback,enviado}') || '/' || (i#>>'{callback,fallido}') || '/'
                        || (i#>>'{callback,simulados}') || '/' || (i->>'sinCallback'), '3/1/1/1/0/2/0/1/1',
                        '7.2 ... conteos por estado, por callback y simulados');
  i := pg_temp.ok(pg_temp.llama('Hub.resumenVerificaciones', jsonb_build_object('idMarca', c_marca, 'desde', '2026-01-01T10:01:30+00')),
                  '7.3 El resumen desde una fecha');
  PERFORM pg_temp.igual((i->>'total') || '/' || (i->>'pendientes'), '2/1', '7.4 ... solo las dos más nuevas');
  i := pg_temp.ok(pg_temp.llama('Hub.resumenVerificaciones', jsonb_build_object('idMarca', c_marca, 'hasta', '2026-01-01T10:01:30+00')),
                  '7.5 El resumen hasta una fecha');
  PERFORM pg_temp.igual((i->>'total') || '/' || (i->>'validas'), '1/1', '7.6 ... solo la primera');
  PERFORM pg_temp.como(c_sin);
  PERFORM pg_temp.error(pg_temp.llama('Hub.resumenVerificaciones', jsonb_build_object('idMarca', c_marca)),
                        'SIN_PERMISO', '7.7 Sin rol del módulo no hay resumen');

  -- 8. Simulación por marca
  PERFORM pg_temp.como(c_super);
  i := pg_temp.ok(pg_temp.llama('Hub.guardaMarca', jsonb_build_object('idMarca', c_marca, 'simularCallbackSf', true)),
                  '8.1 El super admin enciende la simulación del callback');
  PERFORM pg_temp.igual(i#>>'{marca,simularCallbackSf}', 'true', '8.2 ... queda en la marca');
  PERFORM pg_temp.como(c_admin);
  i := pg_temp.ok(pg_temp.llama('Hub.consultaVerificaciones', jsonb_build_object('idMarca', c_marca, 'limite', 1)),
                  '8.3 La consulta con la simulación encendida');
  PERFORM pg_temp.igual(i#>>'{verificaciones,0,simularCallback}', 'true', '8.4 ... la verificación la reporta');
  PERFORM pg_temp.como(c_super);
  i := pg_temp.ok(pg_temp.llama('Hub.guardaMarca', jsonb_build_object('idMarca', c_marca, 'nombre', 'Marca de prueba de verificación')),
                  '8.5 Un cambio de la marca sin el campo');
  PERFORM pg_temp.igual(i#>>'{marca,simularCallbackSf}', 'true', '8.6 ... no cambia la simulación');
  i := pg_temp.ok(pg_temp.llama('Hub.guardaMarca', jsonb_build_object('idMarca', c_marca, 'simularCallbackSf', false)),
                  '8.7 Se apaga la simulación');
  PERFORM pg_temp.igual(i#>>'{marca,simularCallbackSf}', 'false', '8.8 ... queda apagada');
  PERFORM pg_temp.como(c_admin);
  PERFORM pg_temp.error(pg_temp.llama('Hub.guardaMarca', jsonb_build_object('idMarca', c_marca, 'simularCallbackSf', true)),
                        'SIN_PERMISO', '8.9 Marcas es solo del super admin');

  -- 9. Módulos por marca
  PERFORM pg_temp.como(c_super);
  i := pg_temp.ok(pg_temp.llama('Hub.consultaUsuarioActual', '{}'::jsonb), '9.1 El super admin consulta sus marcas');
  PERFORM pg_temp.igual((SELECT m->'modulosActivos' FROM jsonb_array_elements(i->'marcasVisibles') m WHERE m->>'idMarca' = c_marca)::text,
                        '[]', '9.2 ... una marca sin filas no tiene módulos activos');
  PERFORM pg_temp.ok(pg_temp.llama('Hub.guardaModuloMarca', jsonb_build_object('idMarca', c_marca, 'modulo', 'verificacion', 'esActivo', true)),
                     '9.3 Se enciende verificacion');
  PERFORM pg_temp.ok(pg_temp.llama('Hub.guardaModuloMarca', jsonb_build_object('idMarca', c_marca, 'modulo', 'valuacion', 'esActivo', true)),
                     '9.4 Se enciende valuacion');
  PERFORM pg_temp.ok(pg_temp.llama('Hub.guardaModuloMarca', jsonb_build_object('idMarca', c_marca, 'modulo', 'valuacion', 'esActivo', false)),
                     '9.5 Se apaga valuacion');
  i := pg_temp.ok(pg_temp.llama('Hub.consultaUsuarioActual', '{}'::jsonb), '9.6 Se vuelven a consultar las marcas');
  PERFORM pg_temp.igual((SELECT m->'modulosActivos' FROM jsonb_array_elements(i->'marcasVisibles') m WHERE m->>'idMarca' = c_marca)::text,
                        '["verificacion"]', '9.7 ... solo queda activo verificacion');
  i := pg_temp.ok(pg_temp.llama('Hub.consultaModulosMarca', '{}'::jsonb), '9.8 El super admin consulta los módulos por marca');
  PERFORM pg_temp.igual((SELECT m->'modulos' FROM jsonb_array_elements(i->'marcas') m WHERE m->>'idMarca' = c_marca)::text,
                        '[{"modulo": "valuacion", "esActivo": false}, {"modulo": "verificacion", "esActivo": true}]', '9.9 ... con los dos estados');
  PERFORM pg_temp.error(pg_temp.llama('Hub.guardaModuloMarca', jsonb_build_object('idMarca', c_marca, 'modulo', 'inventado', 'esActivo', true)),
                        'CAMPO_INVALIDO', '9.10 No se dan de alta módulos nuevos');
  PERFORM pg_temp.error(pg_temp.llama('Hub.guardaModuloMarca', jsonb_build_object('idMarca', 'NOEXISTE', 'modulo', 'verificacion', 'esActivo', true)),
                        'RECURSO_NO_ENCONTRADO', '9.11 Una marca inexistente');
  PERFORM pg_temp.como(c_admin);
  PERFORM pg_temp.error(pg_temp.llama('Hub.guardaModuloMarca', jsonb_build_object('idMarca', c_marca, 'modulo', 'valuacion', 'esActivo', true)),
                        'SIN_PERMISO', '9.12 Solo el super admin enciende o apaga módulos');
  PERFORM pg_temp.error(pg_temp.llama('Hub.consultaModulosMarca', '{}'::jsonb), 'SIN_PERMISO', '9.13 Ni consulta la administración de módulos');
  i := pg_temp.ok(pg_temp.llama('Hub.consultaUsuarioActual', '{}'::jsonb), '9.14 El administrador de la marca ve sus módulos activos');
  PERFORM pg_temp.igual((SELECT m->'modulosActivos' FROM jsonb_array_elements(i->'marcasVisibles') m WHERE m->>'idMarca' = c_marca)::text,
                        '["verificacion"]', '9.15 ... los mismos que el super admin');

  RAISE NOTICE '========================================================================';
  RAISE NOTICE 'TODAS LAS PRUEBAS PASARON';
  RAISE NOTICE '========================================================================';
END;
$$;

ROLLBACK;

\echo 'Pruebas terminadas; se hizo ROLLBACK (no quedan datos).'
