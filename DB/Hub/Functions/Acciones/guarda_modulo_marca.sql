/**
    Hub.guardaModuloMarca — dashboard (solo super admin)

    Enciende o apaga un módulo en una marca. No da de alta módulos: solo acepta los que existen (ventas, servicio,
    valuacion, verificacion). Apagarlo oculta el módulo a los usuarios de la marca; no borra sus datos.

    Params:
      idMarca (string)
      modulo (string)       ventas | servicio | valuacion | verificacion
      esActivo (boolean)
    Info: { idMarca, modulo, esActivo }
    Errores: RECURSO_NO_ENCONTRADO (marca), CAMPO_INVALIDO con info.campo (modulo)

    @Acceso Publica (super admin)
*/
CREATE OR REPLACE FUNCTION hub_cleber.guarda_modulo_marca(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params jsonb;
  v_actor  hub_cleber.usuarios;
  v_id     text;
  v_modulo text;
  v_activo boolean;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.guardaModuloMarca');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_super_admin(v_actor);

  v_id     := hub_cleber.param_texto(v_params, 'idMarca');
  v_modulo := hub_cleber.param_texto(v_params, 'modulo');
  v_activo := hub_cleber.param_booleano(v_params, 'esActivo');

  IF v_modulo NOT IN ('ventas', 'servicio', 'valuacion', 'verificacion') THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'El módulo no existe: ' || v_modulo, '{"campo":"modulo"}');
  END IF;
  PERFORM 1 FROM hub_cleber.marcas WHERE id_marca = v_id;
  IF NOT FOUND THEN
    PERFORM hub_cleber.error_de_aplicacion('RECURSO_NO_ENCONTRADO', 'La marca no existe: ' || v_id);
  END IF;

  INSERT INTO hub_cleber.marcas_modulos (id_marca, modulo, es_activo) VALUES (v_id, v_modulo, v_activo)
  ON CONFLICT (id_marca, modulo) DO UPDATE SET es_activo = EXCLUDED.es_activo, actualizado_en = now();

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('idMarca', v_id, 'modulo', v_modulo, 'esActivo', v_activo));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
