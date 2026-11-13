/**
    Hub.consultaRolesModulo — dashboard (cualquier usuario activo)

    Catálogo de roles por módulo (hub_cleber.roles_modulo), para los selectores del editor de usuarios.

    Params: modulo? (ventas | servicio | valuacion)
    Info: { roles: [ { modulo, rol, nombre, descripcion, esAdministrador } ] }   por módulo y orden del catálogo

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.consulta_roles_modulo(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params jsonb;
  v_modulo text;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.consultaRolesModulo');
  PERFORM hub_cleber.usuario_actual();
  v_modulo := hub_cleber.param_modulo(v_params, 'modulo', false);

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('roles', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'modulo',          r.modulo,
             'rol',             r.rol,
             'nombre',          r.nombre,
             'descripcion',     r.descripcion,
             'esAdministrador', r.es_administrador) ORDER BY r.modulo, r.orden, r.rol)
      FROM hub_cleber.roles_modulo r
     WHERE v_modulo IS NULL OR r.modulo = v_modulo), '[]'::jsonb)));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
