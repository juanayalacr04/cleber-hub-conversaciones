"use client";

import { use } from "react";
import ConversationChat from "@/components/conversations/ConversationChat";
import { ConversacionChat } from "@/components/valuacion/ConversacionesApiView";
import { VerificacionConversacion } from "@/components/verificacion/VerificacionConversaciones";

export default function ConversationDetailPage({ params }: { params: Promise<{ module: string; id: string }> }) {
  const { module: moduleId, id } = use(params);

  if (moduleId === "verificacion") return <VerificacionConversacion idConversacion={decodeURIComponent(id)} />;

  return (
    <div className="h-[calc(100vh-80px)] md:h-[calc(100vh-120px)]">
      {moduleId === "valuacion"
        ? <ConversacionChat idConversacion={decodeURIComponent(id)} />
        : <ConversationChat conversationId={id} showBackButton={true} />}
    </div>
  );
}
