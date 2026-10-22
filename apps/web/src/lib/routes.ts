/** Rutas con módulo: /servicio/conversaciones, /ventas/bots... `general` es la vista de todos los módulos. */
export function modulePath(moduleId: string | null | undefined, path: string): string {
  return `/${moduleId || "general"}${path}`;
}

export function conversationPath(id: string, moduleId?: string | null): string {
  return modulePath(moduleId, `/conversaciones/${id}`);
}
