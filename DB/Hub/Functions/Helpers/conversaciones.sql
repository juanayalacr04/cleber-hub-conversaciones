/**
    Helpers de configuración (equipos, números, bots) y conversaciones: parámetros, permisos por módulo y forma JSON.

    Permisos por módulo (mismo criterio que canAccessTeam de las reglas de Firestore, ahora por marca y módulo):
      - Super admin y sistema: todo.
      - Con rol de administrador del módulo en la marca: todas las conversaciones del módulo en la marca.
      - Con otro rol del módulo: solo las conversaciones de su equipo en ese módulo.
      - Sin rol en el módulo de la marca: nada.

    @Acceso No-Publica
*/

-- Teléfono en E.164. Los de México con la regla de clientes.normaliza_telefono (+52 + 10 dígitos);
-- otros países se aceptan si ya vienen con 8 a 15 dígitos. Quita el prefijo "whatsapp:". NULL si no se puede.
CREATE OR REPLACE FUNCTION hub_cleber.telefono_e164(p_telefono text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_limpio  text := regexp_replace(coalesce(p_telefono, ''), '^\s*whatsapp:', '', 'i');
  v_mx      text := clientes.normaliza_telefono(v_limpio);
  v_digitos text := regexp_replace(v_limpio, '\D', '', 'g');
BEGIN
  IF v_mx IS NOT NULL THEN
    RETURN v_mx;
  END IF;
  IF btrim(v_limpio) ~ '^\+[0-9 ()-]+$' AND length(v_digitos) BETWEEN 8 AND 15 THEN
    RETURN '+' || v_digitos;
  END IF;
  RETURN NULL;
END;
$$;

-- Teléfono de un NÚMERO propio (el remitente de WhatsApp), tal como está registrado en el proveedor: no se le aplica la
-- regla de México de clientes.normaliza_telefono, que quita el 1 de +521… (Twilio rechaza el envío si el From no es
-- exactamente el remitente registrado: error 63007). Quita "whatsapp:", espacios, guiones y paréntesis.
--   +5215512345678 → +5215512345678 · 5512345678 → +525512345678 · 5215512345678 → +5215512345678
CREATE OR REPLACE FUNCTION hub_cleber.telefono_numero(p_telefono text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_limpio  text := btrim(regexp_replace(coalesce(p_telefono, ''), '^\s*whatsapp:', '', 'i'));
  v_digitos text := regexp_replace(v_limpio, '\D', '', 'g');
BEGIN
  IF v_limpio !~ '^\+?[0-9 ()-]+$' THEN
    RETURN NULL;
  END IF;
  IF left(v_limpio, 1) <> '+' AND length(v_digitos) = 10 THEN
    RETURN '+52' || v_digitos;              -- 10 dígitos sin código de país: México
  END IF;
  IF length(v_digitos) BETWEEN 8 AND 15 THEN
    RETURN '+' || v_digitos;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION hub_cleber.param_telefono_numero(p_params jsonb, p_campo text, p_requerido boolean DEFAULT true)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_texto    text := hub_cleber.param_texto(p_params, p_campo, p_requerido);
  v_telefono text := hub_cleber.telefono_numero(v_texto);
BEGIN
  IF v_texto IS NOT NULL AND v_telefono IS NULL THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('El campo %s debe ser un teléfono (+código de país y número)', p_campo),
      jsonb_build_object('campo', p_campo));
  END IF;
  RETURN v_telefono;
END;
$$;

-- Teléfono de un CLIENTE, requerido u opcional, en E.164 (regla de México de clientes).
CREATE OR REPLACE FUNCTION hub_cleber.param_telefono(p_params jsonb, p_campo text, p_requerido boolean DEFAULT true)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_texto    text := hub_cleber.param_texto(p_params, p_campo, p_requerido);
  v_telefono text := hub_cleber.telefono_e164(v_texto);
BEGIN
  IF v_texto IS NOT NULL AND v_telefono IS NULL THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('El campo %s debe ser un teléfono (10 dígitos o +código de país)', p_campo),
      jsonb_build_object('campo', p_campo));
  END IF;
  RETURN v_telefono;
END;
$$;

-- Texto de un catálogo cerrado (CAMPO_INVALIDO si no está entre los valores).
CREATE OR REPLACE FUNCTION hub_cleber.param_opcion(p_params jsonb, p_campo text, p_opciones text[], p_requerido boolean DEFAULT true)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_valor text := hub_cleber.param_texto(p_params, p_campo, p_requerido);
BEGIN
  IF v_valor IS NOT NULL AND NOT v_valor = ANY (p_opciones) THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('El campo %s debe ser uno de: %s', p_campo, array_to_string(p_opciones, ', ')),
      jsonb_build_object('campo', p_campo));
  END IF;
  RETURN v_valor;
