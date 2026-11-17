/**
    Hub.marcaSecretosConfigurados — sistema (backend del hub)

    El backend guarda las credenciales de un número o un bot en Secrets Manager y después registra aquí cuáles quedaron
    puestas, para que la pantalla muestre "configurado" sin conocer el valor (antes secretsSet).

    Params:
      tipo (string)            numero / bot
      id (string)              idNumero o idBot
      secretos (string[])      nombres de las credenciales configuradas (reemplaza la lista)
    Info: { numero: Numero } o { bot: Bot }

    @Acceso Publica (sistema)
*/
CREATE OR REPLACE FUNCTION hub_cleber.marca_secretos_configurados(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params   jsonb;
  v_actor    hub_cleber.usuarios;
  v_tipo     text;
  v_id       text;
  v_secretos text[];
  v_numero   hub_cleber.numeros;
  v_bot      hub_cleber.bots;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.marcaSecretosConfigurados');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_sistema(v_actor);

  v_tipo     := hub_cleber.param_opcion(v_params, 'tipo', ARRAY['numero', 'bot']);
  v_id       := hub_cleber.param_texto(v_params, 'id');
  v_secretos := hub_cleber.param_textos(v_params, 'secretos');

  IF v_tipo = 'numero' THEN
    UPDATE hub_cleber.numeros SET secretos_configurados = v_secretos, actualizado_en = now()
     WHERE id_numero = v_id RETURNING * INTO v_numero;
    IF v_numero.id_numero IS NULL THEN
      PERFORM hub_cleber.error_de_aplicacion('RECURSO_NO_ENCONTRADO', 'El número no existe', jsonb_build_object('id', v_id));
    END IF;
    RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('numero', hub_cleber.numero_json(v_numero)));
  END IF;

  UPDATE hub_cleber.bots SET secretos_configurados = v_secretos, actualizado_en = now()
   WHERE id_bot = v_id RETURNING * INTO v_bot;
  IF v_bot.id_bot IS NULL THEN
    PERFORM hub_cleber.error_de_aplicacion('RECURSO_NO_ENCONTRADO', 'El bot no existe', jsonb_build_object('id', v_id));
  END IF;
  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('bot', hub_cleber.bot_json(v_bot)));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
