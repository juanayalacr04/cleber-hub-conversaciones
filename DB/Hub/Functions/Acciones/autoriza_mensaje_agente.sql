/**
    Hub.autorizaMensajeAgente — dashboard, vía backend (cualquier rol que escribe; si está with_agent, su asesor o
    un administrador)

    Paso 1 del mensaje del asesor: el backend la llama con el token del usuario ANTES de mandar el mensaje al
    proveedor, para no enviar nada que el usuario no pueda escribir. Regresa lo necesario para el envío.
    Paso 2: Hub.registraMensajeAgente, cuando el proveedor ya aceptó el mensaje.
    Params: idConversacion (string)
    Info: { conversacion: Conversacion, numero: Numero }
    Errores: ESTADO_INVALIDO (motivo ESTADO_ACTUAL) si está cerrada.

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.autoriza_mensaje_agente(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params jsonb;
  v_actor  hub_cleber.usuarios;
  v_conv   hub_cleber.conversaciones;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.autorizaMensajeAgente');
  v_actor  := hub_cleber.usuario_actual();

  v_conv := hub_cleber.busca_conversacion(v_actor, hub_cleber.param_texto(v_params, 'idConversacion'));
  PERFORM hub_cleber.exige_operar(v_actor, v_conv);
  PERFORM hub_cleber.exige_estado(v_conv, ARRAY['bot', 'waiting_agent', 'with_agent']);

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
    'conversacion', hub_cleber.conversacion_json(v_conv),
    'numero', (SELECT hub_cleber.numero_json(n) FROM hub_cleber.numeros n WHERE n.id_numero = v_conv.id_numero)));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
