"use client";

import { useParams } from "next/navigation";
import { PageHead } from "@/components/shell/Shell";
import { NAV, getModule } from "@/lib/modules";

/** Pantalla pendiente de portar: existe la ruta y el shell, falta el contenido. */
export default function SectionPlaceholder() {
  const { module: moduleId, section } = useParams<{ module: string; section: string }>();
  const mod = getModule(moduleId);
  const item = NAV.find((n) => n.slug === section);
  if (!mod || !item) return null;

  return (
    <>
      <PageHead title={item.label} subtitle={mod.id === "general" ? "Todos los módulos" : `Módulo de ${mod.label}`} mod={mod} />
      <div className="view">
        <div className="empty">
          <b style={{ color: "var(--fg)" }}>{item.label}</b>
          <br />
          Esta pantalla se porta en la Fase 1. El shell, la sesión y el módulo ya funcionan.
        </div>
      </div>
    </>
  );
}
