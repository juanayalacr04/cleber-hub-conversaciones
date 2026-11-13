/**
    Hub.importaUsuarios — sistema (script de carga desde Firestore: dev/carga_usuarios_hub.py)

    Carga o actualiza organizaciones y usuarios. Idempotente: correrla dos veces con los mismos datos
    deja la base igual. Lo que viene en la petición reemplaza lo guardado; lo que NO viene no se toca
    (un usuario ausente en la carga se queda como está). Todo o nada: un error revierte la carga completa.

    Params:
      organizaciones: [ { idOrganizacion, nombre,
                          zonaHoraria?, horario? (objeto), sfCodigoMarca?, sfCalendario?,
                          salesforceConfig? (objeto, sin secretos), plan?, esActiva?, creadoEn? } ]
      usuarios:       [ { email, rol (admin|agent|viewer), idOrigen? (uid de Firebase), nombre?, fotoUrl?,
                          esSuperAdmin?, esActivo?, esDisponible?, estado?, invitadoPor? (idOrigen de quien invitó),
                          ultimoAccesoEn?, creadoEn?,
                          organizaciones: [ { idOrganizacion, idEquipo?, agencias? } ]   reemplaza las del usuario
                                          (agencias: ids del API de agencias, por valor; el hub no tiene catálogo)
                          rolesModulo?:   { "<modulo>": "<ROL>" }                         reemplaza los del usuario } ]
      Las dos listas son opcionales (default []).

    Un usuario se encuentra por idOrigen y, si no, por email (así se corrige un email cambiado en Firestore).
    No importa usuarios de sistema: esos se dan de alta en Datos_maestros/usuarios_sistema.sql.

    Errores: CAMPO_REQUERIDO / CAMPO_INVALIDO con info.lista e info.indice (base 0) del elemento que falló.
    Info: { organizaciones: n, usuarios: { creados: n, actualizados: n } }

    @Acceso Publica (sistema)
*/

