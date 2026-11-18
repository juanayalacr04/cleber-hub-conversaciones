/*
 * alta_numero_valuacion.sql — da de alta (o actualiza) el número de WhatsApp de Valuación de una marca en hub_cleber.
 *
 * Mientras no existan las pantallas de configuración sobre hub_cleber. Llama a Hub.guardaEquipo y Hub.guardaNumero como
 * sistema, igual que lo haría el backend. Re-ejecutable: si el equipo "Valuación" o el número activo de Valuación de la marca
 * ya existen, los actualiza.
 *
 * Variables (psql -v):
 *   marca         código de la marca (TO, HO...)
 *   telefono      número de WhatsApp (+52... o 10 dígitos)
 *   nombre        nombre del número en el hub (p. ej. "Valuación Toyota")
 *   proveedor     twilio / meta / valuetext
 *   id_proveedor  Meta: phone_number_id · ValueText: Sender ID · Twilio: no se usa (la cuenta es la del ambiente)
 *
 * Ejemplo (solo desarrollo/QA):
 *   psql -h <host> -U <usuario> -d <database> -v marca=TO -v telefono=+5215512345678 -v "nombre=Valuación Toyota" `
 *        -v proveedor=twilio -f dev/alta_numero_valuacion.sql
 *
 * La plantilla de la oferta (plantillas.ofertaValuacion) y el bot se agregan después con Hub.guardaNumero. Twilio usa la
 * cuenta del ambiente (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN en el secreto SECRET_NAME); las credenciales de Meta van en
 * Secrets Manager, en hub/<ambiente>/numbers/<idNumero> (el script imprime el idNumero).
 */

\encoding UTF8
\set ON_ERROR_STOP on
\if :{?id_proveedor}
\else
\set id_proveedor ''
\endif

BEGIN;

SELECT set_config('request.headers', '{"x-user-email":"sistema@hub-conversaciones.internal"}', true) AS ignorar \gset

-- 1. Equipo "Valuación" de la marca (lo reutiliza si ya existe)
SELECT coalesce((SELECT id_equipo FROM hub_cleber.equipos
                  WHERE id_marca = upper(:'marca') AND modulo = 'valuacion' AND nombre = 'Valuación'
                  LIMIT 1), '') AS id_equipo_existente \gset

SELECT r->>'successful' AS ok, r->>'errorCode' AS error, r->>'errorMessage' AS mensaje, r#>>'{info,equipo,idEquipo}' AS id_equipo
  FROM hub_cleber.guarda_equipo(jsonb_build_object('action', 'Hub.guardaEquipo', 'params',
         jsonb_strip_nulls(jsonb_build_object('idEquipo', nullif(:'id_equipo_existente', ''), 'idMarca', :'marca',
                                              'modulo', 'valuacion', 'nombre', 'Valuación')))) AS r \gset
\if :ok
\echo 'Equipo Valuación:' :id_equipo
\else
\echo 'FALLÓ Hub.guardaEquipo:' :error :mensaje
ROLLBACK;
\quit
\endif

-- 2. Número de Valuación de la marca (lo actualiza si ya hay uno activo)
SELECT coalesce((SELECT id_numero FROM hub_cleber.numeros
                  WHERE id_marca = upper(:'marca') AND modulo = 'valuacion' AND es_activo
                  LIMIT 1), '') AS id_numero_existente \gset

SELECT r->>'successful' AS ok, r->>'errorCode' AS error, r->>'errorMessage' AS mensaje, r->>'info' AS detalle,
       r#>>'{info,numero,idNumero}' AS id_numero, r#>>'{info,numero,telefono}' AS telefono_guardado
  FROM hub_cleber.guarda_numero(jsonb_build_object('action', 'Hub.guardaNumero', 'params', jsonb_strip_nulls(jsonb_build_object(
         'idNumero', nullif(:'id_numero_existente', ''),
         'idMarca', :'marca', 'modulo', 'valuacion', 'telefono', :'telefono', 'nombre', :'nombre',
         'proveedor', :'proveedor', 'idEquipo', :'id_equipo',
         'configProveedor', CASE :'proveedor'
                              WHEN 'twilio'    THEN '{}'::jsonb
                              WHEN 'meta'      THEN jsonb_build_object('metaPhoneNumberId', :'id_proveedor')
                              WHEN 'valuetext' THEN jsonb_build_object('valuetextSenderId', :'id_proveedor')
                            END)))) AS r \gset
\if :ok
\echo 'Número de Valuación:' :id_numero :telefono_guardado
SELECT :'proveedor' = 'meta' AS es_meta \gset
\if :es_meta
\echo 'Credenciales de Meta en Secrets Manager: hub/<ambiente>/numbers/':id_numero
\endif
\else
\echo 'FALLÓ Hub.guardaNumero:' :error :mensaje :detalle
ROLLBACK;
\quit
\endif

COMMIT;
