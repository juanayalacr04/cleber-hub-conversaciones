"use client";

import { use } from "react";
import ConversationChat from "@/components/conversations/ConversationChat";
import { ConversacionDetalle } from "@/components/valuacion/ConversacionesView";

export default function ConversationDetailPage({ params }: { params: Promise<{ module: string; id: string }> }) {
  const { module: moduleId, id } = use(params);

  return (
    <div className="h-[calc(100vh-80px)] md:h-[calc(100vh-120px)]">
      {moduleId === "valuacion"
        ? <ConversacionDetalle id={id} />
        : <ConversationChat conversationId={id} showBackButton={true} />}
    </div>
  );
}
