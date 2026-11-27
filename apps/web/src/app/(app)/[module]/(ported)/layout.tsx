"use client";

import type { ReactNode } from "react";
import { useParams, usePathname } from "next/navigation";

/**
 * Marco de las pantallas portadas del dashboard anterior: área con scroll y el relleno que ellas esperan.
 * La configuración de Valuación y la de Verificación son pantallas propias que traen su marco (encabezado del shell).
 */
export default function PortedLayout({ children }: { children: ReactNode }) {
  const { module: moduleId } = useParams<{ module: string }>();
  const pathname = usePathname();
  const configuracionPropia = (moduleId === "valuacion" || moduleId === "verificacion") && pathname.split("/")[2] === "configuracion";
  if (configuracionPropia) return <>{children}</>;
  return (
    <div className="view">
      <div className="ported">{children}</div>
    </div>
  );
}
