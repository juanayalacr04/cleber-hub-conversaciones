/**
    Hub.cambiaActivoUsuario — backend, en nombre del usuario (solo super admin)

    Da de baja (o reactiva) a un usuario en TODO el hub. No se borra nada: con es_activo = false el usuario ya no entra
    (busca_usuario y usuarios_contexto lo ignoran), no se le asignan conversaciones y no se le puede invitar; su
    historial (mensajes, conversaciones atendidas) se conserva. Sus marcas, roles y agencias se quedan como estaban, así
    que reactivarlo lo deja igual que antes. Al darlo de baja también queda no disponible.
    Nadie se da de baja a sí mismo.

    Las conversaciones abiertas que tenía asignadas NO se mueven: la respuesta dice cuántas son para que un
    administrador las reasigne.

    Params: idUsuario (string, UUID), esActivo (boolean)
    Info: { usuario: Usuario, conversacionesAbiertas: number }
    Errores:
      SIN_PERMISO     quien llama no es super admin
      CAMPO_INVALIDO  causa NO_EXISTE
      ESTADO_INVALIDO causa PROPIA_BAJA

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.cambia_activo_usuario(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params  jsonb;
  v_actor   hub_cleber.usuarios;
  v_usuario hub_cleber.usuarios;
  v_id      uuid;
  v_activo  boolean;
  v_abiertas integer;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.cambiaActivoUsuario');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_persona(v_actor);
  IF NOT coalesce(v_actor.es_super_admin, false) THEN
    PERFORM hub_cleber.error_de_aplicacion('SIN_PERMISO', 'Solo un super admin da de baja usuarios en el hub');
  END IF;

  v_id     := hub_cleber.param_uuid(v_params, 'idUsuario');
  v_activo := hub_cleber.param_booleano(v_params, 'esActivo');

  v_usuario := hub_cleber.usuario_objetivo(v_id, v_actor);
  IF v_id = v_actor.id_usuario AND NOT v_activo THEN
    PERFORM hub_cleber.error_de_aplicacion('ESTADO_INVALIDO', 'No puedes darte de baja a ti mismo',
      '{"causa":"PROPIA_BAJA"}');
  END IF;

  UPDATE hub_cleber.usuarios
     SET es_activo      = v_activo,
         es_disponible  = CASE WHEN v_activo THEN es_disponible ELSE false END,
         estado         = CASE WHEN v_activo THEN estado ELSE 'offline' END,
         actualizado_en = now()
   WHERE id_usuario = v_id;

  SELECT count(*) INTO v_abiertas FROM hub_cleber.conversaciones WHERE id_agente = v_id AND estado <> 'closed';

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
    'usuario', hub_cleber.usuario_json(v_id), 'conversacionesAbiertas', v_abiertas));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
