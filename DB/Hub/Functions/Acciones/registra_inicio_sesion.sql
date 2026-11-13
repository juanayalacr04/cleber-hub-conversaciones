/**
    Hub.registraInicioSesion — dashboard, al iniciar sesión (cualquier usuario activo del dashboard)

    Registra el acceso del usuario de la petición: último acceso, estado online y, si vienen, el nombre y la foto de
    su cuenta de Google. Reemplaza a me.claim_invite / me.sign_in de Firestore: como la identidad es el email,
    "reclamar la invitación" es solo entrar por primera vez (ultimoAccesoEn deja de ser null).

    Params: nombre? (string), fotoUrl? (string)
    Info: { usuario: Usuario }

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.registra_inicio_sesion(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params jsonb;
  v_actor  hub_cleber.usuarios;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.registraInicioSesion');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_persona(v_actor);

  UPDATE hub_cleber.usuarios SET
    ultimo_acceso_en = now(),
    estado           = 'online',
    nombre           = coalesce(hub_cleber.param_texto(v_params, 'nombre', false), nombre),
    foto_url         = coalesce(hub_cleber.param_texto(v_params, 'fotoUrl', false), foto_url),
    actualizado_en   = now()
  WHERE id_usuario = v_actor.id_usuario;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('usuario', hub_cleber.usuario_json(v_actor.id_usuario)));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
