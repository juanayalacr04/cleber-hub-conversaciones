"use client";

import { use } from "react";
import { ConversacionDetalle } from "@/components/valuacion/ConversacionesView";

export default function DemoConversacionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <div className="view">
      <div className="ported">
        <div className="h-[calc(100vh-80px)] md:h-[calc(100vh-120px)]"><ConversacionDetalle id={id} /></div>
      </div>
    </div>
  );
}
