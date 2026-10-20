/**
 * PUNTO DE EXTENSIÓN DE MÓDULOS (tarea 0.19)
 *
 * Un módulo nuevo se da de alta en este registro y nada más: el shell (menú, franja de color,
 * selector, rutas /[module]/...) lo recoge solo. No se toca `src/components/shell` ni `src/contexts`.
 *
 * Para agregar un módulo:
 *   1. Añadir su entrada a MODULES (id, etiqueta, vertical, icono).
 *   2. Definir su color en globals.css: `--<color>` y `--<color>-soft`, y
 *      `body[data-mod="<id>"] { --mod: ...; --mod-soft: ...; }`.
 *   3. Pantallas propias: carpeta `src/app/(app)/[module]/<pantalla>/page.tsx` que consulte
 *      su propia API. Una pantalla compartida (p. ej. la ficha de conversación) pide sus paneles
 *      al registro `conversationPanels` (`src/components/conversations/panels.tsx`): se agrega
 *      una entrada con la vertical del módulo y sus pestañas.
 *
 * `vertical` es el mismo valor que `teams.vertical` y `conversations.vertical` en Firestore.
 */
export type Vertical = "servicio" | "ventas";
export type ModuleId = Vertical | "general";
export type IconName = "wrench" | "tag" | "grid";

export interface ModuleDef {
  id: ModuleId;
  label: string;
  description: string;
  vertical: Vertical | null; // null = vista agregada de todos los módulos
  icon: IconName;
}

export const MODULES: ModuleDef[] = [
  { id: "servicio", label: "Servicio", description: "Taller y posventa", vertical: "servicio", icon: "wrench" },
  { id: "ventas", label: "Ventas", description: "Prospectos y citas", vertical: "ventas", icon: "tag" },
  { id: "general", label: "General", description: "Resumen de los dos módulos", vertical: null, icon: "grid" },
];

export function getModule(id: string): ModuleDef | undefined {
  return MODULES.find((m) => m.id === id);
}

export interface NavItem {
  slug: string;
  label: string;
  icon: string;
  adminOnly?: boolean;
  /** Solo superadministradores (p. ej. Organizaciones) */
  superAdminOnly?: boolean;
  /** false = la ruta existe pero muestra "en construcción" */
  ready: boolean;
}

export const NAV: NavItem[] = [
  { slug: "dashboard", label: "Dashboard", icon: "dash", ready: true },
  { slug: "conversaciones", label: "Conversaciones", icon: "msg", ready: true },
  { slug: "bots", label: "Bots", icon: "bot", adminOnly: true, ready: true },
  { slug: "whatsapp", label: "WhatsApp", icon: "phone", adminOnly: true, ready: true },
  { slug: "equipos", label: "Equipos", icon: "teams", adminOnly: true, ready: true },
  { slug: "agentes", label: "Agentes", icon: "user", ready: true },
  { slug: "campanas", label: "Campañas", icon: "mega", adminOnly: true, ready: true },
  { slug: "plantillas", label: "Plantillas", icon: "file", adminOnly: true, ready: true },
  { slug: "configuracion", label: "Configuración", icon: "gear", adminOnly: true, ready: true },
  { slug: "organizaciones", label: "Organizaciones", icon: "org", adminOnly: true, superAdminOnly: true, ready: true },
];
