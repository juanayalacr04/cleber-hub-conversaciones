"use client";

import { getModule } from "@/lib/modules";
import { ValuacionDashboard } from "@/components/valuacion/ValuacionDashboard";

export default function DemoDashboardPage() {
  return <ValuacionDashboard mod={getModule("valuacion")!} />;
}
