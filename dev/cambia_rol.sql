/*
 * cambia_rol.sql — SOLO DESARROLLO. Cambia el rol de un usuario del hub para probar permisos.
 *
 * Mientras eres super admin la base te deja ver y hacer todo; con este script te quitas el super admin y te pones
 * un rol en una marca y módulo, con las agencias que indiques. Con rol = SUPERADMIN regresas.
 *
 * Uso: edita los valores del paso 1 y ejecuta el archivo completo, conectado a db_dev_01 (extensión de PostgreSQL
 * de VS Code: "Run" sobre todo el archivo; o psql -f dev/cambia_rol.sql). Después recarga la pantalla del hub.
 *
 *   rol       SUPERADMIN, o un rol del módulo (valuacion: ADMINISTRADOR, GERENTE, VALUADOR, CONSULTA)
 *   org       id_marca de la marca (no hace falta con SUPERADMIN)
 *   agencias  ids separados por coma; '*' = todas las de la marca en valuacion.configuraciones_agencias;
 *             '' = conservar las que ya tenga en la marca
 *   modulo    normalmente valuacion
 *   equipo    id o nombre del equipo del módulo en la marca; '*' = el único equipo activo del módulo en la marca;
 *             '' = conservar el que ya tenga; 'NINGUNO' = quitarlo. Sin equipo, un rol que no es ADMINISTRADOR no ve
 *             conversaciones (hub_cleber.equipos_visibles)
 *
 * Qué cambia: hub_cleber.usuarios.es_super_admin, la membresía en la marca (usuarios_marcas.agencias) y el rol y
 * equipo en el módulo (usuarios_roles_modulo). Al final muestra lo que verá el módulo (hub_cleber.usuarios_contexto).
 * No cambia Firestore: el menú del dashboard que aún sale de Firestore no se entera.
 */

-- 1. Edita estos valores --------------------------------------------------------------------------------------------
SELECT set_config('cambia_rol.email',    'juan.ayala@cleber.com', false) AS email,
       set_config('cambia_rol.rol',      'VALUADOR',              false) AS rol,
       set_config('cambia_rol.org',      'TO',      false) AS org,
       set_config('cambia_rol.agencias', '107',           false) AS agencias,
       set_config('cambia_rol.modulo',   'valuacion',             false) AS modulo,
       set_config('cambia_rol.equipo',   '*',                     false) AS equipo;

-- 2. Aplica el cambio (todo o nada) ---------------------------------------------------------------------------------
DO $$
DECLARE
  v_email    text := lower(btrim(current_setting('cambia_rol.email')));
  v_rol      text := upper(btrim(current_setting('cambia_rol.rol')));
  v_org      text := nullif(btrim(current_setting('cambia_rol.org')), '');
  v_agencias text := nullif(btrim(current_setting('cambia_rol.agencias')), '');
  v_modulo   text := lower(btrim(current_setting('cambia_rol.modulo')));
  v_equipo   text := nullif(btrim(coalesce(current_setting('cambia_rol.equipo', true), '')), '');
  v_usuario  hub_cleber.usuarios;
  v_lista    text[];
  v_id_equipo text;
  v_opciones  text;
