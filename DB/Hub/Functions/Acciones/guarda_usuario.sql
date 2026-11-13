/**
    Hub.guardaUsuario — backend, en nombre del usuario (administrador en la marca, o super admin)

    Cambia lo que un usuario tiene en una marca. Solo toca lo que viene:
      - agencias: reemplaza sus agencias en la marca. Exige administrar algún módulo de la marca.
      - modulos:  por cada módulo que viene, { rol, idEquipo? } asigna o cambia su rol y equipo; null le quita el rol.
                  Exige administrar ESE módulo en la marca. Los módulos que no vienen no se tocan.
    Nadie (salvo el super admin) se quita a sí mismo el rol de administrador de un módulo: no podría deshacerlo.
    El backend actualiza accesos/{email} en Firestore con el usuario de la respuesta.

    Params:
      idUsuario (number), idOrganizacion (string)
      agencias? (string[])
      modulos?  { "<modulo>": { rol, idEquipo? } | null }
      (al menos uno de los dos)
    Info: { usuario: Usuario }
    Errores:
      CAMPO_INVALIDO  causa NO_EXISTE (usuario) o NO_PERTENECE (no está en la marca: usar Hub.invitaUsuario)
      ESTADO_INVALIDO causa PROPIO_ADMINISTRADOR

    @Acceso Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.guarda_usuario(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params   jsonb;
  v_actor    hub_cleber.usuarios;
  v_usuario  hub_cleber.usuarios;
  v_id       bigint;
  v_org      text;
  v_agencias text[];
  v_modulos  jsonb;
  v_modulo   text;
  v_valor    jsonb;
  v_rol      text;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.guardaUsuario');
  v_actor  := hub_cleber.usuario_actual();
  PERFORM hub_cleber.exige_persona(v_actor);

  v_id       := hub_cleber.param_entero(v_params, 'idUsuario', true, 1, 2147483647);
  v_org      := hub_cleber.param_texto(v_params, 'idOrganizacion');
  v_agencias := hub_cleber.param_textos(v_params, 'agencias', false);
  v_modulos  := hub_cleber.param_objeto(v_params, 'modulos', false);
  IF v_agencias IS NULL AND v_modulos IS NULL THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_REQUERIDO', 'Manda agencias o modulos', '{"campo":"modulos"}');
  END IF;

  -- Para editar algo de la marca hay que administrar algún módulo de ella
  PERFORM hub_cleber.exige_administrador_organizacion(v_actor, v_org);
  v_usuario := hub_cleber.usuario_objetivo(v_id, v_actor);
  PERFORM hub_cleber.exige_miembro(v_id, v_org);

  FOR v_modulo IN SELECT jsonb_object_keys(coalesce(v_modulos, '{}'::jsonb)) LOOP
    IF v_modulo NOT IN ('ventas', 'servicio', 'valuacion') THEN
      PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('Módulo desconocido: %s', v_modulo), '{"campo":"modulos"}');
    END IF;
    PERFORM hub_cleber.exige_administrador_modulo(v_actor, v_org, v_modulo);

    v_valor := v_modulos->v_modulo;
    IF jsonb_typeof(v_valor) = 'null' THEN
      v_rol := NULL;
    ELSIF jsonb_typeof(v_valor) = 'object' THEN
      v_rol := hub_cleber.param_texto(v_valor, 'rol');
      PERFORM hub_cleber.exige_rol_catalogo(v_modulo, v_rol);
    ELSE
      PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('modulos.%s debe ser { rol, idEquipo? } o null', v_modulo),
        jsonb_build_object('campo', 'modulos', 'modulo', v_modulo));
    END IF;

    IF v_id = v_actor.id_usuario AND NOT v_actor.es_super_admin
       AND hub_cleber.es_administrador_modulo(v_actor, v_org, v_modulo)
       AND NOT coalesce((SELECT es_administrador FROM hub_cleber.roles_modulo WHERE modulo = v_modulo AND rol = v_rol), false) THEN
      PERFORM hub_cleber.error_de_aplicacion('ESTADO_INVALIDO', format('No puedes quitarte la administración de %s', v_modulo),
        jsonb_build_object('causa', 'PROPIO_ADMINISTRADOR', 'modulo', v_modulo));
    END IF;

    IF v_rol IS NULL THEN
      DELETE FROM hub_cleber.usuarios_roles_modulo WHERE id_usuario = v_id AND id_organizacion = v_org AND modulo = v_modulo;
    ELSE
      INSERT INTO hub_cleber.usuarios_roles_modulo (id_usuario, id_organizacion, modulo, rol, id_equipo)
      VALUES (v_id, v_org, v_modulo, v_rol, hub_cleber.param_texto(v_valor, 'idEquipo', false))
      ON CONFLICT (id_usuario, id_organizacion, modulo) DO UPDATE SET
        rol            = EXCLUDED.rol,
        id_equipo      = EXCLUDED.id_equipo,
        actualizado_en = now();
    END IF;
  END LOOP;

  IF v_agencias IS NOT NULL THEN
    UPDATE hub_cleber.usuarios_organizaciones SET agencias = v_agencias, actualizado_en = now()
     WHERE id_usuario = v_id AND id_organizacion = v_org;
  END IF;

  UPDATE hub_cleber.usuarios SET actualizado_en = now() WHERE id_usuario = v_id;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object('usuario', hub_cleber.usuario_json(v_id)));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
