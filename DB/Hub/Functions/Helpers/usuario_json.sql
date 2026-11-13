/**
    Objeto Usuario.

    { idUsuario, email, nombre, fotoUrl, rol, esSuperAdmin, esSistema, esActivo, esDisponible, estado,
      ultimoAccesoEn, creadoEn,
      organizaciones: [ { idOrganizacion, nombre, idEquipo, agencias } ],   ordenadas por nombre
      rolesModulo:    { "<modulo>": "<ROL>" } }

    @Acceso No-Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.usuario_json(p_id_usuario bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'idUsuario',      u.id_usuario,
    'email',          u.email,
    'nombre',         u.nombre,
    'fotoUrl',        u.foto_url,
    'rol',            u.rol,
    'esSuperAdmin',   u.es_super_admin,
    'esSistema',      u.es_sistema,
    'esActivo',       u.es_activo,
    'esDisponible',   u.es_disponible,
    'estado',         u.estado,
    'ultimoAccesoEn', u.ultimo_acceso_en,
    'creadoEn',       u.creado_en,
    'organizaciones', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'idOrganizacion', uo.id_organizacion,
                 'nombre',         o.nombre,
                 'idEquipo',       uo.id_equipo,
                 'agencias',       to_jsonb(uo.agencias)) ORDER BY o.nombre, uo.id_organizacion)
          FROM hub_cleber.usuarios_organizaciones uo
          JOIN hub_cleber.organizaciones o ON o.id_organizacion = uo.id_organizacion
         WHERE uo.id_usuario = u.id_usuario), '[]'::jsonb),
    'rolesModulo',    coalesce((
        SELECT jsonb_object_agg(rm.modulo, rm.rol)
          FROM hub_cleber.usuarios_roles_modulo rm
         WHERE rm.id_usuario = u.id_usuario), '{}'::jsonb))
    FROM hub_cleber.usuarios u
   WHERE u.id_usuario = p_id_usuario;
$$;
