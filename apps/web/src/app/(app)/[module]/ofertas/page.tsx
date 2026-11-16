"use client";

import { notFound, useParams } from "next/navigation";
import { getModule } from "@/lib/modules";
import { OfertasApiView } from "@/components/valuacion/OfertasApiView";

/** Ofertas solo existe en el módulo de Valuación. Datos reales del schema `valuacion` (el prototipo queda en /demo). */
export default function OfertasPage() {
  const { module: moduleId } = useParams<{ module: string }>();
  const mod = getModule(moduleId);
  if (mod?.id !== "valuacion") notFound();
  return <OfertasApiView mod={mod} />;
}
