-- Catálogo de roles por módulo (Q37). Idempotente: actualiza nombre, descripción, administrador, supervisor y orden.
-- Ventas y servicio conservan los tres roles del hub actual (admin / agent / viewer), con códigos en mayúsculas.
-- Valuación: sus permisos están en valuacion.roles_permisos (repo toma-unidades-en-taller). GERENTE es supervisor:
-- ve las conversaciones de sus agencias sin equipo (2026-11-20).
INSERT INTO hub_cleber.roles_modulo (modulo, rol, nombre, descripcion, es_administrador, es_supervisor, orden) VALUES
  ('ventas',    'ADMINISTRADOR', 'Administrador', 'Configura el módulo y administra a sus usuarios en la marca', true,  false, 1),
  ('ventas',    'AGENTE',        'Agente',        'Atiende conversaciones',                                      false, false, 2),
  ('ventas',    'CONSULTA',      'Consulta',      'Solo lectura',                                                false, false, 3),
  ('servicio',  'ADMINISTRADOR', 'Administrador', 'Configura el módulo y administra a sus usuarios en la marca', true,  false, 1),
  ('servicio',  'AGENTE',        'Agente',        'Atiende conversaciones',                                      false, false, 2),
  ('servicio',  'CONSULTA',      'Consulta',      'Solo lectura',                                                false, false, 3),
  ('valuacion', 'ADMINISTRADOR', 'Administrador', 'Configura valuación y administra a sus usuarios en la marca', true,  false, 1),
  ('valuacion', 'GERENTE',       'Gerente',       'Supervisa las ofertas y conversaciones de sus agencias y da el VoBo de montos', false, true, 2),
  ('valuacion', 'VALUADOR',      'Valuador',      'Valúa y opera ofertas',                                       false, false, 3),
  ('valuacion', 'CONSULTA',      'Consulta',      'Solo lectura',                                                false, false, 4),
  ('verificacion', 'ADMINISTRADOR', 'Administrador', 'Configura verificación y administra a sus usuarios en la marca', true,  false, 1),
  ('verificacion', 'CONSULTA',      'Consulta',      'Solo lectura',                                                false, false, 2)
ON CONFLICT (modulo, rol) DO UPDATE SET
  nombre           = EXCLUDED.nombre,
  descripcion      = EXCLUDED.descripcion,
  es_administrador = EXCLUDED.es_administrador,
  es_supervisor    = EXCLUDED.es_supervisor,
  orden            = EXCLUDED.orden,
  actualizado_en   = now()
WHERE (roles_modulo.nombre, roles_modulo.descripcion, roles_modulo.es_administrador, roles_modulo.es_supervisor, roles_modulo.orden)
  IS DISTINCT FROM (EXCLUDED.nombre, EXCLUDED.descripcion, EXCLUDED.es_administrador, EXCLUDED.es_supervisor, EXCLUDED.orden);
