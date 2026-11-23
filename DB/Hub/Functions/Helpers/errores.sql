/**
    Manejo de errores del schema (mismo patrón que valuacion y clientes; hub no depende de ellos).

    - Error de negocio controlado: hub_cleber.error_de_aplicacion(codigo, mensaje, info) lanza SQLSTATE HB001
      con el código en MESSAGE, el mensaje en DETAIL y el info (jsonb) en HINT.
    - Toda función de acción termina con:

        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
            v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
          RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);

      HB001 → respuesta fallida con su código; cualquier otro → se registra en log_errores y se responde
      ERROR_INTERNO con idCorrelacion. El bloque EXCEPTION revierte lo que la función alcanzó a escribir.

    @Acceso No-Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.error_de_aplicacion(p_codigo text, p_mensaje text, p_info jsonb DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'HB001',
    MESSAGE = p_codigo,
    DETAIL  = coalesce(p_mensaje, ''),
    HINT    = coalesce(p_info::text, '');
END;
$$;

CREATE OR REPLACE FUNCTION hub_cleber.registra_error(
  p_peticion jsonb,
  p_sqlstate text,
  p_mensaje  text,
  p_contexto text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = hub_cleber, pg_temp
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO hub_cleber.log_errores (id_correlacion, peticion, sqlstate, mensaje, contexto)
  VALUES (v_id, p_peticion, p_sqlstate, p_mensaje, p_contexto);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION hub_cleber.maneja_error(
  p_peticion jsonb,
  p_sqlstate text,
  p_mensaje  text,
  p_detalle  text,
  p_info     text,
  p_contexto text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_sqlstate = 'HB001' THEN
    RETURN cleber.construye_respuesta_fallida(p_mensaje, nullif(p_detalle, ''), nullif(p_info, '')::jsonb);
  END IF;
  v_id := hub_cleber.registra_error(p_peticion, p_sqlstate, p_mensaje, p_contexto);
  RETURN cleber.construye_respuesta_fallida(
    'ERROR_INTERNO',
    'Ocurrió un error inesperado; reporta el idCorrelacion a soporte',
    jsonb_build_object('idCorrelacion', v_id));
END;
$$;
