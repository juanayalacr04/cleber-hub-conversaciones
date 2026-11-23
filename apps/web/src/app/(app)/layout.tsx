"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { NotificationProvider } from "@/contexts/NotificationContext";
import { Toaster } from "@/components/ui/sonner";

/** Guardia de sesión: todo lo que cuelga de (app) exige usuario con perfil en hub_cleber. */
export default function AppLayout({ children }: { children: ReactNode }) {
  const { userData, loading } = useAuth();
  const router = useRouter();

  // Sin perfil del hub (sin sesión, acceso negado o error al cargarlo) se va al login, que dice por qué
  useEffect(() => {
    if (!loading && !userData) router.replace("/login");
  }, [loading, userData, router]);

  if (loading || !userData) return <div className="center"><span>Cargando…</span></div>;
  return (
    <NotificationProvider>
      {children}
      <Toaster />
    </NotificationProvider>
  );
}
