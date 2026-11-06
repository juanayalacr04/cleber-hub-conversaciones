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
export type ModuleId = Vertical | "general" | "valuacion";
export type IconName = "wrench" | "tag" | "grid" | "gauge";

export interface ModuleDef {
  id: ModuleId;
  label: string;
  description: string;
  vertical: Vertical | null; // null = vista agregada de todos los módulos (o módulo sin vertical propia)
  icon: IconName;
  /** Opciones de navegación del módulo; si no se define, usa NAV */
  nav?: NavItem[];
}

export const MODULES: ModuleDef[] = [
  { id: "servicio", label: "Servicio", description: "Taller y posventa", vertical: "servicio", icon: "wrench" },
  { id: "ventas", label: "Ventas", description: "Prospectos y citas", vertical: "ventas", icon: "tag" },
  {
    id: "valuacion", label: "Valuación", description: "Avalúo de autos usados", vertical: null, icon: "gauge",
    // Prototipo con datos inventados (src/lib/valuacion/store.ts). El valuador también configura.
    nav: [
      { slug: "dashboard", label: "Dashboard", icon: "dash", ready: true },
      { slug: "ofertas", label: "Ofertas", icon: "offer", ready: true },
      { slug: "conversaciones", label: "Conversaciones", icon: "msg", ready: true },
      { slug: "configuracion", label: "Configuración", icon: "gear", ready: true },
    ],
  },
  { id: "general", label: "General", description: "Resumen de los módulos", vertical: null, icon: "grid" },
];

export function getModule(id: string): ModuleDef | undefined {
  return MODULES.find((m) => m.id === id);
}

/** Opciones de navegación que corresponden al módulo. */
export function getModuleNav(mod: ModuleDef): NavItem[] {
  return mod.nav ?? NAV;
}

/** Quién ve la opción: todos (operacion), administradores de la organización (admin) o solo superadministradores (plataforma). */
export type NavGroup = "operacion" | "admin" | "plataforma";

export const NAV_GROUPS: { id: NavGroup; label: string }[] = [
  { id: "operacion", label: "Operación" },
  { id: "admin", label: "Administración" },
  { id: "plataforma", label: "Plataforma" },
];

export interface NavItem {
  slug: string;
  label: string;
  icon: string;
  /** Por defecto, operacion */
  group?: NavGroup;
  /** false = la ruta existe pero muestra "en construcción" */
  ready: boolean;
}

export const NAV: NavItem[] = [
  { slug: "dashboard", label: "Dashboard", icon: "dash", ready: true },
  { slug: "conversaciones", label: "Conversaciones", icon: "msg", ready: true },
  { slug: "agentes", label: "Agentes", icon: "user", ready: true },
  { slug: "bots", label: "Bots", icon: "bot", group: "admin", ready: true },
  { slug: "whatsapp", label: "WhatsApp", icon: "phone", group: "admin", ready: true },
  { slug: "equipos", label: "Equipos", icon: "teams", group: "admin", ready: true },
  { slug: "campanas", label: "Campañas", icon: "mega", group: "admin", ready: true },
  { slug: "plantillas", label: "Plantillas", icon: "file", group: "admin", ready: true },
  { slug: "configuracion", label: "Configuración", icon: "gear", group: "plataforma", ready: true },
  { slug: "organizaciones", label: "Organizaciones", icon: "org", group: "plataforma", ready: true },
];

/** Opciones del módulo que el usuario puede ver, agrupadas y sin grupos vacíos. */
export function visibleNav(mod: ModuleDef, opts: { admin: boolean; superAdmin: boolean }): { id: NavGroup; label: string; items: NavItem[] }[] {
  const allowed = (g: NavGroup) => g === "operacion" || (g === "admin" && opts.admin) || (g === "plataforma" && opts.superAdmin);
  return NAV_GROUPS
    .map((g) => ({ ...g, items: getModuleNav(mod).filter((n) => (n.group ?? "operacion") === g.id) }))
    .filter((g) => allowed(g.id) && g.items.length > 0);
}
