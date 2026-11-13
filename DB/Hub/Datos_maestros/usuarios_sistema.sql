-- Usuarios de sistema (emails de servicio que llaman por /internal). Idempotente: no toca los que ya existen.
--   sistema@hub-conversaciones.internal  backend del hub (Cloud Functions): webhooks, bot, jobs, importación
--   sistema@toma-unidades.internal       Lambda de valuación
-- No llevan roles del catálogo (Q36): cada módulo reconoce su propio email de servicio (valuación le da SISTEMA).
INSERT INTO hub_cleber.usuarios (email, nombre, es_sistema)
VALUES ('sistema@hub-conversaciones.internal', 'Sistema — hub de conversaciones', true),
       ('sistema@toma-unidades.internal',      'Sistema — toma de unidades (valuación)', true)
ON CONFLICT (email) DO NOTHING;
