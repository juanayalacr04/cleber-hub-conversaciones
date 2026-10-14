import { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";

/**
 * Autoriza una petición de cron (Vercel Cron manda `Authorization: Bearer <CRON_SECRET>`).
 * Falla cerrado, igual que la Cloud Function de inactividad: sin CRON_SECRET se rechaza todo,
 * salvo que se pida explícitamente `ALLOW_UNAUTHENTICATED_CRON=true` (desarrollo local).
 */
export function isCronAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.ALLOW_UNAUTHENTICATED_CRON?.toLowerCase() === "true";
  const received = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/**
 * Secreto compartido con un sistema externo (EXTERNAL_API_SECRET). Se prefiere la cabecera
 * `X-Api-Secret`; el parámetro `?secret=` se sigue aceptando por compatibilidad con los
 * integradores actuales, pero queda en los registros de acceso: conviene migrarlos a la cabecera.
 */
export function hasApiSecret(request: NextRequest, secret: string | undefined): boolean {
  if (!secret) return false;
  const received = Buffer.from(request.headers.get("x-api-secret") ?? request.nextUrl.searchParams.get("secret") ?? "");
  const expected = Buffer.from(secret);
  return received.length === expected.length && timingSafeEqual(received, expected);
}
