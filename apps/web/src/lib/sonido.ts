"use client";

/**
 * Sonido de los avisos de la plataforma. Un solo AudioContext por pestaña (no por componente): si viviera en un
 * componente, al volver a montarse (p. ej. cuando se refresca la sesión) se cerraría y el navegador volvería a bloquear
 * el audio hasta otro clic.
 *
 * Política de autoplay: el audio solo puede arrancar después de un gesto del usuario en la página. El contexto se crea y
 * se reanuda en el primer clic, toque o tecla (y en los siguientes, por si el navegador lo suspende), nunca antes: así no
 * salen las advertencias "The AudioContext was not allowed to start". Si llega un aviso antes de cualquier gesto, no suena.
 */

let contexto: AudioContext | null = null;
let instalado = false;

function creaContexto(): AudioContext | null {
  if (contexto) return contexto;
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    contexto = Ctor ? new Ctor() : null;
  } catch {
    contexto = null;
  }
  return contexto;
}

/** Escucha los gestos del usuario para habilitar el audio. Idempotente. */
export function instalaDesbloqueoAudio(): void {
  if (instalado || typeof window === "undefined") return;
  instalado = true;
  const desbloquea = () => {
    const c = creaContexto();
    if (c && c.state === "suspended") void c.resume().catch(() => {});
  };
  for (const evento of ["pointerdown", "keydown", "touchend"]) {
    window.addEventListener(evento, desbloquea, { capture: true, passive: true });
  }
}

/** Dos tonos ascendentes. No hace nada si el usuario aún no ha interactuado con la página. */
export function suenaAviso(): void {
  if (typeof window === "undefined") return;
  const c = contexto;
  if (!c || c.state !== "running") {
    if (c && c.state === "suspended") void c.resume().catch(() => {});
    return;
  }
  try {
    const nota = (frecuencia: number, inicio: number, duracion: number) => {
      const osc = c.createOscillator();
      const vol = c.createGain();
      osc.connect(vol);
      vol.connect(c.destination);
      osc.type = "sine";
      osc.frequency.value = frecuencia;
      const t = c.currentTime + inicio;
      vol.gain.setValueAtTime(0.0001, t);
      vol.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
      vol.gain.exponentialRampToValueAtTime(0.001, t + duracion);
      osc.start(t);
      osc.stop(t + duracion);
    };
    nota(660, 0, 0.25);
    nota(880, 0.18, 0.35);
  } catch (e) {
    console.warn("[avisos] no se pudo reproducir el sonido:", e);
  }
}
