"""Tool para Abacus: `Ejecutar_Accion_Externo`, la señal del bot al hub (eco).

Abacus admite pocos tools por bot (10), así que el bot usa dos genéricos:

    Ejecutar_Accion_Interno   pide una acción al hub y espera su resultado para seguir hablando (hub-acciones-bot, D14;
                              borrador en ejecutar_accion.py). Para Registrar_Cita, Crear_Lead...
    Ejecutar_Accion_Externo   este: solo avisa. No llama a nadie; devuelve lo que recibe y el hub, al terminar el turno, lee la
                              llamada en la respuesta de Abacus y actúa (ai/parsing.py::expande_acciones_externas).

Se pega tal cual como tool de código en el ChatLLM (solo biblioteca estándar), con estos parámetros:

    accion   STRING  requerido  Transferir_a_Asesor | Clasificar_Motivo (las que el hub reconozca)
    motivo   STRING  requerido  Transferir_a_Asesor: por qué se pasa a un asesor.
                                Clasificar_Motivo: el valor del vocabulario del bot (p. ej. oferta_aceptada_venta).
    datos    STRING  opcional   objeto JSON como texto, para señales que necesiten más (Abacus no admite JSON en los tools)

Una señal nueva no necesita otro tool en Abacus: basta su manejador en el hub y explicarla en las instrucciones del bot.
"""
import json


def ejecutar_accion_externo(accion: str, motivo: str, datos: str = None) -> dict:
    """Avisa al hub de una decisión de la conversación. No regresa información nueva: el hub actúa después de tu respuesta.

    Args:
        accion: qué señal mandas. "Transferir_a_Asesor" para pasar la conversación a un asesor;
            "Clasificar_Motivo" para registrar la decisión del cliente.
        motivo: con Transferir_a_Asesor, por qué (p. ej. "pregunta por financiamiento"); con Clasificar_Motivo, uno de los
            valores que indican tus instrucciones (p. ej. "oferta_aceptada_venta").
        datos: opcional, objeto JSON como texto con información adicional que pidan tus instrucciones.

    Returns:
        `{"ok": true, "accion": ..., "motivo": ...}`: la señal quedó registrada; sigue con tu respuesta al cliente.
    """
    respuesta = {"ok": True, "accion": accion, "motivo": motivo}
    if datos:
        try:
            respuesta["datos"] = json.loads(datos)
        except ValueError:
            return {"ok": False, "error": "`datos` debe ser un objeto JSON válido en texto"}
    return respuesta
