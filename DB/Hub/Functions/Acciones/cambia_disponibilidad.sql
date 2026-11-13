/**
    Hub.cambiaDisponibilidad — backend, en nombre del usuario

    Si el usuario recibe asignaciones automáticas (isAvailable). Cada quien cambia la suya; la de otro la cambia un
    administrador de alguna marca que compartan, o el super admin.

    Params: esDisponible (boolean), idUsuario? (number; default: el propio)
    Info: { idUsuario, esDisponible }

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.cambia_disponibilidad(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params     jsonb;
  v_actor      hub_cleber.usuarios;
  v_usuario    hub_cleber.usuarios;
  v_id         bigint;
  v_disponible boolean;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.cambiaDisponibilidad');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_persona(v_actor);

  v_disponible := hub_cleber.param_booleano(v_params, 'esDisponible');
  v_id         := coalesce(hub_cleber.param_entero(v_params, 'idUsuario', false, 1, 2147483647), v_actor.id_usuario);

  IF v_id <> v_actor.id_usuario THEN
    v_usuario := hub_cleber.usuario_objetivo(v_id, v_actor);
    IF NOT v_actor.es_super_admin AND NOT EXISTS (
         SELECT 1 FROM hub_cleber.usuarios_organizaciones uo
          WHERE uo.id_usuario = v_id AND hub_cleber.es_administrador_organizacion(v_actor, uo.id_organizacion)) THEN
      PERFORM hub_cleber.error_de_aplicacion('SIN_PERMISO', 'No administras ninguna organización de ese usuario');
    END IF;
  END IF;

  UPDATE hub_cleber.usuarios SET es_disponible = v_disponible, actualizado_en = now() WHERE id_usuario = v_id;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('idUsuario', v_id, 'esDisponible', v_disponible));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
