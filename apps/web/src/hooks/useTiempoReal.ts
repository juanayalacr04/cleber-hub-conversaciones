"use client";

import { useEffect, useRef, useState } from "react";
import { estaConfigurado, suscribe, type AvisoConversacion } from "@/lib/tiempoReal";

const AGRUPA_MS = 300;

/**
 * Escucha un canal de tiempo real (lib/tiempoReal.ts) y llama `alCambiar` cuando hay que volver a consultar: al llegar
 * avisos (agrupados: una ráfaga de mensajes es una sola consulta) y cada vez que la suscripción queda activa.
 * Regresa si hay conexión, para que la pantalla refresque más espaciado como respaldo.
 *
 *   const enVivo = useTiempoReal(idMarca ? `/hub/${idMarca}/valuacion` : null, carga)
 *
 * `canal` null = no escuchar (p. ej. mientras no se conoce la marca).
 */
export function useTiempoReal(canal: string | null, alCambiar: (avisos: AvisoConversacion[]) => void): boolean {
  const [conectado, setConectado] = useState(false);
  const callback = useRef(alCambiar);
  callback.current = alCambiar;

  useEffect(() => {
    if (!canal || !estaConfigurado()) { setConectado(false); return; }
    let pendientes: AvisoConversacion[] = [];
    let temporizador: ReturnType<typeof setTimeout> | null = null;
    const programa = () => {
      if (temporizador) return;
      temporizador = setTimeout(() => {
        temporizador = null;
        const lote = pendientes;
        pendientes = [];
        callback.current(lote);
      }, AGRUPA_MS);
    };
    const quita = suscribe(canal, {
      alAvisar: (aviso) => { pendientes.push(aviso); programa(); },
      alSuscribir: programa,
      alCambiarEstado: setConectado,
    });
    return () => {
      if (temporizador) clearTimeout(temporizador);
      quita();
    };
  }, [canal]);

  return conectado;
}
