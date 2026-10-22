import type { ReactNode } from "react";

/** Marco de las pantallas portadas del dashboard anterior: área con scroll y el relleno que ellas esperan. */
export default function PortedLayout({ children }: { children: ReactNode }) {
  return (
    <div className="view">
      <div className="ported">{children}</div>
    </div>
  );
}
