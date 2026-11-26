/**
    Hub.registraVerificacion — sistema (contrato ①, fuente verificacion)

    Registra la verificación de un dato del cliente que pidió otro sistema (Salesforce). La llama el backend al abrir la
    conversación saliente, antes de mandar la plantilla.

    Idempotente por idExterno (el ID opaco del sistema origen): si ya existe regresa la misma con creada = false. Si el mismo
    idExterno llega con otro valor (otro teléfono) → ESTADO_INVALIDO, motivo ID_CON_OTRO_VALOR: el ID ya identifica a otro dato.

    Params:
      idExterno (string)       ID opaco del sistema origen
      idMarca (string)
      tipo? (string)           telefono (por omisión) | correo
      valor (string)           el dato a verificar; un teléfono se normaliza a E.164
      idConversacion? (string) conversación de WhatsApp donde se verifica (siempre en el teléfono)
    Info: { verificacion: Verificacion, creada: boolean }
    Errores: ESTADO_INVALIDO con info.motivo ID_CON_OTRO_VALOR, RECURSO_NO_ENCONTRADO (marca o conversación).

    @Acceso Publica (sistema)
*/
CREATE OR REPLACE FUNCTION hub_cleber.registra_verificacion(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params  jsonb;
  v_actor   hub_cleber.usuarios;
  v_externo text;
  v_marca   text;
  v_tipo    text;
  v_valor   text;
  v_id_conv text;
  v_ver     hub_cleber.verificacion_datos;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.registraVerificacion');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_sistema(v_actor);

  v_externo := hub_cleber.param_texto(v_params, 'idExterno');
  v_marca   := hub_cleber.param_texto(v_params, 'idMarca');
  v_tipo    := coalesce(hub_cleber.param_opcion(v_params, 'tipo', ARRAY['telefono', 'correo'], false), 'telefono');
  v_valor   := CASE WHEN v_tipo = 'telefono' THEN hub_cleber.param_telefono(v_params, 'valor')
                    ELSE lower(hub_cleber.param_texto(v_params, 'valor')) END;
  v_id_conv := hub_cleber.param_texto(v_params, 'idConversacion', false);

  IF NOT EXISTS (SELECT 1 FROM hub_cleber.marcas WHERE id_marca = v_marca) THEN
    PERFORM hub_cleber.error_de_aplicacion('RECURSO_NO_ENCONTRADO', format('La marca %s no existe', v_marca), jsonb_build_object('idMarca', v_marca));
  END IF;
  IF v_id_conv IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hub_cleber.conversaciones WHERE id_conversacion = v_id_conv) THEN
    PERFORM hub_cleber.error_de_aplicacion('RECURSO_NO_ENCONTRADO', 'La conversación no existe', jsonb_build_object('idConversacion', v_id_conv));
  END IF;

  -- Serializa llamadas con el mismo ID
  PERFORM pg_advisory_xact_lock(hashtextextended('verificacion:' || v_externo, 0));

  SELECT * INTO v_ver FROM hub_cleber.verificacion_datos WHERE id_externo = v_externo;
  IF v_ver.id_verificacion IS NOT NULL THEN
    IF v_ver.tipo <> v_tipo OR v_ver.valor <> v_valor THEN
      PERFORM hub_cleber.error_de_aplicacion('ESTADO_INVALIDO', 'El ID ya está registrado con otro dato',
        jsonb_build_object('motivo', 'ID_CON_OTRO_VALOR', 'idExterno', v_externo));
    END IF;
    IF v_ver.id_conversacion IS NULL AND v_id_conv IS NOT NULL THEN
      UPDATE hub_cleber.verificacion_datos SET id_conversacion = v_id_conv, actualizado_en = now()
       WHERE id_verificacion = v_ver.id_verificacion RETURNING * INTO v_ver;
    END IF;
    RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('verificacion', hub_cleber.verificacion_json(v_ver), 'creada', false));
  END IF;

  INSERT INTO hub_cleber.verificacion_datos (id_marca, tipo, valor, id_externo, id_conversacion)
  VALUES (v_marca, v_tipo, v_valor, v_externo, v_id_conv)
  RETURNING * INTO v_ver;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('verificacion', hub_cleber.verificacion_json(v_ver), 'creada', true));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
