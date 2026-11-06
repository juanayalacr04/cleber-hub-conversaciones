"use client";

import { ConversacionesView } from "@/components/valuacion/ConversacionesView";

/** Mismo marco que las conversaciones del HUB (área con scroll y relleno de las pantallas portadas). */
export default function DemoConversacionesPage() {
  return <div className="view"><div className="ported"><ConversacionesView /></div></div>;
}
