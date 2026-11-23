/**
    Hub.registraBitacora — sistema (acciones del bot, pipeline, contrato ①)

    Agrega una entrada a la bitácora de una conversación. Solo inserción.

    Params:
      idConversacion (string)
      accion (string)          p. ej. transferir_a_asesor, envio_plantilla
      origen (string)          bot / usuario / sistema
      idUsuario? (uuid)        quién, si origen = usuario
      idTurno? (string)        turno del bot en el que se pidió (core/action_log.py)
      datos? (object)
    Info: { idBitacora: string }

    @Acceso Publica (sistema)
*/
CREATE OR REPLACE FUNCTION hub_cleber.registra_bitacora(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params jsonb;
  v_actor  hub_cleber.usuarios;
  v_conv   hub_cleber.conversaciones;
  v_id     bigint;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.registraBitacora');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_sistema(v_actor);

  v_conv := hub_cleber.busca_conversacion(v_actor, hub_cleber.param_texto(v_params, 'idConversacion'));

  INSERT INTO hub_cleber.bitacora (id_conversacion, accion, origen, id_usuario, id_turno, datos)
  VALUES (v_conv.id_conversacion,
          hub_cleber.param_texto(v_params, 'accion'),
          hub_cleber.param_opcion(v_params, 'origen', ARRAY['bot', 'usuario', 'sistema']),
          hub_cleber.param_uuid(v_params, 'idUsuario', false),
          hub_cleber.param_texto(v_params, 'idTurno', false),
          coalesce(hub_cleber.param_objeto(v_params, 'datos', false), '{}'))
  RETURNING id_bitacora INTO v_id;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('idBitacora', v_id::text));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