END;
$$;

-- ¿Un objeto de configuración trae credenciales? Van en Secrets Manager, nunca en la base.
CREATE OR REPLACE FUNCTION hub_cleber.contiene_secretos(p_config jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(p_config::text, '') ~* '"(deploymentToken|apiKey|authToken|accessToken|twilioAuthToken|metaAccessToken|metaWebhookVerifyToken|password|secret)"\s*:';
$$;

CREATE OR REPLACE FUNCTION hub_cleber.exige_sin_secretos(p_config jsonb, p_campo text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF hub_cleber.contiene_secretos(p_config) THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO',
      format('El campo %s trae credenciales; se guardan aparte (Secrets Manager)', p_campo), jsonb_build_object('campo', p_campo));
  END IF;
END;
$$;

-- ¿Tiene algún rol en el módulo de la marca? Super admin y sistema: sí.
CREATE OR REPLACE FUNCTION hub_cleber.tiene_modulo(p_usuario hub_cleber.usuarios, p_id_marca text, p_modulo text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce((p_usuario).es_super_admin, false)
      OR coalesce((p_usuario).es_sistema, false)
      OR hub_cleber.rol_modulo(p_usuario, p_id_marca, p_modulo) IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION hub_cleber.exige_modulo(p_usuario hub_cleber.usuarios, p_id_marca text, p_modulo text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT hub_cleber.tiene_modulo(p_usuario, p_id_marca, p_modulo) THEN
    PERFORM hub_cleber.error_de_aplicacion('SIN_PERMISO', format('Sin acceso al módulo %s en la marca %s', p_modulo, p_id_marca),
      jsonb_build_object('idMarca', p_id_marca, 'modulo', p_modulo));
  END IF;
END;
$$;

-- Administrar la configuración de un módulo: administrador del módulo en la marca o super admin. El sistema también
-- (importación).
CREATE OR REPLACE FUNCTION hub_cleber.exige_configurar_modulo(p_usuario hub_cleber.usuarios, p_id_marca text, p_modulo text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT coalesce((p_usuario).es_sistema, false) THEN
    PERFORM hub_cleber.exige_administrador_modulo(p_usuario, p_id_marca, p_modulo);
  END IF;
END;
$$;

-- Equipos cuyas conversaciones ve el usuario en el módulo de la marca. NULL = todas (super admin, sistema,
-- administrador del módulo); '{}' = ninguna.
CREATE OR REPLACE FUNCTION hub_cleber.equipos_visibles(p_usuario hub_cleber.usuarios, p_id_marca text, p_modulo text)
RETURNS text[]
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN coalesce((p_usuario).es_sistema, false) OR hub_cleber.es_administrador_modulo(p_usuario, p_id_marca, p_modulo) THEN NULL
    ELSE coalesce((SELECT ARRAY[rm.id_equipo] FROM hub_cleber.usuarios_roles_modulo rm
                    WHERE rm.id_usuario = (p_usuario).id_usuario AND rm.id_marca = p_id_marca
                      AND rm.modulo = p_modulo AND rm.id_equipo IS NOT NULL), '{}')
  END;
$$;

-- Agencias cuyas conversaciones ve el usuario en el módulo de la marca. NULL = todas (sistema, super admin o
-- administrador del módulo); si no, sus agencias en la marca (usuarios_marcas.agencias). Una conversación sin agencia
-- (id_agencia NULL) no se filtra por agencia.
CREATE OR REPLACE FUNCTION hub_cleber.agencias_visibles(p_usuario hub_cleber.usuarios, p_id_marca text, p_modulo text)
RETURNS text[]
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN coalesce((p_usuario).es_sistema, false) OR coalesce((p_usuario).es_super_admin, false)
         OR hub_cleber.es_administrador_modulo(p_usuario, p_id_marca, p_modulo) THEN NULL
    ELSE coalesce((SELECT um.agencias FROM hub_cleber.usuarios_marcas um
                    WHERE um.id_usuario = (p_usuario).id_usuario AND um.id_marca = p_id_marca), '{}')
  END;
$$;

CREATE OR REPLACE FUNCTION hub_cleber.ve_conversacion(p_usuario hub_cleber.usuarios, p_conv hub_cleber.conversaciones)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT hub_cleber.tiene_modulo(p_usuario, (p_conv).id_marca, (p_conv).modulo)
     AND (hub_cleber.equipos_visibles(p_usuario, (p_conv).id_marca, (p_conv).modulo) IS NULL
          OR (p_conv).id_equipo = ANY (hub_cleber.equipos_visibles(p_usuario, (p_conv).id_marca, (p_conv).modulo)))
     AND ((p_conv).id_agencia IS NULL
          OR hub_cleber.agencias_visibles(p_usuario, (p_conv).id_marca, (p_conv).modulo) IS NULL
          OR (p_conv).id_agencia = ANY (hub_cleber.agencias_visibles(p_usuario, (p_conv).id_marca, (p_conv).modulo)));
$$;

-- Conversación por id, bloqueada para escribir si p_para_escribir. CONVERSACION_NO_ENCONTRADA si no existe o el
-- usuario no la ve (no se distingue, para no revelar que existe).
CREATE OR REPLACE FUNCTION hub_cleber.busca_conversacion(p_usuario hub_cleber.usuarios, p_id text, p_para_escribir boolean DEFAULT false)
RETURNS hub_cleber.conversaciones
LANGUAGE plpgsql
AS $$
DECLARE
  v_conv hub_cleber.conversaciones;
BEGIN
  IF p_para_escribir THEN
    SELECT * INTO v_conv FROM hub_cleber.conversaciones WHERE id_conversacion = p_id FOR UPDATE;
  ELSE
    SELECT * INTO v_conv FROM hub_cleber.conversaciones WHERE id_conversacion = p_id;
  END IF;
  IF v_conv.id_conversacion IS NULL OR NOT hub_cleber.ve_conversacion(p_usuario, v_conv) THEN
    PERFORM hub_cleber.error_de_aplicacion('CONVERSACION_NO_ENCONTRADA', 'La conversación no existe o no tienes acceso',
      jsonb_build_object('idConversacion', p_id));
  END IF;
  RETURN v_conv;
END;
$$;

-- Serializa las operaciones sobre un número + cliente (abrir, reabrir, contrato ①) dentro de la transacción.
CREATE OR REPLACE FUNCTION hub_cleber.bloquea_cliente_numero(p_id_numero text, p_telefono text)
RETURNS void
LANGUAGE sql
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('hub_cleber.conversacion:' || p_id_numero || ':' || p_telefono, 0));
$$;

-- Lo que valida una referencia a equipo o bot: que exista y sea de la misma marca y módulo.
CREATE OR REPLACE FUNCTION hub_cleber.valida_equipo(p_id_equipo text, p_id_marca text, p_modulo text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_id_equipo IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hub_cleber.equipos
                                              WHERE id_equipo = p_id_equipo AND id_marca = p_id_marca AND modulo = p_modulo) THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'El equipo no existe en ese módulo de la marca', '{"campo":"idEquipo"}');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION hub_cleber.valida_bot(p_id_bot text, p_id_marca text, p_modulo text, p_campo text DEFAULT 'idBot')
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_id_bot IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hub_cleber.bots
                                           WHERE id_bot = p_id_bot AND id_marca = p_id_marca AND modulo = p_modulo) THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'El bot no existe en ese módulo de la marca', jsonb_build_object('campo', p_campo));
  END IF;
