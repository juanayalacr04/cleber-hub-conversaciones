"use client";

import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import { instalaDesbloqueoAudio, suenaAviso } from "@/lib/sonido";

/**
 * Avisos dentro de la plataforma: toast (con "Ver" si hay a dónde ir) y sonido. Sin notificaciones del navegador
 * (decidido 2026-11-20: solo dentro de la plataforma). El audio es uno por pestaña (lib/sonido.ts).
 */
interface UseNotificationsReturn {
  showNotification: (title: string, body: string, onClick?: () => void) => void;
  playSound: () => void;
}

export function useNotifications(): UseNotificationsReturn {
  useEffect(() => { instalaDesbloqueoAudio(); }, []);

  const playSound = useCallback(() => suenaAviso(), []);

  const showNotification = useCallback((title: string, body: string, onClick?: () => void) => {
    toast(title, {
      description: body,
      action: onClick ? { label: "Ver", onClick } : undefined,
      duration: 8000,
    });
    suenaAviso();
  }, []);

  return { showNotification, playSound };
}
