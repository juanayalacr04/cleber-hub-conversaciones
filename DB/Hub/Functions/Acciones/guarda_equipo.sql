/**
    Hub.guardaEquipo — dashboard (administrador del módulo en la marca) o sistema (importación)

    Alta (sin idEquipo, o con un idEquipo que no existe: importación) o cambio de un equipo. En un cambio solo se
    tocan los campos que vienen; la marca y el módulo no cambian.

    Params:
      idEquipo? (string)                  sin él es alta con id nuevo
      idMarca, modulo (string)            requeridos en el alta; en un cambio se ignoran (salen del equipo)
      nombre (string)                     requerido en el alta
      modoAsignacion? (string)
      maxConversacionesAgente? (number)   1..1000
      accionOptOut? (string)              close / handoff
      umbralesSemaforo? (object)
      esActivo? (boolean)
    Info: { equipo: Equipo, creado: boolean }

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.guarda_equipo(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params  jsonb;
  v_actor   hub_cleber.usuarios;
  v_id      text;
  v_equipo  hub_cleber.equipos;
  v_existe  boolean;
  v_marca   text;
  v_modulo  text;
  v_nombre  text;
  v_modo    text;
  v_max     integer;
  v_opt_out text;
  v_umbrales jsonb;
  v_activo  boolean;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.guardaEquipo');
  v_actor  := hub_cleber.usuario_actual();

  v_id       := hub_cleber.param_texto(v_params, 'idEquipo', false);
  v_nombre   := hub_cleber.param_texto(v_params, 'nombre', false);
  v_modo     := hub_cleber.param_texto(v_params, 'modoAsignacion', false);
  v_max      := hub_cleber.param_entero(v_params, 'maxConversacionesAgente', false, 1, 1000);
  v_opt_out  := hub_cleber.param_opcion(v_params, 'accionOptOut', ARRAY['close', 'handoff'], false);
  v_umbrales := hub_cleber.param_objeto(v_params, 'umbralesSemaforo', false);
  v_activo   := hub_cleber.param_booleano(v_params, 'esActivo', false);

  IF v_id IS NOT NULL THEN
    SELECT * INTO v_equipo FROM hub_cleber.equipos WHERE id_equipo = v_id FOR UPDATE;
  END IF;
  v_existe := v_equipo.id_equipo IS NOT NULL;

  IF v_existe THEN
    v_marca := v_equipo.id_marca;
    v_modulo := v_equipo.modulo;
  ELSE
    v_marca  := upper(hub_cleber.param_texto(v_params, 'idMarca'));
    v_modulo := hub_cleber.param_modulo(v_params);
    IF NOT EXISTS (SELECT 1 FROM hub_cleber.marcas WHERE id_marca = v_marca) THEN
      PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'La marca no existe', '{"campo":"idMarca"}');
    END IF;
    IF v_nombre IS NULL THEN
      PERFORM hub_cleber.error_de_aplicacion('CAMPO_REQUERIDO', 'El nombre es requerido para dar de alta el equipo', '{"campo":"nombre"}');
    END IF;
  END IF;
  PERFORM hub_cleber.exige_configurar_modulo(v_actor, v_marca, v_modulo);

  IF NOT v_existe THEN
    INSERT INTO hub_cleber.equipos (id_equipo, id_marca, modulo, nombre, modo_asignacion, max_conversaciones_agente,
                                    accion_opt_out, umbrales_semaforo, es_activo)
    VALUES (coalesce(v_id, gen_random_uuid()::text), v_marca, v_modulo, v_nombre, coalesce(v_modo, 'manual'), v_max,
            v_opt_out, coalesce(v_umbrales, '{}'), coalesce(v_activo, true))
    RETURNING * INTO v_equipo;
  ELSE
    UPDATE hub_cleber.equipos SET
      nombre                    = coalesce(v_nombre, nombre),
      modo_asignacion           = coalesce(v_modo, modo_asignacion),
      max_conversaciones_agente = CASE WHEN v_params ? 'maxConversacionesAgente' THEN v_max ELSE max_conversaciones_agente END,
      accion_opt_out            = CASE WHEN v_params ? 'accionOptOut' THEN v_opt_out ELSE accion_opt_out END,
      umbrales_semaforo         = coalesce(v_umbrales, umbrales_semaforo),
      es_activo                 = coalesce(v_activo, es_activo),
      actualizado_en            = now()
    WHERE id_equipo = v_equipo.id_equipo
    RETURNING * INTO v_equipo;
  END IF;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('equipo', hub_cleber.equipo_json(v_equipo), 'creado', NOT v_existe));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
