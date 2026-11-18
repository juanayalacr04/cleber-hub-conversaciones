/**
    Hub.consultaPermisosUsuario — sistema (backend del hub)

    Permisos de un usuario en un módulo de una marca. Lo usa el backend cuando atiende una acción del dashboard que no es
    plpgsql (p. ej. consultar una plantilla en el proveedor): el email llega del authorizer de Google (confiable) y aquí se
    decide qué puede hacer, con las mismas reglas que las acciones Hub.*.

    Params: email (string), idMarca (string), modulo (string)
    Info: { existe: boolean, esSuperAdmin: boolean, rol: string | null, esAdministrador: boolean, escribe: boolean }
          existe = false si el email no está registrado o está inactivo (todo lo demás en false/null).

    @Acceso Publica (sistema)
*/
CREATE OR REPLACE FUNCTION hub_cleber.consulta_permisos_usuario(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params  jsonb;
  v_actor   hub_cleber.usuarios;
  v_usuario hub_cleber.usuarios;
  v_marca   text;
  v_modulo  text;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.consultaPermisosUsuario');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_sistema(v_actor);

  v_usuario := hub_cleber.busca_usuario(hub_cleber.param_email(v_params, 'email'));
  v_marca   := upper(hub_cleber.param_texto(v_params, 'idMarca'));
  v_modulo  := hub_cleber.param_modulo(v_params);

  IF v_usuario.id_usuario IS NULL OR v_usuario.es_sistema THEN
    RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
      'existe', false, 'esSuperAdmin', false, 'rol', NULL, 'esAdministrador', false, 'escribe', false));
  END IF;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
    'existe', true,
    'esSuperAdmin', v_usuario.es_super_admin,
    'rol', hub_cleber.rol_modulo(v_usuario, v_marca, v_modulo),
    'esAdministrador', hub_cleber.es_administrador_modulo(v_usuario, v_marca, v_modulo),
    'escribe', hub_cleber.rol_escribe(v_usuario, v_marca, v_modulo)));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
