"use client";

import { getModule } from "@/lib/modules";
import { FinanciamientoView } from "@/components/valuacion/FinanciamientoView";

export default function DemoFinanciamientoPage() {
  return <FinanciamientoView mod={getModule("valuacion")!} />;
}
