/**
    Hub.transfiereEquipo — dashboard (administrador del módulo en la marca)

    Pasa la conversación a otro equipo del mismo módulo y marca: queda esperando asesor, sin asignar.
    Lo llama el backend con el token del usuario (después publica el aviso de tiempo real).
    Params comunes: idConversacion (string), versionEsperada? (number; si no coincide → CONFLICTO_VERSION).
      idEquipo (string)
    Info: { conversacion }
    Errores: ESTADO_INVALIDO (motivo ESTADO_ACTUAL) si está cerrada; CAMPO_INVALIDO (campo idEquipo).

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.transfiere_equipo(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params jsonb;
  v_actor  hub_cleber.usuarios;
  v_conv   hub_cleber.conversaciones;
  v_equipo text;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.transfiereEquipo');
  v_actor  := hub_cleber.usuario_actual();

  v_conv := hub_cleber.conversacion_para_operar(v_actor, v_params);
  PERFORM hub_cleber.exige_administrador_modulo(v_actor, v_conv.id_marca, v_conv.modulo);
  PERFORM hub_cleber.exige_estado(v_conv, ARRAY['bot', 'waiting_agent', 'with_agent']);
  v_equipo := hub_cleber.param_texto(v_params, 'idEquipo');
  IF NOT EXISTS (SELECT 1 FROM hub_cleber.equipos WHERE id_equipo = v_equipo AND id_marca = v_conv.id_marca
                                                     AND modulo = v_conv.modulo AND es_activo) THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'El equipo no existe o no está activo en ese módulo de la marca', '{"campo":"idEquipo"}');
  END IF;

  UPDATE hub_cleber.conversaciones SET
    id_equipo = v_equipo, estado = 'waiting_agent', id_agente = NULL, asignada_en = NULL, espera_desde = NULL, primera_respuesta_en = NULL,
    actualizado_en = now(), version = version + 1
  WHERE id_conversacion = v_conv.id_conversacion
  RETURNING * INTO v_conv;
  PERFORM hub_cleber.bitacora_usuario(v_conv.id_conversacion, 'transfiere_equipo', v_actor, jsonb_build_object('idEquipo', v_equipo));

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('conversacion', hub_cleber.conversacion_json(v_conv)));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
