/**
 * Teléfono de destino de un envío de prueba. El usuario escribe 10 dígitos; el +52 se agrega solo al enviarlo.
 * Mismas reglas que el hub (core/contrato_entrada.py::normaliza_destino).
 */

/** Deja solo los dígitos del campo y quita el código de país si lo pegaron completo ("+52 81…", "52 81…"). Máximo 10. */
export function diezDigitos(texto: string): string {
  let d = texto.replace(/\D/g, "");
  if (d.length > 10 && d.startsWith("52")) d = d.slice(2);
  return d.slice(0, 10);
}

/** "+52XXXXXXXXXX" si hay 10 dígitos; null si no. */
export function telefonoMx(texto: string): string | null {
  const d = diezDigitos(texto);
  return d.length === 10 ? `+52${d}` : null;
}

/** "81 1234 5678", para mostrarlo mientras se escribe. */
export function formatoDiez(d: string): string {
  return [d.slice(0, 2), d.slice(2, 6), d.slice(6, 10)].filter(Boolean).join(" ");
}
