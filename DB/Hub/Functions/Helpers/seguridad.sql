/**
    Identidad y permisos del schema hub_cleber (DISENO_MIGRACION_POSTGRES.md §4.2).

    La identidad llega SOLO en X-User-Email:
      - Usuarios: el Lambda authorizer de Google valida el id_token y API Gateway inyecta X-User-Email
        (sobrescribe el que mande el cliente). Ruta /hub.
      - Máquinas: llaman por /internal (AWS_IAM) con un email de servicio registrado en hub_cleber.usuarios con es_sistema.
    No hay X-User-Contexto: marcas, agencias, roles y equipos por módulo se leen de las tablas de hub_cleber.

    No hay rol global (Q36): el usuario tiene un rol por marca y módulo, del catálogo hub_cleber.roles_modulo.
    Solo es_super_admin vale en todas las marcas y módulos.

    Pendiente (§12 del diseño): plpgsql no sabe por qué ruta llegó la petición. Que un email de servicio solo valga
    por /internal depende de que /hub nunca deje pasar un email *.internal (el authorizer solo emite emails de Google).

    @Acceso No-Publica
*/

-- Email de servicio del backend del hub. Dominio que no puede existir en Google.
CREATE OR REPLACE FUNCTION hub_cleber.email_sistema()
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 'sistema@hub-conversaciones.internal';
$$;

-- X-User-Email de la petición (minúsculas), o NULL si no viene.
CREATE OR REPLACE FUNCTION hub_cleber.email_peticion()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT lower(nullif(btrim(nullif(current_setting('request.headers', true), '')::jsonb->>'x-user-email'), ''));
$$;

-- Usuario ACTIVO por email; fila con id_usuario NULL si no existe o está inactivo.
CREATE OR REPLACE FUNCTION hub_cleber.busca_usuario(p_email text)
RETURNS hub_cleber.usuarios
LANGUAGE sql
STABLE
AS $$
  SELECT * FROM hub_cleber.usuarios WHERE email = lower(btrim(p_email)) AND es_activo;
$$;

-- Usuario de la petición. Sin header, sin usuario o inactivo → SIN_PERMISO.
CREATE OR REPLACE FUNCTION hub_cleber.usuario_actual()
RETURNS hub_cleber.usuarios
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_email   text := hub_cleber.email_peticion();
  v_usuario hub_cleber.usuarios;
BEGIN
  IF v_email IS NULL THEN
    PERFORM hub_cleber.error_de_aplicacion('SIN_PERMISO', 'No se recibió el usuario de la petición');
  END IF;
  v_usuario := hub_cleber.busca_usuario(v_email);
  IF v_usuario.id_usuario IS NULL THEN
    PERFORM hub_cleber.error_de_aplicacion('SIN_PERMISO', 'El usuario no está registrado en el hub o está inactivo');
  END IF;
  RETURN v_usuario;
END;
$$;

-- Solo usuarios de sistema (backend del hub, Lambdas).
CREATE OR REPLACE FUNCTION hub_cleber.exige_sistema(p_usuario hub_cleber.usuarios)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT coalesce((p_usuario).es_sistema, false) THEN
    PERFORM hub_cleber.error_de_aplicacion('SIN_PERMISO', 'Acción reservada al sistema');
  END IF;
END;
$$;

-- Firmas anteriores (rol global y rol de módulo sin marca); se reemplazan por las de abajo.
DROP FUNCTION IF EXISTS hub_cleber.exige_rol(hub_cleber.usuarios, text[]);
DROP FUNCTION IF EXISTS hub_cleber.rol_modulo(hub_cleber.usuarios, text);

