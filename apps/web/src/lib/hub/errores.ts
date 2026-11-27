/** Mensaje para el usuario de un error del envelope de las acciones Hub.* y de las causas del envío por WhatsApp. `modulo` es el nombre del módulo en los textos. */
export function mensajeError(r: { errorCode: string; errorMessage: string; info?: unknown }, modulo = "Valuación"): string {
  const motivo = ((r.info as { hub?: { motivo?: string } } | undefined)?.hub ?? {}).motivo;
  if (motivo === "CONVERSACION_ABIERTA") return `El cliente ya tiene una conversación abierta en WhatsApp de ${modulo}. Reintenta cuando se cierre.`;
  if (motivo === "SIN_NUMERO") return `La marca no tiene configurado su número de WhatsApp de ${modulo}.`;
  switch (r.errorCode) {
    case "PLANTILLA_NO_CONFIGURADA": return `Falta configurar la plantilla de WhatsApp${modulo === "Valuación" ? " de la oferta" : ""} en el número de ${modulo}.`;
    case "ERROR_PROVEEDOR": return `El proveedor de WhatsApp rechazó el envío (${r.errorMessage}). Puedes reintentar.`;
    case "ERROR_HUB": return "No se pudo contactar al hub de conversaciones. Puedes reintentar.";
    case "SIN_AUTORIZADORES": return "No hay gerente ni administrador con esta agencia para avisarle del VoBo; queda pendiente en Ofertas.";
    case "ERROR_CORREO": return "No se pudo avisar por correo del VoBo; queda pendiente en Ofertas.";
    case "SIN_PERMISO": return "No tienes permiso para esta acción en esta marca o agencia.";
    case "SESION_EXPIRADA": return "Tu sesión venció. Vuelve a iniciar sesión.";
    case "CONFIGURACION": return "Error de configuración del servidor. Avisa a soporte.";
    case "SIN_CONEXION": return "No se pudo contactar al servidor. Revisa tu conexión.";
    default: return r.errorMessage || "No se pudo completar la operación.";
  }
}
