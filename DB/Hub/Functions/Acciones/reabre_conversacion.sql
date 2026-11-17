/**
    Hub.reabreConversacion — dashboard (cualquier rol que escribe)

    Reabre una conversación cerrada; vuelve al bot, sin asesor.
    Lo llama el backend con el token del usuario (después publica el aviso de tiempo real).
    Params comunes: idConversacion (string), versionEsperada? (number; si no coincide → CONFLICTO_VERSION).
    Info: { conversacion }
    Errores: ESTADO_INVALIDO con motivo ESTADO_ACTUAL (no está cerrada) o CONVERSACION_ABIERTA (el cliente ya
             tiene otra abierta en el número; info.idConversacion).

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.reabre_conversacion(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params jsonb;
  v_actor  hub_cleber.usuarios;
  v_conv   hub_cleber.conversaciones;
  v_otra text;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.reabreConversacion');
  v_actor  := hub_cleber.usuario_actual();

  v_conv := hub_cleber.conversacion_para_operar(v_actor, v_params);
  PERFORM hub_cleber.exige_operar(v_actor, v_conv);
  PERFORM hub_cleber.exige_estado(v_conv, ARRAY['closed']);

  PERFORM hub_cleber.bloquea_cliente_numero(v_conv.id_numero, v_conv.telefono_cliente);
  SELECT id_conversacion INTO v_otra FROM hub_cleber.conversaciones
   WHERE id_numero = v_conv.id_numero AND telefono_cliente = v_conv.telefono_cliente AND estado <> 'closed';
  IF v_otra IS NOT NULL THEN
    PERFORM hub_cleber.error_de_aplicacion('ESTADO_INVALIDO', 'El cliente ya tiene otra conversación abierta en el número',
      jsonb_build_object('motivo', 'CONVERSACION_ABIERTA', 'idConversacion', v_otra));
  END IF;

  UPDATE hub_cleber.conversaciones SET
    estado = 'bot', id_agente = NULL, asignada_en = NULL, espera_desde = NULL, primera_respuesta_en = NULL, cerrada_en = NULL, cierre_manual = false, motivo_cierre = NULL,
    actualizado_en = now(), version = version + 1
  WHERE id_conversacion = v_conv.id_conversacion
  RETURNING * INTO v_conv;
  PERFORM hub_cleber.bitacora_usuario(v_conv.id_conversacion, 'reabre_conversacion', v_actor);

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('conversacion', hub_cleber.conversacion_json(v_conv)));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
