/**
    Hub.autorizaCanal — authorizer de AppSync Events (tiempo real)

    ¿El usuario de la petición puede escuchar este canal? La llama el authorizer genérico de AppSync
    (infra/authorizer-appsync) con el email del id_token de Google ya validado en X-User-Email, cuando una pantalla se
    suscribe a un canal del namespace `hub` (DISENO_BACKEND_AWS.md §6). Los avisos no traen datos (solo dicen "esto
    cambió"), pero aun así solo se escuchan los canales que el usuario podría consultar:

      /hub/<idMarca>/<modulo>                    bandeja: tiene rol en el módulo de la marca (tiene_modulo)
      /hub/<idMarca>/<modulo>/<idConversacion>   chat: además ve esa conversación (ve_conversacion)

    Un canal mal formado, de otro namespace o al que no tiene acceso regresa autorizado = false (no es un error).
    Un usuario no registrado o inactivo falla con SIN_PERMISO (usuario_actual); el authorizer lo trata como rechazo.

    Params:
      canal (string)
      operacion? (string)    EVENT_SUBSCRIBE (default) o EVENT_PUBLISH; publicar solo lo hace el backend (IAM): false
    Info: { autorizado: boolean, motivo: string | null }

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.autoriza_canal(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params    jsonb;
  v_actor     hub_cleber.usuarios;
  v_canal     text;
  v_operacion text;
  v_partes    text[];
  v_marca     text;
  v_modulo    text;
  v_conv      hub_cleber.conversaciones;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params    := hub_cleber.valida_peticion(peticion, 'Hub.autorizaCanal');
  v_actor     := hub_cleber.usuario_actual();
  v_canal     := hub_cleber.param_texto(v_params, 'canal');
  v_operacion := coalesce(hub_cleber.param_texto(v_params, 'operacion', false), 'EVENT_SUBSCRIBE');

  IF v_operacion <> 'EVENT_SUBSCRIBE' THEN
    RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('autorizado', false, 'motivo', 'OPERACION_NO_PERMITIDA'));
  END IF;

  -- '/hub/TOYOTA/valuacion/abc' → {hub, TOYOTA, valuacion, abc}
  v_partes := string_to_array(btrim(v_canal, '/'), '/');
  IF v_partes[1] IS DISTINCT FROM 'hub' OR cardinality(v_partes) NOT IN (3, 4) THEN
    RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('autorizado', false, 'motivo', 'CANAL_INVALIDO'));
  END IF;
  v_marca  := upper(v_partes[2]);
  v_modulo := lower(v_partes[3]);
  IF v_modulo NOT IN ('ventas', 'servicio', 'valuacion') THEN
    RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('autorizado', false, 'motivo', 'CANAL_INVALIDO'));
  END IF;

  IF NOT hub_cleber.tiene_modulo(v_actor, v_marca, v_modulo) THEN
    RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('autorizado', false, 'motivo', 'SIN_ACCESO_MODULO'));
  END IF;

  IF cardinality(v_partes) = 4 THEN
    SELECT * INTO v_conv FROM hub_cleber.conversaciones
     WHERE id_conversacion = v_partes[4] AND id_marca = v_marca AND modulo = v_modulo;
    IF v_conv.id_conversacion IS NULL OR NOT hub_cleber.ve_conversacion(v_actor, v_conv) THEN
      RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('autorizado', false, 'motivo', 'SIN_ACCESO_CONVERSACION'));
    END IF;
  END IF;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('autorizado', true, 'motivo', NULL));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
