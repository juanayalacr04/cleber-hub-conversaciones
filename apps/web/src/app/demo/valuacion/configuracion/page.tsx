"use client";

import { getModule } from "@/lib/modules";
import { ConfiguracionView } from "@/components/valuacion/ConfiguracionView";

export default function DemoConfiguracionPage() {
  return <ConfiguracionView mod={getModule("valuacion")!} />;
}
