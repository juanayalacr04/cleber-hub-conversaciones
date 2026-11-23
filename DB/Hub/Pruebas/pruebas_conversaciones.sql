/*
 * pruebas_conversaciones.sql — pruebas del núcleo de conversaciones de hub_cleber (solo desarrollo/QA)
 *
 * Configuración (equipos, bots, números), pipeline (resolver número, abrir/reabrir conversación, guardar mensaje,
 * actualizar), contrato ① y bandeja con permisos por equipo.
 *
 * Llama a las acciones como lo haría PostgREST (simula X-User-Email con request.headers).
 * Todo corre en UNA transacción que termina en ROLLBACK: no deja datos.
 * Usa la marca 'PRUEBACONV' y emails @prueba-conv.invalid.
 *
 * Ejecución, desde psql conectado a la base:
 *   \cd '<ruta del repo>/DB/Hub'
 *   \i Pruebas/pruebas_conversaciones.sql
 *
 * Cada caso imprime "OK  <caso>". Si uno falla, el script se detiene con "FALLÓ <caso>"; en ese caso escribe
 * ROLLBACK; para cerrar la transacción.
 */

\encoding UTF8
\set ON_ERROR_STOP on
\set VERBOSITY terse

BEGIN;

-- ============================================================================
-- Helpers de prueba (temporales)
-- ============================================================================

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
  c_admin   CONSTANT text := 'admin@prueba-conv.invalid';
  c_ag_a    CONSTANT text := 'agente-a@prueba-conv.invalid';
  c_ag_b    CONSTANT text := 'agente-b@prueba-conv.invalid';
  c_serv    CONSTANT text := 'servicio@prueba-conv.invalid';
  c_cons    CONSTANT text := 'consulta@prueba-conv.invalid';
  c_marca   CONSTANT text := 'PRUEBACONV';
  v_admin   uuid;
  v_ag_a    uuid;
  v_ag_b    uuid;
  v_serv    uuid;
  v_cons    uuid;
  v_gerente uuid;
  v_conv3   text;
  v_eq_a    text;
  v_eq_b    text;
  v_bot     text;
  v_numero  text;
  v_conv    text;
  v_conv2   text;
  v_ext     text;
  v_version integer;
  v_id_msj  text;
  i         jsonb;
