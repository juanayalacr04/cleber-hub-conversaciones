"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { allowedModules } from "@/components/shell/Shell";

/** Entrada: lleva al primer módulo permitido, o al login si no hay sesión. */
export default function Home() {
  const { userData, loading, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) return router.replace("/login");
    if (!userData) return;
    const mods = allowedModules(userData);
    router.replace(mods.length ? `/${mods[0].id}/dashboard` : "/login");
  }, [loading, user, userData, router]);

  return <div className="center"><span className="sub">Cargando…</span></div>;
}
