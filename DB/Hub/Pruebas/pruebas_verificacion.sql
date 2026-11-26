/*
 * pruebas_verificacion.sql — pruebas del módulo verificacion de hub_cleber (solo desarrollo/QA)
 *
 * Alta idempotente de una verificación (ID opaco + teléfono), rechazo del mismo ID con otro teléfono, resultado válido / no
 * válido, primera decisión manda y permisos (solo el sistema). Requiere haber corrido Migraciones/008 y Alta_db.sql.
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
  c_marca   CONSTANT text := 'PRUEBAVER';
  v_admin   uuid;
  v_numero  text;
  v_conv    text;
  i         jsonb;
BEGIN
  INSERT INTO hub_cleber.marcas (id_marca, nombre) VALUES (c_marca, 'Marca de prueba de verificación');
  INSERT INTO hub_cleber.usuarios (email, nombre) VALUES (c_admin, 'Admin') RETURNING id_usuario INTO v_admin;
  INSERT INTO hub_cleber.usuarios_marcas (id_usuario, id_marca) VALUES (v_admin, c_marca);
  INSERT INTO hub_cleber.usuarios_roles_modulo (id_usuario, id_marca, modulo, rol) VALUES (v_admin, c_marca, 'verificacion', 'ADMINISTRADOR');

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

  RAISE NOTICE '========================================================================';
  RAISE NOTICE 'TODAS LAS PRUEBAS PASARON';
  RAISE NOTICE '========================================================================';
END;
$$;

ROLLBACK;

\echo 'Pruebas terminadas; se hizo ROLLBACK (no quedan datos).'
