/**
    Helpers de verificación de datos del cliente (módulo verificacion).

    @Acceso No-Publica
*/

-- Verificación: { idVerificacion, idMarca, tipo, valor, idExterno, idConversacion, estado, resueltoEn, callback: { estado, intentos,
--                 ultimoError, ultimoIntentoEn, enviadoEn }, callbackSimulado, simularCallback, creadoEn, actualizadoEn }
-- simularCallback: la marca tiene encendida la simulación del callback a Salesforce (marcas.simular_callback_sf).
CREATE OR REPLACE FUNCTION hub_cleber.verificacion_json(v hub_cleber.verificacion_datos)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object('idVerificacion', v.id_verificacion::text, 'idMarca', v.id_marca, 'tipo', v.tipo, 'valor', v.valor,
                            'idExterno', v.id_externo, 'idConversacion', v.id_conversacion, 'estado', v.estado, 'resueltoEn', v.resuelto_en,
                            'callback', jsonb_build_object('estado', v.callback_estado, 'intentos', v.callback_intentos,
                                                           'ultimoError', v.callback_ultimo_error,
                                                           'ultimoIntentoEn', v.callback_ultimo_intento_en,
                                                           'enviadoEn', v.callback_enviado_en),
                            'callbackSimulado', v.callback_simulado,
                            'simularCallback', coalesce((SELECT m.simular_callback_sf FROM hub_cleber.marcas m
                                                          WHERE m.id_marca = v.id_marca), false),
                            'creadoEn', v.creado_en, 'actualizadoEn', v.actualizado_en);
$$;