END;
$$;

-- ============================================================================
-- Operación del asesor (DISENO_BACKEND_AWS.md; reglas de core/authz.py)
--   Leer:     ve_conversacion.
--   Escribir: rol del módulo que no sea CONSULTA (o super admin). Si está with_agent, solo su asesor o un
--             administrador del módulo.
--   Tomar, asignar y transferir de equipo: administrador del módulo.
-- ============================================================================

-- ¿Su rol en el módulo de la marca permite escribir? CONSULTA solo lee.
CREATE OR REPLACE FUNCTION hub_cleber.rol_escribe(p_usuario hub_cleber.usuarios, p_id_marca text, p_modulo text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce((p_usuario).es_super_admin, false)
      OR coalesce(hub_cleber.rol_modulo(p_usuario, p_id_marca, p_modulo) <> 'CONSULTA', false);
$$;

CREATE OR REPLACE FUNCTION hub_cleber.puede_operar(p_usuario hub_cleber.usuarios, p_conv hub_cleber.conversaciones)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT hub_cleber.ve_conversacion(p_usuario, p_conv)
     AND hub_cleber.rol_escribe(p_usuario, (p_conv).id_marca, (p_conv).modulo)
     AND (hub_cleber.es_administrador_modulo(p_usuario, (p_conv).id_marca, (p_conv).modulo)
          OR (p_conv).estado <> 'with_agent'
          OR (p_conv).id_agente = (p_usuario).id_usuario);
$$;

CREATE OR REPLACE FUNCTION hub_cleber.exige_operar(p_usuario hub_cleber.usuarios, p_conv hub_cleber.conversaciones)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT hub_cleber.puede_operar(p_usuario, p_conv) THEN
    PERFORM hub_cleber.error_de_aplicacion('SIN_PERMISO',
      CASE WHEN hub_cleber.rol_escribe(p_usuario, (p_conv).id_marca, (p_conv).modulo)
           THEN 'La conversación la atiende otro asesor' ELSE 'Tu rol no permite modificar conversaciones' END,
      jsonb_build_object('idConversacion', (p_conv).id_conversacion));
  END IF;
END;
$$;

-- Estado esperado; ESTADO_INVALIDO con motivo ESTADO_ACTUAL y el estado en que está.
CREATE OR REPLACE FUNCTION hub_cleber.exige_estado(p_conv hub_cleber.conversaciones, p_estados text[])
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT (p_conv).estado = ANY (p_estados) THEN
    PERFORM hub_cleber.error_de_aplicacion('ESTADO_INVALIDO',
      format('La conversación está %s; se esperaba %s', (p_conv).estado, array_to_string(p_estados, ' o ')),
      jsonb_build_object('motivo', 'ESTADO_ACTUAL', 'estado', (p_conv).estado));
  END IF;
END;
$$;

-- versionEsperada opcional de los params: si viene y no coincide → CONFLICTO_VERSION (info.version).
CREATE OR REPLACE FUNCTION hub_cleber.exige_version(p_conv hub_cleber.conversaciones, p_params jsonb)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_esperada integer := hub_cleber.param_entero(p_params, 'versionEsperada', false, 1, 2147483647);
BEGIN
  IF v_esperada IS NOT NULL AND v_esperada <> (p_conv).version THEN
    PERFORM hub_cleber.error_de_aplicacion('CONFLICTO_VERSION', 'La conversación cambió mientras tanto',
      jsonb_build_object('version', (p_conv).version));
  END IF;
END;
$$;

-- Conversación de una operación del asesor: existe y la ve (busca_conversacion, bloqueada), versión al día.
CREATE OR REPLACE FUNCTION hub_cleber.conversacion_para_operar(p_usuario hub_cleber.usuarios, p_params jsonb)
RETURNS hub_cleber.conversaciones
LANGUAGE plpgsql
AS $$
DECLARE
  v_conv hub_cleber.conversaciones := hub_cleber.busca_conversacion(p_usuario, hub_cleber.param_texto(p_params, 'idConversacion'), true);
BEGIN
  PERFORM hub_cleber.exige_version(v_conv, p_params);
  RETURN v_conv;
END;
$$;

-- Entrada de bitácora de una operación del asesor (origen usuario).
CREATE OR REPLACE FUNCTION hub_cleber.bitacora_usuario(p_id_conversacion text, p_accion text, p_usuario hub_cleber.usuarios,
                                                       p_datos jsonb DEFAULT '{}')
RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO hub_cleber.bitacora (id_conversacion, accion, origen, id_usuario, datos)
  VALUES (p_id_conversacion, p_accion, 'usuario', (p_usuario).id_usuario, coalesce(p_datos, '{}'));
$$;

-- Nota: { idNota, idConversacion, idAutor, nombreAutor, texto, creadoEn }
CREATE OR REPLACE FUNCTION hub_cleber.nota_json(n hub_cleber.notas)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object('idNota', n.id_nota::text, 'idConversacion', n.id_conversacion, 'idAutor', n.id_autor,
                            'nombreAutor', n.nombre_autor, 'texto', n.texto, 'creadoEn', n.creado_en);
$$;

-- ============================================================================
-- Forma JSON
-- ============================================================================

-- Equipo: { idEquipo, idMarca, modulo, nombre, modoAsignacion, maxConversacionesAgente, accionOptOut,
--           umbralesSemaforo, esActivo, creadoEn, actualizadoEn }
CREATE OR REPLACE FUNCTION hub_cleber.equipo_json(e hub_cleber.equipos)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'idEquipo', e.id_equipo, 'idMarca', e.id_marca, 'modulo', e.modulo, 'nombre', e.nombre,
    'modoAsignacion', e.modo_asignacion, 'maxConversacionesAgente', e.max_conversaciones_agente,
    'accionOptOut', e.accion_opt_out, 'umbralesSemaforo', e.umbrales_semaforo, 'esActivo', e.es_activo,
    'creadoEn', e.creado_en, 'actualizadoEn', e.actualizado_en);
