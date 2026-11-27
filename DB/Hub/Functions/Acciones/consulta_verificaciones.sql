/**
    Hub.consultaVerificaciones — dashboard (bandeja de verificaciones) o sistema

    Verificaciones de datos de una marca, de la más reciente a la más vieja (por creado_en), con la conversación donde se
    verificaron (estado y resultado) cuando la tienen. Los permisos son los del módulo verificacion en la marca: cualquier rol
    del módulo (ADMINISTRADOR o CONSULTA) y el super admin.

    Params:
      idMarca (string)
      estados? (string[])         pendiente / valido / no_valido
      callbackEstados? (string[]) pendiente / enviado / fallido
      busqueda? (string)          parte del ID externo o del valor
      antesDe? (string ISO)       paginación: creadoEn de la última que ya se tiene
      limite? (number)            1..200, default 50
    Info: { verificaciones: [Verificacion + conversacion: { estado, resultado } | null], hayMas: boolean }

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.consulta_verificaciones(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params   jsonb;
  v_actor    hub_cleber.usuarios;
  v_marca    text;
  v_estados  text[];
  v_callback text[];
  v_busqueda text;
  v_antes    timestamptz;
  v_limite   integer;
  v_lista    jsonb;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.consultaVerificaciones');
  v_actor  := hub_cleber.usuario_actual();
  v_marca  := hub_cleber.param_texto(v_params, 'idMarca');
  PERFORM hub_cleber.exige_modulo(v_actor, v_marca, 'verificacion');

  v_estados  := hub_cleber.param_textos(v_params, 'estados', false);
  IF v_estados IS NOT NULL AND NOT v_estados <@ ARRAY['pendiente', 'valido', 'no_valido'] THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'estados solo admite pendiente, valido y no_valido', '{"campo":"estados"}');
  END IF;
  v_callback := hub_cleber.param_textos(v_params, 'callbackEstados', false);
  IF v_callback IS NOT NULL AND NOT v_callback <@ ARRAY['pendiente', 'enviado', 'fallido'] THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'callbackEstados solo admite pendiente, enviado y fallido',
                                           '{"campo":"callbackEstados"}');
  END IF;
  v_busqueda := hub_cleber.param_texto(v_params, 'busqueda', false);
  v_antes    := hub_cleber.param_fecha_hora(v_params, 'antesDe', false);
  v_limite   := coalesce(hub_cleber.param_entero(v_params, 'limite', false, 1, 200), 50);

  SELECT coalesce(jsonb_agg(hub_cleber.verificacion_json(vd)
                            || jsonb_build_object('conversacion', (SELECT jsonb_build_object('estado', c.estado, 'resultado', c.resultado)
                                                                     FROM hub_cleber.conversaciones c
                                                                    WHERE c.id_conversacion = vd.id_conversacion))
                            ORDER BY vd.creado_en DESC, vd.id_verificacion), '[]')
    INTO v_lista
    FROM hub_cleber.verificacion_datos vd
   WHERE vd.id_verificacion IN (
          SELECT vd.id_verificacion FROM hub_cleber.verificacion_datos vd
           WHERE vd.id_marca = v_marca
             AND (v_estados IS NULL OR vd.estado = ANY (v_estados))
             AND (v_callback IS NULL OR vd.callback_estado = ANY (v_callback))
             AND (v_antes IS NULL OR vd.creado_en < v_antes)
             AND (v_busqueda IS NULL
                  OR vd.id_externo ILIKE '%' || v_busqueda || '%'
                  OR vd.valor ILIKE '%' || v_busqueda || '%')
           ORDER BY vd.creado_en DESC, vd.id_verificacion
           LIMIT v_limite + 1);

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
    'verificaciones', CASE WHEN jsonb_array_length(v_lista) > v_limite THEN v_lista - v_limite ELSE v_lista END,
    'hayMas', jsonb_array_length(v_lista) > v_limite));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