-- Relanza un error controlado agregando la lista y el índice del elemento que lo causó.
CREATE OR REPLACE FUNCTION hub_cleber.error_en_elemento(p_lista text, p_indice integer, p_codigo text, p_mensaje text, p_info text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM hub_cleber.error_de_aplicacion(p_codigo,
    format('%s[%s]: %s', p_lista, p_indice, p_mensaje),
    coalesce(nullif(p_info, '')::jsonb, '{}'::jsonb) || jsonb_build_object('lista', p_lista, 'indice', p_indice));
END;
$$;

CREATE OR REPLACE FUNCTION hub_cleber.importa_usuarios(peticion jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_params        jsonb;
  v_lista         text;
  v_indice        integer;
  e               jsonb;
  m               jsonb;
  v_id_org        text;
  v_codigo_marca  text;
  v_email         text;
  v_origen        text;
  v_id_usuario    bigint;
  v_otro          bigint;
  v_orgs_usuario  text[];
  v_roles         jsonb;
  v_modulo        text;
  v_n_orgs        integer := 0;
  v_creados       integer := 0;
  v_actualizados  integer := 0;
  v_invitaciones  jsonb := '[]'::jsonb;
  v_c_codigo text; v_c_mensaje text; v_c_info text;
  v_err_estado text; v_err_mensaje text; v_err_detalle text; v_err_info text; v_err_contexto text;
BEGIN
  v_params := hub_cleber.valida_peticion(peticion, 'Hub.importaUsuarios');
  PERFORM hub_cleber.exige_sistema(hub_cleber.usuario_actual());

  -- ── Organizaciones ───────────────────────────────────────────────────────────────────────
  v_lista := 'organizaciones';
  FOR e, v_indice IN SELECT x, (n - 1)::integer FROM jsonb_array_elements(hub_cleber.param_arreglo(v_params, 'organizaciones', false)) WITH ORDINALITY t(x, n) LOOP
    BEGIN
      IF jsonb_typeof(e) <> 'object' THEN
        PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'Cada organización debe ser un objeto');
      END IF;
      v_id_org := hub_cleber.param_texto(e, 'idOrganizacion');
      IF v_id_org !~ '^[A-Za-z0-9_-]+$' THEN
        PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'idOrganizacion solo admite letras, dígitos, _ y -', '{"campo":"idOrganizacion"}');
      END IF;
      v_codigo_marca := hub_cleber.param_texto(e, 'sfCodigoMarca', false);
      IF v_codigo_marca IS NOT NULL AND EXISTS (
           SELECT 1 FROM hub_cleber.organizaciones WHERE sf_codigo_marca = v_codigo_marca AND id_organizacion <> v_id_org) THEN
        PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('El código de marca %s ya es de otra organización', v_codigo_marca),
          '{"campo":"sfCodigoMarca"}');
      END IF;
      IF coalesce(hub_cleber.param_texto(e, 'plan', false), 'free') NOT IN ('free', 'pro', 'enterprise') THEN
        PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'plan debe ser free, pro o enterprise', '{"campo":"plan"}');
      END IF;

      INSERT INTO hub_cleber.organizaciones AS o (id_organizacion, nombre, zona_horaria, horario, sf_codigo_marca, sf_calendario,
                                           salesforce_config, plan, es_activa, creado_en)
      VALUES (v_id_org,
              hub_cleber.param_texto(e, 'nombre'),
              coalesce(hub_cleber.param_texto(e, 'zonaHoraria', false), 'America/Mexico_City'),
              coalesce(hub_cleber.param_objeto(e, 'horario', false), '{}'),
              v_codigo_marca,
              hub_cleber.param_texto(e, 'sfCalendario', false),
              coalesce(hub_cleber.param_objeto(e, 'salesforceConfig', false), '{}'),
              coalesce(hub_cleber.param_texto(e, 'plan', false), 'free'),
              coalesce(hub_cleber.param_booleano(e, 'esActiva', false), true),
              coalesce(hub_cleber.param_fecha_hora(e, 'creadoEn', false), now()))
      ON CONFLICT (id_organizacion) DO UPDATE SET
        nombre            = EXCLUDED.nombre,
        zona_horaria      = EXCLUDED.zona_horaria,
        horario           = EXCLUDED.horario,
        sf_codigo_marca   = EXCLUDED.sf_codigo_marca,
        sf_calendario     = EXCLUDED.sf_calendario,
        salesforce_config = EXCLUDED.salesforce_config,
        plan              = EXCLUDED.plan,
        es_activa         = EXCLUDED.es_activa,
        actualizado_en    = now();
      v_n_orgs := v_n_orgs + 1;
    EXCEPTION WHEN SQLSTATE 'HB001' THEN
      GET STACKED DIAGNOSTICS v_c_codigo = MESSAGE_TEXT, v_c_mensaje = PG_EXCEPTION_DETAIL, v_c_info = PG_EXCEPTION_HINT;
      PERFORM hub_cleber.error_en_elemento(v_lista, v_indice, v_c_codigo, v_c_mensaje, v_c_info);
    END;
  END LOOP;

  -- ── Usuarios ─────────────────────────────────────────────────────────────────────────────
  v_lista := 'usuarios';
  -- Emails o idOrigen repetidos dentro de la misma carga: se rechaza antes de escribir.
  SELECT k INTO v_email FROM (
    SELECT lower(btrim(x->>'email')) AS k FROM jsonb_array_elements(hub_cleber.param_arreglo(v_params, 'usuarios', false)) x
     WHERE jsonb_typeof(x) = 'object'
    UNION ALL
    SELECT 'idOrigen ' || (x->>'idOrigen') FROM jsonb_array_elements(hub_cleber.param_arreglo(v_params, 'usuarios', false)) x
     WHERE jsonb_typeof(x) = 'object' AND x->>'idOrigen' IS NOT NULL) d
   WHERE k IS NOT NULL GROUP BY k HAVING count(*) > 1 LIMIT 1;
  IF v_email IS NOT NULL THEN
    PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('Usuario repetido en la carga: %s', v_email), '{"lista":"usuarios"}');
  END IF;

  FOR e, v_indice IN SELECT x, (n - 1)::integer FROM jsonb_array_elements(hub_cleber.param_arreglo(v_params, 'usuarios', false)) WITH ORDINALITY t(x, n) LOOP
    BEGIN
      IF jsonb_typeof(e) <> 'object' THEN
        PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'Cada usuario debe ser un objeto');
      END IF;
      v_email  := hub_cleber.param_email(e, 'email');
      v_origen := hub_cleber.param_texto(e, 'idOrigen', false);
      IF v_email LIKE '%.internal' THEN
        PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'Los usuarios de sistema no se importan', '{"campo":"email"}');
      END IF;
      IF hub_cleber.param_texto(e, 'rol') NOT IN ('admin', 'agent', 'viewer') THEN
        PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'rol debe ser admin, agent o viewer', '{"campo":"rol"}');
      END IF;
      IF coalesce(hub_cleber.param_texto(e, 'estado', false), 'offline') NOT IN ('online', 'away', 'offline') THEN
        PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'estado debe ser online, away u offline', '{"campo":"estado"}');
      END IF;

      v_id_usuario := NULL;
      IF v_origen IS NOT NULL THEN
        SELECT id_usuario INTO v_id_usuario FROM hub_cleber.usuarios WHERE id_origen = v_origen;
      END IF;
      IF v_id_usuario IS NULL THEN
        SELECT id_usuario INTO v_id_usuario FROM hub_cleber.usuarios WHERE email = v_email;
      END IF;
      SELECT id_usuario INTO v_otro FROM hub_cleber.usuarios WHERE email = v_email AND id_usuario IS DISTINCT FROM v_id_usuario;
      IF v_otro IS NOT NULL THEN
        PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('El email %s ya es de otro usuario', v_email), '{"campo":"email"}');
      END IF;

      IF v_id_usuario IS NULL THEN
        INSERT INTO hub_cleber.usuarios (email, nombre, foto_url, rol, es_super_admin, es_activo, es_disponible, estado,
                                  ultimo_acceso_en, id_origen, creado_en)
        VALUES (v_email,
                coalesce(hub_cleber.param_texto(e, 'nombre', false), ''),
                hub_cleber.param_texto(e, 'fotoUrl', false),
                hub_cleber.param_texto(e, 'rol'),
                coalesce(hub_cleber.param_booleano(e, 'esSuperAdmin', false), false),
                coalesce(hub_cleber.param_booleano(e, 'esActivo', false), true),
                coalesce(hub_cleber.param_booleano(e, 'esDisponible', false), true),
                coalesce(hub_cleber.param_texto(e, 'estado', false), 'offline'),
                hub_cleber.param_fecha_hora(e, 'ultimoAccesoEn', false),
                v_origen,
                coalesce(hub_cleber.param_fecha_hora(e, 'creadoEn', false), now()))
        RETURNING id_usuario INTO v_id_usuario;
        v_creados := v_creados + 1;
      ELSE
        UPDATE hub_cleber.usuarios SET
          email            = v_email,
          nombre           = coalesce(hub_cleber.param_texto(e, 'nombre', false), ''),
          foto_url         = hub_cleber.param_texto(e, 'fotoUrl', false),
          rol              = hub_cleber.param_texto(e, 'rol'),
          es_super_admin   = coalesce(hub_cleber.param_booleano(e, 'esSuperAdmin', false), false),
          es_activo        = coalesce(hub_cleber.param_booleano(e, 'esActivo', false), true),
          es_disponible    = coalesce(hub_cleber.param_booleano(e, 'esDisponible', false), true),
          estado           = coalesce(hub_cleber.param_texto(e, 'estado', false), 'offline'),
          ultimo_acceso_en = hub_cleber.param_fecha_hora(e, 'ultimoAccesoEn', false),
          id_origen        = coalesce(v_origen, id_origen),
          actualizado_en   = now()
        WHERE id_usuario = v_id_usuario;
        v_actualizados := v_actualizados + 1;
      END IF;

      -- Marcas: reemplaza las del usuario
      v_orgs_usuario := '{}';
      FOR m IN SELECT * FROM jsonb_array_elements(hub_cleber.param_arreglo(e, 'organizaciones')) LOOP
        IF jsonb_typeof(m) <> 'object' THEN
          PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', 'Cada organización del usuario debe ser un objeto', '{"campo":"organizaciones"}');
        END IF;
        v_id_org := hub_cleber.param_texto(m, 'idOrganizacion');
        IF NOT EXISTS (SELECT 1 FROM hub_cleber.organizaciones WHERE id_organizacion = v_id_org) THEN
          PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('No existe la organización %s', v_id_org),
            '{"campo":"organizaciones","causa":"NO_EXISTE"}');
        END IF;
        IF v_id_org = ANY (v_orgs_usuario) THEN
          PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('Organización repetida: %s', v_id_org), '{"campo":"organizaciones"}');
        END IF;
        v_orgs_usuario := v_orgs_usuario || v_id_org;

        INSERT INTO hub_cleber.usuarios_organizaciones (id_usuario, id_organizacion, id_equipo, agencias)
        VALUES (v_id_usuario, v_id_org, hub_cleber.param_texto(m, 'idEquipo', false),
                coalesce(hub_cleber.param_textos(m, 'agencias', false), '{}'))
        ON CONFLICT (id_usuario, id_organizacion) DO UPDATE SET
          id_equipo      = EXCLUDED.id_equipo,
          agencias       = EXCLUDED.agencias,
          actualizado_en = now();
      END LOOP;
      DELETE FROM hub_cleber.usuarios_organizaciones
       WHERE id_usuario = v_id_usuario AND NOT (id_organizacion = ANY (v_orgs_usuario));

      -- Roles por módulo: reemplaza los del usuario
      v_roles := coalesce(hub_cleber.param_objeto(e, 'rolesModulo', false), '{}'::jsonb);
      FOR v_modulo IN SELECT jsonb_object_keys(v_roles) LOOP
        IF v_modulo NOT IN ('ventas', 'servicio', 'valuacion') THEN
          PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('Módulo desconocido: %s', v_modulo), '{"campo":"rolesModulo"}');
        END IF;
        IF jsonb_typeof(v_roles->v_modulo) <> 'string' OR (v_roles->>v_modulo) !~ '^[A-Z][A-Z_]*$' OR (v_roles->>v_modulo) = 'SISTEMA' THEN
          PERFORM hub_cleber.error_de_aplicacion('CAMPO_INVALIDO', format('Rol inválido en %s (mayúsculas y _, sin SISTEMA)', v_modulo),
            '{"campo":"rolesModulo"}');
        END IF;
        INSERT INTO hub_cleber.usuarios_roles_modulo (id_usuario, modulo, rol)
        VALUES (v_id_usuario, v_modulo, v_roles->>v_modulo)
        ON CONFLICT (id_usuario, modulo) DO UPDATE SET rol = EXCLUDED.rol, actualizado_en = now();
      END LOOP;
      DELETE FROM hub_cleber.usuarios_roles_modulo
       WHERE id_usuario = v_id_usuario AND NOT (v_roles ? modulo);

      v_invitaciones := v_invitaciones || jsonb_build_object('idUsuario', v_id_usuario, 'invitadoPor', hub_cleber.param_texto(e, 'invitadoPor', false));
    EXCEPTION WHEN SQLSTATE 'HB001' THEN
      GET STACKED DIAGNOSTICS v_c_codigo = MESSAGE_TEXT, v_c_mensaje = PG_EXCEPTION_DETAIL, v_c_info = PG_EXCEPTION_HINT;
      PERFORM hub_cleber.error_en_elemento(v_lista, v_indice, v_c_codigo, v_c_mensaje, v_c_info);
    END;
  END LOOP;

  -- Quién invitó a quién: al final, cuando ya existen todos (el que invitó puede venir después en la lista).
  -- Si quien invitó no está en el hub, queda NULL.
  UPDATE hub_cleber.usuarios u SET invitado_por = i.id_invito
    FROM (SELECT (x->>'idUsuario')::bigint AS id_usuario, inv.id_usuario AS id_invito
            FROM jsonb_array_elements(v_invitaciones) x
            LEFT JOIN hub_cleber.usuarios inv ON inv.id_origen = x->>'invitadoPor') i
   WHERE u.id_usuario = i.id_usuario AND u.invitado_por IS DISTINCT FROM i.id_invito;

  RETURN cleber.construye_respuesta_exitosa(jsonb_build_object(
    'organizaciones', v_n_orgs,
    'usuarios',       jsonb_build_object('creados', v_creados, 'actualizados', v_actualizados)));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_err_estado = RETURNED_SQLSTATE, v_err_mensaje = MESSAGE_TEXT,
    v_err_detalle = PG_EXCEPTION_DETAIL, v_err_info = PG_EXCEPTION_HINT, v_err_contexto = PG_EXCEPTION_CONTEXT;
  RETURN hub_cleber.maneja_error(peticion, v_err_estado, v_err_mensaje, v_err_detalle, v_err_info, v_err_contexto);
END;
$$;
