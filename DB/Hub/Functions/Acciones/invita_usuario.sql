/**
    Hub.invitaUsuario — backend, en nombre del usuario (administrador del módulo en la marca, o super admin)

    Da a una persona su rol en un módulo de una marca. Si el email no existe en el hub, crea al usuario como
    invitado (ultimoAccesoEn = null); su nombre y foto llegan en su primer inicio de sesión (Hub.registraInicioSesion).
    Si ya existe (por ejemplo, de otra marca), solo le agrega la marca y el rol. No manda el correo: lo hace el
    backend, que además actualiza accesos/{email} en Firestore con el usuario de la respuesta.

    Params:
      email (string), idOrganizacion (string), modulo (string), rol (string, del catálogo del módulo)
      idEquipo? (string)       equipo en ese módulo (id de Firestore mientras los equipos sigan ahí)
      agencias? (string[])     reemplaza las del usuario en la marca (ids del API de agencias, por valor)
      nombre? (string)         solo si se crea
    Info: { usuario: Usuario, creado: boolean }
    Errores:
      CAMPO_INVALIDO  causa NO_EXISTE (organización), rol fuera del catálogo, email de sistema
      ESTADO_INVALIDO causa YA_TIENE_ROL (cambiarlo con Hub.guardaUsuario) o USUARIO_INACTIVO

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.invita_usuario(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params   jsonb;
  v_actor    hub_cleber.usuarios;
  v_usuario  hub_cleber.usuarios;
  v_email    text;
  v_org      text;
  v_modulo   text;
  v_rol      text;
  v_equipo   text;
  v_agencias text[];
  v_nombre   text;
  v_creado   boolean := false;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.invitaUsuario');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_persona(v_actor);

  v_email    := hub_cleber.param_email(v_params, 'email');
  v_org      := hub_cleber.param_texto(v_params, 'idOrganizacion');
  v_modulo   := hub_cleber.param_modulo(v_params, 'modulo');
  v_rol      := hub_cleber.param_texto(v_params, 'rol');
  v_equipo   := hub_cleber.param_texto(v_params, 'idEquipo', false);
  v_agencias := hub_cleber.param_textos(v_params, 'agencias', false);
  v_nombre   := hub_cleber.param_texto(v_params, 'nombre', false);

  PERFORM hub_cleber.exige_administrador_modulo(v_actor, v_org, v_modulo);
  PERFORM hub_cleber.exige_organizacion_activa(v_org);
  PERFORM hub_cleber.exige_rol_catalogo(v_modulo, v_rol);
  IF v_email LIKE '%.internal' THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'Los usuarios de sistema no se invitan', '{"campo":"email"}');
  END IF;

  SELECT * INTO v_usuario FROM hub_cleber.usuarios WHERE email = v_email FOR UPDATE;
  IF FOUND THEN
    IF NOT v_usuario.es_activo THEN
      PERFORM hub_cleber.error_de_aplicacion('ESTADO_INVALIDO', 'El usuario está dado de baja en el hub', '{"causa":"USUARIO_INACTIVO"}');
    END IF;
    v_usuario := hub_cleber.usuario_objetivo(v_usuario.id_usuario, v_actor);
    IF EXISTS (SELECT 1 FROM hub_cleber.usuarios_roles_modulo
                WHERE id_usuario = v_usuario.id_usuario AND id_organizacion = v_org AND modulo = v_modulo) THEN
      PERFORM hub_cleber.error_de_aplicacion('ESTADO_INVALIDO',
        format('El usuario ya tiene rol en %s en esta organización; cámbialo desde el editor', v_modulo),
        jsonb_build_object('causa', 'YA_TIENE_ROL', 'idUsuario', v_usuario.id_usuario));
    END IF;
  ELSE
    INSERT INTO hub_cleber.usuarios (email, nombre, invitado_por)
    VALUES (v_email, coalesce(v_nombre, ''), v_actor.id_usuario)
    RETURNING * INTO v_usuario;
    v_creado := true;
  END IF;

  INSERT INTO hub_cleber.usuarios_organizaciones AS uo (id_usuario, id_organizacion, agencias)
  VALUES (v_usuario.id_usuario, v_org, coalesce(v_agencias, '{}'))
  ON CONFLICT (id_usuario, id_organizacion) DO UPDATE SET
    agencias       = coalesce(v_agencias, uo.agencias),
    actualizado_en = now();

  INSERT INTO hub_cleber.usuarios_roles_modulo (id_usuario, id_organizacion, modulo, rol, id_equipo)
  VALUES (v_usuario.id_usuario, v_org, v_modulo, v_rol, v_equipo);

  UPDATE hub_cleber.usuarios SET actualizado_en = now() WHERE id_usuario = v_usuario.id_usuario;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
    'usuario', hub_cleber.usuario_json(v_usuario.id_usuario),
    'creado',  v_creado));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
