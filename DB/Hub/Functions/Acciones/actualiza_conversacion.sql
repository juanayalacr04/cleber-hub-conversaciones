/**
    Hub.actualizaConversacion — sistema (pipeline, acciones del bot, jobs)

    Cambia el estado y los datos de una conversación. Solo se tocan los campos que vienen; en los que admiten null,
    mandar null los limpia. Las operaciones del dashboard (tomar, cerrar, transferir) van en acciones propias con
    permisos de usuario.

    Params (además de idConversacion):
      estado? (string)                 bot / waiting_agent / with_agent / closed
                                       closed: guarda estado y agente previos (para la reapertura) y sella cerrada_en
      cierreManual? (boolean)          con closed: la conversación no se reabre (p. ej. /reset)
      idAgente? (uuid | null)
      idEquipo? (string | null)        del mismo módulo y marca
      idBot? (string | null)           bot activo (cambio de bot); del mismo módulo y marca
      idSesionBot? (string | null)     abacusConversationId
      nombreCliente?, claveCliente? (string | null)
      motivoHandoff? (string | null)
      resultado? (string | null)       sella resultado_en
      prioridad? (string)
      etiquetas? (string[])            reemplaza la lista
      recordatoriosInactividad? (number)
      ultimaPlantillaEn? (string ISO | null)
      metadatos? (object)              se MEZCLA con los actuales (una llave de primer nivel con null la borra)
      versionEsperada? (number)        si viene y no coincide → CONFLICTO_VERSION (info.version)
    Info: { conversacion: Conversacion, anterior: { estado, idAgente } }

    @Acceso Publica (sistema)
*/
CREATE OR REPLACE FUNCTION hub_cleber.actualiza_conversacion(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params jsonb;
  v_actor  hub_cleber.usuarios;
  v_conv   hub_cleber.conversaciones;
  v_ant    hub_cleber.conversaciones;
  v_estado text;
  v_equipo text;
  v_bot    text;
  v_meta   jsonb;
  v_version integer;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.actualizaConversacion');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_sistema(v_actor);

  v_conv := hub_cleber.busca_conversacion(v_actor, hub_cleber.param_texto(v_params, 'idConversacion'), true);
  v_ant  := v_conv;

  v_version := hub_cleber.param_entero(v_params, 'versionEsperada', false, 1, 2147483647);
  IF v_version IS NOT NULL AND v_version <> v_conv.version THEN
    PERFORM hub_cleber.error_de_aplicacion('CONFLICTO_VERSION', 'La conversación cambió mientras tanto',
      jsonb_build_object('version', v_conv.version));
  END IF;

  v_estado := hub_cleber.param_opcion(v_params, 'estado', ARRAY['bot', 'waiting_agent', 'with_agent', 'closed'], false);
  v_equipo := hub_cleber.param_texto(v_params, 'idEquipo', false);
  v_bot    := hub_cleber.param_texto(v_params, 'idBot', false);
  v_meta   := hub_cleber.param_objeto(v_params, 'metadatos', false);
  PERFORM hub_cleber.valida_equipo(v_equipo, v_conv.id_marca, v_conv.modulo);
  PERFORM hub_cleber.valida_bot(v_bot, v_conv.id_marca, v_conv.modulo);

  -- Reabrir por aquí no puede romper la regla de una abierta por número + cliente.
  -- La reapertura normal es la de Hub.obtieneOAbreConversacion.
  IF v_conv.estado = 'closed' AND v_estado IS NOT NULL AND v_estado <> 'closed' THEN
    PERFORM hub_cleber.bloquea_cliente_numero(v_conv.id_numero, v_conv.telefono_cliente);
    IF EXISTS (SELECT 1 FROM hub_cleber.conversaciones
                WHERE id_numero = v_conv.id_numero AND telefono_cliente = v_conv.telefono_cliente AND estado <> 'closed') THEN
      PERFORM hub_cleber.error_de_aplicacion('ESTADO_INVALIDO', 'El cliente ya tiene otra conversación abierta en el número',
        jsonb_build_object('motivo', 'CONVERSACION_ABIERTA'));
    END IF;
  END IF;

  UPDATE hub_cleber.conversaciones c SET
    estado              = coalesce(v_estado, c.estado),
    estado_antes_cierre = CASE WHEN v_estado = 'closed' AND c.estado <> 'closed' THEN c.estado ELSE c.estado_antes_cierre END,
    agente_antes_cierre = CASE WHEN v_estado = 'closed' AND c.estado <> 'closed' THEN c.id_agente ELSE c.agente_antes_cierre END,
    cerrada_en          = CASE WHEN v_estado = 'closed' THEN now()
                               WHEN v_estado IS NOT NULL THEN NULL ELSE c.cerrada_en END,
    cierre_manual       = CASE WHEN v_estado = 'closed' THEN coalesce(hub_cleber.param_booleano(v_params, 'cierreManual', false), false)
                               WHEN v_estado IS NOT NULL THEN false ELSE c.cierre_manual END,
    id_agente           = CASE WHEN v_params ? 'idAgente' THEN hub_cleber.param_uuid(v_params, 'idAgente', false) ELSE c.id_agente END,
    id_equipo           = CASE WHEN v_params ? 'idEquipo' THEN v_equipo ELSE c.id_equipo END,
    id_bot              = CASE WHEN v_params ? 'idBot' THEN v_bot ELSE c.id_bot END,
    id_sesion_bot       = CASE WHEN v_params ? 'idSesionBot' THEN hub_cleber.param_texto(v_params, 'idSesionBot', false) ELSE c.id_sesion_bot END,
    nombre_cliente      = CASE WHEN v_params ? 'nombreCliente' THEN hub_cleber.param_texto(v_params, 'nombreCliente', false) ELSE c.nombre_cliente END,
    clave_cliente       = CASE WHEN v_params ? 'claveCliente' THEN hub_cleber.param_texto(v_params, 'claveCliente', false) ELSE c.clave_cliente END,
    motivo_handoff      = CASE WHEN v_params ? 'motivoHandoff' THEN hub_cleber.param_texto(v_params, 'motivoHandoff', false) ELSE c.motivo_handoff END,
    resultado           = CASE WHEN v_params ? 'resultado' THEN hub_cleber.param_texto(v_params, 'resultado', false) ELSE c.resultado END,
    resultado_en        = CASE WHEN v_params ? 'resultado' THEN
                                 CASE WHEN hub_cleber.param_texto(v_params, 'resultado', false) IS NULL THEN NULL ELSE now() END
                               ELSE c.resultado_en END,
    prioridad           = coalesce(hub_cleber.param_texto(v_params, 'prioridad', false), c.prioridad),
    etiquetas           = coalesce(hub_cleber.param_textos(v_params, 'etiquetas', false), c.etiquetas),
    recordatorios_inactividad = coalesce(hub_cleber.param_entero(v_params, 'recordatoriosInactividad', false, 0, 1000), c.recordatorios_inactividad),
    ultima_plantilla_en = CASE WHEN v_params ? 'ultimaPlantillaEn' THEN hub_cleber.param_fecha_hora(v_params, 'ultimaPlantillaEn', false) ELSE c.ultima_plantilla_en END,
    metadatos           = CASE WHEN v_meta IS NULL THEN c.metadatos
                               ELSE (c.metadatos || v_meta) - ARRAY(SELECT k FROM jsonb_each(v_meta) AS e(k, v) WHERE v = 'null'::jsonb) END,
    actualizado_en      = now(),
    version             = c.version + 1
  WHERE c.id_conversacion = v_conv.id_conversacion
  RETURNING * INTO v_conv;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
    'conversacion', hub_cleber.conversacion_json(v_conv),
    'anterior', jsonb_build_object('estado', v_ant.estado, 'idAgente', v_ant.id_agente)));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
