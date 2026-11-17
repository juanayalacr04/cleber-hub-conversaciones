/**
    Hub.consultaMensajes — dashboard (chat) o sistema

    Mensajes de una conversación en orden cronológico, con la conversación al día.
      - Sin desdeIdMensaje: los últimos `limite` (al abrir el chat).
      - Con desdeIdMensaje: los posteriores a ese (al recibir un aviso de tiempo real), hasta `limite`.
      - Con antesDeIdMensaje: los anteriores a ese (para cargar más hacia atrás).

    Params:
      idConversacion (string)
      desdeIdMensaje?, antesDeIdMensaje? (string)   idMensaje (bigint en texto); no los dos
      limite? (number)                              1..500, default 100
      incluyeSistema? (boolean)                     default false: los de sistema (contexto para el bot) no se muestran
    Info: { conversacion: Conversacion, mensajes: [Mensaje], hayMas: boolean }

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.consulta_mensajes(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params  jsonb;
  v_actor   hub_cleber.usuarios;
  v_conv    hub_cleber.conversaciones;
  v_desde   bigint;
  v_antes   bigint;
  v_limite  integer;
  v_sistema boolean;
  v_lista   jsonb;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.consultaMensajes');
  v_actor  := hub_cleber.usuario_actual();
  v_conv   := hub_cleber.busca_conversacion(v_actor, hub_cleber.param_texto(v_params, 'idConversacion'));

  BEGIN
    v_desde := hub_cleber.param_texto(v_params, 'desdeIdMensaje', false)::bigint;
    v_antes := hub_cleber.param_texto(v_params, 'antesDeIdMensaje', false)::bigint;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'El id de mensaje debe ser un número en texto', '{"campo":"desdeIdMensaje"}');
  END;
  IF v_desde IS NOT NULL AND v_antes IS NOT NULL THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'Usa desdeIdMensaje o antesDeIdMensaje, no los dos', '{"campo":"antesDeIdMensaje"}');
  END IF;
  v_limite  := coalesce(hub_cleber.param_entero(v_params, 'limite', false, 1, 500), 100);
  v_sistema := coalesce(hub_cleber.param_booleano(v_params, 'incluyeSistema', false), false);

  IF v_desde IS NOT NULL THEN
    -- Hacia adelante: los primeros `limite` después de v_desde
    SELECT coalesce(jsonb_agg(hub_cleber.mensaje_json(m) ORDER BY m.id_mensaje), '[]') INTO v_lista
      FROM hub_cleber.mensajes m
     WHERE m.id_mensaje IN (SELECT x.id_mensaje FROM hub_cleber.mensajes x
                             WHERE x.id_conversacion = v_conv.id_conversacion AND x.id_mensaje > v_desde
                               AND (v_sistema OR x.remitente <> 'system')
                             ORDER BY x.id_mensaje
                             LIMIT v_limite + 1);
    RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
      'conversacion', hub_cleber.conversacion_json(v_conv),
      'mensajes', CASE WHEN jsonb_array_length(v_lista) > v_limite THEN v_lista - v_limite ELSE v_lista END,
      'hayMas', jsonb_array_length(v_lista) > v_limite));
  END IF;

  -- Hacia atrás: los últimos `limite` (antes de v_antes si viene), regresados en orden cronológico
  SELECT coalesce(jsonb_agg(hub_cleber.mensaje_json(m) ORDER BY m.id_mensaje), '[]') INTO v_lista
    FROM hub_cleber.mensajes m
   WHERE m.id_mensaje IN (SELECT x.id_mensaje FROM hub_cleber.mensajes x
                           WHERE x.id_conversacion = v_conv.id_conversacion AND (v_antes IS NULL OR x.id_mensaje < v_antes)
                             AND (v_sistema OR x.remitente <> 'system')
                           ORDER BY x.id_mensaje DESC
                           LIMIT v_limite + 1);
  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
    'conversacion', hub_cleber.conversacion_json(v_conv),
    'mensajes', CASE WHEN jsonb_array_length(v_lista) > v_limite THEN v_lista - 0 ELSE v_lista END,
    'hayMas', jsonb_array_length(v_lista) > v_limite));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
