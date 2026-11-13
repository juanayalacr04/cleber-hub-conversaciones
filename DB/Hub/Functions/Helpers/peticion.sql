/**
    Validación del envelope y de los params. Lanzan errores controlados (HB001) con los códigos estables:
    PETICION_INVALIDA, ACCION_INVALIDA, CAMPO_REQUERIDO, CAMPO_INVALIDO.

    @Acceso No-Publica
*/

-- Valida { action, params } y regresa params (objeto; {} si no viene).
CREATE OR REPLACE FUNCTION hub_cleber.valida_peticion(p_peticion jsonb, p_accion text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_peticion IS NULL OR jsonb_typeof(p_peticion) <> 'object' THEN
    PERFORM hub_cleber.error_de_aplicacion('PETICION_INVALIDA', 'La petición debe ser un objeto { action, params }');
  END IF;
  IF p_peticion->>'action' IS DISTINCT FROM p_accion THEN
    PERFORM hub_cleber.error_de_aplicacion('ACCION_INVALIDA', format('Se esperaba la acción %s', p_accion));
  END IF;
  IF p_peticion->'params' IS NULL OR jsonb_typeof(p_peticion->'params') = 'null' THEN
    RETURN '{}'::jsonb;
  END IF;
  IF jsonb_typeof(p_peticion->'params') <> 'object' THEN
    PERFORM hub_cleber.error_de_aplicacion('PETICION_INVALIDA', 'params debe ser un objeto');
  END IF;
  RETURN p_peticion->'params';
END;
$$;

-- Valor de un param con su tipo JSON. NULL si no viene (o viene null) y no es requerido.
CREATE OR REPLACE FUNCTION hub_cleber.param(p_params jsonb, p_campo text, p_tipo text, p_requerido boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_valor jsonb := p_params->p_campo;
BEGIN
  IF v_valor IS NULL OR jsonb_typeof(v_valor) = 'null' THEN
    IF p_requerido THEN
      PERFORM hub_cleber.error_de_aplicacion('CAMPO_REQUERIDO', format('Falta el campo %s', p_campo), jsonb_build_object('campo', p_campo));
    END IF;
    RETURN NULL;
  END IF;
  IF jsonb_typeof(v_valor) <> p_tipo THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('El campo %s debe ser de tipo %s', p_campo, p_tipo), jsonb_build_object('campo', p_campo));
  END IF;
  RETURN v_valor;
END;
$$;

-- Texto recortado; vacío = NULL. Si es requerido no puede venir vacío.
CREATE OR REPLACE FUNCTION hub_cleber.param_texto(p_params jsonb, p_campo text, p_requerido boolean DEFAULT true)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_texto text := nullif(btrim(hub_cleber.param(p_params, p_campo, 'string', p_requerido) #>> '{}'), '');
BEGIN
  IF v_texto IS NULL AND p_requerido THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_REQUERIDO', format('El campo %s no puede ir vacío', p_campo), jsonb_build_object('campo', p_campo));
  END IF;
  RETURN v_texto;
END;
$$;

-- Entero dentro de un rango; NULL si no viene y no es requerido.
CREATE OR REPLACE FUNCTION hub_cleber.param_entero(p_params jsonb, p_campo text, p_requerido boolean, p_minimo integer, p_maximo integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_numero numeric := (hub_cleber.param(p_params, p_campo, 'number', p_requerido) #>> '{}')::numeric;
BEGIN
  IF v_numero IS NOT NULL AND (v_numero <> trunc(v_numero) OR v_numero < p_minimo OR v_numero > p_maximo) THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO',
      format('El campo %s debe ser un entero entre %s y %s', p_campo, p_minimo, p_maximo), jsonb_build_object('campo', p_campo));
  END IF;
  RETURN v_numero::integer;
END;
$$;

-- Fecha-hora ISO 8601.
CREATE OR REPLACE FUNCTION hub_cleber.param_fecha_hora(p_params jsonb, p_campo text, p_requerido boolean DEFAULT true)
RETURNS timestamptz
LANGUAGE plpgsql
AS $$
DECLARE
  v_texto text := hub_cleber.param_texto(p_params, p_campo, p_requerido);
BEGIN
  IF v_texto IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN v_texto::timestamptz;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('El campo %s debe ser una fecha-hora ISO 8601', p_campo), jsonb_build_object('campo', p_campo));
  RETURN NULL;
END;
$$;

-- Arreglo de textos no vacíos, sin duplicados y ordenado.
CREATE OR REPLACE FUNCTION hub_cleber.param_textos(p_params jsonb, p_campo text, p_requerido boolean DEFAULT true)
RETURNS text[]
LANGUAGE plpgsql
AS $$
DECLARE
  v_arreglo jsonb := hub_cleber.param(p_params, p_campo, 'array', p_requerido);
  v_textos  text[];
BEGIN
  IF v_arreglo IS NULL THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_arreglo) e WHERE jsonb_typeof(e) <> 'string' OR btrim(e #>> '{}') = '') THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('El campo %s debe ser un arreglo de textos', p_campo), jsonb_build_object('campo', p_campo));
  END IF;
  SELECT coalesce(array_agg(DISTINCT btrim(e #>> '{}') ORDER BY btrim(e #>> '{}')), '{}')
    INTO v_textos
    FROM jsonb_array_elements(v_arreglo) e;
  RETURN v_textos;
END;
$$;

-- Booleano; NULL si no viene y no es requerido.
CREATE OR REPLACE FUNCTION hub_cleber.param_booleano(p_params jsonb, p_campo text, p_requerido boolean DEFAULT true)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT (hub_cleber.param(p_params, p_campo, 'boolean', p_requerido) #>> '{}')::boolean;
$$;

-- Objeto JSON; NULL si no viene y no es requerido.
CREATE OR REPLACE FUNCTION hub_cleber.param_objeto(p_params jsonb, p_campo text, p_requerido boolean DEFAULT true)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT hub_cleber.param(p_params, p_campo, 'object', p_requerido);
$$;

-- Arreglo JSON (de cualquier tipo de elemento); '[]' si no viene y no es requerido.
CREATE OR REPLACE FUNCTION hub_cleber.param_arreglo(p_params jsonb, p_campo text, p_requerido boolean DEFAULT true)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT coalesce(hub_cleber.param(p_params, p_campo, 'array', p_requerido), '[]'::jsonb);
$$;

-- Email normalizado (minúsculas, sin espacios); CAMPO_INVALIDO si no tiene forma de email.
CREATE OR REPLACE FUNCTION hub_cleber.param_email(p_params jsonb, p_campo text, p_requerido boolean DEFAULT true)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_email text := lower(hub_cleber.param_texto(p_params, p_campo, p_requerido));
BEGIN
  IF v_email IS NOT NULL AND v_email !~ '^[^@\s]+@[^@\s]+$' THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('El campo %s debe ser un email', p_campo), jsonb_build_object('campo', p_campo));
  END IF;
  RETURN v_email;
END;
$$;
