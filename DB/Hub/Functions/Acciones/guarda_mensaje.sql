/**
    Hub.guardaMensaje — sistema (pipeline, envío de agentes y plantillas)

    Guarda un mensaje y actualiza el resumen de la conversación en la misma transacción.
    Idempotente por idMensajeProveedor: si ya existe, regresa el guardado con duplicado = true y no cambia nada
    (sustituye processed_events: un webhook repetido no duplica el mensaje).

    Efectos en la conversación (no aplican a remitente "system", que es contexto para el bot):
      - último mensaje (fecha, texto recortado a 100, remitente)
      - customer: ultimo_mensaje_cliente_en = now, ultima_plantilla_en = NULL, recordatorios_inactividad = 0
      - esPlantilla: ultima_plantilla_en = now

    Params:
      idConversacion (string)
      remitente (string)               customer / bot / agent / system
      texto? (string), mediaUrl? (string)   al menos uno
      idMensajeProveedor? (string)
      idAgente? (string, uuid)         quién lo mandó, si es agent
      esPlantilla? (boolean)
    Info: { mensaje: Mensaje, conversacion: Conversacion, duplicado: boolean }

    @Acceso Publica (sistema)
*/
CREATE OR REPLACE FUNCTION hub_cleber.guarda_mensaje(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params    jsonb;
  v_actor     hub_cleber.usuarios;
  v_conv      hub_cleber.conversaciones;
  v_remitente text;
  v_texto     text;
  v_media     text;
  v_id_prov   text;
  v_agente    uuid;
  v_plantilla boolean;
  v_mensaje   hub_cleber.mensajes;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.guardaMensaje');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_sistema(v_actor);

  v_remitente := hub_cleber.param_opcion(v_params, 'remitente', ARRAY['customer', 'bot', 'agent', 'system']);
  -- El texto no se recorta: se guarda tal cual llegó
  v_texto     := nullif(hub_cleber.param(v_params, 'texto', 'string', false) #>> '{}', '');
  v_media     := hub_cleber.param_texto(v_params, 'mediaUrl', false);
  v_id_prov   := hub_cleber.param_texto(v_params, 'idMensajeProveedor', false);
  v_agente    := hub_cleber.param_uuid(v_params, 'idAgente', false);
  v_plantilla := coalesce(hub_cleber.param_booleano(v_params, 'esPlantilla', false), false);
  IF v_texto IS NULL AND v_media IS NULL THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_REQUERIDO', 'El mensaje necesita texto o mediaUrl', '{"campo":"texto"}');
  END IF;

  v_conv := hub_cleber.busca_conversacion(v_actor, hub_cleber.param_texto(v_params, 'idConversacion'), true);

  IF v_id_prov IS NOT NULL THEN
    SELECT * INTO v_mensaje FROM hub_cleber.mensajes WHERE id_mensaje_proveedor = v_id_prov;
    IF v_mensaje.id_mensaje IS NOT NULL THEN
      RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
        'mensaje', hub_cleber.mensaje_json(v_mensaje), 'conversacion', hub_cleber.conversacion_json(v_conv), 'duplicado', true));
    END IF;
  END IF;

  INSERT INTO hub_cleber.mensajes (id_conversacion, remitente, id_agente, texto, media_url, es_plantilla, id_mensaje_proveedor)
  VALUES (v_conv.id_conversacion, v_remitente, v_agente, v_texto, v_media, v_plantilla, v_id_prov)
  RETURNING * INTO v_mensaje;

  IF v_remitente <> 'system' THEN
    UPDATE hub_cleber.conversaciones SET
      ultimo_mensaje_en         = v_mensaje.creado_en,
      ultimo_mensaje_texto      = coalesce(left(v_texto, 100), '📎 Archivo adjunto'),
      ultimo_remitente          = v_remitente,
      ultimo_mensaje_cliente_en = CASE WHEN v_remitente = 'customer' THEN v_mensaje.creado_en ELSE ultimo_mensaje_cliente_en END,
      ultima_plantilla_en       = CASE WHEN v_remitente = 'customer' THEN NULL
                                       WHEN v_plantilla THEN v_mensaje.creado_en ELSE ultima_plantilla_en END,
      recordatorios_inactividad = CASE WHEN v_remitente = 'customer' THEN 0 ELSE recordatorios_inactividad END,
      actualizado_en = now(), version = version + 1
    WHERE id_conversacion = v_conv.id_conversacion
    RETURNING * INTO v_conv;
  END IF;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
    'mensaje', hub_cleber.mensaje_json(v_mensaje), 'conversacion', hub_cleber.conversacion_json(v_conv), 'duplicado', false));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
