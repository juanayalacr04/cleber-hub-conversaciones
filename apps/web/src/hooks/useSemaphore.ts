import { useEffect, useState } from "react";
import { db } from "@/lib/firebase";
import { doc, onSnapshot, Timestamp } from "firebase/firestore";

interface SemaphoreThresholds {
  yellowMinutes: number;
  redMinutes: number;
}

export type SemaphoreColor = "green" | "yellow" | "red";

export function useSemaphore(teamId?: string) {
  const [thresholds, setThresholds] = useState<SemaphoreThresholds | null>(null);
  const [now, setNow] = useState(Date.now());

  // Subscribe to team semaphore thresholds
  useEffect(() => {
    if (!teamId || teamId === "all") {
      setThresholds(null);
      return;
    }
    const unsub = onSnapshot(doc(db, "teams", teamId), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        const t = data.semaphoreThresholds;
        if (t && typeof t.yellowMinutes === "number" && typeof t.redMinutes === "number") {
          setThresholds({ yellowMinutes: t.yellowMinutes, redMinutes: t.redMinutes });
        } else {
          setThresholds(null);
        }
      } else {
        setThresholds(null);
      }
    });
    return unsub;
  }, [teamId]);

  // Refresh "now" every 30 seconds so colors update live
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  /**
   * Returns the semaphore color for a waiting_agent conversation.
   * Returns null if no thresholds configured or no timestamp.
   */
  function getColor(lastMessageAt: Timestamp | null | undefined): SemaphoreColor | null {
    if (!thresholds || !lastMessageAt) return null;
    const elapsedMinutes = (now - lastMessageAt.toMillis()) / 60_000;
    if (elapsedMinutes < thresholds.yellowMinutes) return "green";
    if (elapsedMinutes < thresholds.redMinutes) return "yellow";
    return "red";
  }

  return { getColor, thresholds };
}
