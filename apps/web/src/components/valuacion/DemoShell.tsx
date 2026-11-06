"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { Moon, PanelLeftClose, PanelLeftOpen, Sun } from "lucide-react";
import { Icon } from "@/components/shell/icons";
import { Toaster } from "@/components/ui/sonner";
import { getModule, getModuleNav } from "@/lib/modules";
import { ValuacionBase } from "@/lib/valuacion/base";

export const DEMO_BASE = "/demo/valuacion";
const SIDEBAR_KEY = "hub_sidebar_collapsed";

/**
 * Marco de la demo pública de Valuación: el mismo menú lateral del HUB, pero solo con
 * el módulo de Valuación, marca Toyota y sin sesión (no hay usuario, organización ni
 * cierre de sesión). Las pantallas son los mismos componentes que usa el HUB.
 */
export function DemoShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(false);
  const mod = getModule("valuacion")!;
  const section = pathname.split("/")[3] ?? "dashboard";

  useEffect(() => {
    try { setCollapsed(localStorage.getItem(SIDEBAR_KEY) === "1"); } catch { /* sin storage */ }
  }, []);
  useEffect(() => { document.body.dataset.mod = "valuacion"; }, []);
  const toggleSidebar = () => setCollapsed((c) => {
    try { localStorage.setItem(SIDEBAR_KEY, c ? "0" : "1"); } catch { /* sin storage */ }
    return !c;
  });

  return (
    <ValuacionBase base={DEMO_BASE}>
      <div className={`app demo${collapsed ? " collapsed" : ""}`}>
        <aside className="side" aria-label="Menú principal">
          <div className="side-h">
            <div className="brand-mark demo-mark" aria-hidden="true">T</div>
            <div className="brand"><b>Toyota</b></div>
            <span className="env">DEMO</span>
            <button type="button" className="icon-btn theme-btn" aria-label="Cambiar tema" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
              {resolvedTheme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button
              type="button" className="icon-btn side-toggle" onClick={toggleSidebar}
              aria-label={collapsed ? "Mostrar menú" : "Ocultar menú"} aria-expanded={!collapsed} title={collapsed ? "Mostrar menú" : "Ocultar menú"}
            >
              {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
          </div>

          {/* Un solo módulo: se muestra como en el HUB, pero sin menú para cambiarlo */}
          <div className="modpick">
            <p className="lbl">Módulo</p>
            <div className="mod-btn mod-trigger" data-m={mod.id} title={collapsed ? `Módulo: ${mod.label}` : undefined}>
              <span className="dot"><Icon name={mod.icon} /></span>
              <span className="grow"><b>{mod.label}</b><small>{mod.description}</small></span>
            </div>
          </div>

          <nav className="nav-wrap" aria-label="Navegación del módulo">
            <div className="nav-group" data-g="operacion">
              <p className="lbl">Operación</p>
              {getModuleNav(mod).map((n) => (
                <Link
                  key={n.slug} href={`${DEMO_BASE}/${n.slug}`} className="nav" aria-current={section === n.slug ? "page" : undefined}
                  title={collapsed ? n.label : undefined} aria-label={collapsed ? n.label : undefined}
                >
                  <span className="l"><Icon name={n.icon} /><span className="nl">{n.label}</span></span>
                </Link>
              ))}
            </div>
          </nav>

          <div className="side-f">
            <div className="me">
              <div className="avatar" aria-hidden="true">V</div>
              <div className="grow"><b>Valuador (demo)</b><small>Sin inicio de sesión</small></div>
            </div>
          </div>
        </aside>

        <section className="main">
          <div className="strip" />
          {children}
        </section>
      </div>
      <Toaster />
    </ValuacionBase>
  );
}