$$;

-- Bot: { idBot, idMarca, modulo, nombre, tipo, categoria, config, secretosConfigurados, esActivo, creadoEn, actualizadoEn }
CREATE OR REPLACE FUNCTION hub_cleber.bot_json(b hub_cleber.bots)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'idBot', b.id_bot, 'idMarca', b.id_marca, 'modulo', b.modulo, 'nombre', b.nombre, 'tipo', b.tipo,
    'categoria', b.categoria, 'config', b.config, 'secretosConfigurados', to_jsonb(b.secretos_configurados),
    'esActivo', b.es_activo, 'creadoEn', b.creado_en, 'actualizadoEn', b.actualizado_en);
$$;

-- Número: { idNumero, idMarca, modulo, telefono, nombre, proveedor, idEquipo, idBotDefault, ventanaReaperturaHoras,
--           horasCierreInactividad, webhookCierreUrl, plantillas, configProveedor, secretosConfigurados, esActivo, ... }
CREATE OR REPLACE FUNCTION hub_cleber.numero_json(n hub_cleber.numeros)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'idNumero', n.id_numero, 'idMarca', n.id_marca, 'modulo', n.modulo, 'telefono', n.telefono, 'nombre', n.nombre,
    'proveedor', n.proveedor, 'idEquipo', n.id_equipo, 'idBotDefault', n.id_bot_default,
    'ventanaReaperturaHoras', n.ventana_reapertura_horas, 'horasCierreInactividad', n.horas_cierre_inactividad,
    'webhookCierreUrl', n.webhook_cierre_url, 'plantillas', n.plantillas, 'configProveedor', n.config_proveedor,
    'secretosConfigurados', to_jsonb(n.secretos_configurados), 'esActivo', n.es_activo,
    'creadoEn', n.creado_en, 'actualizadoEn', n.actualizado_en);
