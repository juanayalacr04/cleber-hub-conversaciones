"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";

/** Guardia de sesión: todo lo que cuelga de (app) exige usuario con perfil. */
export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, userData, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading || !userData) return <div className="center"><span>Cargando…</span></div>;
  return <>{children}</>;
}
