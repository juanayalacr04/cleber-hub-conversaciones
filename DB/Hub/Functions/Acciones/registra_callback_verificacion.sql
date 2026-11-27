/**
    Hub.registraCallbackVerificacion — sistema (el hub intentó entregar el resultado de una verificación al sistema origen)

    Deja asentado el intento: suma uno al conteo y guarda la fecha. Si se entregó, el callback queda enviado; si no, fallido con el
    último error. Un callback ya enviado no cambia (es idempotente: repetir el aviso regresa aplicada = false). Una verificación
    pendiente (sin resultado) no tiene nada que entregar.

    Params:
      idExterno (string)   ID opaco del sistema origen
      entregado (boolean)  true si el sistema origen aceptó el resultado
      error (string)       opcional, motivo del fallo
    Info: { verificacion: Verificacion, aplicada: boolean }
    Errores: RECURSO_NO_ENCONTRADO (no hay verificación con ese ID), ESTADO_INVALIDO (la verificación sigue pendiente).

    @Acceso Publica (sistema)
*/
CREATE OR REPLACE FUNCTION hub_cleber.registra_callback_verificacion(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params    jsonb;
  v_actor     hub_cleber.usuarios;
  v_externo   text;
  v_entregado boolean;
  v_error     text;
  v_ver       hub_cleber.verificacion_datos;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.registraCallbackVerificacion');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_sistema(v_actor);

  v_externo   := hub_cleber.param_texto(v_params, 'idExterno');
  v_entregado := hub_cleber.param_booleano(v_params, 'entregado');
  v_error     := left(hub_cleber.param_texto(v_params, 'error', false), 500);

  SELECT * INTO v_ver FROM hub_cleber.verificacion_datos WHERE id_externo = v_externo FOR UPDATE;
  IF v_ver.id_verificacion IS NULL THEN
    PERFORM hub_cleber.error_de_aplicacion('RECURSO_NO_ENCONTRADO', 'La verificación no existe', jsonb_build_object('idExterno', v_externo));
  END IF;
  IF v_ver.estado = 'pendiente' THEN
    PERFORM hub_cleber.error_de_aplicacion('ESTADO_INVALIDO', 'La verificación sigue pendiente: no hay resultado que entregar',
                                           jsonb_build_object('idExterno', v_externo));
  END IF;

  IF v_ver.callback_estado = 'enviado' THEN
    RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('verificacion', hub_cleber.verificacion_json(v_ver), 'aplicada', false));
  END IF;

  UPDATE hub_cleber.verificacion_datos
     SET callback_estado = CASE WHEN v_entregado THEN 'enviado' ELSE 'fallido' END,
         callback_intentos = callback_intentos + 1,
         callback_ultimo_intento_en = now(),
         callback_ultimo_error = CASE WHEN v_entregado THEN NULL ELSE coalesce(v_error, 'Sin detalle') END,
         callback_enviado_en = CASE WHEN v_entregado THEN now() ELSE callback_enviado_en END,
         actualizado_en = now()
   WHERE id_verificacion = v_ver.id_verificacion
  RETURNING * INTO v_ver;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('verificacion', hub_cleber.verificacion_json(v_ver), 'aplicada', true));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
