"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { onAuthStateChanged, signInWithPopup, signOut as firebaseSignOut, type User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db, googleProvider } from "@/lib/firebase";
import type { Vertical } from "@/lib/modules";

export interface UserData {
  id: string;
  email: string;
  name: string;
  role: "admin" | "agent" | "viewer";
  isSuperAdmin?: boolean;
  organizationId: string | null;
  organizationIds: string[];
  teamId: string | null;
  /** vertical (módulo) del equipo del usuario, resuelta desde teams/{teamId} */
  vertical: Vertical | null;
}

interface AuthState {
  user: User | null;
  userData: UserData | null;
  loading: boolean;
  accessDenied: boolean;
  profileError: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [userData, setUserData] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [profileError, setProfileError] = useState(false);

  useEffect(() => {
    return onAuthStateChanged(auth, async (fbUser) => {
      setUser(fbUser);
      setProfileError(false);
      if (!fbUser) {
        setUserData(null);
        setLoading(false);
        return;
      }
      try {
        const snap = await getDoc(doc(db, "users", fbUser.uid));
        if (!snap.exists()) {
          // Sin documento en `users` no hay acceso: el alta es por invitación o siembra de admin.
          setAccessDenied(true);
          await firebaseSignOut(auth);
          return;
        }
        const d = snap.data();
        const orgId: string | null = d.organizationId ?? d.organizationIds?.[0] ?? null;
        const teamId: string | null = (orgId && d.orgTeams?.[orgId]) ?? d.teamId ?? null;
        let vertical: Vertical | null = null;
        if (teamId) {
          const team = await getDoc(doc(db, "teams", teamId));
          vertical = (team.data()?.vertical as Vertical | undefined) ?? null;
        }
        setAccessDenied(false);
        setUserData({
          id: fbUser.uid,
          email: d.email ?? fbUser.email ?? "",
          name: d.name ?? fbUser.displayName ?? "",
          role: d.role ?? "viewer",
          isSuperAdmin: d.isSuperAdmin === true,
          organizationId: orgId,
          organizationIds: d.organizationIds ?? (orgId ? [orgId] : []),
          teamId,
          vertical,
        });
      } catch (e) {
        console.error("Error cargando el perfil del usuario:", e);
        setProfileError(true);
      } finally {
        setLoading(false);
      }
    });
  }, []);

  const value: AuthState = {
    user,
    userData,
    loading,
    accessDenied,
    profileError,
    signInWithGoogle: async () => {
      setAccessDenied(false);
      await signInWithPopup(auth, googleProvider);
    },
    signOut: async () => {
      await firebaseSignOut(auth);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth debe usarse dentro de AuthProvider");
  return v;
}

export function isAdmin(u: UserData | null): boolean {
  return !!u && (u.role === "admin" || u.isSuperAdmin === true);
}
