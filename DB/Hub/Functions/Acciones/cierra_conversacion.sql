/**
    Hub.cierraConversacion — dashboard (cualquier rol que escribe; si está with_agent, su asesor o un administrador)

    Cierra la conversación con un motivo. Es cierre manual: si el cliente vuelve a escribir se abre una nueva
    (no se reabre esta).
    Lo llama el backend con el token del usuario (después publica el aviso de tiempo real).
    Params comunes: idConversacion (string), versionEsperada? (number; si no coincide → CONFLICTO_VERSION).
      motivo (string)          hasta 200 caracteres
    Info: { conversacion }
    Errores: ESTADO_INVALIDO (motivo ESTADO_ACTUAL) si ya está cerrada.

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.cierra_conversacion(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params jsonb;
  v_actor  hub_cleber.usuarios;
  v_conv   hub_cleber.conversaciones;
  v_motivo text;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.cierraConversacion');
  v_actor  := hub_cleber.usuario_actual();

  v_conv := hub_cleber.conversacion_para_operar(v_actor, v_params);
  PERFORM hub_cleber.exige_operar(v_actor, v_conv);
  PERFORM hub_cleber.exige_estado(v_conv, ARRAY['bot', 'waiting_agent', 'with_agent']);
  v_motivo := left(hub_cleber.param_texto(v_params, 'motivo'), 200);

  UPDATE hub_cleber.conversaciones SET
    estado_antes_cierre = estado, agente_antes_cierre = id_agente,
    estado = 'closed', cerrada_en = now(), cierre_manual = true, motivo_cierre = v_motivo, id_agente = NULL, asignada_en = NULL, espera_desde = NULL, primera_respuesta_en = NULL,
    actualizado_en = now(), version = version + 1
  WHERE id_conversacion = v_conv.id_conversacion
  RETURNING * INTO v_conv;
  PERFORM hub_cleber.bitacora_usuario(v_conv.id_conversacion, 'cierra_conversacion', v_actor, jsonb_build_object('motivo', v_motivo));

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('conversacion', hub_cleber.conversacion_json(v_conv)));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
