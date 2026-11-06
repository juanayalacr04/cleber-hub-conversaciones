"use client";

import { notFound, useParams } from "next/navigation";
import { getModule } from "@/lib/modules";
import { OfertasView } from "@/components/valuacion/OfertasView";

/** Ofertas solo existe en el módulo de Valuación. */
export default function OfertasPage() {
  const { module: moduleId } = useParams<{ module: string }>();
  const mod = getModule(moduleId);
  if (mod?.id !== "valuacion") notFound();
  return <OfertasView mod={mod} />;
}
