"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Check, ChevronsUpDown, LogOut, Moon, PanelLeftClose, PanelLeftOpen, Sun } from "lucide-react";
import { isAdmin, useAuth } from "@/contexts/AuthContext";
import { MODULES, getModule, getModuleNav, visibleNav, type ModuleDef } from "@/lib/modules";
import { Icon } from "./icons";
import { OrgSwitcher } from "./OrgSwitcher";
import { useDismiss } from "./useDismiss";

/** Módulos que el usuario puede ver: admin y superadmin todos; el resto, el de su equipo. */
export function allowedModules(userData: ReturnType<typeof useAuth>["userData"]): ModuleDef[] {
  if (isAdmin(userData)) return MODULES;
  return MODULES.filter((m) => m.vertical && m.vertical === userData?.vertical);
}

const SIDEBAR_KEY = "hub_sidebar_collapsed";

export function Shell({ children }: { children: ReactNode }) {
  const { module: moduleId } = useParams<{ module: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const { userData, user, signOut } = useAuth();
  const { resolvedTheme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const pickRef = useRef<HTMLDivElement>(null);
  // Barra lateral colapsada a solo íconos; se recuerda por navegador
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try { setCollapsed(localStorage.getItem(SIDEBAR_KEY) === "1"); } catch { /* sin storage */ }
  }, []);
  const toggleSidebar = () => {
    setOpen(false);
    setCollapsed((c) => {
      try { localStorage.setItem(SIDEBAR_KEY, c ? "0" : "1"); } catch { /* sin storage */ }
      return !c;
    });
  };

  const mod = getModule(moduleId);
  const allowed = allowedModules(userData);
  const admin = isAdmin(userData);
  const section = pathname.split("/")[2] ?? "dashboard";

  useEffect(() => {
    if (!userData) return;
    if (!mod || !allowed.some((m) => m.id === mod.id)) {
      router.replace(allowed.length ? `/${allowed[0].id}/dashboard` : "/login");
    }
  }, [userData, mod, allowed, router]);

  useEffect(() => {
    document.body.dataset.mod = mod?.id ?? "general";
  }, [mod]);

  useDismiss(pickRef, open, () => setOpen(false));

  if (!mod || !allowed.some((m) => m.id === mod.id)) return null;

  const initials = (userData?.name || user?.displayName || "U").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div className={`app${collapsed ? " collapsed" : ""}`}>
      <aside className="side" aria-label="Menú principal">
        <div className="side-h">
          <div className="brand-mark">C</div>
          <div className="brand"><b>Cleber Hub</b></div>
          <span className="env">DEV</span>
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

        <OrgSwitcher />

        <div className="modpick" ref={pickRef}>
          <p className="lbl">Módulo activo</p>
          <button
            type="button"
            className="mod-btn mod-trigger"
            data-m={mod.id}
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            title={collapsed ? `Módulo: ${mod.label}` : undefined}
          >
            <span className="dot"><Icon name={mod.icon} /></span>
            <span className="grow"><b>{mod.label}</b><small>{mod.description}</small></span>
            <ChevronsUpDown size={16} aria-hidden="true" />
          </button>
          {open && (
            <ul className="mod-menu" role="listbox" aria-label="Módulo">
              {allowed.map((m) => {
                const target = getModuleNav(m).some((n) => n.slug === section) ? section : getModuleNav(m)[0].slug;
                return (
                  <li key={m.id} role="option" aria-selected={m.id === mod.id}>
                    <Link href={`/${m.id}/${target}`} className="mod-btn" data-m={m.id} onClick={() => setOpen(false)}>
                      <span className="dot"><Icon name={m.icon} /></span>
                      <span className="grow"><b>{m.label}</b><small>{m.description}</small></span>
                      {m.id === mod.id && <Check size={16} aria-hidden="true" />}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <nav className="nav-wrap" aria-label="Navegación del módulo">
          {visibleNav(mod, { admin, superAdmin: !!userData?.isSuperAdmin }).map((g) => (
            <div key={g.id} className="nav-group" data-g={g.id}>
              <p className="lbl">{g.label}</p>
              {g.items.map((n) => (
                <Link key={n.slug} href={`/${mod.id}/${n.slug}`} className="nav" aria-current={section === n.slug ? "page" : undefined} title={collapsed ? n.label : undefined} aria-label={collapsed ? n.label : undefined}>
                  <span className="l"><Icon name={n.icon} /><span className="nl">{n.label}</span></span>
                </Link>
              ))}
            </div>
          ))}
        </nav>

        <div className="side-f">
          <div className="me">
            <div className="avatar">{initials}</div>
            <div className="grow"><b>{userData?.name || user?.displayName || "Usuario"}</b><small>{userData?.isSuperAdmin ? "superadmin" : userData?.role}</small></div>
            <button type="button" className="icon-btn" style={{ marginLeft: 0 }} aria-label="Cerrar sesión" onClick={signOut}><LogOut size={16} /></button>
          </div>
        </div>
      </aside>

      <section className="main">
        <div className="strip" />
        {children}
      </section>
    </div>
  );
}

export function PageHead({ title, subtitle, mod }: { title: string; subtitle: string; mod: ModuleDef }) {
  return (
    <header className="head">
      <div><h1>{title}</h1><p>{subtitle}</p></div>
      <span className="modchip">
        <span className="dot"><Icon name={mod.icon} className="i" /></span>
        {mod.id === "general" ? "Todos los módulos" : `Módulo ${mod.label}`}
      </span>
    </header>
  );
}
