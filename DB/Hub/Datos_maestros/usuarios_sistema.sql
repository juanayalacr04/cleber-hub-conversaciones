-- Usuarios de sistema (emails de servicio que llaman por /internal). Idempotente: no toca los que ya existen.
--   sistema@hub-conversaciones.internal  backend del hub (Cloud Functions): webhooks, bot, jobs, importación
--   sistema@toma-unidades.internal       Lambda de valuación: rol SISTEMA en el módulo valuacion
INSERT INTO hub_cleber.usuarios (email, nombre, es_sistema)
VALUES ('sistema@hub-conversaciones.internal', 'Sistema — hub de conversaciones', true),
       ('sistema@toma-unidades.internal',      'Sistema — toma de unidades (valuación)', true)
ON CONFLICT (email) DO NOTHING;

INSERT INTO hub_cleber.usuarios_roles_modulo (id_usuario, modulo, rol)
SELECT id_usuario, 'valuacion', 'SISTEMA' FROM hub_cleber.usuarios WHERE email = 'sistema@toma-unidades.internal'
ON CONFLICT (id_usuario, modulo) DO NOTHING;
