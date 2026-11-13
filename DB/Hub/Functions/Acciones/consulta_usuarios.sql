/**
    Hub.consultaUsuarios — dashboard (administrador de algún módulo de la marca, o super admin)

    Usuarios de una marca para el editor.

    Params:
      idOrganizacion (string)
      modulo? (string)             solo quienes tienen rol en ese módulo de la marca
      incluyeInactivos? (boolean)  default false
    Info: {
      usuarios: [ UsuarioEnOrganizacion ],      por nombre y email (ver hub_cleber.usuario_en_organizacion_json)
      permisos: { modulos: ["<modulo>"], agencias: true }   qué puede editar quien consulta en esta marca
    }
    Los usuarios de sistema no aparecen. Un super admin que no pertenece a la marca tampoco.

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.consulta_usuarios(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params    jsonb;
  v_actor     hub_cleber.usuarios;
  v_org       text;
  v_modulo    text;
  v_inactivos boolean;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.consultaUsuarios');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_persona(v_actor);

  v_org       := hub_cleber.param_texto(v_params, 'idOrganizacion');
  v_modulo    := hub_cleber.param_modulo(v_params, 'modulo', false);
  v_inactivos := coalesce(hub_cleber.param_booleano(v_params, 'incluyeInactivos', false), false);

  PERFORM hub_cleber.exige_administrador_organizacion(v_actor, v_org);
  PERFORM hub_cleber.exige_organizacion_activa(v_org);

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
    'usuarios', coalesce((
        SELECT jsonb_agg(hub_cleber.usuario_en_organizacion_json(u.id_usuario, v_org)
                         ORDER BY lower(nullif(u.nombre, '')) NULLS LAST, u.email)
          FROM hub_cleber.usuarios u
          JOIN hub_cleber.usuarios_organizaciones uo ON uo.id_usuario = u.id_usuario AND uo.id_organizacion = v_org
         WHERE NOT u.es_sistema
           AND (v_inactivos OR u.es_activo)
           AND (v_modulo IS NULL OR EXISTS (SELECT 1 FROM hub_cleber.usuarios_roles_modulo rm
                                             WHERE rm.id_usuario = u.id_usuario AND rm.id_organizacion = v_org
                                               AND rm.modulo = v_modulo))), '[]'::jsonb),
    'permisos', jsonb_build_object(
        'modulos',  coalesce((SELECT jsonb_agg(m ORDER BY m) FROM unnest(ARRAY['ventas', 'servicio', 'valuacion']) m
                               WHERE hub_cleber.es_administrador_modulo(v_actor, v_org, m)), '[]'::jsonb),
        'agencias', true)));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
