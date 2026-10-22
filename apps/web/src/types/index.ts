// Organization
export interface Organization {
  id: string;
  name: string;
  createdAt: Date;
  plan: "free" | "pro" | "enterprise";
  settings: {
    timezone: string;
    businessHours: {
      start: string;
      end: string;
    };
  };
  salesforceConfig?: {
    instanceUrl: string;
    clientId: string;
    clientSecret: string;
    username: string;
    password: string;
  };
}

// User
export interface User {
  id: string;
  email: string;
  name: string;
  photoURL: string | null;
  role: "admin" | "agent" | "viewer";
  organizationId: string | null;
  organizationIds: string[];
  orgTeams: { [orgId: string]: string };
  isSuperAdmin?: boolean;
  status: "online" | "away" | "offline";
  assignedConversations?: string[];
  createdAt: Date;
  lastLoginAt: Date | null;
  invitedBy?: string;
}

// Bot
export interface Bot {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  type?: "chatllm" | "workflow" | "vertex_ai" | "external";
  brand?: "Honda" | "Nissan" | "Toyota";
  category?: "Ventas" | "Servicio" | "Soporte" | "General";
  abacusConfig: {
    apiUrl: string;
    deploymentId: string;
    deploymentToken: string;
  };
  vertexAiConfig?: {
    endpoint: string;
    projectId?: string;
    location?: string;
  };
  externalConfig?: {
    endpoint: string;
    apiKey?: string;
  };
  twilioConfig: {
    phoneNumber: string;
    accountSid: string;
    authToken: string;
  };
  handoffConfig: {
    enabled: boolean;
    triggerKeywords: string[];
    autoHandoffAfterErrors: number;
    workingHoursOnly: boolean;
  };
  status: "active" | "paused" | "draft";
  createdAt: Date;
}

// Conversation
export interface Conversation {
  id: string;
  botId: string;
  organizationId: string;
  customerPhone: string;
  customerName: string | null;
  status: "bot" | "waiting_agent" | "with_agent" | "closed";
  assignedAgentId: string | null;
  priority: "low" | "normal" | "high" | "urgent";
  tags: string[];
  lastMessageAt: Date;
  createdAt: Date;
  appointmentDate?: Date;
  metadata?: Record<string, unknown>;
  broadcastId?: string | null;
  botName?: string;
  botBrand?: string;
  botCategory?: string;
  lastMessagePreview?: string;
  lastMessageSender?: "customer" | "bot" | "agent";
  channel?: "whatsapp" | "voice" | "web";
  lastCustomerMessageAt?: Date;
  lastTemplateMessageAt?: Date | null;
  inactivityRemindersSent?: number;
  direction?: "inbound" | "outbound";
  conversationOutcome?: import("@/lib/conversation-outcomes").ConversationOutcome | null;
  conversationOutcomeAt?: Date;
  conversationOutcomeHistory?: { outcome: import("@/lib/conversation-outcomes").ConversationOutcome; at: Date }[];
  aiOutcome?: "interes_cita" | "otro_motivo" | null;
  /** Módulo de la conversación (ver teams.vertical): "servicio" | "ventas" */
  vertical?: "servicio" | "ventas" | null;
  customerId?: string | null;
  source?: string | null;
  externalId?: string | null;
}

// Broadcast
export interface Broadcast {
  id: string;
  organizationId: string;
  name: string;
  whatsappNumberId: string;
  botId: string;
  templateName: string;
  templateLanguage: string;
  templateComponents: Record<string, unknown>[];
  contentSid: string | null;
  valuetextObjectApi: string | null;
  botInstructions: string | null;
  variableMapping?: string[];
  status: "draft" | "sending" | "completed" | "failed";
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  failedCount: number;
  confirmedCount: number;
  cancelledCount: number;
  rescheduledCount: number;
  createdBy: string;
  createdAt: Date;
  completedAt: Date | null;
}

// Broadcast Recipient
export interface BroadcastRecipient {
  id: string;
  phone: string;
  name: string | null;
  variables: Record<string, string> | null;
  salesforceRecordId: string | null;
  conversationId: string | null;
  status: "pending" | "sent" | "delivered" | "read" | "failed";
  errorMessage: string | null;
  whatsappMessageId: string | null;
  sentAt: Date | null;
  response: "confirmar_cita" | "cancelar_cita" | "reagendar_cita" | null;
}

// Message
export interface Message {
  id: string;
  conversationId: string;
  sender: "customer" | "bot" | "agent";
  agentId: string | null;
  text: string;
  mediaUrl: string | null;
  createdAt: Date;
}

// Customer
export interface Customer {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  organizationId: string;
  totalConversations: number;
  lastConversationAt: Date;
  tags: string[];
  notes: string | null;
  createdAt: Date;
}

// Stats
export interface DailyStats {
  id: string;
  organizationId: string;
  date: string;
  conversations: {
    total: number;
    byStatus: Record<string, number>;
    byBot: Record<string, number>;
  };
  messages: {
    total: number;
    fromCustomers: number;
    fromBot: number;
    fromAgents: number;
  };
  handoffs: {
    total: number;
    avgResponseTime: number;
  };
  agents: Record<string, { conversations: number; messages: number }>;
}