-- ¿El usuario ve la marca? Super admin y sistema: todas.
CREATE OR REPLACE FUNCTION hub_cleber.tiene_organizacion(p_usuario hub_cleber.usuarios, p_id_organizacion text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce((p_usuario).es_super_admin, false)
      OR coalesce((p_usuario).es_sistema, false)
      OR EXISTS (SELECT 1 FROM hub_cleber.usuarios_organizaciones uo
                  WHERE uo.id_usuario = (p_usuario).id_usuario AND uo.id_organizacion = p_id_organizacion);
$$;

CREATE OR REPLACE FUNCTION hub_cleber.exige_organizacion(p_usuario hub_cleber.usuarios, p_id_organizacion text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT hub_cleber.tiene_organizacion(p_usuario, p_id_organizacion) THEN
    PERFORM hub_cleber.error_de_aplicacion('SIN_PERMISO', format('Sin acceso a la organización %s', p_id_organizacion),
      jsonb_build_object('idOrganizacion', p_id_organizacion));
  END IF;
END;
$$;

-- Rol del usuario en un módulo de una marca, o NULL.
CREATE OR REPLACE FUNCTION hub_cleber.rol_modulo(p_usuario hub_cleber.usuarios, p_id_organizacion text, p_modulo text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT rm.rol FROM hub_cleber.usuarios_roles_modulo rm
   WHERE rm.id_usuario = (p_usuario).id_usuario AND rm.id_organizacion = p_id_organizacion AND rm.modulo = p_modulo;
$$;

-- ¿Administra el módulo en la marca? Super admin: siempre. Los demás: si su rol ahí es de administrador (catálogo).
CREATE OR REPLACE FUNCTION hub_cleber.es_administrador_modulo(p_usuario hub_cleber.usuarios, p_id_organizacion text, p_modulo text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce((p_usuario).es_super_admin, false)
      OR EXISTS (SELECT 1 FROM hub_cleber.usuarios_roles_modulo rm
                   JOIN hub_cleber.roles_modulo c ON c.modulo = rm.modulo AND c.rol = rm.rol
                  WHERE rm.id_usuario = (p_usuario).id_usuario AND rm.id_organizacion = p_id_organizacion
                    AND rm.modulo = p_modulo AND c.es_administrador);
$$;

CREATE OR REPLACE FUNCTION hub_cleber.exige_administrador_modulo(p_usuario hub_cleber.usuarios, p_id_organizacion text, p_modulo text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT hub_cleber.es_administrador_modulo(p_usuario, p_id_organizacion, p_modulo) THEN
    PERFORM hub_cleber.error_de_aplicacion('SIN_PERMISO', format('No administras el módulo %s en la organización %s', p_modulo, p_id_organizacion),
      jsonb_build_object('idOrganizacion', p_id_organizacion, 'modulo', p_modulo));
  END IF;
END;
$$;

-- ¿Administra algún módulo de la marca? Es lo que se pide para editar lo que es de la marca y no de un módulo
-- (las agencias del usuario, Q39). Super admin: siempre.
CREATE OR REPLACE FUNCTION hub_cleber.es_administrador_organizacion(p_usuario hub_cleber.usuarios, p_id_organizacion text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce((p_usuario).es_super_admin, false)
      OR EXISTS (SELECT 1 FROM hub_cleber.usuarios_roles_modulo rm
                   JOIN hub_cleber.roles_modulo c ON c.modulo = rm.modulo AND c.rol = rm.rol
                  WHERE rm.id_usuario = (p_usuario).id_usuario AND rm.id_organizacion = p_id_organizacion AND c.es_administrador);
$$;

CREATE OR REPLACE FUNCTION hub_cleber.exige_administrador_organizacion(p_usuario hub_cleber.usuarios, p_id_organizacion text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT hub_cleber.es_administrador_organizacion(p_usuario, p_id_organizacion) THEN
    PERFORM hub_cleber.error_de_aplicacion('SIN_PERMISO', format('No administras ningún módulo de la organización %s', p_id_organizacion),
      jsonb_build_object('idOrganizacion', p_id_organizacion));
  END IF;
END;
$$;

-- Agencias del usuario en una marca. NULL = sin restricción (super admin y sistema); '{}' = ninguna.
-- El catálogo de agencias no vive en el hub (viene de un API externo): aquí solo se guardan los ids por valor,
-- así que "todas" no se puede enumerar en plpgsql; cada módulo interpreta NULL como acceso total.
CREATE OR REPLACE FUNCTION hub_cleber.agencias_permitidas(p_usuario hub_cleber.usuarios, p_id_organizacion text)
RETURNS text[]
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN coalesce((p_usuario).es_super_admin, false) OR coalesce((p_usuario).es_sistema, false) THEN NULL
    ELSE coalesce((SELECT uo.agencias FROM hub_cleber.usuarios_organizaciones uo
                    WHERE uo.id_usuario = (p_usuario).id_usuario AND uo.id_organizacion = p_id_organizacion), '{}')
  END;
$$;

/**
    Contexto de un usuario para un módulo. Lo llama valuacion.usuario_actual() por valor (sin join a tablas de hub_cleber);
    junto con clientes.normaliza_telefono es la única dependencia permitida entre schemas.

      { email, esSuperAdmin, esSistema,
        marcas: { "<idOrganizacion>": { rol, idEquipo, agencias: ["<idAgencia>", ...] } } }

    marcas = solo las marcas donde el usuario tiene rol en p_modulo (sin rol en una marca = sin acceso al módulo ahí).
    El super admin entra a todas aunque no aparezcan; el sistema no tiene marcas (cada módulo reconoce su email de
    servicio). Usuario inexistente o inactivo → NULL.

    SECURITY DEFINER: valuación no necesita permisos sobre las tablas de hub_cleber.
*/
CREATE OR REPLACE FUNCTION hub_cleber.usuarios_contexto(p_email text, p_modulo text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = hub_cleber, pg_temp
AS $$
  SELECT jsonb_build_object(
    'email',        u.email,
    'esSuperAdmin', u.es_super_admin,
    'esSistema',    u.es_sistema,
    'marcas',       coalesce((SELECT jsonb_object_agg(rm.id_organizacion, jsonb_build_object(
                                       'rol',      rm.rol,
                                       'idEquipo', rm.id_equipo,
                                       'agencias', to_jsonb(uo.agencias)))
                                FROM hub_cleber.usuarios_roles_modulo rm
                                JOIN hub_cleber.usuarios_organizaciones uo
                                  ON uo.id_usuario = rm.id_usuario AND uo.id_organizacion = rm.id_organizacion
                               WHERE rm.id_usuario = u.id_usuario AND rm.modulo = p_modulo), '{}'::jsonb))
    FROM hub_cleber.usuarios u
   WHERE u.email = lower(btrim(p_email)) AND u.es_activo;
$$;
