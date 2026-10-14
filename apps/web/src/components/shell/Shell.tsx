"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { LogOut, Moon, Sun } from "lucide-react";
import { isAdmin, useAuth } from "@/contexts/AuthContext";
import { MODULES, NAV, getModule, type ModuleDef } from "@/lib/modules";
import { Icon } from "./icons";

/** Módulos que el usuario puede ver: admin y superadmin todos; el resto, el de su equipo. */
export function allowedModules(userData: ReturnType<typeof useAuth>["userData"]): ModuleDef[] {
  if (isAdmin(userData)) return MODULES;
  return MODULES.filter((m) => m.vertical && m.vertical === userData?.vertical);
}

export function Shell({ children }: { children: ReactNode }) {
  const { module: moduleId } = useParams<{ module: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const { userData, user, signOut } = useAuth();
  const { resolvedTheme, setTheme } = useTheme();

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

  if (!mod || !allowed.some((m) => m.id === mod.id)) return null;

  const initials = (userData?.name || user?.displayName || "U").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div className="app">
      <aside className="side" aria-label="Menú principal">
        <div className="side-h">
          <div className="brand-mark">C</div>
          <div className="brand"><b>Cleber Hub</b></div>
          <span className="env">DEV</span>
          <button type="button" className="icon-btn" aria-label="Cambiar tema" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
            {resolvedTheme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>

        <div className="modpick" role="group" aria-label="Módulo">
          <p className="lbl">Módulo</p>
          {allowed.map((m) => (
            <Link key={m.id} href={`/${m.id}/${section}`} className="mod-btn" data-m={m.id} aria-current={m.id === mod.id ? "true" : undefined}>
              <span className="dot"><Icon name={m.icon} /></span>
              <span><b>{m.label}</b><small>{m.description}</small></span>
            </Link>
          ))}
        </div>

        <nav className="nav-wrap" aria-label="General">
          <p className="lbl" style={{ marginBottom: 6 }}>General</p>
          {NAV.filter((n) => (!n.adminOnly || admin) && (!n.superAdminOnly || userData?.isSuperAdmin)).map((n) => (
            <Link key={n.slug} href={`/${mod.id}/${n.slug}`} className="nav" aria-current={section === n.slug ? "page" : undefined}>
              <span className="l"><Icon name={n.icon} />{n.label}</span>
            </Link>
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
