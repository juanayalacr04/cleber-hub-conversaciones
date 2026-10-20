import { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";

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
