"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import {
  User,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
} from "firebase/auth";
import { doc, getDoc, collection, query, getDocs, orderBy } from "firebase/firestore";
import { auth, db, googleProvider } from "@/lib/firebase";
import { callHubAction, HubActionError } from "@/lib/hub-actions";

export interface UserData {
  id: string;
  email: string;
  name: string;
  photoURL: string | null;
  role: "admin" | "agent" | "viewer";
  organizationId: string | null;
  organizationIds: string[];
  orgTeams: { [orgId: string]: string };
  isSuperAdmin?: boolean;
  teamId: string | null;
  status: "online" | "away" | "offline";
  createdAt: Date;
  lastLoginAt: Date | null;
  /** Módulo del equipo activo (teams.vertical). Lo resuelve el contexto, no se guarda en users. */
  vertical?: "servicio" | "ventas" | null;
}

interface OrgOption {
  id: string;
  name: string;
}

interface AuthContextType {
  user: User | null;
  userData: UserData | null;
  loading: boolean;
  accessDenied: boolean;
  userDataError: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  organizations: OrgOption[];
  setSelectedOrgId: (orgId: string) => void;
  /** Vuelve a leer la lista de organizaciones (el superadmin la necesita tras crear o renombrar una). */
  refreshOrganizations: () => Promise<void>;
  currentOrgName: string | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [rawUserData, setRawUserData] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [userDataError, setUserDataError] = useState(false);
  const [organizations, setOrganizations] = useState<OrgOption[]>([]);
  const [fetchedOrg, setFetchedOrg] = useState<{ id: string; name: string } | null>(null);
  const [selectedOrgId, setSelectedOrgIdState] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("superadmin_selected_org");
    }
    return null;
  });

  const setSelectedOrgId = (orgId: string) => {
    setSelectedOrgIdState(orgId);
    localStorage.setItem("superadmin_selected_org", orgId);
  };

  // Derive organizationId and teamId based on selected org
  const baseUserData: UserData | null = rawUserData
    ? (() => {
        // Superadmin: override con org seleccionada (igual que antes)
        if (rawUserData.isSuperAdmin && selectedOrgId) {
          return { ...rawUserData, organizationId: selectedOrgId };
        }
        const orgIds = rawUserData.organizationIds || [];
        // Multi-org: derivar org y team activos desde el selector
        if (orgIds.length > 1 && selectedOrgId && orgIds.includes(selectedOrgId)) {
          return {
            ...rawUserData,
            organizationId: selectedOrgId,
            // Fallback al teamId legacy si la org seleccionada es la org principal del usuario
            // (cubre el caso donde orgTeams no fue migrado aún para esa org)
            teamId: rawUserData.orgTeams?.[selectedOrgId] ??
              (selectedOrgId === rawUserData.organizationId ? rawUserData.teamId ?? null : null),
          };
        }
        // Si organizationId es null pero tiene orgs en el array, usar la primera
        if (!rawUserData.organizationId && orgIds.length > 0) {
          const firstOrg = orgIds[0];
          return {
            ...rawUserData,
            organizationId: firstOrg,
            teamId: rawUserData.orgTeams?.[firstOrg] ?? rawUserData.teamId ?? null,
          };
        }
        // Single-org: derive teamId from orgTeams[organizationId] in case only orgTeams was set
        // (handleChangeTeam only updates orgTeams, not the global teamId)
        const orgId = rawUserData.organizationId;
        if (orgId) {
          const derivedTeamId = rawUserData.orgTeams?.[orgId] ?? rawUserData.teamId ?? null;
          if (derivedTeamId !== rawUserData.teamId) {
            return { ...rawUserData, teamId: derivedTeamId };
          }
        }
        return rawUserData;
      })()
    : null;

  // Módulo del usuario: la vertical de su equipo activo
  const [teamVertical, setTeamVertical] = useState<{ teamId: string; vertical: UserData["vertical"] } | null>(null);
  const activeTeamId = baseUserData?.teamId ?? null;
  useEffect(() => {
    if (!activeTeamId) return;
    let cancelled = false;
    getDoc(doc(db, "teams", activeTeamId))
      .then((snap) => !cancelled && setTeamVertical({ teamId: activeTeamId, vertical: (snap.data()?.vertical ?? null) as UserData["vertical"] }))
      .catch(() => !cancelled && setTeamVertical({ teamId: activeTeamId, vertical: null }));
    return () => {
      cancelled = true;
    };
  }, [activeTeamId]);
  const verticalPending = !!activeTeamId && teamVertical?.teamId !== activeTeamId;
  const userData: UserData | null = baseUserData
    ? { ...baseUserData, vertical: activeTeamId && teamVertical?.teamId === activeTeamId ? teamVertical.vertical : null }
    : null;

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);

      if (!firebaseUser) {
        setRawUserData(null);
        setUserDataError(false);
        setLoading(false);
        return;
      }

      try {
        const userRef = doc(db, "users", firebaseUser.uid);
        let userSnap = await getDoc(userRef);
        let justClaimed = false;

        if (!userSnap.exists()) {
          // Primer inicio de sesión de alguien invitado: la función 2 convierte el documento pre-registrado
          // por email en users/{uid} (rol, organizaciones y equipo salen de la invitación, no del cliente)
          try {
            await callHubAction(firebaseUser, "me.claim_invite");
            userSnap = await getDoc(userRef);
            justClaimed = true;
          } catch (claimError) {
            if (!(claimError instanceof HubActionError && claimError.code === "no_autorizado")) throw claimError;
          }
        }

        if (userSnap.exists()) {
          // La última conexión y el estado los escribe la función 2; si falla no se bloquea el acceso
          if (!justClaimed) {
            await callHubAction(firebaseUser, "me.sign_in").catch((e) => console.error("No se pudo registrar el inicio de sesión:", e));
          }
          const data = userSnap.data();

          // Sin migración lazy de organizationIds/orgTeams: en el hub nacen completos (alta o migración de datos)
          const updated = { ...data, teamId: data.teamId || null, lastLoginAt: new Date(), status: "online" } as UserData;
          setRawUserData(updated);
        } else {
          // Not invited — deny access and sign out
          setAccessDenied(true);
          await firebaseSignOut(auth);
          setUser(null);
          setRawUserData(null);
        }
      } catch (error) {
        // Sin este catch un fallo (típicamente permisos de Firestore en el primer login
        // de un invitado) dejaba userData en null con loading ya en false, y el dashboard
        // renderizaba con los fallbacks del Sidebar ("Usuario" / "viewer") sin señal alguna.
        console.error("Error cargando el perfil del usuario:", error);
        setUserDataError(true);
      } finally {
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, []);

  // Todas las organizaciones, para el superadmin. Trabaja con la que tenía elegida; si no hay (primer inicio de sesión, o la guardada
  // en el navegador ya no existe, p. ej. de otro proyecto) usa su organización principal y, si tampoco, la primera de la lista.
  const loadSuperadminOrgs = async (primaryOrgId: string | null) => {
    try {
      const orgsSnap = await getDocs(query(collection(db, "organizations"), orderBy("name")));
      const orgs = orgsSnap.docs.map((d) => ({ id: d.id, name: d.data().name as string }));
      setOrganizations(orgs);
      const exists = (id: string | null) => !!id && orgs.some((o) => o.id === id);
      const next = exists(selectedOrgId) ? selectedOrgId : exists(primaryOrgId) ? primaryOrgId : orgs[0]?.id ?? null;
      if (next && next !== selectedOrgId) setSelectedOrgId(next);
    } catch (error) {
      console.error("Error cargando las organizaciones:", error);
    }
  };

  const refreshOrganizations = async () => {
    if (rawUserData?.isSuperAdmin) await loadSuperadminOrgs(rawUserData.organizationId);
  };

  // Fetch organizations: todas para superadmin, solo las propias para usuario multi-org
  useEffect(() => {
    if (rawUserData?.isSuperAdmin) {
      loadSuperadminOrgs(rawUserData.organizationId);
      return;
    }

    const orgIds = rawUserData?.organizationIds || [];
    if (orgIds.length > 1) {
      const fetchUserOrgs = async () => {
        const orgDocs = await Promise.all(orgIds.map((id) => getDoc(doc(db, "organizations", id))));
        const orgs = orgDocs
          .filter((d) => d.exists())
          .map((d) => ({ id: d.id, name: d.data()!.name as string }));
        setOrganizations(orgs);
        if (!selectedOrgId || !orgIds.includes(selectedOrgId)) {
          setSelectedOrgId(orgIds[0]);
        }
      };
      fetchUserOrgs();
      return;
    }

    setOrganizations([]);
  }, [rawUserData?.isSuperAdmin, rawUserData?.organizationIds?.join(",")]);

  // Nombre de la org activa (para el título de la pestaña). Superadmin y multi-org ya lo
  // tienen en `organizations`; los usuarios de una sola org requieren leer el doc.
  const activeOrgId = userData?.organizationId ?? null;
  const orgNameFromList = organizations.find((o) => o.id === activeOrgId)?.name ?? null;
  const currentOrgName = orgNameFromList ?? (fetchedOrg?.id === activeOrgId ? fetchedOrg.name : null);

  useEffect(() => {
    if (!activeOrgId || orgNameFromList) return;

    let cancelled = false;
    getDoc(doc(db, "organizations", activeOrgId))
      .then((snap) => {
        if (!cancelled && snap.exists()) {
          setFetchedOrg({ id: activeOrgId, name: snap.data().name as string });
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [activeOrgId, orgNameFromList]);

  const signInWithGoogle = async () => {
    try {
      setAccessDenied(false);
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Error signing in with Google:", error);
      throw error;
    }
  };

  const signOut = async () => {
    try {
      // Estado offline antes de cerrar sesión (la función 2 lo escribe); si falla, la sesión se cierra igual
      if (user) {
        await callHubAction(user, "me.sign_out").catch((e) => console.error("No se pudo marcar offline:", e));
      }
      await firebaseSignOut(auth);
    } catch (error) {
      console.error("Error signing out:", error);
      throw error;
    }
  };

  return (
    <AuthContext.Provider
      value={{ user, userData, loading: loading || verticalPending, accessDenied, userDataError, signInWithGoogle, signOut, organizations, setSelectedOrgId, refreshOrganizations, currentOrgName }}
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

/** Administrador de la organización o superadmin. */
export function isAdmin(u: UserData | null): boolean {
  return !!u && (u.role === "admin" || u.isSuperAdmin === true);
}
