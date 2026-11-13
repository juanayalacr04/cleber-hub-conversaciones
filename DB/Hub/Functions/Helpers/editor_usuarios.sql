/**
    Helpers del editor de usuarios (Hub.consultaUsuarios, invitaUsuario, guardaUsuario, quitaUsuarioDeOrganizacion,
    cambiaDisponibilidad). Quién edita a quién: decisión Q39 (DISENO_MIGRACION_POSTGRES.md):
      - Super admin: todo.
      - Administrador de un módulo en una marca: los roles y equipos de ese módulo en esa marca.
      - Agencias del usuario en una marca: cualquier administrador de algún módulo de la marca.
      - Solo un super admin modifica a un super admin.

    @Acceso No-Publica
*/

-- Módulo del hub (ventas / servicio / valuacion).
CREATE OR REPLACE FUNCTION hub_cleber.param_modulo(p_params jsonb, p_campo text, p_requerido boolean DEFAULT true)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_modulo text := hub_cleber.param_texto(p_params, p_campo, p_requerido);
BEGIN
  IF v_modulo IS NOT NULL AND v_modulo NOT IN ('ventas', 'servicio', 'valuacion') THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('Módulo desconocido: %s', v_modulo), jsonb_build_object('campo', p_campo));
  END IF;
  RETURN v_modulo;
END;
$$;

-- El rol debe existir en el catálogo del módulo.
CREATE OR REPLACE FUNCTION hub_cleber.exige_rol_catalogo(p_modulo text, p_rol text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hub_cleber.roles_modulo WHERE modulo = p_modulo AND rol = p_rol) THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('El rol %s no existe en el módulo %s', p_rol, p_modulo),
      jsonb_build_object('campo', 'rol', 'modulo', p_modulo));
  END IF;
END;
$$;

-- El editor lo usan personas; el sistema carga usuarios con Hub.importaUsuarios.
CREATE OR REPLACE FUNCTION hub_cleber.exige_persona(p_usuario hub_cleber.usuarios)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF coalesce((p_usuario).es_sistema, false) THEN
    PERFORM hub_cleber.error_de_aplicacion('SIN_PERMISO', 'Acción reservada a usuarios del dashboard');
  END IF;
END;
$$;

-- La organización existe y está activa.
CREATE OR REPLACE FUNCTION hub_cleber.exige_organizacion_activa(p_id_organizacion text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hub_cleber.organizaciones WHERE id_organizacion = p_id_organizacion AND es_activa) THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('No existe la organización %s', p_id_organizacion),
      jsonb_build_object('campo', 'idOrganizacion', 'causa', 'NO_EXISTE'));
  END IF;
END;
$$;

-- Usuario sobre el que se actúa. Inexistente o de sistema → CAMPO_INVALIDO (NO_EXISTE).
-- Un super admin solo lo modifica otro super admin.
CREATE OR REPLACE FUNCTION hub_cleber.usuario_objetivo(p_id_usuario bigint, p_actor hub_cleber.usuarios)
RETURNS hub_cleber.usuarios
LANGUAGE plpgsql
AS $$
DECLARE
  v_usuario hub_cleber.usuarios;
BEGIN
  SELECT * INTO v_usuario FROM hub_cleber.usuarios WHERE id_usuario = p_id_usuario AND NOT es_sistema;
  IF NOT FOUND THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('No existe el usuario %s', p_id_usuario),
      jsonb_build_object('campo', 'idUsuario', 'causa', 'NO_EXISTE'));
  END IF;
  IF v_usuario.es_super_admin AND NOT coalesce((p_actor).es_super_admin, false) THEN
    PERFORM hub_cleber.error_de_aplicacion('SIN_PERMISO', 'Solo un super admin modifica a un super admin');
  END IF;
  RETURN v_usuario;
END;
$$;

-- El usuario pertenece a la marca.
CREATE OR REPLACE FUNCTION hub_cleber.exige_miembro(p_id_usuario bigint, p_id_organizacion text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hub_cleber.usuarios_organizaciones
                  WHERE id_usuario = p_id_usuario AND id_organizacion = p_id_organizacion) THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('El usuario no pertenece a la organización %s', p_id_organizacion),
      jsonb_build_object('campo', 'idOrganizacion', 'causa', 'NO_PERTENECE'));
  END IF;
END;
$$;

/**
    Usuario visto desde una marca (lista del editor):
    { idUsuario, email, nombre, fotoUrl, esSuperAdmin, esActivo, esDisponible, estado, ultimoAccesoEn,
      esInvitado (nunca ha entrado), agencias, modulos: { "<modulo>": { rol, idEquipo } } }
*/
CREATE OR REPLACE FUNCTION hub_cleber.usuario_en_organizacion_json(p_id_usuario bigint, p_id_organizacion text)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'idUsuario',      u.id_usuario,
    'email',          u.email,
    'nombre',         u.nombre,
    'fotoUrl',        u.foto_url,
    'esSuperAdmin',   u.es_super_admin,
    'esActivo',       u.es_activo,
    'esDisponible',   u.es_disponible,
    'estado',         u.estado,
    'ultimoAccesoEn', u.ultimo_acceso_en,
    'esInvitado',     u.ultimo_acceso_en IS NULL,
    'agencias',       to_jsonb(uo.agencias),
    'modulos',        coalesce((SELECT jsonb_object_agg(rm.modulo, jsonb_build_object('rol', rm.rol, 'idEquipo', rm.id_equipo))
                                  FROM hub_cleber.usuarios_roles_modulo rm
                                 WHERE rm.id_usuario = uo.id_usuario AND rm.id_organizacion = uo.id_organizacion), '{}'::jsonb))
    FROM hub_cleber.usuarios u
    JOIN hub_cleber.usuarios_organizaciones uo ON uo.id_usuario = u.id_usuario AND uo.id_organizacion = p_id_organizacion
   WHERE u.id_usuario = p_id_usuario;
$$;
