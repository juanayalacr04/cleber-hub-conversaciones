/**
    Hub.guardaBot — dashboard (administrador del módulo en la marca) o sistema (importación)

    Alta o cambio de un bot. En un cambio solo se tocan los campos que vienen; la marca y el módulo no cambian.
    config se reemplaza completa cuando viene (es la configuración que interpreta el backend).
    Las credenciales NO se guardan aquí (CAMPO_INVALIDO si config las trae): las pone el backend en Secrets Manager
    y las marca con Hub.marcaSecretosConfigurados.

    Params:
      idBot? (string)
      idMarca, modulo (string)   requeridos en el alta
      nombre (string)            requerido en el alta
      tipo? (string)             chatllm (default) / workflow / vertex_ai / external
      categoria? (string)
      config? (object)
      esActivo? (boolean)
    Info: { bot: Bot, creado: boolean }

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.guarda_bot(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params    jsonb;
  v_actor     hub_cleber.usuarios;
  v_id        text;
  v_bot       hub_cleber.bots;
  v_existe    boolean;
  v_marca     text;
  v_modulo    text;
  v_nombre    text;
  v_tipo      text;
  v_categoria text;
  v_config    jsonb;
  v_activo    boolean;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.guardaBot');
  v_actor  := hub_cleber.usuario_actual();

  v_id        := hub_cleber.param_texto(v_params, 'idBot', false);
  v_nombre    := hub_cleber.param_texto(v_params, 'nombre', false);
  v_tipo      := hub_cleber.param_opcion(v_params, 'tipo', ARRAY['chatllm', 'workflow', 'vertex_ai', 'external'], false);
  v_categoria := hub_cleber.param_texto(v_params, 'categoria', false);
  v_config    := hub_cleber.param_objeto(v_params, 'config', false);
  v_activo    := hub_cleber.param_booleano(v_params, 'esActivo', false);
  PERFORM hub_cleber.exige_sin_secretos(v_config, 'config');

  IF v_id IS NOT NULL THEN
    SELECT * INTO v_bot FROM hub_cleber.bots WHERE id_bot = v_id FOR UPDATE;
  END IF;
  v_existe := v_bot.id_bot IS NOT NULL;

  IF v_existe THEN
    v_marca := v_bot.id_marca;
    v_modulo := v_bot.modulo;
  ELSE
    v_marca  := hub_cleber.param_texto(v_params, 'idMarca');
    v_modulo := hub_cleber.param_modulo(v_params);
    IF NOT EXISTS (SELECT 1 FROM hub_cleber.marcas WHERE id_marca = v_marca) THEN
      PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'La marca no existe', '{"campo":"idMarca"}');
    END IF;
    IF v_nombre IS NULL THEN
      PERFORM hub_cleber.error_de_aplicacion('CAMPO_REQUERIDO', 'El nombre es requerido para dar de alta el bot', '{"campo":"nombre"}');
    END IF;
  END IF;
  PERFORM hub_cleber.exige_configurar_modulo(v_actor, v_marca, v_modulo);

  IF NOT v_existe THEN
    INSERT INTO hub_cleber.bots (id_bot, id_marca, modulo, nombre, tipo, categoria, config, es_activo)
    VALUES (coalesce(v_id, gen_random_uuid()::text), v_marca, v_modulo, v_nombre, coalesce(v_tipo, 'chatllm'), v_categoria,
            coalesce(v_config, '{}'), coalesce(v_activo, true))
    RETURNING * INTO v_bot;
  ELSE
    UPDATE hub_cleber.bots SET
      nombre         = coalesce(v_nombre, nombre),
      tipo           = coalesce(v_tipo, tipo),
      categoria      = CASE WHEN v_params ? 'categoria' THEN v_categoria ELSE categoria END,
      config         = coalesce(v_config, config),
      es_activo      = coalesce(v_activo, es_activo),
      actualizado_en = now()
    WHERE id_bot = v_bot.id_bot
    RETURNING * INTO v_bot;
  END IF;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('bot', hub_cleber.bot_json(v_bot), 'creado', NOT v_existe));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
