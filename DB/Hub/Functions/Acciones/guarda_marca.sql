/**
    Hub.guardaMarca — dashboard (solo super admin)

    Alta o cambio de una marca (upsert por idMarca). En un cambio solo se tocan los campos que vienen.

    Params:
      idMarca (string)          letras, números, guion y guion bajo; no cambia después del alta (lo guardan por valor
                                valuacion.*, clientes.* y Firestore)
      nombre (string)           requerido en el alta
      zonaHoraria? (string)     nombre IANA (default America/Mexico_City)
      sfCodigoMarca? (string)   único entre marcas; "" lo quita
      esActiva? (boolean)
    Info: { marca: Marca, creada: boolean }
    Errores: CAMPO_INVALIDO / CAMPO_REQUERIDO con info.campo (idMarca, nombre, zonaHoraria, sfCodigoMarca)

    @Acceso Publica (super admin)
*/
CREATE OR REPLACE FUNCTION hub_cleber.guarda_marca(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params jsonb;
  v_actor  hub_cleber.usuarios;
  v_id     text;
  v_nombre text;
  v_zona   text;
  v_sf     text;
  v_activa boolean;
  v_existe boolean;
  v_marca  hub_cleber.marcas;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.guardaMarca');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_super_admin(v_actor);

  v_id     := hub_cleber.param_texto(v_params, 'idMarca');
  v_nombre := hub_cleber.param_texto(v_params, 'nombre', false);
  v_zona   := hub_cleber.param_texto(v_params, 'zonaHoraria', false);
  v_sf     := hub_cleber.param_texto(v_params, 'sfCodigoMarca', false);   -- "" llega como NULL
  v_activa := hub_cleber.param_booleano(v_params, 'esActiva', false);

  IF v_id !~ '^[A-Za-z0-9_-]+$' THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'El id solo admite letras, números, guion y guion bajo', '{"campo":"idMarca"}');
  END IF;
  IF v_zona IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_zona) THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('Zona horaria desconocida: %s', v_zona), '{"campo":"zonaHoraria"}');
  END IF;
  IF v_sf IS NOT NULL AND EXISTS (SELECT 1 FROM hub_cleber.marcas WHERE sf_codigo_marca = v_sf AND id_marca <> v_id) THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('El código de Salesforce %s ya es de otra marca', v_sf), '{"campo":"sfCodigoMarca"}');
  END IF;

  PERFORM 1 FROM hub_cleber.marcas WHERE id_marca = v_id FOR UPDATE;
  v_existe := FOUND;

  IF NOT v_existe THEN
    IF v_nombre IS NULL THEN
      PERFORM hub_cleber.error_de_aplicacion('CAMPO_REQUERIDO', 'El nombre es requerido para dar de alta la marca', '{"campo":"nombre"}');
    END IF;
    INSERT INTO hub_cleber.marcas (id_marca, nombre, zona_horaria, sf_codigo_marca, es_activa)
    VALUES (v_id, v_nombre, coalesce(v_zona, 'America/Mexico_City'), v_sf, coalesce(v_activa, true))
    RETURNING * INTO v_marca;
  ELSE
    UPDATE hub_cleber.marcas SET
      nombre          = coalesce(v_nombre, nombre),
      zona_horaria    = coalesce(v_zona, zona_horaria),
      sf_codigo_marca = CASE WHEN v_params ? 'sfCodigoMarca' THEN v_sf ELSE sf_codigo_marca END,
      es_activa       = coalesce(v_activa, es_activa),
      actualizado_en  = now()
    WHERE id_marca = v_id
    RETURNING * INTO v_marca;
  END IF;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('marca', hub_cleber.marca_json(v_marca), 'creada', NOT v_existe));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
