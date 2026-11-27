-- Módulos activos por marca. Solo el super admin los enciende o apaga (Hub.guardaModuloMarca); la lista de módulos
-- existentes vive en el código de la web (lib/modules.ts) y no se da de alta aquí.
-- Sin fila = el módulo no está activo en la marca.
CREATE TABLE IF NOT EXISTS hub_cleber.marcas_modulos (
  id_marca          text        NOT NULL,
  modulo            text        NOT NULL,
  es_activo         boolean     NOT NULL DEFAULT false,
  creado_en         timestamptz NOT NULL DEFAULT now(),
  actualizado_en    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_marcas_modulos PRIMARY KEY (id_marca, modulo),
  CONSTRAINT fk_marcas_modulos_marca FOREIGN KEY (id_marca) REFERENCES hub_cleber.marcas (id_marca),
  CONSTRAINT chk_marcas_modulos_modulo CHECK (modulo IN ('ventas', 'servicio', 'valuacion', 'verificacion'))
);
