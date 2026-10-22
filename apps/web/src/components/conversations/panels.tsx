/**
 * PANELES POR MÓDULO EN LA FICHA DE CONVERSACIÓN (tarea 1.22b)
 *
 * La ficha (`ConversationChat`) no conoce a ningún módulo: pide a este registro los paneles de
 * `conversation.vertical` y dibuja una pestaña por cada uno. Un módulo nuevo agrega aquí su entrada
 * y sus componentes; `ConversationChat` no se toca.
 */
import type { ComponentType } from "react";
import { Building2, Tag, UserCircle, type LucideIcon } from "lucide-react";
import type { Vertical } from "@/lib/modules";
import type { ConversationOutcome } from "@/lib/conversation-outcomes";
import LeadsPanel from "@/components/conversations/LeadsPanel";
import AccountsPanel from "@/components/conversations/AccountsPanel";
import OutcomePanel from "@/components/conversations/OutcomePanel";

/** Lo mínimo que un panel puede leer de la conversación; `Conversation` de la ficha lo cumple. */
export interface PanelConversation {
  customerPhone: string;
  vertical?: Vertical | null;
  conversationOutcome?: ConversationOutcome | null;
  conversationOutcomeHistory?: { outcome: ConversationOutcome; at: { toDate: () => Date } }[];
}

export interface ConversationPanelDef {
  /** Identificador de la pestaña; único dentro de la vertical */
  id: string;
  label: string;
  icon: LucideIcon;
  Component: ComponentType<{ conversation: PanelConversation }>;
}

export const conversationPanels: Record<Vertical, ConversationPanelDef[]> = {
  ventas: [
    {
      id: "leads",
      label: "Leads",
      icon: UserCircle,
      Component: ({ conversation }) => <LeadsPanel customerPhone={conversation.customerPhone} />,
    },
  ],
  servicio: [
    {
      id: "cuentas",
      label: "Cuentas",
      icon: Building2,
      Component: ({ conversation }) => <AccountsPanel customerPhone={conversation.customerPhone} />,
    },
    {
      id: "etiquetas",
      label: "Etiquetas",
      icon: Tag,
      Component: ({ conversation }) => (
        <OutcomePanel outcome={conversation.conversationOutcome} history={conversation.conversationOutcomeHistory} />
      ),
    },
  ],
};

export function getConversationPanels(vertical: string | null | undefined): ConversationPanelDef[] {
  return vertical && vertical in conversationPanels ? conversationPanels[vertical as Vertical] : [];
}
