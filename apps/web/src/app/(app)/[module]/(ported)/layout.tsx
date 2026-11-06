"use client";

import type { ReactNode } from "react";
import { useParams, usePathname } from "next/navigation";

/**
 * Marco de las pantallas portadas del dashboard anterior: área con scroll y el relleno que ellas esperan.
 * La configuración de Valuación es una pantalla propia que trae su marco (encabezado del shell).
 */
export default function PortedLayout({ children }: { children: ReactNode }) {
  const { module: moduleId } = useParams<{ module: string }>();
  const pathname = usePathname();
  if (moduleId === "valuacion" && pathname.split("/")[2] === "configuracion") return <>{children}</>;
  return (
    <div className="view">
      <div className="ported">{children}</div>
    </div>
  );
}
