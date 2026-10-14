"use client";

import { createContext, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { collection, query, where, onSnapshot, orderBy, limit, collectionGroup, Timestamp, getDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "./AuthContext";
import { useNotifications } from "@/hooks/useNotifications";
import { conversationPath } from "@/lib/routes";

interface NotificationContextType {
  unreadCount: number;
  permission: NotificationPermission | "default";
  supported: boolean;
  requestPermission: () => Promise<boolean>;
  soundEnabled: boolean;
  setSoundEnabled: (enabled: boolean) => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { user, userData } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const {
    permission,
    supported,
    requestPermission,
    notifyNewMessage,
    notifyConversationAssigned,
  } = useNotifications();

  const [unreadCount, setUnreadCount] = useState(0);
  const [soundEnabled, setSoundEnabledState] = useState(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem("notifications_sound_enabled");
    return stored !== "false";
  });
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;

  const lastMessageTimestamps = useRef<Map<string, number>>(new Map());
  const initialLoadComplete = useRef(false);
  const currentConversationId = useRef<string | null>(null);

  const setSoundEnabled = (enabled: boolean) => {
    setSoundEnabledState(enabled);
    soundEnabledRef.current = enabled;
    localStorage.setItem("notifications_sound_enabled", String(enabled));
  };

  // Track current conversation from URL
  useEffect(() => {
    const match = pathname.match(/\/conversations\/([^/]+)/);
    currentConversationId.current = match ? match[1] : null;
  }, [pathname]);

  // Subscribe to conversations assigned to this agent
  useEffect(() => {
    if (!user?.uid || !userData?.organizationId) {
      return;
    }

    // Only agents and admins receive notifications
    if (userData.role !== "agent" && userData.role !== "admin") {
      return;
    }

    // Subscribe to conversations assigned to this user
    const conversationsRef = collection(db, "conversations");
    const q = query(
      conversationsRef,
      where("assignedAgentId", "==", user.uid),
      where("status", "==", "with_agent")
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      // Track unread conversations (simplified - you could add a proper unread field)
      setUnreadCount(snapshot.size);

      // Check for new assignments
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added" && initialLoadComplete.current && soundEnabledRef.current) {
          const conv = change.doc.data();
          // Notify about new assignment
          notifyConversationAssigned(conv.customerPhone || "Desconocido", () => {
            router.push(conversationPath(change.doc.id, (change.doc.data().vertical as string | undefined) ?? null));
          });
        }
      });

      initialLoadComplete.current = true;
    });

    return () => unsubscribe();
  }, [user?.uid, userData?.organizationId, userData?.role, notifyConversationAssigned, router]);

  // Subscribe to new messages in assigned conversations
  useEffect(() => {
    if (!user?.uid || !userData?.organizationId) {
      return;
    }

    if (userData.role !== "agent" && userData.role !== "admin") {
      return;
    }

    // Listen for new messages across all conversations assigned to this user
    // Note: This uses collectionGroup which requires a composite index
    const messagesRef = collectionGroup(db, "messages");
    const q = query(
      messagesRef,
      where("sender", "==", "customer"),
      orderBy("createdAt", "desc"),
      limit(10)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added") {
          const message = change.doc.data();
          const conversationId = change.doc.ref.parent.parent?.id;

          if (!conversationId) return;

          // Skip if this is the conversation currently being viewed
          if (conversationId === currentConversationId.current) return;

          // Check if this is actually a new message
          const createdAt = message.createdAt as Timestamp;
          if (!createdAt) return;

          const messageTime = createdAt.toMillis();
          const lastKnown = lastMessageTimestamps.current.get(conversationId) || 0;

          // Only notify for messages newer than what we've seen
          // and only after initial load
          if (messageTime > lastKnown && initialLoadComplete.current) {
            // Get conversation data for customer name/phone and org check
            const convRef = doc(db, "conversations", conversationId);
            getDoc(convRef).then((convDoc) => {
              const convData = convDoc.data();
              // Skip if conversation belongs to a different organization
              if (convData?.organizationId !== userData?.organizationId) return;

              if (!soundEnabledRef.current) return;

              const displayName = convData?.customerName || convData?.customerPhone || "Desconocido";
              notifyNewMessage(
                displayName,
                message.text || "",
                () => {
                  router.push(conversationPath(conversationId, (convData?.vertical as string | undefined) ?? null));
                }
              );
            }).catch(() => {
              // On error, skip notification (can't verify org)
            });
          }

          lastMessageTimestamps.current.set(conversationId, messageTime);
        }
      });
    });

    return () => unsubscribe();
  }, [user?.uid, userData?.organizationId, userData?.role, notifyNewMessage, router]);

  return (
    <NotificationContext.Provider
      value={{
        unreadCount,
        permission,
        supported,
        requestPermission,
        soundEnabled,
        setSoundEnabled,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotificationContext() {
  const context = useContext(NotificationContext);
  if (context === undefined) {
    throw new Error("useNotificationContext must be used within a NotificationProvider");
  }
  return context;
}
