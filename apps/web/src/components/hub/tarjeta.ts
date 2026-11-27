import type { KeyboardEvent, SyntheticEvent } from "react";

/**
 * Props para que una tarjeta (Card) completa abra su editor: clic, Enter o espacio. Sin `onAbre` la tarjeta queda normal.
 * Lo que tenga acciones propias dentro (menú de los tres puntos, enlaces) va envuelto en `noAbre` para no abrir también el editor
 * (los eventos del menú, aunque se pinte en un portal, suben por el árbol de React hasta la tarjeta).
 */
export function tarjetaClicable(onAbre: (() => void) | null, etiqueta: string) {
  if (!onAbre) return {};
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": etiqueta,
    className: "cursor-pointer transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    onClick: onAbre,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onAbre(); }
    },
  };
}

/** Detiene el clic y las teclas para que no lleguen a la tarjeta. */
export const noAbre = {
  onClick: (e: SyntheticEvent) => e.stopPropagation(),
  onKeyDown: (e: SyntheticEvent) => e.stopPropagation(),
};
