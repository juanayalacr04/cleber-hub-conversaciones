/**
    Hub.guardaNumero — dashboard (administrador del módulo en la marca) o sistema (importación)

    Alta o cambio de un número de WhatsApp. En un cambio solo se tocan los campos que vienen; la marca y el módulo
    no cambian. Cada módulo tiene un solo número activo por marca (A8).
    Las credenciales NO se guardan aquí (CAMPO_INVALIDO si configProveedor las trae).

    Params:
      idNumero? (string)
      idMarca, modulo (string)          requeridos en el alta
      telefono (string)                 requerido en el alta; se guarda en E.164 (+52...)
      nombre (string)                   requerido en el alta
      proveedor (string)                requerido en el alta: twilio / meta / valuetext
      idEquipo?, idBotDefault? (string) del mismo módulo y marca; null los quita
      ventanaReaperturaHoras? (number)  0..720 (0 = no se reabren)
      horasCierreInactividad? (number)  1..720; null lo quita
      webhookCierreUrl? (string)        null lo quita
      plantillas?, configProveedor? (object)   se reemplazan completos
      esActivo? (boolean)
    Info: { numero: Numero, creado: boolean }
    Errores: ESTADO_INVALIDO con info.motivo TELEFONO_EN_USO (otro número activo con ese teléfono) o
             NUMERO_EXISTENTE (el módulo ya tiene número activo en la marca), y info.idNumero del otro.

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.guarda_numero(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params     jsonb;
  v_actor      hub_cleber.usuarios;
  v_id         text;
  v_numero     hub_cleber.numeros;
  v_existe     boolean;
  v_marca      text;
  v_modulo     text;
  v_telefono   text;
  v_nombre     text;
  v_proveedor  text;
  v_equipo     text;
  v_bot        text;
  v_ventana    integer;
  v_cierre     integer;
  v_webhook    text;
  v_plantillas jsonb;
  v_config     jsonb;
  v_activo     boolean;
  v_otro       text;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.guardaNumero');
  v_actor  := hub_cleber.usuario_actual();

  v_id         := hub_cleber.param_texto(v_params, 'idNumero', false);
  v_telefono   := hub_cleber.param_telefono(v_params, 'telefono', false);
  v_nombre     := hub_cleber.param_texto(v_params, 'nombre', false);
  v_proveedor  := hub_cleber.param_opcion(v_params, 'proveedor', ARRAY['twilio', 'meta', 'valuetext'], false);
  v_equipo     := hub_cleber.param_texto(v_params, 'idEquipo', false);
  v_bot        := hub_cleber.param_texto(v_params, 'idBotDefault', false);
  v_ventana    := hub_cleber.param_entero(v_params, 'ventanaReaperturaHoras', false, 0, 720);
  v_cierre     := hub_cleber.param_entero(v_params, 'horasCierreInactividad', false, 1, 720);
  v_webhook    := hub_cleber.param_texto(v_params, 'webhookCierreUrl', false);
  v_plantillas := hub_cleber.param_objeto(v_params, 'plantillas', false);
  v_config     := hub_cleber.param_objeto(v_params, 'configProveedor', false);
  v_activo     := hub_cleber.param_booleano(v_params, 'esActivo', false);
  PERFORM hub_cleber.exige_sin_secretos(v_config, 'configProveedor');
  PERFORM hub_cleber.exige_sin_secretos(v_plantillas, 'plantillas');

  IF v_id IS NOT NULL THEN
    SELECT * INTO v_numero FROM hub_cleber.numeros WHERE id_numero = v_id FOR UPDATE;
  END IF;
  v_existe := v_numero.id_numero IS NOT NULL;

  IF v_existe THEN
    v_marca := v_numero.id_marca;
    v_modulo := v_numero.modulo;
  ELSE
    v_marca  := upper(hub_cleber.param_texto(v_params, 'idMarca'));
    v_modulo := hub_cleber.param_modulo(v_params);
    IF NOT EXISTS (SELECT 1 FROM hub_cleber.marcas WHERE id_marca = v_marca) THEN
      PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'La marca no existe', '{"campo":"idMarca"}');
    END IF;
    IF v_telefono IS NULL THEN
      PERFORM hub_cleber.error_de_aplicacion('CAMPO_REQUERIDO', 'El teléfono es requerido para dar de alta el número', '{"campo":"telefono"}');
    END IF;
    IF v_nombre IS NULL THEN
      PERFORM hub_cleber.error_de_aplicacion('CAMPO_REQUERIDO', 'El nombre es requerido para dar de alta el número', '{"campo":"nombre"}');
    END IF;
    IF v_proveedor IS NULL THEN
      PERFORM hub_cleber.error_de_aplicacion('CAMPO_REQUERIDO', 'El proveedor es requerido para dar de alta el número', '{"campo":"proveedor"}');
    END IF;
  END IF;
  PERFORM hub_cleber.exige_configurar_modulo(v_actor, v_marca, v_modulo);
  PERFORM hub_cleber.valida_equipo(v_equipo, v_marca, v_modulo);
  PERFORM hub_cleber.valida_bot(v_bot, v_marca, v_modulo, 'idBotDefault');

  -- Unicidad entre activos, con error de negocio en lugar de la violación del índice
  IF coalesce(v_activo, v_numero.es_activo, true) THEN
    SELECT id_numero INTO v_otro FROM hub_cleber.numeros
     WHERE es_activo AND telefono = coalesce(v_telefono, v_numero.telefono) AND id_numero IS DISTINCT FROM v_numero.id_numero;
    IF v_otro IS NOT NULL THEN
      PERFORM hub_cleber.error_de_aplicacion('ESTADO_INVALIDO', 'Otro número activo ya usa ese teléfono',
        jsonb_build_object('motivo', 'TELEFONO_EN_USO', 'idNumero', v_otro));
    END IF;
    SELECT id_numero INTO v_otro FROM hub_cleber.numeros
     WHERE es_activo AND id_marca = v_marca AND modulo = v_modulo AND id_numero IS DISTINCT FROM v_numero.id_numero;
    IF v_otro IS NOT NULL THEN
      PERFORM hub_cleber.error_de_aplicacion('ESTADO_INVALIDO', 'El módulo ya tiene un número activo en la marca',
        jsonb_build_object('motivo', 'NUMERO_EXISTENTE', 'idNumero', v_otro));
    END IF;
  END IF;

  IF NOT v_existe THEN
    INSERT INTO hub_cleber.numeros (id_numero, id_marca, modulo, telefono, nombre, proveedor, id_equipo, id_bot_default,
                                    ventana_reapertura_horas, horas_cierre_inactividad, webhook_cierre_url, plantillas,
                                    config_proveedor, es_activo)
    VALUES (coalesce(v_id, gen_random_uuid()::text), v_marca, v_modulo, v_telefono, v_nombre, v_proveedor, v_equipo, v_bot,
            coalesce(v_ventana, 96), v_cierre, v_webhook, coalesce(v_plantillas, '{}'), coalesce(v_config, '{}'),
            coalesce(v_activo, true))
    RETURNING * INTO v_numero;
  ELSE
    UPDATE hub_cleber.numeros SET
      telefono                 = coalesce(v_telefono, telefono),
      nombre                   = coalesce(v_nombre, nombre),
      proveedor                = coalesce(v_proveedor, proveedor),
      id_equipo                = CASE WHEN v_params ? 'idEquipo' THEN v_equipo ELSE id_equipo END,
      id_bot_default           = CASE WHEN v_params ? 'idBotDefault' THEN v_bot ELSE id_bot_default END,
      ventana_reapertura_horas = coalesce(v_ventana, ventana_reapertura_horas),
      horas_cierre_inactividad = CASE WHEN v_params ? 'horasCierreInactividad' THEN v_cierre ELSE horas_cierre_inactividad END,
      webhook_cierre_url       = CASE WHEN v_params ? 'webhookCierreUrl' THEN v_webhook ELSE webhook_cierre_url END,
      plantillas               = coalesce(v_plantillas, plantillas),
      config_proveedor         = coalesce(v_config, config_proveedor),
      es_activo                = coalesce(v_activo, es_activo),
      actualizado_en           = now()
    WHERE id_numero = v_numero.id_numero
    RETURNING * INTO v_numero;
  END IF;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('numero', hub_cleber.numero_json(v_numero), 'creado', NOT v_existe));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
