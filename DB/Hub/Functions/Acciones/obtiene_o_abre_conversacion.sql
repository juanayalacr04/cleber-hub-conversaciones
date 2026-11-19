/**
    Hub.obtieneOAbreConversacion — sistema (pipeline de mensajes entrantes)

    Conversación del cliente en un número: la abierta, una cerrada reciente reabierta, o una nueva. Es la lógica de
    core/conversations.py::get_or_create_conversation, ahora atómica (bloqueo por número + cliente):

      1. Abierta: si su último mensaje es de hace más de horasSesion, se cierra y se abre una nueva; si no, se usa.
      2. Cerrada reciente: la última cerrada del número + cliente se reabre si no fue cierre manual y se cerró hace
         menos de numeros.ventana_reapertura_horas. Si al cerrarse la traía un asesor (estado_antes_cierre), vuelve
         con él; si no, vuelve al bot. El resultado "inactividad" se limpia.
      3. Nueva: con la marca, el módulo, el equipo y el bot default del número, y la agencia de la última conversación
         del cliente en el número (si tenía).

    Params:
      idNumero (string)
      telefonoCliente (string)          se normaliza a E.164
      nombreCliente? (string)           se guarda si la conversación no tiene
      claveCliente? (string)            clientes.clientes, por valor
      horasSesion? (number)             1..720, default 24
      limiteHistorial? (number)         0..200, default 40: últimos mensajes para el bot (incluye los de sistema,
                                        p. ej. el <<CONTEXTO>> del contrato ①)
    Info: { conversacion: Conversacion, origen: "abierta" | "reabierta" | "nueva", historial: [Mensaje] (cronológico) }

    @Acceso Publica (sistema)
*/
CREATE OR REPLACE FUNCTION hub_cleber.obtiene_o_abre_conversacion(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params   jsonb;
  v_actor    hub_cleber.usuarios;
  v_numero   hub_cleber.numeros;
  v_telefono text;
  v_nombre   text;
  v_clave    text;
  v_horas    integer;
  v_limite   integer;
  v_conv     hub_cleber.conversaciones;
  v_cerrada  hub_cleber.conversaciones;
  v_origen   text;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.obtieneOAbreConversacion');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_sistema(v_actor);

  SELECT * INTO v_numero FROM hub_cleber.numeros WHERE id_numero = hub_cleber.param_texto(v_params, 'idNumero');
  IF v_numero.id_numero IS NULL THEN
    PERFORM hub_cleber.error_de_aplicacion('RECURSO_NO_ENCONTRADO', 'El número no existe', '{"campo":"idNumero"}');
  END IF;
  v_telefono := hub_cleber.param_telefono(v_params, 'telefonoCliente');
  v_nombre   := hub_cleber.param_texto(v_params, 'nombreCliente', false);
  v_clave    := hub_cleber.param_texto(v_params, 'claveCliente', false);
  v_horas    := coalesce(hub_cleber.param_entero(v_params, 'horasSesion', false, 1, 720), 24);
  v_limite   := coalesce(hub_cleber.param_entero(v_params, 'limiteHistorial', false, 0, 200), 40);

  PERFORM hub_cleber.bloquea_cliente_numero(v_numero.id_numero, v_telefono);

  -- 1. Abierta
  SELECT * INTO v_conv FROM hub_cleber.conversaciones
   WHERE id_numero = v_numero.id_numero AND telefono_cliente = v_telefono AND estado <> 'closed'
   FOR UPDATE;

  IF v_conv.id_conversacion IS NOT NULL AND v_conv.ultimo_mensaje_en < now() - make_interval(hours => v_horas) THEN
    -- La sesión expiró: se cierra y se abre una nueva
    UPDATE hub_cleber.conversaciones SET
      estado_antes_cierre = estado, agente_antes_cierre = id_agente,
      estado = 'closed', cerrada_en = now(), actualizado_en = now(), version = version + 1
    WHERE id_conversacion = v_conv.id_conversacion;
    v_conv := NULL;
    v_origen := 'nueva';
  ELSIF v_conv.id_conversacion IS NOT NULL THEN
    v_origen := 'abierta';
  ELSE
    -- 2. Cerrada reciente
    IF v_numero.ventana_reapertura_horas > 0 THEN
      SELECT * INTO v_cerrada FROM hub_cleber.conversaciones
       WHERE id_numero = v_numero.id_numero AND telefono_cliente = v_telefono AND estado = 'closed'
       ORDER BY cerrada_en DESC NULLS LAST
       LIMIT 1
       FOR UPDATE;
      IF v_cerrada.id_conversacion IS NOT NULL AND NOT v_cerrada.cierre_manual
         AND v_cerrada.cerrada_en > now() - make_interval(hours => v_numero.ventana_reapertura_horas) THEN
        UPDATE hub_cleber.conversaciones SET
          estado       = CASE WHEN estado_antes_cierre IN ('with_agent', 'waiting_agent') THEN estado_antes_cierre ELSE 'bot' END,
          id_agente    = CASE WHEN estado_antes_cierre IN ('with_agent', 'waiting_agent') THEN agente_antes_cierre END,
          resultado    = CASE WHEN resultado = 'inactividad' THEN NULL ELSE resultado END,
          resultado_en = CASE WHEN resultado = 'inactividad' THEN NULL ELSE resultado_en END,
          cerrada_en   = NULL,
          actualizado_en = now(), version = version + 1
        WHERE id_conversacion = v_cerrada.id_conversacion
        RETURNING * INTO v_conv;
        v_origen := 'reabierta';
      END IF;
    END IF;
    v_origen := coalesce(v_origen, 'nueva');
  END IF;

  -- 3. Nueva
  IF v_origen = 'nueva' THEN
    -- La agencia sale de la última conversación del cliente en el número (p. ej. la de su oferta de Valuación): así la
    -- sigue viendo el valuador de esa agencia
    INSERT INTO hub_cleber.conversaciones (id_marca, modulo, id_numero, id_equipo, id_bot, direccion,
                                           telefono_cliente, nombre_cliente, clave_cliente, id_agencia)
    VALUES (v_numero.id_marca, v_numero.modulo, v_numero.id_numero, v_numero.id_equipo, v_numero.id_bot_default, 'inbound',
            v_telefono, v_nombre, v_clave,
            (SELECT c.id_agencia FROM hub_cleber.conversaciones c
              WHERE c.id_numero = v_numero.id_numero AND c.telefono_cliente = v_telefono AND c.id_agencia IS NOT NULL
              ORDER BY c.creado_en DESC LIMIT 1))
    RETURNING * INTO v_conv;
  ELSIF (v_nombre IS NOT NULL AND v_conv.nombre_cliente IS NULL) OR (v_clave IS NOT NULL AND v_conv.clave_cliente IS NULL) THEN
    UPDATE hub_cleber.conversaciones SET
      nombre_cliente = coalesce(nombre_cliente, v_nombre),
      clave_cliente  = coalesce(clave_cliente, v_clave),
      actualizado_en = now(), version = version + 1
    WHERE id_conversacion = v_conv.id_conversacion
    RETURNING * INTO v_conv;
  END IF;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
    'conversacion', hub_cleber.conversacion_json(v_conv),
    'origen',       v_origen,
    'historial',    coalesce((SELECT jsonb_agg(hub_cleber.mensaje_json(h) ORDER BY h.id_mensaje)
                                FROM hub_cleber.mensajes h
                               WHERE h.id_mensaje IN (SELECT m.id_mensaje FROM hub_cleber.mensajes m
                                                       WHERE m.id_conversacion = v_conv.id_conversacion
                                                       ORDER BY m.id_mensaje DESC
                                                       LIMIT v_limite)), '[]')));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
