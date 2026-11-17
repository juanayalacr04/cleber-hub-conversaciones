/**
    Hub.abreConversacionExterna — sistema (contrato ①: Valuación, Salesforce u otro sistema abre una conversación)

    Abre una conversación saliente con un cliente en el número del módulo de la marca. La usa hub-contrato-entrada
    antes de mandar la plantilla (DISENO_BACKEND_AWS.md §5.1).

    Idempotente por (fuente, idExterno): si ya existe, la regresa con creada = false y el backend NO vuelve a enviar.
    Si el cliente ya tiene otra conversación abierta en ese número → ESTADO_INVALIDO, motivo CONVERSACION_ABIERTA
    (con su idConversacion): solo hay una abierta por número + cliente (A8). Quien llama decide si reintenta después.

    Params:
      fuente (string)              p. ej. valuacion
      idExterno (string)           p. ej. el idOferta
      idMarca, modulo (string)     el número sale de aquí (uno activo por marca y módulo)
      telefono (string)            del cliente; se normaliza a E.164
      nombreCliente?, claveCliente? (string)
      contexto? (object)           se guarda en metadatos.contexto (lo usa el módulo para la plantilla y el bot)
    Info: { conversacion: Conversacion, numero: Numero, creada: boolean }
    Errores: ESTADO_INVALIDO con info.motivo SIN_NUMERO (el módulo no tiene número activo en la marca) o
             CONVERSACION_ABIERTA.

    @Acceso Publica (sistema)
*/
CREATE OR REPLACE FUNCTION hub_cleber.abre_conversacion_externa(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params   jsonb;
  v_actor    hub_cleber.usuarios;
  v_fuente   text;
  v_externo  text;
  v_marca    text;
  v_modulo   text;
  v_telefono text;
  v_contexto jsonb;
  v_numero   hub_cleber.numeros;
  v_conv     hub_cleber.conversaciones;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.abreConversacionExterna');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_sistema(v_actor);

  v_fuente   := lower(hub_cleber.param_texto(v_params, 'fuente'));
  v_externo  := hub_cleber.param_texto(v_params, 'idExterno');
  v_marca    := upper(hub_cleber.param_texto(v_params, 'idMarca'));
  v_modulo   := hub_cleber.param_modulo(v_params);
  v_telefono := hub_cleber.param_telefono(v_params, 'telefono');
  v_contexto := hub_cleber.param_objeto(v_params, 'contexto', false);

  -- Ya abierta por esta fuente: se regresa tal cual
  SELECT * INTO v_conv FROM hub_cleber.conversaciones WHERE fuente = v_fuente AND id_externo = v_externo;
  IF v_conv.id_conversacion IS NOT NULL THEN
    SELECT * INTO v_numero FROM hub_cleber.numeros WHERE id_numero = v_conv.id_numero;
    RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
      'conversacion', hub_cleber.conversacion_json(v_conv), 'numero', hub_cleber.numero_json(v_numero), 'creada', false));
  END IF;

  SELECT * INTO v_numero FROM hub_cleber.numeros WHERE es_activo AND id_marca = v_marca AND modulo = v_modulo;
  IF v_numero.id_numero IS NULL THEN
    PERFORM hub_cleber.error_de_aplicacion('ESTADO_INVALIDO', format('El módulo %s no tiene número activo en la marca %s', v_modulo, v_marca),
      jsonb_build_object('motivo', 'SIN_NUMERO', 'idMarca', v_marca, 'modulo', v_modulo));
  END IF;

  PERFORM hub_cleber.bloquea_cliente_numero(v_numero.id_numero, v_telefono);

  -- Pudo crearla otra llamada con la misma fuente mientras se esperaba el bloqueo
  SELECT * INTO v_conv FROM hub_cleber.conversaciones WHERE fuente = v_fuente AND id_externo = v_externo;
  IF v_conv.id_conversacion IS NOT NULL THEN
    RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
      'conversacion', hub_cleber.conversacion_json(v_conv), 'numero', hub_cleber.numero_json(v_numero), 'creada', false));
  END IF;

  SELECT * INTO v_conv FROM hub_cleber.conversaciones
   WHERE id_numero = v_numero.id_numero AND telefono_cliente = v_telefono AND estado <> 'closed';
  IF v_conv.id_conversacion IS NOT NULL THEN
    PERFORM hub_cleber.error_de_aplicacion('ESTADO_INVALIDO', 'El cliente ya tiene una conversación abierta en el número',
      jsonb_build_object('motivo', 'CONVERSACION_ABIERTA', 'idConversacion', v_conv.id_conversacion));
  END IF;

  INSERT INTO hub_cleber.conversaciones (id_marca, modulo, id_numero, id_equipo, id_bot, direccion, telefono_cliente,
                                         nombre_cliente, clave_cliente, fuente, id_externo, metadatos)
  VALUES (v_numero.id_marca, v_numero.modulo, v_numero.id_numero, v_numero.id_equipo, v_numero.id_bot_default, 'outbound',
          v_telefono, hub_cleber.param_texto(v_params, 'nombreCliente', false), hub_cleber.param_texto(v_params, 'claveCliente', false),
          v_fuente, v_externo, CASE WHEN v_contexto IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('contexto', v_contexto) END)
  RETURNING * INTO v_conv;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
    'conversacion', hub_cleber.conversacion_json(v_conv), 'numero', hub_cleber.numero_json(v_numero), 'creada', true));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
