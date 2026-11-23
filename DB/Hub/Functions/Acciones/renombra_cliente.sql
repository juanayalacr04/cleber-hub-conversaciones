/**
    Hub.renombraCliente — dashboard (cualquier rol que escribe)

    Nombre del cliente en la conversación.
    Lo llama el backend con el token del usuario (después publica el aviso de tiempo real).
    Params comunes: idConversacion (string), versionEsperada? (number; si no coincide → CONFLICTO_VERSION).
      nombreCliente (string | null)    hasta 120 caracteres; null o vacío lo borra
    Info: { conversacion }

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.renombra_cliente(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params jsonb;
  v_actor  hub_cleber.usuarios;
  v_conv   hub_cleber.conversaciones;
  v_nombre text;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.renombraCliente');
  v_actor  := hub_cleber.usuario_actual();

  v_conv := hub_cleber.conversacion_para_operar(v_actor, v_params);
  PERFORM hub_cleber.exige_operar(v_actor, v_conv);
  IF NOT v_params ? 'nombreCliente' THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_REQUERIDO', 'Falta el campo nombreCliente', '{"campo":"nombreCliente"}');
  END IF;
  v_nombre := left(hub_cleber.param_texto(v_params, 'nombreCliente', false), 120);

  UPDATE hub_cleber.conversaciones SET
    nombre_cliente = v_nombre, actualizado_en = now(), version = version + 1
  WHERE id_conversacion = v_conv.id_conversacion
  RETURNING * INTO v_conv;
  PERFORM hub_cleber.bitacora_usuario(v_conv.id_conversacion, 'renombra_cliente', v_actor, jsonb_build_object('nombreCliente', v_nombre));

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('conversacion', hub_cleber.conversacion_json(v_conv)));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
