import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { DemoShell } from "@/components/valuacion/DemoShell";

export const metadata: Metadata = { title: "Toyota · Valuación (demo)", robots: { index: false, follow: false } };

// Se evalúa en cada petición para que la variable de entorno se lea al ejecutar, no al compilar
export const dynamic = "force-dynamic";

/**
 * Demo pública del módulo de Valuación: sin login, solo este módulo, marca Toyota y
 * datos inventados (src/lib/valuacion/store.ts). Queda apagada salvo que el entorno
 * tenga DEMO_VALUACION=1, para no publicarla por accidente en dev o producción.
 */
export default function DemoValuacionLayout({ children }: { children: ReactNode }) {
  if (process.env.DEMO_VALUACION !== "1") notFound();
  return <DemoShell>{children}</DemoShell>;
}