$$;

-- Conversación (lo que muestran la bandeja y el chat, y lo que necesita el pipeline).
CREATE OR REPLACE FUNCTION hub_cleber.conversacion_json(c hub_cleber.conversaciones)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'idConversacion', c.id_conversacion, 'idMarca', c.id_marca, 'modulo', c.modulo, 'idNumero', c.id_numero,
    'idEquipo', c.id_equipo, 'idBot', c.id_bot, 'canal', c.canal, 'direccion', c.direccion,
    'telefonoCliente', c.telefono_cliente, 'nombreCliente', c.nombre_cliente, 'claveCliente', c.clave_cliente,
    'estado', c.estado, 'idAgente', c.id_agente, 'prioridad', c.prioridad, 'etiquetas', to_jsonb(c.etiquetas),
    'fuente', c.fuente, 'idExterno', c.id_externo, 'idAgencia', c.id_agencia, 'resultado', c.resultado, 'resultadoEn', c.resultado_en,
    'motivoHandoff', c.motivo_handoff, 'idSesionBot', c.id_sesion_bot,
    'ultimoMensajeEn', c.ultimo_mensaje_en, 'ultimoMensajeTexto', c.ultimo_mensaje_texto,
    'ultimoRemitente', c.ultimo_remitente, 'ultimoMensajeClienteEn', c.ultimo_mensaje_cliente_en,
    'ultimaPlantillaEn', c.ultima_plantilla_en, 'recordatoriosInactividad', c.recordatorios_inactividad,
    'motivoCierre', c.motivo_cierre, 'asignadaEn', c.asignada_en, 'esperaDesde', c.espera_desde,
    'primeraRespuestaEn', c.primera_respuesta_en, 'tiemposRespuesta', to_jsonb(c.tiempos_respuesta),
    'metadatos', c.metadatos, 'cerradaEn', c.cerrada_en, 'creadoEn', c.creado_en,
    'actualizadoEn', c.actualizado_en, 'version', c.version);
$$;

-- Mensaje: { idMensaje, idConversacion, remitente, idAgente, texto, mediaUrl, esPlantilla, idMensajeProveedor, creadoEn }
-- idMensaje va como texto (bigint no cabe siempre en un número de JavaScript).
CREATE OR REPLACE FUNCTION hub_cleber.mensaje_json(m hub_cleber.mensajes)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'idMensaje', m.id_mensaje::text, 'idConversacion', m.id_conversacion, 'remitente', m.remitente,
    'idAgente', m.id_agente, 'texto', m.texto, 'mediaUrl', m.media_url, 'esPlantilla', m.es_plantilla,
    'idMensajeProveedor', m.id_mensaje_proveedor, 'creadoEn', m.creado_en);
$$;
