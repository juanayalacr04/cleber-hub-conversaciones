"use client";

import { getModule } from "@/lib/modules";
import { OfertasView } from "@/components/valuacion/OfertasView";

export default function DemoOfertasPage() {
  return <OfertasView mod={getModule("valuacion")!} />;
}
