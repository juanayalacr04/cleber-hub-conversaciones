"use client";

/**
 * Sesión del dashboard. La identidad es la de hub_cleber (PostgreSQL):
 *   1. Login con NextAuth + Google (lib/auth.ts).
 *   2. Hub.registraInicioSesion: registra el acceso. SIN_PERMISO = el correo no está dado de alta en el hub (o está
 *      inactivo) → acceso negado. Ya no se lee users/{uid} de Firestore ni se reclama la invitación ahí.
 *   3. Hub.consultaUsuarioActual: marcas que puede ver y su rol por marca y módulo. De ahí sale `userData`.
 * Ya no se abre sesión de Firebase: `user` queda en null (lo usaban las pantallas de Ventas y Servicio que leen
 * Firestore, ocultas hasta su mudanza).
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { signIn as nextAuthSignIn, signOut as nextAuthSignOut, useSession } from "next-auth/react";
import { consultaUsuarioActual, registraInicioSesion, type UsuarioHub } from "@/lib/hub/usuario";
// Solo el tipo (no carga Firebase): lo esperan las pantallas de Ventas y Servicio. `user` es siempre null.
import type { User } from "firebase/auth";

export type ModuloHub = "ventas" | "servicio" | "valuacion" | "verificacion";

export interface UserData {
  /** idUsuario del hub (antes, el uid de Firebase) */
  id: string;
  idUsuario: string;
  email: string;
  name: string;
  photoURL: string | null;
  /** Rol en la marca activa, resumido de sus roles por módulo: ADMINISTRADOR → admin; sin rol operativo → viewer */
  role: "admin" | "agent" | "viewer";
  /** Marca activa */
  organizationId: string | null;
  /** Marcas del usuario */
  organizationIds: string[];
  /** Equipo de ventas/servicio por marca */
  orgTeams: { [orgId: string]: string };
  isSuperAdmin?: boolean;
  /** Equipo (ventas o servicio) en la marca activa */
  teamId: string | null;
  status: "online" | "away" | "offline";
  createdAt: Date;
  lastLoginAt: Date | null;
  /** Módulo de ventas/servicio donde tiene rol en la marca activa (ventas primero) */
  vertical?: "servicio" | "ventas" | null;
  /** Módulos donde tiene rol en la marca activa */
  modulos: ModuloHub[];
  /** Módulos que el super admin tiene encendidos en la marca activa */
  modulosActivos: string[];
}

interface OrgOption {
  id: string;
  name: string;
}

