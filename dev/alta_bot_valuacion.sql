/*
 * alta_bot_valuacion.sql — da de alta (o actualiza) el bot de Valuación de una marca y lo deja como bot default del número.
 *
 * Mientras no existan las pantallas de bots sobre hub_cleber. Llama a Hub.guardaBot y Hub.guardaNumero como sistema, igual
 * que lo haría el backend. Re-ejecutable: si el bot (idBot) ya existe lo actualiza. Requiere que el número de Valuación de la
 * marca ya exista (dev/alta_numero_valuacion.sql o la pantalla Números de WhatsApp).
 *
 * El token y la llave de Abacus NO van aquí: están en el secreto del ambiente (SECRET_NAME), una llave por módulo
 * (ABACUS_DEPLOYMENT_TOKEN_VALUACION) y una para toda la organización (ABACUS_API_KEY). Ver core/datos/bots.py.
 *
 * Los datos del bot se editan en el bloque DATOS DEL BOT, más abajo (marca, id, nombre, tipo y deploymentId de Abacus).
 * Se pueden sobrescribir desde la línea de comandos con -v (p. ej. -v marca=HO); lo que no se pase usa lo del bloque.
 *
 * Ejecución (solo desarrollo/QA):
 *   psql -h <host> -U <usuario> -d <database> -f dev/alta_bot_valuacion.sql
 *   o, dentro de psql:  \i dev/alta_bot_valuacion.sql
 *
 * Si algo falla, el script hace ROLLBACK y termina con \quit, que cierra la sesión de psql.
 */

\encoding UTF8
\set ON_ERROR_STOP on

-- ============================ DATOS DEL BOT (editar aquí) ============================
\if :{?marca}
\else
\set marca TO
\endif
\if :{?id_bot}
\else
\set id_bot bot-valuacion-to
\endif
\if :{?nombre}
\else
\set nombre 'Bot Valuación Toyota'
\endif
\if :{?tipo}
\else
\set tipo chatllm
\endif
\if :{?deployment_id}
\else
\set deployment_id 102d50f2e8
\endif
-- =====================================================================================

BEGIN;

SELECT set_config('request.headers', '{"x-user-email":"sistema@hub-conversaciones.internal"}', true) AS ignorar \gset

-- 1. Bot
SELECT r->>'successful' AS ok, r->>'errorCode' AS error, r->>'errorMessage' AS mensaje, r->>'info' AS detalle,
       r#>>'{info,bot,idBot}' AS id_bot_guardado, r#>>'{info,creado}' AS creado
  FROM hub_cleber.guarda_bot(jsonb_build_object('action', 'Hub.guardaBot', 'params', jsonb_build_object(
         'idBot', :'id_bot', 'idMarca', upper(:'marca'), 'modulo', 'valuacion', 'nombre', :'nombre', 'tipo', :'tipo',
         'config', jsonb_build_object('abacusConfig', jsonb_build_object('deploymentId', :'deployment_id')),
         'esActivo', true))) AS r \gset
\if :ok
\echo 'Bot:' :id_bot_guardado '(creado:' :creado ')'
\else
\echo 'FALLÓ Hub.guardaBot:' :error :mensaje :detalle
ROLLBACK;
\quit
\endif

-- 2. Bot default del número de Valuación de la marca
SELECT coalesce((SELECT id_numero FROM hub_cleber.numeros
                  WHERE id_marca = upper(:'marca') AND modulo = 'valuacion' AND es_activo
                  LIMIT 1), '') AS id_numero \gset
SELECT :'id_numero' = '' AS sin_numero \gset
\if :sin_numero
\echo 'FALLÓ: la marca' :marca 'no tiene un número activo de Valuación. Dalo de alta primero (dev/alta_numero_valuacion.sql).'
ROLLBACK;
\quit
\endif

SELECT r->>'successful' AS ok, r->>'errorCode' AS error, r->>'errorMessage' AS mensaje, r->>'info' AS detalle,
       r#>>'{info,numero,telefono}' AS telefono, r#>>'{info,numero,idBotDefault}' AS bot_default
  FROM hub_cleber.guarda_numero(jsonb_build_object('action', 'Hub.guardaNumero', 'params', jsonb_build_object(
         'idNumero', :'id_numero', 'idBotDefault', :'id_bot'))) AS r \gset
\if :ok
\echo 'Número' :telefono ': bot default =' :bot_default
\else
\echo 'FALLÓ Hub.guardaNumero:' :error :mensaje :detalle
ROLLBACK;
\quit
\endif

COMMIT;