BEGIN
  -- ==========================================================================
  -- 0. Datos base: marca y usuarios (directo en tablas)
  -- ==========================================================================
  INSERT INTO hub_cleber.marcas (id_marca, nombre) VALUES (c_marca, 'Marca de prueba de conversaciones');
  INSERT INTO hub_cleber.usuarios (email, nombre) VALUES (c_admin, 'Admin') RETURNING id_usuario INTO v_admin;
  INSERT INTO hub_cleber.usuarios (email, nombre) VALUES (c_ag_a, 'Agente A') RETURNING id_usuario INTO v_ag_a;
  INSERT INTO hub_cleber.usuarios (email, nombre) VALUES (c_ag_b, 'Agente B') RETURNING id_usuario INTO v_ag_b;
  INSERT INTO hub_cleber.usuarios (email, nombre) VALUES (c_serv, 'Solo servicio') RETURNING id_usuario INTO v_serv;
  INSERT INTO hub_cleber.usuarios (email, nombre) VALUES (c_cons, 'Consulta') RETURNING id_usuario INTO v_cons;
  INSERT INTO hub_cleber.usuarios_marcas (id_usuario, id_marca)
  SELECT u, c_marca FROM unnest(ARRAY[v_admin, v_ag_a, v_ag_b, v_serv, v_cons]) u;
  INSERT INTO hub_cleber.usuarios_roles_modulo (id_usuario, id_marca, modulo, rol)
  VALUES (v_admin, c_marca, 'valuacion', 'ADMINISTRADOR'), (v_serv, c_marca, 'servicio', 'AGENTE');

  -- ==========================================================================
  -- 1. Configuración
  -- ==========================================================================
  PERFORM pg_temp.como(c_admin);
  i := pg_temp.ok(pg_temp.llama('Hub.guardaEquipo', jsonb_build_object('idMarca', lower(c_marca), 'modulo', 'valuacion', 'nombre', 'Equipo A')),
                  '1.1 El administrador del módulo da de alta un equipo (la marca se acepta en minúsculas)');
  v_eq_a := i#>>'{equipo,idEquipo}';
  PERFORM pg_temp.igual(i#>>'{equipo,idMarca}', c_marca, '1.2 ... con la marca en mayúsculas');
  i := pg_temp.ok(pg_temp.llama('Hub.guardaEquipo', jsonb_build_object('idMarca', c_marca, 'modulo', 'valuacion', 'nombre', 'Equipo B')),
                  '1.3 Segundo equipo');
  v_eq_b := i#>>'{equipo,idEquipo}';

  INSERT INTO hub_cleber.usuarios_roles_modulo (id_usuario, id_marca, modulo, rol, id_equipo)
  VALUES (v_ag_a, c_marca, 'valuacion', 'VALUADOR', v_eq_a), (v_ag_b, c_marca, 'valuacion', 'VALUADOR', v_eq_b),
         (v_cons, c_marca, 'valuacion', 'CONSULTA', v_eq_a);

  PERFORM pg_temp.como(c_ag_a);
  PERFORM pg_temp.error(pg_temp.llama('Hub.guardaEquipo', jsonb_build_object('idMarca', c_marca, 'modulo', 'valuacion', 'nombre', 'X')),
                        'SIN_PERMISO', '1.4 Un valuador no configura el módulo');

  PERFORM pg_temp.como(c_admin);
  i := pg_temp.error(pg_temp.llama('Hub.guardaBot', jsonb_build_object('idMarca', c_marca, 'modulo', 'valuacion', 'nombre', 'Bot',
                                   'config', '{"abacusConfig":{"deploymentId":"d1","deploymentToken":"secreto"}}'::jsonb)),
                     'CAMPO_INVALIDO', '1.5 Un bot con credenciales en config se rechaza');
  PERFORM pg_temp.igual(i->>'campo', 'config', '1.6 ... señalando el campo config');
  i := pg_temp.ok(pg_temp.llama('Hub.guardaBot', jsonb_build_object('idMarca', c_marca, 'modulo', 'valuacion', 'nombre', 'Bot de valuación',
                                'config', '{"abacusConfig":{"deploymentId":"d1"}}'::jsonb)), '1.7 Alta de bot sin credenciales');
  v_bot := i#>>'{bot,idBot}';
  PERFORM pg_temp.igual(i#>>'{bot,tipo}', 'chatllm', '1.8 ... tipo chatllm por omisión');

  i := pg_temp.ok(pg_temp.llama('Hub.guardaNumero', jsonb_build_object('idMarca', c_marca, 'modulo', 'valuacion', 'telefono', '55 1234 5678',
                                'nombre', 'Valuación prueba', 'proveedor', 'twilio', 'idEquipo', v_eq_a, 'idBotDefault', v_bot)),
                  '1.9 Alta de número');
  v_numero := i#>>'{numero,idNumero}';
  PERFORM pg_temp.igual(i#>>'{numero,telefono}', '+525512345678', '1.10 ... con el teléfono en E.164');
  PERFORM pg_temp.igual(i#>>'{numero,ventanaReaperturaHoras}', '96', '1.11 ... y la ventana de reapertura por omisión');
  i := pg_temp.error(pg_temp.llama('Hub.guardaNumero', jsonb_build_object('idMarca', c_marca, 'modulo', 'valuacion', 'telefono', '5500000001',
                                   'nombre', 'Otro', 'proveedor', 'meta')), 'ESTADO_INVALIDO', '1.12 Un segundo número activo del módulo se rechaza');
  PERFORM pg_temp.igual(i->>'motivo', 'NUMERO_EXISTENTE', '1.13 ... con motivo NUMERO_EXISTENTE');
  PERFORM pg_temp.igual(hub_cleber.telefono_numero('whatsapp:+52 1 55 9999 0000') || '/' || hub_cleber.telefono_numero('5599990000')
                        || '/' || clientes.normaliza_telefono('+5215599990000'),
                        '+5215599990000/+525599990000/+525599990000', '1.11b El número propio conserva el 1 (+521); el del cliente no');
  i := pg_temp.error(pg_temp.llama('Hub.guardaNumero', jsonb_build_object('idNumero', v_numero, 'idEquipo', 'no-existe')),
                     'CAMPO_INVALIDO', '1.14 Un equipo que no es del módulo se rechaza');

  PERFORM pg_temp.como(c_sistema);
  i := pg_temp.error(pg_temp.llama('Hub.guardaNumero', jsonb_build_object('idMarca', c_marca, 'modulo', 'servicio', 'telefono', '+52 55 1234 5678',
                                   'nombre', 'Servicio', 'proveedor', 'twilio')), 'ESTADO_INVALIDO', '1.15 El mismo teléfono no puede estar activo en otro módulo');
  PERFORM pg_temp.igual(i->>'motivo', 'TELEFONO_EN_USO', '1.16 ... con motivo TELEFONO_EN_USO');

  PERFORM pg_temp.como(c_ag_a);
  i := pg_temp.ok(pg_temp.llama('Hub.consultaConfiguracionModulo', jsonb_build_object('idMarca', c_marca, 'modulo', 'valuacion')),
                  '1.17 Un valuador consulta la configuración del módulo');
  PERFORM pg_temp.igual(jsonb_array_length(i->'numeros')::text || '/' || jsonb_array_length(i->'equipos') || '/' || (i->>'puedeEditar'),
                        '1/2/false', '1.18 ... ve el número y los equipos, sin poder editar');
  PERFORM pg_temp.como(c_serv);
  PERFORM pg_temp.error(pg_temp.llama('Hub.consultaConfiguracionModulo', jsonb_build_object('idMarca', c_marca, 'modulo', 'valuacion')),
                        'SIN_PERMISO', '1.19 Sin rol en el módulo no se ve su configuración');

  PERFORM pg_temp.como(c_admin);
  PERFORM pg_temp.error(pg_temp.llama('Hub.marcaSecretosConfigurados', jsonb_build_object('tipo', 'numero', 'id', v_numero, 'secretos', '["twilioAuthToken"]'::jsonb)),
                        'SIN_PERMISO', '1.20 Solo el sistema marca credenciales');
  PERFORM pg_temp.como(c_sistema);
  i := pg_temp.ok(pg_temp.llama('Hub.marcaSecretosConfigurados', jsonb_build_object('tipo', 'numero', 'id', v_numero, 'secretos', '["twilioAuthToken"]'::jsonb)),
                  '1.21 El sistema marca las credenciales del número');
  PERFORM pg_temp.igual(i#>>'{numero,secretosConfigurados}', '["twilioAuthToken"]', '1.22 ... y quedan en secretosConfigurados');

  -- ==========================================================================
  -- 2. Pipeline (sistema)
  -- ==========================================================================
  i := pg_temp.ok(pg_temp.llama('Hub.resuelveNumero', '{"telefono":"whatsapp:+525512345678"}'), '2.1 Resuelve el número por teléfono con prefijo whatsapp:');
  PERFORM pg_temp.igual(i#>>'{numero,idNumero}' || '/' || (i#>>'{botDefault,idBot}') || '/' || (i#>>'{equipo,idEquipo}') || '/' || (i#>>'{marca,idMarca}'),
                        v_numero || '/' || v_bot || '/' || v_eq_a || '/' || c_marca, '2.2 ... con su bot, equipo y marca');
  PERFORM pg_temp.ok(pg_temp.llama('Hub.resuelveNumero', jsonb_build_object('idMarca', c_marca, 'modulo', 'valuacion')), '2.3 Resuelve por marca y módulo');
  PERFORM pg_temp.error(pg_temp.llama('Hub.resuelveNumero', jsonb_build_object('idMarca', c_marca, 'modulo', 'servicio')),
                        'RECURSO_NO_ENCONTRADO', '2.4 Un módulo sin número activo');
  PERFORM pg_temp.como(c_admin);
  PERFORM pg_temp.error(pg_temp.llama('Hub.resuelveNumero', '{"telefono":"+525512345678"}'), 'SIN_PERMISO', '2.5 El pipeline es solo del sistema');

  PERFORM pg_temp.como(c_sistema);
  i := pg_temp.ok(pg_temp.llama('Hub.obtieneOAbreConversacion', jsonb_build_object('idNumero', v_numero, 'telefonoCliente', '5598765432',
                                'nombreCliente', 'Cliente Uno')), '2.6 Primer mensaje de un cliente');
  v_conv := i#>>'{conversacion,idConversacion}';
  PERFORM pg_temp.igual((i->>'origen') || '/' || (i#>>'{conversacion,estado}') || '/' || (i#>>'{conversacion,idBot}') || '/' || (i#>>'{conversacion,modulo}'),
                        'nueva/bot/' || v_bot || '/valuacion', '2.7 ... abre una nueva con el bot y el módulo del número');
  PERFORM pg_temp.igual(i#>>'{conversacion,telefonoCliente}', '+525598765432', '2.8 ... con el teléfono normalizado');
  i := pg_temp.ok(pg_temp.llama('Hub.obtieneOAbreConversacion', jsonb_build_object('idNumero', v_numero, 'telefonoCliente', '+52 1 55 9876 5432')),
                  '2.9 Segundo mensaje (el teléfono con 521)');
  PERFORM pg_temp.igual((i->>'origen') || '/' || (i#>>'{conversacion,idConversacion}'), 'abierta/' || v_conv, '2.10 ... usa la misma conversación');

  i := pg_temp.ok(pg_temp.llama('Hub.guardaMensaje', jsonb_build_object('idConversacion', v_conv, 'remitente', 'customer', 'texto', 'Hola',
                                'idMensajeProveedor', 'SM-prueba-1')), '2.11 Guarda el mensaje del cliente');
  v_version := (i#>>'{conversacion,version}')::integer;
  PERFORM pg_temp.igual((i#>>'{conversacion,ultimoRemitente}') || '/' || (i#>>'{conversacion,ultimoMensajeTexto}') || '/' || (i->>'duplicado'),
                        'customer/Hola/false', '2.12 ... y actualiza el último mensaje de la conversación');
  i := pg_temp.ok(pg_temp.llama('Hub.guardaMensaje', jsonb_build_object('idConversacion', v_conv, 'remitente', 'customer', 'texto', 'Hola',
                                'idMensajeProveedor', 'SM-prueba-1')), '2.13 El mismo mensaje del proveedor otra vez');
  PERFORM pg_temp.igual((i->>'duplicado') || '/' || (SELECT count(*) FROM hub_cleber.mensajes WHERE id_conversacion = v_conv)::text,
                        'true/1', '2.14 ... no se duplica');
  i := pg_temp.ok(pg_temp.llama('Hub.guardaMensaje', jsonb_build_object('idConversacion', v_conv, 'remitente', 'system', 'texto', '<<CONTEXTO>> x')),
                  '2.15 Un mensaje de sistema');
  PERFORM pg_temp.igual(i#>>'{conversacion,ultimoRemitente}', 'customer', '2.16 ... no cuenta como último mensaje');
  PERFORM pg_temp.ok(pg_temp.llama('Hub.guardaMensaje', jsonb_build_object('idConversacion', v_conv, 'remitente', 'bot', 'texto', '¿En qué te ayudo?')),
                     '2.17 Respuesta del bot');
  i := pg_temp.ok(pg_temp.llama('Hub.obtieneOAbreConversacion', jsonb_build_object('idNumero', v_numero, 'telefonoCliente', '5598765432')),
                  '2.18 El siguiente mensaje trae el historial');
  PERFORM pg_temp.igual(jsonb_array_length(i->'historial')::text || '/' || (i#>>'{historial,0,texto}'), '3/Hola',
                        '2.19 ... en orden cronológico, con el de sistema');

  PERFORM pg_temp.error(pg_temp.llama('Hub.actualizaConversacion', jsonb_build_object('idConversacion', v_conv, 'estado', 'with_agent', 'versionEsperada', 1)),
                        'CONFLICTO_VERSION', '2.20 Una versión vieja se rechaza');
  i := pg_temp.ok(pg_temp.llama('Hub.actualizaConversacion', jsonb_build_object('idConversacion', v_conv, 'estado', 'with_agent', 'idAgente', v_ag_a,
                                'metadatos', '{"a":1,"b":2}'::jsonb)), '2.21 Pasa a un asesor');
  i := pg_temp.ok(pg_temp.llama('Hub.actualizaConversacion', jsonb_build_object('idConversacion', v_conv, 'estado', 'closed',
                                'metadatos', '{"b":null,"c":3}'::jsonb)), '2.22 Se cierra');
  PERFORM pg_temp.igual((i#>>'{conversacion,cerradaEn}' IS NOT NULL)::text || '/' || (i#>>'{conversacion,metadatos}') || '/' || (i#>>'{anterior,estado}'),
                        'true/{"a": 1, "c": 3}/with_agent', '2.23 ... sella cerradaEn, mezcla metadatos (null borra) y regresa el estado anterior');
  i := pg_temp.ok(pg_temp.llama('Hub.obtieneOAbreConversacion', jsonb_build_object('idNumero', v_numero, 'telefonoCliente', '5598765432')),
                  '2.24 El cliente vuelve a escribir dentro de la ventana');
  PERFORM pg_temp.igual((i->>'origen') || '/' || (i#>>'{conversacion,idConversacion}') || '/' || (i#>>'{conversacion,estado}') || '/' || (i#>>'{conversacion,idAgente}'),
                        'reabierta/' || v_conv || '/with_agent/' || v_ag_a, '2.25 ... se reabre con el asesor que la traía');

  PERFORM pg_temp.ok(pg_temp.llama('Hub.actualizaConversacion', jsonb_build_object('idConversacion', v_conv, 'estado', 'closed', 'cierreManual', true)),
                     '2.26 Cierre manual (/reset)');
  i := pg_temp.ok(pg_temp.llama('Hub.obtieneOAbreConversacion', jsonb_build_object('idNumero', v_numero, 'telefonoCliente', '5598765432')),
                  '2.27 El cliente escribe después de un cierre manual');
  v_conv2 := i#>>'{conversacion,idConversacion}';
  PERFORM pg_temp.igual((i->>'origen') || '/' || (v_conv2 <> v_conv)::text, 'nueva/true', '2.28 ... abre una nueva');

  PERFORM pg_temp.error(pg_temp.llama('Hub.actualizaConversacion', jsonb_build_object('idConversacion', v_conv, 'estado', 'bot')),
                        'ESTADO_INVALIDO', '2.29 No se reabre a mano si ya hay otra abierta con el cliente');

  UPDATE hub_cleber.conversaciones SET ultimo_mensaje_en = now() - interval '25 hours' WHERE id_conversacion = v_conv2;
  i := pg_temp.ok(pg_temp.llama('Hub.obtieneOAbreConversacion', jsonb_build_object('idNumero', v_numero, 'telefonoCliente', '5598765432')),
                  '2.30 El cliente escribe después de 25 h sin mensajes');
  v_conv3 := i#>>'{conversacion,idConversacion}';
  PERFORM pg_temp.igual((i->>'origen') || '/' || (i#>>'{conversacion,idConversacion}' <> v_conv2)::text || '/'
                        || (SELECT estado FROM hub_cleber.conversaciones WHERE id_conversacion = v_conv2),
                        'nueva/true/closed', '2.31 ... la sesión expirada se cierra y se abre otra');

  -- ==========================================================================
  -- 3. Contrato ①
  -- ==========================================================================
  i := pg_temp.ok(pg_temp.llama('Hub.abreConversacionExterna', jsonb_build_object('fuente', 'valuacion', 'idExterno', '101', 'idMarca', c_marca,
                                'modulo', 'valuacion', 'telefono', '5511112222', 'nombreCliente', 'Cliente Oferta',
                                'contexto', '{"montoOferta":270000}'::jsonb)), '3.1 Valuación abre una conversación por una oferta');
  v_ext := i#>>'{conversacion,idConversacion}';
  PERFORM pg_temp.igual((i->>'creada') || '/' || (i#>>'{conversacion,direccion}') || '/' || (i#>>'{conversacion,metadatos,contexto,montoOferta}')
                        || '/' || (i#>>'{numero,idNumero}'), 'true/outbound/270000/' || v_numero, '3.2 ... saliente, con su contexto y el número del módulo');
  i := pg_temp.ok(pg_temp.llama('Hub.abreConversacionExterna', jsonb_build_object('fuente', 'valuacion', 'idExterno', '101', 'idMarca', c_marca,
                                'modulo', 'valuacion', 'telefono', '5511112222')), '3.3 La misma oferta otra vez');
  PERFORM pg_temp.igual((i->>'creada') || '/' || (i#>>'{conversacion,idConversacion}'), 'false/' || v_ext, '3.4 ... regresa la misma sin crear otra');
  i := pg_temp.error(pg_temp.llama('Hub.abreConversacionExterna', jsonb_build_object('fuente', 'valuacion', 'idExterno', '102', 'idMarca', c_marca,
                                   'modulo', 'valuacion', 'telefono', '5511112222')), 'ESTADO_INVALIDO', '3.5 Otra oferta al mismo cliente con la conversación abierta');
  PERFORM pg_temp.igual((i->>'motivo') || '/' || (i->>'idConversacion'), 'CONVERSACION_ABIERTA/' || v_ext, '3.6 ... motivo CONVERSACION_ABIERTA');
  i := pg_temp.error(pg_temp.llama('Hub.abreConversacionExterna', jsonb_build_object('fuente', 'valuacion', 'idExterno', '103', 'idMarca', c_marca,
                                   'modulo', 'servicio', 'telefono', '5511112222')), 'ESTADO_INVALIDO', '3.7 Un módulo sin número');
  PERFORM pg_temp.igual(i->>'motivo', 'SIN_NUMERO', '3.8 ... motivo SIN_NUMERO');
  i := pg_temp.ok(pg_temp.llama('Hub.obtieneOAbreConversacion', jsonb_build_object('idNumero', v_numero, 'telefonoCliente', '5511112222')),
                  '3.9 El cliente contesta la oferta');
  PERFORM pg_temp.igual((i->>'origen') || '/' || (i#>>'{conversacion,idConversacion}'), 'abierta/' || v_ext, '3.10 ... su respuesta cae en la conversación de la oferta');
  PERFORM pg_temp.como(c_admin);
  PERFORM pg_temp.error(pg_temp.llama('Hub.abreConversacionExterna', jsonb_build_object('fuente', 'valuacion', 'idExterno', '104', 'idMarca', c_marca,
                                      'modulo', 'valuacion', 'telefono', '5533334444')), 'SIN_PERMISO', '3.11 El contrato ① es solo del sistema');

  -- ==========================================================================
  -- 4. Bandeja y chat (permisos por equipo)
  -- ==========================================================================
  -- Abiertas: la de 2.30 y la de la oferta, ambas del equipo A (el del número)
  i := pg_temp.ok(pg_temp.llama('Hub.consultaConversaciones', jsonb_build_object('idMarca', c_marca, 'modulo', 'valuacion')),
                  '4.1 El administrador consulta la bandeja');
  PERFORM pg_temp.igual(jsonb_array_length(i->'conversaciones')::text || '/' || (i->>'hayMas'), '2/false', '4.2 ... ve las abiertas');
  i := pg_temp.ok(pg_temp.llama('Hub.consultaConversaciones', jsonb_build_object('idMarca', c_marca, 'modulo', 'valuacion', 'estados', '["closed"]'::jsonb, 'limite', 1)),
                  '4.3 Cerradas, de una en una');
  PERFORM pg_temp.igual(jsonb_array_length(i->'conversaciones')::text || '/' || (i->>'hayMas'), '1/true', '4.4 ... con hayMas');
  i := pg_temp.ok(pg_temp.llama('Hub.consultaConversaciones', jsonb_build_object('idMarca', c_marca, 'modulo', 'valuacion', 'busqueda', '1111')),
                  '4.5 Búsqueda por parte del teléfono');
  PERFORM pg_temp.igual(i#>>'{conversaciones,0,idConversacion}', v_ext, '4.6 ... encuentra la de la oferta');

  PERFORM pg_temp.como(c_ag_a);
  i := pg_temp.ok(pg_temp.llama('Hub.consultaConversaciones', jsonb_build_object('idMarca', c_marca, 'modulo', 'valuacion')),
                  '4.7 Un valuador del equipo A');
  PERFORM pg_temp.igual(jsonb_array_length(i->'conversaciones')::text, '2', '4.8 ... ve las de su equipo');
  PERFORM pg_temp.como(c_ag_b);
  i := pg_temp.ok(pg_temp.llama('Hub.consultaConversaciones', jsonb_build_object('idMarca', c_marca, 'modulo', 'valuacion')),
                  '4.9 Un valuador del equipo B');
  PERFORM pg_temp.igual(jsonb_array_length(i->'conversaciones')::text, '0', '4.10 ... no ve las de otro equipo');
  PERFORM pg_temp.error(pg_temp.llama('Hub.consultaMensajes', jsonb_build_object('idConversacion', v_conv)),
                        'CONVERSACION_NO_ENCONTRADA', '4.11 ... ni sus mensajes');
  PERFORM pg_temp.como(c_serv);
  PERFORM pg_temp.error(pg_temp.llama('Hub.consultaConversaciones', jsonb_build_object('idMarca', c_marca, 'modulo', 'valuacion')),
                        'SIN_PERMISO', '4.12 Sin rol en el módulo no hay bandeja');

  -- Supervisor (roles_modulo.es_supervisor, GERENTE de valuación): todos los equipos, solo sus agencias, sin equipo
  INSERT INTO hub_cleber.usuarios (email, nombre) VALUES ('gerente@prueba-conv.invalid', 'Gerente') RETURNING id_usuario INTO v_gerente;
  INSERT INTO hub_cleber.usuarios_marcas (id_usuario, id_marca, agencias) VALUES (v_gerente, c_marca, ARRAY['AG-2']);
  INSERT INTO hub_cleber.usuarios_roles_modulo (id_usuario, id_marca, modulo, rol) VALUES (v_gerente, c_marca, 'valuacion', 'GERENTE');
  UPDATE hub_cleber.conversaciones SET id_agencia = 'AG-1' WHERE id_conversacion = v_ext;
  PERFORM pg_temp.como('gerente@prueba-conv.invalid');
  i := pg_temp.ok(pg_temp.llama('Hub.consultaConversaciones', jsonb_build_object('idMarca', c_marca, 'modulo', 'valuacion')),
                  '4.12a Un GERENTE sin equipo consulta la bandeja');
  PERFORM pg_temp.igual(jsonb_array_length(i->'conversaciones')::text, '1', '4.12b ... ve la sin agencia, no la de otra agencia');
  UPDATE hub_cleber.usuarios_marcas SET agencias = ARRAY['AG-1', 'AG-2'] WHERE id_usuario = v_gerente AND id_marca = c_marca;
  i := pg_temp.ok(pg_temp.llama('Hub.consultaConversaciones', jsonb_build_object('idMarca', c_marca, 'modulo', 'valuacion')),
                  '4.12c Con la agencia de la oferta');
  PERFORM pg_temp.igual(jsonb_array_length(i->'conversaciones')::text, '2', '4.12d ... ve también la de la oferta (equipo A, sin ser del equipo)');
  UPDATE hub_cleber.conversaciones SET id_agencia = NULL WHERE id_conversacion = v_ext;

  PERFORM pg_temp.como(c_ag_a);
  i := pg_temp.ok(pg_temp.llama('Hub.consultaMensajes', jsonb_build_object('idConversacion', v_conv)), '4.13 El chat de una conversación');
  PERFORM pg_temp.igual(jsonb_array_length(i->'mensajes')::text || '/' || (i#>>'{mensajes,0,texto}'), '2/Hola', '4.14 ... sin los mensajes de sistema');
  v_id_msj := i#>>'{mensajes,0,idMensaje}';
  i := pg_temp.ok(pg_temp.llama('Hub.consultaMensajes', jsonb_build_object('idConversacion', v_conv, 'incluyeSistema', true)), '4.15 Con los de sistema');
  PERFORM pg_temp.igual(jsonb_array_length(i->'mensajes')::text, '3', '4.16 ... son 3');
  i := pg_temp.ok(pg_temp.llama('Hub.consultaMensajes', jsonb_build_object('idConversacion', v_conv, 'desdeIdMensaje', v_id_msj)), '4.17 Los posteriores a uno');
  PERFORM pg_temp.igual(jsonb_array_length(i->'mensajes')::text || '/' || (i#>>'{mensajes,0,remitente}'), '1/bot', '4.18 ... solo los nuevos');
  i := pg_temp.ok(pg_temp.llama('Hub.consultaMensajes', jsonb_build_object('idConversacion', v_conv, 'limite', 1)), '4.19 El último mensaje');
  PERFORM pg_temp.igual((i#>>'{mensajes,0,remitente}') || '/' || (i->>'hayMas'), 'bot/true', '4.20 ... es el más reciente, con hayMas');

  -- ==========================================================================
  -- 5. Bitácora
  -- ==========================================================================
  PERFORM pg_temp.como(c_sistema);
  i := pg_temp.ok(pg_temp.llama('Hub.registraBitacora', jsonb_build_object('idConversacion', v_ext, 'accion', 'envio_plantilla', 'origen', 'sistema',
                                'datos', '{"plantilla":"oferta"}'::jsonb)), '5.1 El sistema registra en la bitácora');
  PERFORM pg_temp.igual((SELECT accion FROM hub_cleber.bitacora WHERE id_bitacora = (i->>'idBitacora')::bigint), 'envio_plantilla', '5.2 ... queda guardado');
  PERFORM pg_temp.como(c_admin);
  PERFORM pg_temp.error(pg_temp.llama('Hub.registraBitacora', jsonb_build_object('idConversacion', v_ext, 'accion', 'x', 'origen', 'usuario')),
                        'SIN_PERMISO', '5.3 Un usuario no escribe la bitácora directo');

  -- ==========================================================================
  -- 6. Operación del asesor (sobre la conversación de la oferta, equipo A, estado bot)
  -- ==========================================================================
  PERFORM pg_temp.como(c_ag_a);
  PERFORM pg_temp.error(pg_temp.llama('Hub.tomaConversacion', jsonb_build_object('idConversacion', v_ext)),
                        'SIN_PERMISO', '6.1 Un valuador no toma conversaciones (lo hace un administrador)');
  PERFORM pg_temp.como(c_admin);
  i := pg_temp.error(pg_temp.llama('Hub.tomaConversacion', jsonb_build_object('idConversacion', v_ext)),
                     'ESTADO_INVALIDO', '6.2 Solo se toma una que espera asesor');
  PERFORM pg_temp.igual((i->>'motivo') || '/' || (i->>'estado'), 'ESTADO_ACTUAL/bot', '6.3 ... con el estado en que está');
  PERFORM pg_temp.como(c_sistema);
  PERFORM pg_temp.ok(pg_temp.llama('Hub.actualizaConversacion', jsonb_build_object('idConversacion', v_ext, 'estado', 'waiting_agent')),
                     '6.4 El bot la escala (espera asesor)');
  PERFORM pg_temp.como(c_admin);
  i := pg_temp.ok(pg_temp.llama('Hub.tomaConversacion', jsonb_build_object('idConversacion', v_ext)), '6.5 El administrador la toma');
  PERFORM pg_temp.igual((i#>>'{conversacion,estado}') || '/' || (i#>>'{conversacion,idAgente}') || '/' || (i#>>'{conversacion,esperaDesde}' IS NOT NULL)::text,
                        'with_agent/' || v_admin || '/true', '6.6 ... queda con él y empieza a medir la espera');

  PERFORM pg_temp.como(c_ag_a);
  PERFORM pg_temp.error(pg_temp.llama('Hub.cierraConversacion', jsonb_build_object('idConversacion', v_ext, 'motivo', 'x')),
                        'SIN_PERMISO', '6.7 Otro asesor no cierra una conversación tomada');
  PERFORM pg_temp.como(c_admin);
  PERFORM pg_temp.error(pg_temp.llama('Hub.asignaConversacion', jsonb_build_object('idConversacion', v_ext, 'idAgente', v_ag_b)),
                        'CAMPO_INVALIDO', '6.8 No se asigna a un asesor de otro equipo');
  PERFORM pg_temp.error(pg_temp.llama('Hub.asignaConversacion', jsonb_build_object('idConversacion', v_ext, 'idAgente', v_cons)),
                        'CAMPO_INVALIDO', '6.9 Ni a alguien con rol de consulta');
  i := pg_temp.ok(pg_temp.llama('Hub.asignaConversacion', jsonb_build_object('idConversacion', v_ext, 'idAgente', v_ag_a)),
                  '6.10 Se asigna al valuador del equipo');
  PERFORM pg_temp.igual((i#>>'{conversacion,idAgente}') || '/' || coalesce(i#>>'{conversacion,primeraRespuestaEn}', 'null'),
                        v_ag_a || '/null', '6.11 ... con su primera respuesta pendiente');

  PERFORM pg_temp.como(c_ag_a);
  i := pg_temp.ok(pg_temp.llama('Hub.autorizaMensajeAgente', jsonb_build_object('idConversacion', v_ext)), '6.12 El asesor pide enviar un mensaje');
  PERFORM pg_temp.igual(i#>>'{numero,telefono}', '+525512345678', '6.13 ... y recibe el número por el que sale');
  i := pg_temp.ok(pg_temp.llama('Hub.registraMensajeAgente', jsonb_build_object('idConversacion', v_ext, 'texto', 'Hola, soy tu asesor',
                                'idMensajeProveedor', 'SM-agente-1')), '6.14 El mensaje ya enviado se registra');
  PERFORM pg_temp.igual((i#>>'{mensaje,remitente}') || '/' || (i#>>'{conversacion,ultimoRemitente}') || '/'
                        || jsonb_array_length(i#>'{conversacion,tiemposRespuesta}')::text,
                        'agent/agent/1', '6.15 ... como del asesor, con su tiempo de respuesta');
  i := pg_temp.ok(pg_temp.llama('Hub.registraMensajeAgente', jsonb_build_object('idConversacion', v_ext, 'texto', 'Hola, soy tu asesor',
                                'idMensajeProveedor', 'SM-agente-1')), '6.16 El mismo mensaje otra vez');
  PERFORM pg_temp.igual(i->>'duplicado', 'true', '6.17 ... no se duplica');

  i := pg_temp.ok(pg_temp.llama('Hub.agregaNota', jsonb_build_object('idConversacion', v_ext, 'texto', 'Cliente pide más monto')), '6.18 Nota interna');
  PERFORM pg_temp.igual(i#>>'{nota,nombreAutor}', 'Agente A', '6.19 ... con el nombre del autor');
  i := pg_temp.ok(pg_temp.llama('Hub.renombraCliente', jsonb_build_object('idConversacion', v_ext, 'nombreCliente', 'Cliente Renombrado')),
                  '6.20 Cambia el nombre del cliente');
  PERFORM pg_temp.igual(i#>>'{conversacion,nombreCliente}', 'Cliente Renombrado', '6.21 ... y queda guardado');

  PERFORM pg_temp.como(c_cons);
  i := pg_temp.ok(pg_temp.llama('Hub.consultaNotas', jsonb_build_object('idConversacion', v_ext)), '6.22 Consulta lee las notas');
  PERFORM pg_temp.igual(jsonb_array_length(i->'notas')::text, '1', '6.23 ... son 1');
  PERFORM pg_temp.error(pg_temp.llama('Hub.agregaNota', jsonb_build_object('idConversacion', v_conv3, 'texto', 'x')),
                        'SIN_PERMISO', '6.24 ... pero no escribe');

  PERFORM pg_temp.como(c_ag_a);
  i := pg_temp.ok(pg_temp.llama('Hub.devuelveAlBot', jsonb_build_object('idConversacion', v_ext)), '6.25 El asesor la devuelve al bot');
  v_version := (i#>>'{conversacion,version}')::integer;
  PERFORM pg_temp.igual((i#>>'{conversacion,estado}') || '/' || coalesce(i#>>'{conversacion,idAgente}', 'null'), 'bot/null', '6.26 ... sin asesor');
  PERFORM pg_temp.error(pg_temp.llama('Hub.cierraConversacion', jsonb_build_object('idConversacion', v_ext, 'motivo', 'x', 'versionEsperada', v_version - 1)),
                        'CONFLICTO_VERSION', '6.27 Cerrar con una versión vieja');
  i := pg_temp.ok(pg_temp.llama('Hub.cierraConversacion', jsonb_build_object('idConversacion', v_ext, 'motivo', 'Cliente no interesado',
                                'versionEsperada', v_version)), '6.28 Cerrar con la versión al día');
  PERFORM pg_temp.igual((i#>>'{conversacion,estado}') || '/' || (i#>>'{conversacion,motivoCierre}'), 'closed/Cliente no interesado', '6.29 ... con su motivo');
  i := pg_temp.ok(pg_temp.llama('Hub.reabreConversacion', jsonb_build_object('idConversacion', v_ext)), '6.30 Se reabre');
  PERFORM pg_temp.igual((i#>>'{conversacion,estado}') || '/' || coalesce(i#>>'{conversacion,motivoCierre}', 'null'), 'bot/null', '6.31 ... vuelve al bot');
  i := pg_temp.error(pg_temp.llama('Hub.reabreConversacion', jsonb_build_object('idConversacion', v_conv)),
                     'ESTADO_INVALIDO', '6.32 No se reabre si el cliente ya tiene otra abierta en el número');
  PERFORM pg_temp.igual((i->>'motivo') || '/' || (i->>'idConversacion'), 'CONVERSACION_ABIERTA/' || v_conv3, '6.33 ... y dice cuál');

  PERFORM pg_temp.como(c_admin);
  i := pg_temp.ok(pg_temp.llama('Hub.transfiereEquipo', jsonb_build_object('idConversacion', v_ext, 'idEquipo', v_eq_b)), '6.34 Se transfiere al equipo B');
  PERFORM pg_temp.igual((i#>>'{conversacion,estado}') || '/' || (i#>>'{conversacion,idEquipo}'), 'waiting_agent/' || v_eq_b, '6.35 ... espera asesor de ese equipo');
  PERFORM pg_temp.como(c_ag_a);
  PERFORM pg_temp.error(pg_temp.llama('Hub.consultaNotas', jsonb_build_object('idConversacion', v_ext)),
                        'CONVERSACION_NO_ENCONTRADA', '6.36 El equipo A ya no la ve');
  PERFORM pg_temp.como(c_ag_b);
  PERFORM pg_temp.error(pg_temp.llama('Hub.registraMensajeAgente', jsonb_build_object('idConversacion', v_ext, 'mediaUrl', 'http://x/y.jpg')),
                        'CAMPO_INVALIDO', '6.37 mediaUrl debe ser https');
  i := pg_temp.ok(pg_temp.llama('Hub.registraMensajeAgente', jsonb_build_object('idConversacion', v_ext, 'texto', 'Te atiendo yo')),
                  '6.38 El valuador del equipo B contesta');
  PERFORM pg_temp.igual((i#>>'{conversacion,estado}') || '/' || (i#>>'{conversacion,idAgente}') || '/'
                        || jsonb_array_length(i#>'{conversacion,tiemposRespuesta}')::text,
                        'with_agent/' || v_ag_b || '/2', '6.39 ... la toma al contestar y suma otro tiempo de respuesta');

  -- 7. Permisos de un usuario para el backend (acciones del dashboard que no son plpgsql)
  PERFORM pg_temp.como(c_sistema);
  i := pg_temp.ok(pg_temp.llama('Hub.consultaPermisosUsuario', jsonb_build_object('email', c_admin, 'idMarca', c_marca, 'modulo', 'valuacion')),
                  '7.1 El sistema consulta los permisos del administrador');
  PERFORM pg_temp.igual((i->>'rol') || '/' || (i->>'esAdministrador') || '/' || (i->>'escribe'), 'ADMINISTRADOR/true/true', '7.2 ... administra el módulo');
  i := pg_temp.ok(pg_temp.llama('Hub.consultaPermisosUsuario', jsonb_build_object('email', c_cons, 'idMarca', c_marca, 'modulo', 'valuacion')),
                  '7.3 ... los de un usuario de consulta');
  PERFORM pg_temp.igual((i->>'rol') || '/' || (i->>'esAdministrador') || '/' || (i->>'escribe'), 'CONSULTA/false/false', '7.4 ... solo lee');
  i := pg_temp.ok(pg_temp.llama('Hub.consultaPermisosUsuario', jsonb_build_object('email', 'nadie@prueba-conv.invalid', 'idMarca', c_marca, 'modulo', 'valuacion')),
                  '7.5 ... los de un email no registrado');
  PERFORM pg_temp.igual(i->>'existe', 'false', '7.6 ... no existe');
  PERFORM pg_temp.como(c_admin);
  PERFORM pg_temp.error(pg_temp.llama('Hub.consultaPermisosUsuario', jsonb_build_object('email', c_admin, 'idMarca', c_marca, 'modulo', 'valuacion')),
                        'SIN_PERMISO', '7.7 Solo el sistema la usa');

  -- 8. Canales de tiempo real (authorizer de AppSync). v_ext quedó en el equipo B; v_conv3 está en el equipo A.
  PERFORM pg_temp.como(c_ag_a);
  i := pg_temp.ok(pg_temp.llama('Hub.autorizaCanal', jsonb_build_object('canal', '/hub/' || lower(c_marca) || '/valuacion')),
                  '8.1 Un valuador se suscribe a la bandeja de su módulo (marca en minúsculas)');
  PERFORM pg_temp.igual(i->>'autorizado', 'true', '8.2 ... autorizado');
  i := pg_temp.ok(pg_temp.llama('Hub.autorizaCanal', jsonb_build_object('canal', '/hub/' || c_marca || '/valuacion/' || v_conv3)),
                  '8.3 ... y al chat de una conversación de su equipo');
  PERFORM pg_temp.igual(i->>'autorizado', 'true', '8.4 ... autorizado');
  i := pg_temp.ok(pg_temp.llama('Hub.autorizaCanal', jsonb_build_object('canal', '/hub/' || c_marca || '/valuacion/' || v_ext)),
                  '8.5 ... pero no al de una de otro equipo');
  PERFORM pg_temp.igual((i->>'autorizado') || '/' || (i->>'motivo'), 'false/SIN_ACCESO_CONVERSACION', '8.6 ... rechazado');
  i := pg_temp.ok(pg_temp.llama('Hub.autorizaCanal', jsonb_build_object('canal', '/hub/' || c_marca || '/servicio')),
                  '8.7 Ni a un módulo en el que no tiene rol');
  PERFORM pg_temp.igual((i->>'autorizado') || '/' || (i->>'motivo'), 'false/SIN_ACCESO_MODULO', '8.8 ... rechazado');
  i := pg_temp.ok(pg_temp.llama('Hub.autorizaCanal', jsonb_build_object('canal', '/otro/' || c_marca || '/valuacion')),
                  '8.9 Un canal de otro namespace');
  PERFORM pg_temp.igual((i->>'autorizado') || '/' || (i->>'motivo'), 'false/CANAL_INVALIDO', '8.10 ... rechazado');
  i := pg_temp.ok(pg_temp.llama('Hub.autorizaCanal', jsonb_build_object('canal', '/hub/' || c_marca || '/valuacion', 'operacion', 'EVENT_PUBLISH')),
                  '8.11 Publicar desde la pantalla');
  PERFORM pg_temp.igual((i->>'autorizado') || '/' || (i->>'motivo'), 'false/OPERACION_NO_PERMITIDA', '8.12 ... rechazado (solo el backend publica)');
  PERFORM pg_temp.como(c_admin);
  i := pg_temp.ok(pg_temp.llama('Hub.autorizaCanal', jsonb_build_object('canal', '/hub/' || c_marca || '/valuacion/' || v_ext)),
                  '8.13 El administrador escucha cualquier conversación del módulo');
  PERFORM pg_temp.igual(i->>'autorizado', 'true', '8.14 ... autorizado');
  PERFORM pg_temp.como('nadie@prueba-conv.invalid');
  PERFORM pg_temp.error(pg_temp.llama('Hub.autorizaCanal', jsonb_build_object('canal', '/hub/' || c_marca || '/valuacion')),
                        'SIN_PERMISO', '8.15 Un email no registrado');

  PERFORM pg_temp.como(c_ag_b);

  PERFORM pg_temp.igual((SELECT string_agg(DISTINCT accion, ',' ORDER BY accion) FROM hub_cleber.bitacora
                          WHERE id_conversacion = v_ext AND origen = 'usuario'),
                        'asigna_conversacion,cierra_conversacion,devuelve_al_bot,reabre_conversacion,renombra_cliente,toma_conversacion,transfiere_equipo',
                        '6.40 Cada operación queda en la bitácora');

  RAISE NOTICE '========================================================================';
  RAISE NOTICE 'TODAS LAS PRUEBAS PASARON';
  RAISE NOTICE '========================================================================';
END;
$$;

ROLLBACK;

\echo 'Pruebas terminadas; se hizo ROLLBACK (no quedan datos).'
