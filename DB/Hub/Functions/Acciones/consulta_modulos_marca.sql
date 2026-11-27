/**
    Hub.consultaModulosMarca — dashboard (solo super admin)

    Módulos que tienen fila en cada marca y si están activos. Un módulo sin fila no está activo. La lista de módulos que
    existen la define el código de la web, no esta acción.

    Params: ninguno
    Info: { marcas: [ { idMarca, nombre, esActiva, modulos: [ { modulo, esActivo } ] } ] }

    @Acceso Publica (super admin)
*/
CREATE OR REPLACE FUNCTION hub_cleber.consulta_modulos_marca(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_actor hub_cleber.usuarios;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  PERFORM hub_cleber.valida_peticion(peticion, 'Hub.consultaModulosMarca');
  v_actor := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_super_admin(v_actor);

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('marcas', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'idMarca', m.id_marca, 'nombre', m.nombre, 'esActiva', m.es_activa,
             'modulos', coalesce((SELECT jsonb_agg(jsonb_build_object('modulo', mm.modulo, 'esActivo', mm.es_activo) ORDER BY mm.modulo)
                                    FROM hub_cleber.marcas_modulos mm WHERE mm.id_marca = m.id_marca), '[]'::jsonb))
           ORDER BY m.nombre, m.id_marca)
      FROM hub_cleber.marcas m), '[]'::jsonb)));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
