/**
    Hub.resuelveNumero — sistema (backend del hub; el resultado se guarda en caché ~60 s)

    Todo lo que el pipeline necesita de un número activo, en una llamada. Se busca por UNO de:
      telefono (string)                     el número que recibió el mensaje (Twilio, ValueText); acepta "whatsapp:+52..."
      metaPhoneNumberId (string)            el phone_number_id del webhook de Meta
      idMarca + modulo (string)             el número del módulo en la marca (contrato ①)

    Info: { numero: Numero, botDefault: Bot | null, equipo: Equipo | null,
            marca: { idMarca, nombre, horario, sfCalendario, salesforceConfig } }
    Errores: RECURSO_NO_ENCONTRADO si no hay número activo; CAMPO_REQUERIDO si no viene ningún criterio.
    El bot y el equipo inactivos se regresan igual (con esActivo = false): decide el backend.

    @Acceso Publica (sistema)
*/
CREATE OR REPLACE FUNCTION hub_cleber.resuelve_numero(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params   jsonb;
  v_actor    hub_cleber.usuarios;
  v_telefono text;
  v_meta     text;
  v_marca    text;
  v_modulo   text;
  v_numero   hub_cleber.numeros;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.resuelveNumero');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_sistema(v_actor);

  v_telefono := hub_cleber.param_telefono_numero(v_params, 'telefono', false);
  v_meta     := hub_cleber.param_texto(v_params, 'metaPhoneNumberId', false);
  v_marca    := upper(hub_cleber.param_texto(v_params, 'idMarca', false));
  v_modulo   := hub_cleber.param_modulo(v_params, 'modulo', false);

  IF v_telefono IS NOT NULL THEN
    SELECT * INTO v_numero FROM hub_cleber.numeros WHERE es_activo AND telefono = v_telefono;
  ELSIF v_meta IS NOT NULL THEN
    SELECT * INTO v_numero FROM hub_cleber.numeros WHERE es_activo AND config_proveedor->>'metaPhoneNumberId' = v_meta;
  ELSIF v_marca IS NOT NULL AND v_modulo IS NOT NULL THEN
    SELECT * INTO v_numero FROM hub_cleber.numeros WHERE es_activo AND id_marca = v_marca AND modulo = v_modulo;
  ELSE
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_REQUERIDO', 'Falta telefono, metaPhoneNumberId o idMarca + modulo', '{"campo":"telefono"}');
  END IF;

  IF v_numero.id_numero IS NULL THEN
    PERFORM hub_cleber.error_de_aplicacion('RECURSO_NO_ENCONTRADO', 'No hay número activo con ese criterio',
      jsonb_strip_nulls(jsonb_build_object('telefono', v_telefono, 'metaPhoneNumberId', v_meta, 'idMarca', v_marca, 'modulo', v_modulo)));
  END IF;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
    'numero',     hub_cleber.numero_json(v_numero),
    'botDefault', (SELECT hub_cleber.bot_json(b) FROM hub_cleber.bots b WHERE b.id_bot = v_numero.id_bot_default),
    'equipo',     (SELECT hub_cleber.equipo_json(e) FROM hub_cleber.equipos e WHERE e.id_equipo = v_numero.id_equipo),
    'marca',      (SELECT jsonb_build_object('idMarca', m.id_marca, 'nombre', m.nombre, 'horario', m.horario,
                                             'sfCalendario', m.sf_calendario, 'salesforceConfig', m.salesforce_config)
                     FROM hub_cleber.marcas m WHERE m.id_marca = v_numero.id_marca)));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