BEGIN
  SELECT * INTO v_usuario FROM hub_cleber.usuarios WHERE email = v_email;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe el usuario % en hub_cleber.usuarios', v_email;
  END IF;
  IF v_usuario.es_sistema THEN
    RAISE EXCEPTION 'El usuario % es de sistema; este script es para personas', v_email;
  END IF;

  IF v_rol = 'SUPERADMIN' THEN
    UPDATE hub_cleber.usuarios SET es_super_admin = true, actualizado_en = now() WHERE id_usuario = v_usuario.id_usuario;
    RAISE NOTICE '% vuelve a ser super admin', v_email;
    RETURN;
  END IF;

  IF v_org IS NULL OR v_org LIKE '<%' THEN
    RAISE EXCEPTION 'Falta org para el rol %. Opciones: %', v_rol,
      (SELECT string_agg(id_marca || ' (' || nombre || ')', ', ' ORDER BY nombre) FROM hub_cleber.marcas);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hub_cleber.marcas WHERE id_marca = v_org) THEN
    RAISE EXCEPTION 'No existe la marca %. Opciones: %', v_org,
      (SELECT string_agg(id_marca || ' (' || nombre || ')', ', ' ORDER BY nombre) FROM hub_cleber.marcas);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hub_cleber.roles_modulo WHERE modulo = v_modulo AND rol = v_rol) THEN
    RAISE EXCEPTION 'El rol % no existe en el módulo %. Opciones: SUPERADMIN, %', v_rol, v_modulo,
      (SELECT string_agg(rol, ', ' ORDER BY orden) FROM hub_cleber.roles_modulo WHERE modulo = v_modulo);
  END IF;
  IF v_agencias LIKE '<%' THEN
    RAISE EXCEPTION 'Pon las agencias (separadas por coma), ''*'' para todas, o '''' para conservar las actuales';
  END IF;

  -- Agencias: '*' = todas las configuradas en valuación para la marca; lista separada por comas; vacío = no cambiar
  IF v_agencias = '*' THEN
    IF to_regclass('valuacion.configuraciones_agencias') IS NULL THEN
      RAISE EXCEPTION 'agencias = ''*'' necesita el schema valuacion; pon la lista de agencias';
    END IF;
    EXECUTE 'SELECT coalesce(array_agg(id_agencia ORDER BY id_agencia), ''{}'') FROM valuacion.configuraciones_agencias WHERE id_marca = $1'
       INTO v_lista USING v_org;
  ELSIF v_agencias IS NOT NULL THEN
    SELECT array_agg(DISTINCT btrim(a)) INTO v_lista FROM unnest(string_to_array(v_agencias, ',')) a WHERE btrim(a) <> '';
  END IF;

  -- Equipo: '*' = el único activo del módulo en la marca; id o nombre; NINGUNO = quitar; vacío = no cambiar
  SELECT string_agg(e.id_equipo || ' (' || e.nombre || CASE WHEN e.es_activo THEN '' ELSE ', inactivo' END || ')', ', ' ORDER BY e.nombre)
    INTO v_opciones
    FROM hub_cleber.equipos e WHERE e.id_marca = v_org AND e.modulo = v_modulo;
  IF v_equipo = '*' THEN
    IF (SELECT count(*) FROM hub_cleber.equipos WHERE id_marca = v_org AND modulo = v_modulo AND es_activo) <> 1 THEN
      RAISE EXCEPTION 'equipo = ''*'' necesita exactamente un equipo activo de % en %. Pon el id o el nombre. Opciones: %',
        v_modulo, v_org, coalesce(v_opciones, 'ninguno (créalo en Equipos)');
    END IF;
    SELECT id_equipo INTO v_id_equipo FROM hub_cleber.equipos WHERE id_marca = v_org AND modulo = v_modulo AND es_activo;
  ELSIF v_equipo IS NOT NULL AND upper(v_equipo) <> 'NINGUNO' THEN
    SELECT id_equipo INTO v_id_equipo FROM hub_cleber.equipos
     WHERE id_marca = v_org AND modulo = v_modulo AND (id_equipo = v_equipo OR lower(nombre) = lower(v_equipo))
     ORDER BY (id_equipo = v_equipo) DESC LIMIT 1;
    IF v_id_equipo IS NULL THEN
      RAISE EXCEPTION 'No existe el equipo % de % en %. Opciones: %', v_equipo, v_modulo, v_org,
        coalesce(v_opciones, 'ninguno (créalo en Equipos)');
    END IF;
  END IF;

  UPDATE hub_cleber.usuarios SET es_super_admin = false, actualizado_en = now() WHERE id_usuario = v_usuario.id_usuario;

  INSERT INTO hub_cleber.usuarios_marcas (id_usuario, id_marca, agencias)
  VALUES (v_usuario.id_usuario, v_org, coalesce(v_lista, '{}'))
  ON CONFLICT (id_usuario, id_marca) DO UPDATE
    SET agencias = coalesce(v_lista, usuarios_marcas.agencias), actualizado_en = now();

  INSERT INTO hub_cleber.usuarios_roles_modulo (id_usuario, id_marca, modulo, rol, id_equipo)
  VALUES (v_usuario.id_usuario, v_org, v_modulo, v_rol, v_id_equipo)
  ON CONFLICT (id_usuario, id_marca, modulo) DO UPDATE SET
    rol            = EXCLUDED.rol,
    id_equipo      = CASE WHEN v_equipo IS NULL THEN usuarios_roles_modulo.id_equipo ELSE EXCLUDED.id_equipo END,
    actualizado_en = now();

  RAISE NOTICE '% ahora es % en % (%), equipo %, sin super admin', v_email, v_rol, v_org, v_modulo,
    coalesce((SELECT rm.id_equipo FROM hub_cleber.usuarios_roles_modulo rm
               WHERE rm.id_usuario = v_usuario.id_usuario AND rm.id_marca = v_org AND rm.modulo = v_modulo), 'ninguno');
END;
$$;

-- 3. Lo que verá el módulo con este usuario -------------------------------------------------------------------------
SELECT u.email, u.es_super_admin,
       jsonb_pretty(hub_cleber.usuarios_contexto(u.email, current_setting('cambia_rol.modulo'))) AS contexto
  FROM hub_cleber.usuarios u
 WHERE u.email = lower(btrim(current_setting('cambia_rol.email')));
