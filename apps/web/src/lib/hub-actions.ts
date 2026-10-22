/**
 * Cliente del endpoint de acciones de usuario de la función 2 (`POST /user-actions/execute`, tarea 1.37).
 *
 * La web lee Firestore en vivo y pide toda escritura aquí: la función 2 valida el token, los permisos y el
 * estado antes de escribir. El navegador ya no escribe en Firestore.
 */
import type { User } from "firebase/auth";

const HUB_ACTIONS_URL = process.env.NEXT_PUBLIC_HUB_ACTIONS_URL ?? "";

export class HubActionError extends Error {
  constructor(
    message: string,
    public code: string,
    public retryable = false
  ) {
    super(message);
    this.name = "HubActionError";
  }
}

/** Ejecuta `action` en nombre del usuario. Devuelve `result`; lanza `HubActionError` si el hub la rechaza. */
export async function callHubAction<T = Record<string, unknown>>(
  user: User | null,
  action: string,
  data: Record<string, unknown> = {}
): Promise<T> {
  if (!user) throw new HubActionError("Sesión no iniciada", "no_autorizado");
  if (!HUB_ACTIONS_URL) throw new HubActionError("Falta NEXT_PUBLIC_HUB_ACTIONS_URL", "error_interno");

  const res = await fetch(HUB_ACTIONS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await user.getIdToken()}` },
    body: JSON.stringify({ action, data }),
  });
  const body = await res.json().catch(() => null);
  if (res.ok && body?.ok) return (body.result ?? {}) as T;

  const err = body?.error;
  throw new HubActionError(
    typeof err === "string" ? err : err?.message || `Error ${res.status}`,
    typeof err === "object" && err?.code ? err.code : res.status === 401 ? "no_autorizado" : "error_interno",
    typeof err === "object" && err?.retryable === true
  );
}
