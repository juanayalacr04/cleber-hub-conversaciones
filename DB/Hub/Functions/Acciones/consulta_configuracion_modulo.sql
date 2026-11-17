/**
    Hub.consultaConfiguracionModulo — dashboard (cualquier rol en el módulo de la marca) o sistema

    Equipos, números y bots de un módulo en una marca (activos e inactivos), ordenados por nombre.

    Params: idMarca, modulo (string)
    Info: { equipos: [Equipo], numeros: [Numero], bots: [Bot], puedeEditar: boolean }

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.consulta_configuracion_modulo(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params jsonb;
  v_actor  hub_cleber.usuarios;
  v_marca  text;
  v_modulo text;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.consultaConfiguracionModulo');
  v_actor  := hub_cleber.usuario_actual();
  v_marca  := upper(hub_cleber.param_texto(v_params, 'idMarca'));
  v_modulo := hub_cleber.param_modulo(v_params);
  PERFORM hub_cleber.exige_modulo(v_actor, v_marca, v_modulo);

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
    'equipos', coalesce((SELECT jsonb_agg(hub_cleber.equipo_json(e) ORDER BY e.nombre)
                           FROM hub_cleber.equipos e WHERE e.id_marca = v_marca AND e.modulo = v_modulo), '[]'),
    'numeros', coalesce((SELECT jsonb_agg(hub_cleber.numero_json(n) ORDER BY n.nombre)
                           FROM hub_cleber.numeros n WHERE n.id_marca = v_marca AND n.modulo = v_modulo), '[]'),
    'bots',    coalesce((SELECT jsonb_agg(hub_cleber.bot_json(b) ORDER BY b.nombre)
                           FROM hub_cleber.bots b WHERE b.id_marca = v_marca AND b.modulo = v_modulo), '[]'),
    'puedeEditar', coalesce(v_actor.es_sistema, false) OR hub_cleber.es_administrador_modulo(v_actor, v_marca, v_modulo)));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
