/**
    Hub.consultaUsuarioActual — dashboard (cualquier usuario activo)

    Quién es el usuario de la petición (X-User-Email) y qué marcas puede ver. Es lo primero que pide el dashboard
    después del login; si responde SIN_PERMISO, el usuario no está dado de alta en el hub.

    (Se llama consultaUsuarioActual y no usuarioActual para no chocar con el helper hub_cleber.usuario_actual()).

    Params: ninguno
    Info: {
      usuario: Usuario,
      organizacionesVisibles: [ { idOrganizacion, nombre } ]   super admin: todas las activas; los demás: las suyas
    }

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.consulta_usuario_actual(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_usuario hub_cleber.usuarios;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  PERFORM hub_cleber.valida_peticion(peticion, 'Hub.consultaUsuarioActual');
  v_usuario := hub_cleber.usuario_actual();

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
    'usuario', hub_cleber.usuario_json(v_usuario.id_usuario),
    'organizacionesVisibles', coalesce((
        SELECT jsonb_agg(jsonb_build_object('idOrganizacion', o.id_organizacion, 'nombre', o.nombre)
                         ORDER BY o.nombre, o.id_organizacion)
          FROM hub_cleber.organizaciones o
         WHERE o.es_activa
           AND (v_usuario.es_super_admin OR v_usuario.es_sistema
                OR EXISTS (SELECT 1 FROM hub_cleber.usuarios_organizaciones uo
                            WHERE uo.id_usuario = v_usuario.id_usuario AND uo.id_organizacion = o.id_organizacion))),
        '[]'::jsonb)));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
