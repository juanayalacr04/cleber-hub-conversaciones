/**
    Hub.resumenVerificaciones — dashboard (tarjetas del módulo) o sistema

    Conteos de las verificaciones de una marca en un rango de fechas (por creado_en): por estado, por estado del callback y
    cuántas se entregaron simuladas. Los permisos son los del módulo verificacion en la marca: cualquier rol del módulo
    (ADMINISTRADOR o CONSULTA) y el super admin.

    Params:
      idMarca (string)
      desde? (string ISO)   creado_en >= desde
      hasta? (string ISO)   creado_en <= hasta
    Info: { total, pendientes, validas, noValidas, callback: { pendiente, enviado, fallido, simulados }, sinCallback }

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.resumen_verificaciones(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params jsonb;
  v_actor  hub_cleber.usuarios;
  v_marca  text;
  v_desde  timestamptz;
  v_hasta  timestamptz;
  v_info   jsonb;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.resumenVerificaciones');
  v_actor  := hub_cleber.usuario_actual();
  v_marca  := hub_cleber.param_texto(v_params, 'idMarca');
  PERFORM hub_cleber.exige_modulo(v_actor, v_marca, 'verificacion');

  v_desde := hub_cleber.param_fecha_hora(v_params, 'desde', false);
  v_hasta := hub_cleber.param_fecha_hora(v_params, 'hasta', false);

  SELECT jsonb_build_object(
           'total',      count(*),
           'pendientes', count(*) FILTER (WHERE vd.estado = 'pendiente'),
           'validas',    count(*) FILTER (WHERE vd.estado = 'valido'),
           'noValidas',  count(*) FILTER (WHERE vd.estado = 'no_valido'),
           'callback',   jsonb_build_object(
                           'pendiente', count(*) FILTER (WHERE vd.callback_estado = 'pendiente'),
                           'enviado',   count(*) FILTER (WHERE vd.callback_estado = 'enviado'),
                           'fallido',   count(*) FILTER (WHERE vd.callback_estado = 'fallido'),
                           'simulados', count(*) FILTER (WHERE vd.callback_simulado)),
           'sinCallback', count(*) FILTER (WHERE vd.callback_estado IS NULL))
    INTO v_info
    FROM hub_cleber.verificacion_datos vd
   WHERE vd.id_marca = v_marca
     AND (v_desde IS NULL OR vd.creado_en >= v_desde)
     AND (v_hasta IS NULL OR vd.creado_en <= v_hasta);

  RETURN cleber.construye_respuesta_exitosa(v_info);

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
