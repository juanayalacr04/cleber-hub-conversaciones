/**
    Hub.actualizaVerificacion — sistema (el bot de verificación resolvió la verificación)

    Guarda el resultado de una verificación pendiente: valido (true) o no valido (false). La primera decisión manda: si la
    verificación ya está resuelta no se cambia y se regresa con aplicada = false (el bot puede repetir la acción). Al resolverla
    queda pendiente de entregar su resultado al sistema origen (callback_estado = pendiente).

    Params:
      idExterno (string)   ID opaco del sistema origen
      valido (boolean)
    Info: { verificacion: Verificacion, aplicada: boolean }
    Errores: RECURSO_NO_ENCONTRADO (no hay verificación con ese ID).

    @Acceso Publica (sistema)
*/
CREATE OR REPLACE FUNCTION hub_cleber.actualiza_verificacion(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params  jsonb;
  v_actor   hub_cleber.usuarios;
  v_externo text;
  v_valido  boolean;
  v_ver     hub_cleber.verificacion_datos;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.actualizaVerificacion');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_sistema(v_actor);

  v_externo := hub_cleber.param_texto(v_params, 'idExterno');
  v_valido  := hub_cleber.param_booleano(v_params, 'valido');

  SELECT * INTO v_ver FROM hub_cleber.verificacion_datos WHERE id_externo = v_externo FOR UPDATE;
  IF v_ver.id_verificacion IS NULL THEN
    PERFORM hub_cleber.error_de_aplicacion('RECURSO_NO_ENCONTRADO', 'La verificación no existe', jsonb_build_object('idExterno', v_externo));
  END IF;

  IF v_ver.estado <> 'pendiente' THEN
    RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('verificacion', hub_cleber.verificacion_json(v_ver), 'aplicada', false));
  END IF;

  UPDATE hub_cleber.verificacion_datos
     SET estado = CASE WHEN v_valido THEN 'valido' ELSE 'no_valido' END, resuelto_en = now(), callback_estado = 'pendiente',
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
