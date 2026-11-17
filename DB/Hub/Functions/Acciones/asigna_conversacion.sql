/**
    Hub.asignaConversacion — dashboard (administrador del módulo en la marca)

    Asigna la conversación a un asesor: pasa a with_agent. El asesor debe estar activo, tener en el módulo de la
    marca un rol que escribe (no CONSULTA) y poder ver la conversación (su equipo).
    Lo llama el backend con el token del usuario (después publica el aviso de tiempo real).
    Params comunes: idConversacion (string), versionEsperada? (number; si no coincide → CONFLICTO_VERSION).
      idAgente (uuid)
    Info: { conversacion }
    Errores: ESTADO_INVALIDO (motivo ESTADO_ACTUAL) si está cerrada; CAMPO_INVALIDO (campo idAgente).

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.asigna_conversacion(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params jsonb;
  v_actor  hub_cleber.usuarios;
  v_conv   hub_cleber.conversaciones;
  v_agente hub_cleber.usuarios;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.asignaConversacion');
  v_actor  := hub_cleber.usuario_actual();

  v_conv := hub_cleber.conversacion_para_operar(v_actor, v_params);
  PERFORM hub_cleber.exige_administrador_modulo(v_actor, v_conv.id_marca, v_conv.modulo);
  PERFORM hub_cleber.exige_estado(v_conv, ARRAY['bot', 'waiting_agent', 'with_agent']);

  SELECT * INTO v_agente FROM hub_cleber.usuarios
   WHERE id_usuario = hub_cleber.param_uuid(v_params, 'idAgente') AND es_activo AND NOT es_sistema;
  IF v_agente.id_usuario IS NULL OR NOT hub_cleber.rol_escribe(v_agente, v_conv.id_marca, v_conv.modulo)
     OR NOT hub_cleber.ve_conversacion(v_agente, v_conv) THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'El asesor no existe o no atiende conversaciones de este equipo',
      '{"campo":"idAgente"}');
  END IF;

  UPDATE hub_cleber.conversaciones SET
    estado = 'with_agent', id_agente = v_agente.id_usuario, asignada_en = now(),
    espera_desde = CASE WHEN estado = 'waiting_agent' THEN ultimo_mensaje_en ELSE espera_desde END,
    primera_respuesta_en = CASE WHEN id_agente IS DISTINCT FROM v_agente.id_usuario THEN NULL ELSE primera_respuesta_en END,
    actualizado_en = now(), version = version + 1
  WHERE id_conversacion = v_conv.id_conversacion
  RETURNING * INTO v_conv;
  PERFORM hub_cleber.bitacora_usuario(v_conv.id_conversacion, 'asigna_conversacion', v_actor,
    jsonb_build_object('idAgente', v_agente.id_usuario));

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('conversacion', hub_cleber.conversacion_json(v_conv)));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
