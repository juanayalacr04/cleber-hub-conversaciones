/**
    Hub.consultaConversaciones — dashboard (bandeja y kanban) o sistema

    Conversaciones de un módulo en una marca, de la más reciente a la más vieja (por último mensaje), con los
    permisos por equipo y agencia de ve_conversacion: el administrador del módulo ve todas; los demás, las de su equipo
    y, si la conversación tiene agencia, solo las de sus agencias.

    Params:
      idMarca, modulo (string)
      estados? (string[])        bot / waiting_agent / with_agent / closed; default: las abiertas
      idEquipo? (string)
      idAgente? (uuid)           solo las asignadas a ese agente
      busqueda? (string)         parte del teléfono o del nombre del cliente
      antesDe? (string ISO)      paginación: ultimoMensajeEn de la última que ya se tiene
      limite? (number)           1..200, default 50
    Info: { conversaciones: [Conversacion], hayMas: boolean }

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.consulta_conversaciones(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params   jsonb;
  v_actor    hub_cleber.usuarios;
  v_marca    text;
  v_modulo   text;
  v_estados  text[];
  v_equipo   text;
  v_agente   uuid;
  v_busqueda text;
  v_antes    timestamptz;
  v_limite   integer;
  v_visibles text[];
  v_agencias text[];
  v_lista    jsonb;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.consultaConversaciones');
  v_actor  := hub_cleber.usuario_actual();
  v_marca  := upper(hub_cleber.param_texto(v_params, 'idMarca'));
  v_modulo := hub_cleber.param_modulo(v_params);
  PERFORM hub_cleber.exige_modulo(v_actor, v_marca, v_modulo);

  v_estados  := coalesce(hub_cleber.param_textos(v_params, 'estados', false), ARRAY['bot', 'waiting_agent', 'with_agent']);
  IF NOT v_estados <@ ARRAY['bot', 'waiting_agent', 'with_agent', 'closed'] THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'estados solo admite bot, waiting_agent, with_agent y closed', '{"campo":"estados"}');
  END IF;
  v_equipo   := hub_cleber.param_texto(v_params, 'idEquipo', false);
  v_agente   := hub_cleber.param_uuid(v_params, 'idAgente', false);
  v_busqueda := hub_cleber.param_texto(v_params, 'busqueda', false);
  v_antes    := hub_cleber.param_fecha_hora(v_params, 'antesDe', false);
  v_limite   := coalesce(hub_cleber.param_entero(v_params, 'limite', false, 1, 200), 50);
  v_visibles := hub_cleber.equipos_visibles(v_actor, v_marca, v_modulo);
  v_agencias := hub_cleber.agencias_visibles(v_actor, v_marca, v_modulo);

  SELECT coalesce(jsonb_agg(hub_cleber.conversacion_json(c) ORDER BY c.ultimo_mensaje_en DESC, c.id_conversacion), '[]')
    INTO v_lista
    FROM hub_cleber.conversaciones c
   WHERE c.id_conversacion IN (
          SELECT c.id_conversacion FROM hub_cleber.conversaciones c
           WHERE c.id_marca = v_marca AND c.modulo = v_modulo
             AND c.estado = ANY (v_estados)
             AND (v_visibles IS NULL OR c.id_equipo = ANY (v_visibles))
             AND (c.id_agencia IS NULL OR v_agencias IS NULL OR c.id_agencia = ANY (v_agencias))
             AND (v_equipo IS NULL OR c.id_equipo = v_equipo)
             AND (v_agente IS NULL OR c.id_agente = v_agente)
             AND (v_antes IS NULL OR c.ultimo_mensaje_en < v_antes)
             AND (v_busqueda IS NULL
                  OR c.telefono_cliente LIKE '%' || regexp_replace(v_busqueda, '\D', '', 'g') || '%' AND regexp_replace(v_busqueda, '\D', '', 'g') <> ''
                  OR c.nombre_cliente ILIKE '%' || v_busqueda || '%')
           ORDER BY c.ultimo_mensaje_en DESC, c.id_conversacion
           LIMIT v_limite + 1);

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
    'conversaciones', CASE WHEN jsonb_array_length(v_lista) > v_limite THEN v_lista - v_limite ELSE v_lista END,
    'hayMas', jsonb_array_length(v_lista) > v_limite));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
