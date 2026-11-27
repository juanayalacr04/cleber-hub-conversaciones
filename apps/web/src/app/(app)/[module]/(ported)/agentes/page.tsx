"use client";

import { useParams } from "next/navigation";
import { UsuariosView } from "@/components/hub/UsuariosView";
import type { ModuloHub } from "@/lib/hub/usuarios";

/** Usuarios de la marca activa en hub_cleber (PostgreSQL). En General se ven todos los de la marca. */
export default function AgentesPage() {
  const { module: moduleId } = useParams<{ module: string }>();
  const modulo = (["ventas", "servicio", "valuacion", "verificacion"] as const).find((m) => m === moduleId) ?? null;
  return <UsuariosView key={moduleId} modulo={modulo as ModuloHub | null} />;
}
