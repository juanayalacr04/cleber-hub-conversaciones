"use client";

import { use } from "react";
import ConversationChat from "@/components/conversations/ConversationChat";

export default function ConversationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  return (
    <div className="h-[calc(100vh-80px)] md:h-[calc(100vh-120px)]">
      <ConversationChat conversationId={id} showBackButton={true} />
    </div>
  );
}
