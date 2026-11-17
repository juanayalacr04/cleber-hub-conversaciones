/**
    Hub.consultaMarcas — dashboard (solo super admin)

    Todas las marcas, para la pantalla Marcas.

    Params:
      incluyeInactivas? (boolean)  default true
    Info: { marcas: [ Marca ] }   por nombre (ver hub_cleber.marca_json)

    @Acceso Publica (super admin)
*/
CREATE OR REPLACE FUNCTION hub_cleber.consulta_marcas(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params    jsonb;
  v_actor     hub_cleber.usuarios;
  v_inactivas boolean;
  v_marcas    jsonb;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.consultaMarcas');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_super_admin(v_actor);
  v_inactivas := coalesce(hub_cleber.param_booleano(v_params, 'incluyeInactivas', false), true);

  SELECT coalesce(jsonb_agg(hub_cleber.marca_json(m) ORDER BY m.nombre, m.id_marca), '[]'::jsonb)
    INTO v_marcas
    FROM hub_cleber.marcas m
   WHERE v_inactivas OR m.es_activa;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('marcas', v_marcas));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
