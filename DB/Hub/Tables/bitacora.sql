-- Bitácora de una conversación (sale de conversations/{id}/actionLog de Firestore). Solo inserción.
--
-- origen: bot (acción pedida por el bot), usuario (dashboard), sistema (pipeline, jobs, contrato ①).
-- id_turno agrupa lo que el bot pidió por el endpoint durante un turno (core/action_log.py).
CREATE TABLE IF NOT EXISTS hub_cleber.bitacora (
  id_bitacora      bigint      GENERATED ALWAYS AS IDENTITY,
  id_conversacion  text        NOT NULL,
  accion           text        NOT NULL,
  origen           text        NOT NULL,
  id_usuario       uuid,
  id_turno         text,
  datos            jsonb       NOT NULL DEFAULT '{}',
  registrado_en    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_bitacora PRIMARY KEY (id_bitacora),
  CONSTRAINT fk_bitacora_conversacion FOREIGN KEY (id_conversacion) REFERENCES hub_cleber.conversaciones (id_conversacion),
  CONSTRAINT chk_bitacora_origen CHECK (origen IN ('bot', 'usuario', 'sistema')),
  CONSTRAINT chk_bitacora_datos CHECK (jsonb_typeof(datos) = 'object')
);

CREATE INDEX IF NOT EXISTS ix_bitacora_conversacion ON hub_cleber.bitacora (id_conversacion, id_bitacora);
CREATE INDEX IF NOT EXISTS ix_bitacora_turno ON hub_cleber.bitacora (id_conversacion, id_turno) WHERE id_turno IS NOT NULL;
