/**
    Hub.quitaUsuarioDeOrganizacion — backend, en nombre del usuario (administrador en la marca, o super admin)

    Saca al usuario de la marca: se borran sus agencias y sus roles en ella. Sus otras marcas no cambian; el usuario
    no se borra del hub. Exige administrar TODOS los módulos donde el usuario tiene rol en la marca (si no tiene
    ninguno, basta administrar alguno). Nadie (salvo el super admin) se quita a sí mismo.
    El backend actualiza accesos/{email} en Firestore con el usuario de la respuesta.

    Params: idUsuario (number), idOrganizacion (string)
    Info: { usuario: Usuario }
    Errores:
      CAMPO_INVALIDO  causa NO_EXISTE o NO_PERTENECE
      ESTADO_INVALIDO causa PROPIA_MEMBRESIA

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.quita_usuario_de_organizacion(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params  jsonb;
  v_actor   hub_cleber.usuarios;
  v_usuario hub_cleber.usuarios;
  v_id      bigint;
  v_org     text;
  v_modulo  text;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.quitaUsuarioDeOrganizacion');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_persona(v_actor);

  v_id  := hub_cleber.param_entero(v_params, 'idUsuario', true, 1, 2147483647);
  v_org := hub_cleber.param_texto(v_params, 'idOrganizacion');

  PERFORM hub_cleber.exige_administrador_organizacion(v_actor, v_org);
  v_usuario := hub_cleber.usuario_objetivo(v_id, v_actor);
  PERFORM hub_cleber.exige_miembro(v_id, v_org);
  IF v_id = v_actor.id_usuario AND NOT v_actor.es_super_admin THEN
    PERFORM hub_cleber.error_de_aplicacion('ESTADO_INVALIDO', 'No puedes quitarte a ti mismo de la organización',
      '{"causa":"PROPIA_MEMBRESIA"}');
  END IF;
  FOR v_modulo IN SELECT modulo FROM hub_cleber.usuarios_roles_modulo WHERE id_usuario = v_id AND id_organizacion = v_org LOOP
    PERFORM hub_cleber.exige_administrador_modulo(v_actor, v_org, v_modulo);
  END LOOP;

  DELETE FROM hub_cleber.usuarios_organizaciones WHERE id_usuario = v_id AND id_organizacion = v_org;
  UPDATE hub_cleber.usuarios SET actualizado_en = now() WHERE id_usuario = v_id;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('usuario', hub_cleber.usuario_json(v_id)));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
