-- Equipo de un módulo en una marca (sale de teams de Firestore). Los usuarios se ligan a él por
-- usuarios_roles_modulo.id_equipo (Q38).
--
-- El id es text: los equipos importados de Firestore conservan su id (el mismo que ya guarda
-- usuarios_roles_modulo.id_equipo), los nuevos reciben un UUID en texto. Así la importación no traduce referencias.
-- Las conversaciones activas por agente se calculan, no se guardan.
CREATE TABLE IF NOT EXISTS hub_cleber.equipos (
  id_equipo                  text        NOT NULL DEFAULT gen_random_uuid()::text,
  id_marca                   text        NOT NULL,
  modulo                     text        NOT NULL,
  nombre                     text        NOT NULL,
  modo_asignacion            text        NOT NULL DEFAULT 'manual',   -- assignmentMode
  max_conversaciones_agente  integer,                                 -- NULL = sin límite
  accion_opt_out             text,                                    -- close / handoff; NULL = lo decide el bot
  umbrales_semaforo          jsonb       NOT NULL DEFAULT '{}',
  ultimo_agente_asignado     uuid,                                    -- puntero del round robin (Hub.asignaAgenteAutomatico)
  es_activo                  boolean     NOT NULL DEFAULT true,
  creado_en                  timestamptz NOT NULL DEFAULT now(),
  actualizado_en             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_equipos PRIMARY KEY (id_equipo),
  CONSTRAINT fk_equipos_marca FOREIGN KEY (id_marca) REFERENCES hub_cleber.marcas (id_marca),
  CONSTRAINT chk_equipos_modulo CHECK (modulo IN ('ventas', 'servicio', 'valuacion')),
  CONSTRAINT chk_equipos_accion_opt_out CHECK (accion_opt_out IN ('close', 'handoff')),
  CONSTRAINT chk_equipos_max CHECK (max_conversaciones_agente > 0),
  CONSTRAINT chk_equipos_umbrales CHECK (jsonb_typeof(umbrales_semaforo) = 'object')
);

CREATE INDEX IF NOT EXISTS ix_equipos_marca_modulo ON hub_cleber.equipos (id_marca, modulo);
