/**
    Hub.asignaAgenteAutomatico — sistema (pipeline de entrada, al pasar la conversación a asesor)

    Si el equipo de la conversación asigna en automático, elige un asesor y le asigna la conversación (pasa a
    with_agent). Mismas reglas que el hub anterior (cleber-bot-platform main.py::auto_assign_agent):

      Candidatos   usuarios activos y disponibles (es_disponible), no de sistema, con un rol en el módulo de la marca que
                   escribe (no CONSULTA), cuyo equipo en el módulo es el de la conversación y, si la conversación tiene
                   agencia, que la tengan entre sus agencias de la marca.
      Tope         si el equipo tiene max_conversaciones_agente, queda fuera quien ya tiene esas conversaciones with_agent.
      round_robin  por id; el siguiente después de equipos.ultimo_agente_asignado. Si ese ya no es candidato, sigue desde
                   donde caería en el orden (no reinicia en el primero).
      least_busy   el que tiene menos conversaciones with_agent (en todas las marcas); empate, por id.

    El equipo se bloquea (FOR UPDATE): dos pasos a asesor simultáneos no toman el mismo turno.
    No cambia nada (idAgente null) si la conversación no está en waiting_agent, no tiene equipo activo, el equipo es
    manual (u otro modo) o no hay candidatos: queda esperando a que la tomen.

    Params: idConversacion (string)
    Info: { conversacion, idAgente (uuid | null), modo (string | null) }

    @Acceso Publica (sistema)
*/
CREATE OR REPLACE FUNCTION hub_cleber.asigna_agente_automatico(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params jsonb;
  v_actor  hub_cleber.usuarios;
  v_conv   hub_cleber.conversaciones;
  v_equipo hub_cleber.equipos;
  v_agente uuid;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.asignaAgenteAutomatico');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_sistema(v_actor);

  v_conv := hub_cleber.busca_conversacion(v_actor, hub_cleber.param_texto(v_params, 'idConversacion'), true);
  IF v_conv.id_equipo IS NOT NULL THEN
    SELECT * INTO v_equipo FROM hub_cleber.equipos WHERE id_equipo = v_conv.id_equipo AND es_activo FOR UPDATE;
  END IF;

  IF v_conv.estado <> 'waiting_agent' OR v_equipo.id_equipo IS NULL
     OR v_equipo.modo_asignacion NOT IN ('round_robin', 'least_busy') THEN
    RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
      'conversacion', hub_cleber.conversacion_json(v_conv), 'idAgente', NULL, 'modo', v_equipo.modo_asignacion));
  END IF;

  WITH candidatos AS (
    SELECT u.id_usuario,
           (SELECT count(*) FROM hub_cleber.conversaciones c
             WHERE c.id_agente = u.id_usuario AND c.estado = 'with_agent') AS carga
      FROM hub_cleber.usuarios u
      JOIN hub_cleber.usuarios_roles_modulo rm
        ON rm.id_usuario = u.id_usuario AND rm.id_marca = v_conv.id_marca AND rm.modulo = v_conv.modulo
      JOIN hub_cleber.usuarios_marcas um
        ON um.id_usuario = u.id_usuario AND um.id_marca = v_conv.id_marca
     WHERE u.es_activo AND u.es_disponible AND NOT u.es_sistema
       AND rm.rol <> 'CONSULTA' AND rm.id_equipo = v_equipo.id_equipo
       AND (v_conv.id_agencia IS NULL OR v_conv.id_agencia = ANY (um.agencias))
  )
  SELECT c.id_usuario INTO v_agente
    FROM candidatos c
   WHERE v_equipo.max_conversaciones_agente IS NULL OR c.carga < v_equipo.max_conversaciones_agente
   ORDER BY
     -- round robin: primero los que van después del último asignado (false antes que true), y en orden de id
     CASE WHEN v_equipo.modo_asignacion = 'round_robin' THEN
       (v_equipo.ultimo_agente_asignado IS NOT NULL AND c.id_usuario::text <= v_equipo.ultimo_agente_asignado::text)
     END,
     CASE WHEN v_equipo.modo_asignacion = 'least_busy' THEN c.carga END,
     c.id_usuario::text
   LIMIT 1;

  IF v_agente IS NULL THEN
    RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
      'conversacion', hub_cleber.conversacion_json(v_conv), 'idAgente', NULL, 'modo', v_equipo.modo_asignacion));
  END IF;

  UPDATE hub_cleber.conversaciones SET
    estado = 'with_agent', id_agente = v_agente, asignada_en = now(),
    espera_desde = ultimo_mensaje_en, primera_respuesta_en = NULL,
    actualizado_en = now(), version = version + 1
  WHERE id_conversacion = v_conv.id_conversacion
  RETURNING * INTO v_conv;

  UPDATE hub_cleber.equipos SET ultimo_agente_asignado = v_agente WHERE id_equipo = v_equipo.id_equipo;

  INSERT INTO hub_cleber.bitacora (id_conversacion, accion, origen, id_usuario, datos)
  VALUES (v_conv.id_conversacion, 'asigna_agente_automatico', 'sistema', NULL,
          jsonb_build_object('idAgente', v_agente, 'modo', v_equipo.modo_asignacion, 'idEquipo', v_equipo.id_equipo));

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
    'conversacion', hub_cleber.conversacion_json(v_conv), 'idAgente', v_agente, 'modo', v_equipo.modo_asignacion));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