interface AuthContextType {
  user: User | null;
  userData: UserData | null;
  /** Usuario de hub_cleber (rol por marca y módulo); null mientras carga o si falló */
  usuarioHub: UsuarioHub | null;
  loading: boolean;
  accessDenied: boolean;
  userDataError: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  organizations: OrgOption[];
  setSelectedOrgId: (orgId: string) => void;
  /** Vuelve a leer el usuario y sus marcas (tras crear, renombrar o desactivar una marca, o cambiar roles propios). */
  refreshOrganizations: () => Promise<void>;
  currentOrgName: string | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const MARCA_KEY = "superadmin_selected_org";
const ROLES_OPERATIVOS = ["AGENTE", "VALUADOR", "GERENTE"];

/** userData de la marca activa a partir del usuario del hub. */
function construyeUserData(u: UsuarioHub, idMarca: string | null, uidFirebase: string | null, modulosActivos: string[]): UserData {
  const marca = u.marcas.find((m) => m.idMarca === idMarca) ?? null;
  const roles = Object.values(marca?.modulos ?? {}).map((r) => r.rol);
  const modulos = (Object.keys(marca?.modulos ?? {}) as ModuloHub[]).filter((m) => ["ventas", "servicio", "valuacion", "verificacion"].includes(m));
  const vertical = marca?.modulos.ventas ? "ventas" : marca?.modulos.servicio ? "servicio" : null;
  const orgTeams: Record<string, string> = {};
  for (const m of u.marcas) {
    const equipo = m.modulos.ventas?.idEquipo ?? m.modulos.servicio?.idEquipo;
    if (equipo) orgTeams[m.idMarca] = equipo;
  }
  return {
    id: uidFirebase ?? u.idUsuario,
    idUsuario: u.idUsuario,
    email: u.email,
    name: u.nombre || u.email,
    photoURL: u.fotoUrl,
    role: u.esSuperAdmin || roles.includes("ADMINISTRADOR") ? "admin" : roles.some((r) => ROLES_OPERATIVOS.includes(r)) ? "agent" : "viewer",
    organizationId: idMarca,
    organizationIds: u.marcas.map((m) => m.idMarca),
    orgTeams,
    isSuperAdmin: u.esSuperAdmin,
    teamId: vertical ? marca?.modulos[vertical]?.idEquipo ?? null : null,
    status: u.estado,
    createdAt: new Date(u.creadoEn),
    lastLoginAt: u.ultimoAccesoEn ? new Date(u.ultimoAccesoEn) : null,
    vertical,
    modulos,
    modulosActivos,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data: session, status: sessionStatus } = useSession();
  const user: User | null = null;
  const [usuarioHub, setUsuarioHub] = useState<UsuarioHub | null>(null);
  const [perfilPendiente, setPerfilPendiente] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [userDataError, setUserDataError] = useState(false);
  const denegado = useRef(false);   // no reintentar en esta sesión después de negar el acceso
  const [organizations, setOrganizations] = useState<OrgOption[]>([]);
  const [activosPorMarca, setActivosPorMarca] = useState<Record<string, string[]>>({});
  const [selectedOrgId, setSelectedOrgIdState] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try { return localStorage.getItem(MARCA_KEY); } catch { return null; }
  });

  const setSelectedOrgId = useCallback((orgId: string) => {
    setSelectedOrgIdState(orgId);
    try { localStorage.setItem(MARCA_KEY, orgId); } catch { /* sin storage */ }
  }, []);

  // Marca activa: la elegida si la puede ver; si no, la primera de las suyas o de las visibles
  const idMarca = (() => {
    if (!usuarioHub) return null;
    if (selectedOrgId && organizations.some((o) => o.id === selectedOrgId)) return selectedOrgId;
    return usuarioHub.marcas[0]?.idMarca ?? organizations[0]?.id ?? null;
  })();
  const userData = usuarioHub ? construyeUserData(usuarioHub, idMarca, null, idMarca ? activosPorMarca[idMarca] ?? [] : []) : null;

  /** Usuario y marcas visibles (Hub.consultaUsuarioActual). */
  const cargaUsuario = useCallback(async () => {
    const r = await consultaUsuarioActual();
    if (!r.successful) {
      console.error("Hub.consultaUsuarioActual falló:", r.errorCode, r.errorMessage);
      return r;
    }
    setUsuarioHub(r.info.usuario);
    setOrganizations(r.info.marcasVisibles.map((m) => ({ id: m.idMarca, name: m.nombre })));
    setActivosPorMarca(Object.fromEntries(r.info.marcasVisibles.map((m) => [m.idMarca, m.modulosActivos ?? []])));
    return r;
  }, []);

  const niegaAcceso = useCallback(async () => {
    denegado.current = true;
    setAccessDenied(true);
    setUsuarioHub(null);
    await nextAuthSignOut({ redirect: false });
  }, []);

  // Al tener sesión de NextAuth: registra el acceso en el hub y carga el usuario
  const email = session?.user?.email ?? null;
  useEffect(() => {
    if (sessionStatus !== "authenticated" || !session?.idToken || session.error || denegado.current) return;
    let vivo = true;
    setPerfilPendiente(true);
    setUserDataError(false);
    (async () => {
      try {
        const r = await registraInicioSesion({ nombre: session.user?.name, fotoUrl: session.user?.image });
        if (!vivo) return;
        if (!r.successful) {
          if (r.errorCode === "SIN_PERMISO") return niegaAcceso();
          if (r.errorCode === "SESION_EXPIRADA") return nextAuthSignOut({ redirectTo: "/login" });
          console.error("Hub.registraInicioSesion falló:", r.errorCode, r.errorMessage);
          setUserDataError(true);
          return;
        }
        const c = await cargaUsuario();
        if (vivo && !c.successful) setUserDataError(true);
      } catch (e) {
        console.error("No se pudo cargar el perfil del hub:", e);
        if (vivo) setUserDataError(true);
      } finally {
        if (vivo) setPerfilPendiente(false);
      }
    })();
    return () => { vivo = false; };
    // Una vez por cuenta: el id_token se renueva y no hace falta volver a registrar el acceso
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus, email]);

  useEffect(() => {
    if (sessionStatus === "unauthenticated") {
      setUsuarioHub(null);
      setOrganizations([]);
    }
  }, [sessionStatus]);

  const refreshOrganizations = useCallback(async () => { await cargaUsuario(); }, [cargaUsuario]);

  // Recuerda la marca efectiva (p. ej. la primera, si la guardada ya no se puede ver)
  useEffect(() => {
    if (idMarca && idMarca !== selectedOrgId) setSelectedOrgId(idMarca);
  }, [idMarca, selectedOrgId, setSelectedOrgId]);

  const currentOrgName = organizations.find((o) => o.id === idMarca)?.name
    ?? usuarioHub?.marcas.find((m) => m.idMarca === idMarca)?.nombre ?? null;

  // Sin sesión se puede volver a intentar el acceso; si no se pudo renovar el id_token, de vuelta al login
  useEffect(() => {
    if (sessionStatus === "unauthenticated") denegado.current = false;
    if (session?.error === "RENOVACION_FALLIDA") nextAuthSignOut({ redirectTo: "/login" });
  }, [sessionStatus, session?.error]);

  const signInWithGoogle = async () => {
    setAccessDenied(false);
    denegado.current = false;
    await nextAuthSignIn("google", { redirectTo: "/" });
  };

  const signOut = async () => {
    await nextAuthSignOut({ redirectTo: "/login" });
  };

  const loading = sessionStatus === "loading" || perfilPendiente
    || (sessionStatus === "authenticated" && !usuarioHub && !accessDenied && !userDataError && !session?.error);

  return (
    <AuthContext.Provider
      value={{ user, userData, usuarioHub, loading, accessDenied, userDataError, signInWithGoogle, signOut, organizations, setSelectedOrgId, refreshOrganizations, currentOrgName }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

/** Administrador en la marca activa (de algún módulo) o superadmin. */
export function isAdmin(u: UserData | null): boolean {
  return !!u && (u.role === "admin" || u.isSuperAdmin === true);
}
