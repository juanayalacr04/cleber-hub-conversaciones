"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { allowedModules } from "@/components/shell/Shell";

/** Entrada: lleva al primer módulo permitido en la marca activa, o al login si no hay sesión. */
export default function Home() {
  const { userData, loading, organizations, setSelectedOrgId, currentOrgName, signOut } = useAuth();
  const router = useRouter();
  const mods = allowedModules(userData);
  const primero = mods[0]?.id ?? null;

  useEffect(() => {
    if (loading) return;
    if (!userData) { router.replace("/login"); return; }
    if (primero) router.replace(`/${primero}/dashboard`);
  }, [loading, userData, primero, router]);

  // Con sesión pero sin rol en ningún módulo de la marca activa: se dice, sin rebotar al login
  if (!loading && userData && mods.length === 0) {
    const otras = organizations.filter((o) => o.id !== userData.organizationId);
    return (
      <div className="center">
        <div className="card login">
          <h1>Sin módulos</h1>
          <p>No tienes rol en ningún módulo de {currentOrgName ?? "esta marca"}. Pide a un administrador que te asigne uno.</p>
          {otras.length > 0 && (
            <select className="date" value="" onChange={(e) => setSelectedOrgId(e.target.value)} aria-label="Cambiar de marca">
              <option value="" disabled>Cambiar de marca</option>
              {otras.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
          <button type="button" className="btn" onClick={signOut}>Cerrar sesión</button>
        </div>
      </div>
    );
  }

  return <div className="center"><span className="sub">Cargando…</span></div>;
}
