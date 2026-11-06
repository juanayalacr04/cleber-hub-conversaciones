"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Ruta base de las pantallas de Valuación. En el HUB es "/valuacion"; la demo pública
 * (src/app/demo/valuacion) monta las mismas pantallas bajo "/demo/valuacion".
 */
const BaseContext = createContext("/valuacion");

export function ValuacionBase({ base, children }: { base: string; children: ReactNode }) {
  return <BaseContext.Provider value={base}>{children}</BaseContext.Provider>;
}

/** Arma un enlace interno de Valuación: href("/ofertas") → "/valuacion/ofertas". */
export function useValuacionHref() {
  const base = useContext(BaseContext);
  return (path: string) => `${base}${path}`;
}
