/**
    Hub.agregaNota — dashboard (cualquier rol que escribe; si está with_agent, su asesor o un administrador)

    Nota interna en la conversación (no la ve el cliente). No cambia la versión de la conversación.
    Params: idConversacion (string), texto (string, hasta 4000)
    Info: { nota: Nota }

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.agrega_nota(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params jsonb;
  v_actor  hub_cleber.usuarios;
  v_conv   hub_cleber.conversaciones;
  v_nota hub_cleber.notas;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.agregaNota');
  v_actor  := hub_cleber.usuario_actual();

  v_conv := hub_cleber.busca_conversacion(v_actor, hub_cleber.param_texto(v_params, 'idConversacion'));
  PERFORM hub_cleber.exige_operar(v_actor, v_conv);

  INSERT INTO hub_cleber.notas (id_conversacion, id_autor, nombre_autor, texto)
  VALUES (v_conv.id_conversacion, v_actor.id_usuario, coalesce(nullif(v_actor.nombre, ''), v_actor.email),
          left(hub_cleber.param_texto(v_params, 'texto'), 4000))
  RETURNING * INTO v_nota;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('nota', hub_cleber.nota_json(v_nota)));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
