/**
    Hub.devuelveAlBot — dashboard (su asesor, o un administrador del módulo)

    El asesor suelta la conversación y vuelve a contestar el bot.
    Lo llama el backend con el token del usuario (después publica el aviso de tiempo real).
    Params comunes: idConversacion (string), versionEsperada? (number; si no coincide → CONFLICTO_VERSION).
    Info: { conversacion }
    Errores: ESTADO_INVALIDO (motivo ESTADO_ACTUAL) si no está en with_agent.

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.devuelve_al_bot(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params jsonb;
  v_actor  hub_cleber.usuarios;
  v_conv   hub_cleber.conversaciones;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.devuelveAlBot');
  v_actor  := hub_cleber.usuario_actual();

  v_conv := hub_cleber.conversacion_para_operar(v_actor, v_params);
  PERFORM hub_cleber.exige_operar(v_actor, v_conv);
  PERFORM hub_cleber.exige_estado(v_conv, ARRAY['with_agent']);

  UPDATE hub_cleber.conversaciones SET
    estado = 'bot', id_agente = NULL, asignada_en = NULL, espera_desde = NULL, primera_respuesta_en = NULL,
    actualizado_en = now(), version = version + 1
  WHERE id_conversacion = v_conv.id_conversacion
  RETURNING * INTO v_conv;
  PERFORM hub_cleber.bitacora_usuario(v_conv.id_conversacion, 'devuelve_al_bot', v_actor);

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('conversacion', hub_cleber.conversacion_json(v_conv)));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
