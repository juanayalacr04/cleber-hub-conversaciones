-- Usuario del hub (users de Firestore). La identidad es el email: el Lambda authorizer valida el id_token de Google
-- y API Gateway inyecta X-User-Email.
--
-- No hay rol global (Q36): el rol es por marca y módulo (usuarios_roles_modulo). Solo es_super_admin vale en todo.
--
-- Usuarios de sistema (es_sistema): emails de servicio (*.internal) que llaman por /internal. No tienen roles en el
-- catálogo; cada módulo reconoce su propio email de servicio (ej. valuación: sistema@toma-unidades.internal → SISTEMA).
CREATE TABLE IF NOT EXISTS hub_cleber.usuarios (
  id_usuario        bigint      GENERATED ALWAYS AS IDENTITY,
  email             text        NOT NULL,                 -- siempre en minúsculas (sin citext: no requiere la extensión)
  nombre            text        NOT NULL DEFAULT '',
  foto_url          text,
  es_super_admin    boolean     NOT NULL DEFAULT false,
  es_sistema        boolean     NOT NULL DEFAULT false,
  es_activo         boolean     NOT NULL DEFAULT true,    -- false = no entra (sin borrar su historial)
  es_disponible     boolean     NOT NULL DEFAULT true,    -- isAvailable: recibe asignaciones automáticas
  estado            text        NOT NULL DEFAULT 'offline', -- presencia (status): online / away / offline
  invitado_por      bigint,
  ultimo_acceso_en  timestamptz,                          -- lastLoginAt; NULL = invitado que no ha entrado
  id_origen         text,                                 -- uid de Firebase (id del documento users/{uid})
  creado_en         timestamptz NOT NULL DEFAULT now(),
  actualizado_en    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_usuarios PRIMARY KEY (id_usuario),
  CONSTRAINT uq_usuarios_email UNIQUE (email),
  CONSTRAINT uq_usuarios_id_origen UNIQUE (id_origen),
  CONSTRAINT fk_usuarios_invitado_por FOREIGN KEY (invitado_por) REFERENCES hub_cleber.usuarios (id_usuario) ON DELETE SET NULL,
  CONSTRAINT chk_usuarios_email CHECK (email = lower(btrim(email)) AND email ~ '^[^@\s]+@[^@\s]+$'),
  CONSTRAINT chk_usuarios_sistema CHECK (
    (es_sistema AND NOT es_super_admin AND email LIKE '%.internal')
    OR (NOT es_sistema AND email NOT LIKE '%.internal')),
  CONSTRAINT chk_usuarios_estado CHECK (estado IN ('online', 'away', 'offline'))
);
