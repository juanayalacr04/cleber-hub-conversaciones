"use client";

import { Tag } from "lucide-react";
import { cn } from "@/lib/utils";
import { OUTCOME_LABELS, OUTCOME_COLORS, type ConversationOutcome } from "@/lib/conversation-outcomes";

interface OutcomePanelProps {
  outcome?: ConversationOutcome | null;
  history?: { outcome: ConversationOutcome; at: { toDate: () => Date } | null }[];
}

export default function OutcomePanel({ outcome, history = [] }: OutcomePanelProps) {
  if (!outcome) {
    return (
      <div className="py-8 px-4 text-center">
        <Tag className="h-10 w-10 text-gray-300 mx-auto mb-2" />
        <p className="text-sm text-gray-500">Esta conversación aún no tiene etiqueta.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-3 space-y-4">
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Etiqueta actual</p>
        <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium", OUTCOME_COLORS[outcome])}>
          {OUTCOME_LABELS[outcome]}
        </span>
      </div>
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">Cuándo se asignó cada etiqueta, de la más reciente a la más antigua.</p>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin historial disponible.</p>
        ) : (
          [...history].reverse().map((entry, i) => {
            const date = entry.at?.toDate();
            return (
              <div key={i} className="flex items-center justify-between gap-2">
                <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium", OUTCOME_COLORS[entry.outcome])}>
                  {OUTCOME_LABELS[entry.outcome]}
                </span>
                <span className="text-xs text-muted-foreground whitespace-nowrap text-right">
                  {date ? (
                    <>
                      {date.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" })}
                      {" · "}
                      {date.toLocaleTimeString("es-MX", { hour: "numeric", minute: "2-digit", hour12: true })}
                    </>
                  ) : ""}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
