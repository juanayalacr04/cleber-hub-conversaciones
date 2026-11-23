/**
    Hub.guardaMarca — dashboard (solo super admin)

    Alta o cambio de una marca (upsert por idMarca). En un cambio solo se tocan los campos que vienen.

    Params:
      idMarca (string)          CÓDIGO de la marca (TO, HO...): letras, números, guion y guion bajo; se guarda en
                                mayúsculas. Filtra el catálogo de agencias de Cleber. No cambia después del alta (lo
                                guardan por valor valuacion.* y clientes.*)
      nombre (string)           requerido en el alta
      esActiva? (boolean)
    Info: { marca: Marca, creada: boolean }
    Errores: CAMPO_INVALIDO / CAMPO_REQUERIDO con info.campo (idMarca, nombre)

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
  v_activa boolean;
  v_existe boolean;
  v_marca  hub_cleber.marcas;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.guardaMarca');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_super_admin(v_actor);

  v_id     := upper(hub_cleber.param_texto(v_params, 'idMarca'));
  v_nombre := hub_cleber.param_texto(v_params, 'nombre', false);
  v_activa := hub_cleber.param_booleano(v_params, 'esActiva', false);

  IF v_id !~ '^[A-Za-z0-9_-]+$' THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'El id solo admite letras, números, guion y guion bajo', '{"campo":"idMarca"}');
  END IF;

  PERFORM 1 FROM hub_cleber.marcas WHERE id_marca = v_id FOR UPDATE;
  v_existe := FOUND;

  IF NOT v_existe THEN
    IF v_nombre IS NULL THEN
      PERFORM hub_cleber.error_de_aplicacion('CAMPO_REQUERIDO', 'El nombre es requerido para dar de alta la marca', '{"campo":"nombre"}');
    END IF;
    INSERT INTO hub_cleber.marcas (id_marca, nombre, es_activa)
    VALUES (v_id, v_nombre, coalesce(v_activa, true))
    RETURNING * INTO v_marca;
  ELSE
    UPDATE hub_cleber.marcas SET
      nombre          = coalesce(v_nombre, nombre),
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
