"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";

interface UseNotificationsReturn {
  permission: NotificationPermission | "default";
  supported: boolean;
  requestPermission: () => Promise<boolean>;
  showNotification: (title: string, body: string, onClick?: () => void) => void;
  notifyNewMessage: (customerPhone: string, messageText: string, onClick?: () => void) => void;
  notifyConversationAssigned: (customerPhone: string, onClick?: () => void) => void;
  notifyHandoff: (customerPhone: string, reason: string, onClick?: () => void) => void;
  playSound: () => void;
}

export function useNotifications(): UseNotificationsReturn {
  const [permission, setPermission] = useState<NotificationPermission | "default">("default");
  const [supported, setSupported] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) {
      setSupported(true);
      setPermission(Notification.permission);
    }

    return () => {
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
    };
  }, []);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return false;
    }

    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      return result === "granted";
    } catch {
      return false;
    }
  }, []);

  const playSound = useCallback(() => {
    if (typeof window === "undefined") return;

    try {
      // Create or reuse AudioContext
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      }

      const audioContext = audioContextRef.current;

      // Resume if suspended (needed for autoplay policy)
      if (audioContext.state === "suspended") {
        audioContext.resume();
      }

      // Create a simple beep sound
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      // Configure sound - pleasant notification tone
      oscillator.frequency.value = 800;
      oscillator.type = "sine";

      // Configure volume envelope
      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);

      // Play sound
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.3);
    } catch (e) {
      console.warn("Could not play notification sound:", e);
    }
  }, []);

  const showNotification = useCallback(
    (title: string, body: string, onClick?: () => void) => {
      // Always show toast notification
      toast(title, {
        description: body,
        action: onClick
          ? {
              label: "Ver",
              onClick: onClick,
            }
          : undefined,
        duration: 5000,
      });

      // Play sound
      playSound();

      // Show browser notification if permission granted
      if (supported && permission === "granted") {
        try {
          const notification = new Notification(title, {
            body,
            icon: "/favicon.ico",
            badge: "/favicon.ico",
            tag: `notification-${Date.now()}`,
            requireInteraction: false,
          });

          if (onClick) {
            notification.onclick = () => {
              window.focus();
              onClick();
              notification.close();
            };
          }

          // Auto close after 5 seconds
          setTimeout(() => notification.close(), 5000);
        } catch (e) {
          console.error("Error showing browser notification:", e);
        }
      }
    },
    [permission, supported, playSound]
  );

  const formatPhone = (phone: string) => {
    return phone.replace("whatsapp:", "").slice(-10);
  };

  const notifyNewMessage = useCallback(
    (customerIdentifier: string, messageText: string, onClick?: () => void) => {
      // If it looks like a phone number, format it; otherwise use as-is (it's a name)
      const displayName = customerIdentifier.includes("whatsapp:") || customerIdentifier.startsWith("+")
        ? formatPhone(customerIdentifier)
        : customerIdentifier;
      const shortMessage = messageText.length > 50 ? messageText.slice(0, 50) + "..." : messageText;

      showNotification(
        `Nuevo mensaje de ${displayName}`,
        shortMessage,
        onClick
      );
    },
    [showNotification]
  );

  const notifyConversationAssigned = useCallback(
    (customerPhone: string, onClick?: () => void) => {
      const shortPhone = formatPhone(customerPhone);

      showNotification(
        "Conversacion asignada",
        `Se te ha asignado una conversacion con ${shortPhone}`,
        onClick
      );
    },
    [showNotification]
  );

  const notifyHandoff = useCallback(
    (customerPhone: string, reason: string, onClick?: () => void) => {
      const shortPhone = formatPhone(customerPhone);

      showNotification(
        "Solicitud de atencion",
        `${shortPhone} solicita hablar con un agente: ${reason}`,
        onClick
      );
    },
    [showNotification]
  );

  return {
    permission,
    supported,
    requestPermission,
    showNotification,
    notifyNewMessage,
    notifyConversationAssigned,
    notifyHandoff,
    playSound,
  };
}
