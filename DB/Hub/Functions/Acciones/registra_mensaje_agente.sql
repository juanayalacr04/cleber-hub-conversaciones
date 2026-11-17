/**
    Hub.registraMensajeAgente — dashboard, vía backend (mismos permisos que Hub.autorizaMensajeAgente)

    Paso 2 del mensaje del asesor: el proveedor ya lo aceptó y se guarda. Idempotente por idMensajeProveedor.
    Si la conversación estaba con el bot o esperando asesor, el asesor la toma (pasa a with_agent asignada a él):
    un humano ya le está hablando al cliente. La primera respuesta del ciclo registra el tiempo de respuesta.
    Si se cerró entre el paso 1 y este, el mensaje se guarda y la conversación sigue cerrada.
    Params:
      idConversacion (string)
      texto? (string, hasta 4096), mediaUrl? (string https)   al menos uno
      idMensajeProveedor? (string)
    Info: { mensaje: Mensaje, conversacion: Conversacion, duplicado: boolean }

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.registra_mensaje_agente(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params jsonb;
  v_actor  hub_cleber.usuarios;
  v_conv   hub_cleber.conversaciones;
  v_texto   text;
  v_media   text;
  v_id_prov text;
  v_mensaje hub_cleber.mensajes;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.registraMensajeAgente');
  v_actor  := hub_cleber.usuario_actual();

  v_conv := hub_cleber.conversacion_para_operar(v_actor, v_params);
  PERFORM hub_cleber.exige_operar(v_actor, v_conv);
  -- Sin exigir estado: el mensaje ya salió al cliente; si la conversación se cerró entre el paso 1 y este, se guarda igual

  v_texto   := left(nullif(btrim(hub_cleber.param(v_params, 'texto', 'string', false) #>> '{}'), ''), 4096);
  v_media   := hub_cleber.param_texto(v_params, 'mediaUrl', false);
  v_id_prov := hub_cleber.param_texto(v_params, 'idMensajeProveedor', false);
  IF v_texto IS NULL AND v_media IS NULL THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_REQUERIDO', 'El mensaje necesita texto o mediaUrl', '{"campo":"texto"}');
  END IF;
  IF v_media IS NOT NULL AND v_media !~ '^https://' THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'mediaUrl debe ser una URL https', '{"campo":"mediaUrl"}');
  END IF;

  IF v_id_prov IS NOT NULL THEN
    SELECT * INTO v_mensaje FROM hub_cleber.mensajes WHERE id_mensaje_proveedor = v_id_prov;
    IF v_mensaje.id_mensaje IS NOT NULL THEN
      RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
        'mensaje', hub_cleber.mensaje_json(v_mensaje), 'conversacion', hub_cleber.conversacion_json(v_conv), 'duplicado', true));
    END IF;
  END IF;

  INSERT INTO hub_cleber.mensajes (id_conversacion, remitente, id_agente, texto, media_url, id_mensaje_proveedor)
  VALUES (v_conv.id_conversacion, 'agent', v_actor.id_usuario, v_texto, v_media, v_id_prov)
  RETURNING * INTO v_mensaje;

  UPDATE hub_cleber.conversaciones SET
    ultimo_mensaje_en    = v_mensaje.creado_en,
    ultimo_mensaje_texto = coalesce(left(v_texto, 100), '📎 Archivo adjunto'),
    ultimo_remitente     = 'agent',
    -- En un UPDATE el lado derecho lee los valores anteriores: la espera efectiva se calcula aquí mismo
    estado               = CASE WHEN estado = 'closed' THEN estado ELSE 'with_agent' END,
    id_agente            = CASE WHEN estado = 'closed' THEN id_agente ELSE coalesce(id_agente, v_actor.id_usuario) END,
    asignada_en          = CASE WHEN estado = 'closed' THEN asignada_en ELSE coalesce(asignada_en, now()) END,
    espera_desde         = coalesce(espera_desde, CASE WHEN estado = 'waiting_agent' THEN ultimo_mensaje_en END),
    primera_respuesta_en = CASE WHEN primera_respuesta_en IS NULL AND coalesce(espera_desde, CASE WHEN estado = 'waiting_agent' THEN ultimo_mensaje_en END) IS NOT NULL THEN now() ELSE primera_respuesta_en END,
    tiempos_respuesta    = CASE WHEN primera_respuesta_en IS NULL AND coalesce(espera_desde, CASE WHEN estado = 'waiting_agent' THEN ultimo_mensaje_en END) IS NOT NULL
                                THEN tiempos_respuesta || greatest(0, round(extract(epoch FROM now() - coalesce(espera_desde, CASE WHEN estado = 'waiting_agent' THEN ultimo_mensaje_en END))))::integer
                                ELSE tiempos_respuesta END,
    actualizado_en = now(), version = version + 1
  WHERE id_conversacion = v_conv.id_conversacion
  RETURNING * INTO v_conv;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
    'mensaje', hub_cleber.mensaje_json(v_mensaje), 'conversacion', hub_cleber.conversacion_json(v_conv), 'duplicado', false));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
