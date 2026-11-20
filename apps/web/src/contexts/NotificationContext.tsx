"use client";

/**
 * Notificaciones del asesor en toda la plataforma: conversación que se le asigna y mensaje nuevo del cliente en una
 * conversación suya. Solo dentro de la plataforma: toast con "Ver" y sonido (sin notificaciones del navegador).
 *
 * Fuente: hub_cleber por tiempo real (AppSync Events, lib/tiempoReal.ts). Por cada módulo donde el usuario tiene rol en
 * la marca activa (con cualquier rol; el super admin, en todos) se escucha /hub/<marca>/<modulo>; los avisos no traen datos, así que cuando
 * uno toca una conversación suya (o una que era suya) se vuelve a consultar Hub.consultaConversaciones con idAgente =
 * el usuario y se compara con la consulta anterior:
 *   - conversación que no estaba → "Conversación asignada"
 *   - último mensaje más nuevo y del cliente → "Nuevo mensaje"
 * La primera consulta solo toma la foto (no avisa de lo que ya tenía). Sin tiempo real se consulta cada 30 s.
 * No avisa de la conversación que el usuario tiene abierta.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./AuthContext";
import { useNotifications } from "@/hooks/useNotifications";
import { useTiempoReal } from "@/hooks/useTiempoReal";
import { conversationPath } from "@/lib/routes";
import { consultaConversaciones, type ConversacionHub } from "@/lib/hub/conversaciones";
import type { ModuloHub } from "@/lib/hub/usuarios";

interface NotificationContextType {
  /** Conversaciones asignadas al usuario (con asesor) en la marca activa */
  unreadCount: number;
  /** Avisos activados (toast y sonido); se recuerda en este navegador */
  soundEnabled: boolean;
  setSoundEnabled: (enabled: boolean) => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

const MODULOS: ModuloHub[] = ["ventas", "servicio", "valuacion"];
const LLAVE_SONIDO = "notifications_sound_enabled";
const RESPALDO_MS = 30_000;

type Evento = { tipo: "asignada" | "mensaje"; conv: ConversacionHub; modulo: ModuloHub };

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { usuarioHub, userData } = useAuth();
  const router = useRouter();
  const { showNotification, playSound } = useNotifications();

  const [soundEnabled, setSoundEnabledState] = useState(() => {
    if (typeof window === "undefined") return true;
    try { return localStorage.getItem(LLAVE_SONIDO) !== "false"; } catch { return true; }
  });
  const soundRef = useRef(soundEnabled);
  soundRef.current = soundEnabled;
  const setSoundEnabled = (enabled: boolean) => {
    setSoundEnabledState(enabled);
    soundRef.current = enabled;
    try { localStorage.setItem(LLAVE_SONIDO, String(enabled)); } catch { /* sin almacenamiento */ }
  };

  const [conteos, setConteos] = useState<Record<string, number>>({});
  const unreadCount = Object.values(conteos).reduce((a, b) => a + b, 0);

  const idMarca = userData?.organizationId ?? null;
  const idUsuario = usuarioHub?.idUsuario ?? null;
  // Módulos que escucha en la marca activa: cualquiera donde tenga rol (el que sea) y, el super admin, todos. Avisa solo
  // de conversaciones asignadas a él (la consulta filtra por idAgente), así que el rol no importa.
  const modulos = useMemo(() => {
    if (usuarioHub?.esSuperAdmin) return MODULOS;
    const marca = usuarioHub?.marcas.find((m) => m.idMarca === idMarca);
    return MODULOS.filter((m) => !!marca?.modulos[m]);
  }, [usuarioHub, idMarca]);

  const avisa = useCallback(({ tipo, conv, modulo }: Evento) => {
    if (!soundRef.current) return;
    // La que tiene abierta en pantalla (ruta /<modulo>/conversaciones/<id> o ?c=<id> en Conversaciones de Valuación):
    // un mensaje nuevo solo suena (ya lo está viendo); la asignación no se avisa (la tomó él mismo o ya la ve)
    const abierta = document.visibilityState === "visible"
      && (window.location.pathname.includes(`/conversaciones/${conv.idConversacion}`)
          || new URLSearchParams(window.location.search).get("c") === conv.idConversacion);
    if (abierta) {
      if (tipo === "mensaje") playSound();
      return;
    }
    const quien = conv.nombreCliente || conv.telefonoCliente?.replace("whatsapp:", "") || "un cliente";
    const ir = () => router.push(conversationPath(conv.idConversacion, modulo));
    if (tipo === "asignada") {
      showNotification("Conversación asignada", `Se te asignó la conversación con ${quien}`, ir);
    } else {
      const texto = conv.ultimoMensajeTexto ?? "";
      showNotification(`Nuevo mensaje de ${quien}`, texto.length > 80 ? `${texto.slice(0, 80)}…` : texto || "Mensaje nuevo", ir);
    }
  }, [router, showNotification, playSound]);

  const alContar = useCallback((modulo: string, n: number) => {
    setConteos((c) => (c[modulo] === n ? c : { ...c, [modulo]: n }));
  }, []);

  return (
    <NotificationContext.Provider value={{ unreadCount, soundEnabled, setSoundEnabled }}>
      {idMarca && idUsuario && modulos.map((m) => (
        <VigilaAsignadas key={`${idMarca}/${m}`} idMarca={idMarca} modulo={m} idUsuario={idUsuario} avisa={avisa} alContar={alContar} />
      ))}
      {children}
    </NotificationContext.Provider>
  );
}

/** Conversaciones asignadas al usuario en un módulo de la marca; avisa lo nuevo (ver arriba). */
function VigilaAsignadas({ idMarca, modulo, idUsuario, avisa, alContar }: {
  idMarca: string; modulo: ModuloHub; idUsuario: string;
  avisa: (e: Evento) => void; alContar: (modulo: string, n: number) => void;
}) {
  const conocidas = useRef<Map<string, ConversacionHub> | null>(null);
  const enCurso = useRef(false);
  const otraVez = useRef(false);
  // En ref: si cambia (p. ej. al dar permiso de notificaciones) no debe reiniciar la foto y perder avisos
  const avisaRef = useRef(avisa);
  avisaRef.current = avisa;

  const consulta = useCallback(async () => {
    // Una consulta a la vez; si llegan avisos mientras tanto, se repite una vez al terminar
    if (enCurso.current) { otraVez.current = true; return; }
    enCurso.current = true;
    try {
      do {
        otraVez.current = false;
        const r = await consultaConversaciones({ idMarca, modulo, idAgente: idUsuario, estados: ["with_agent"], limite: 200 });
        if (!r.successful) { console.warn(`[avisos] ${modulo}: no se pudo consultar (${r.errorCode} ${r.errorMessage})`); return; }
        const previas = conocidas.current;
        const actuales = new Map(r.info.conversaciones.map((c) => [c.idConversacion, c]));
        conocidas.current = actuales;
        alContar(modulo, actuales.size);
        if (!previas) continue;   // primera foto: no avisa de lo que ya tenía
        for (const c of actuales.values()) {
          const antes = previas.get(c.idConversacion);
          if (!antes) avisaRef.current({ tipo: "asignada", conv: c, modulo });
          else if (c.ultimoRemitente === "customer" && (c.ultimoMensajeEn ?? "") > (antes.ultimoMensajeEn ?? "")) {
            avisaRef.current({ tipo: "mensaje", conv: c, modulo });
          }
        }
      } while (otraVez.current);
    } finally {
      enCurso.current = false;
    }
  }, [idMarca, modulo, idUsuario, alContar]);

  useEffect(() => { conocidas.current = null; void consulta(); }, [consulta]);

  // Avisos del módulo: solo consulta si alguno es suyo o era suyo (sin avisos = se suscribió o reconectó: consulta)
  const enVivo = useTiempoReal(`/hub/${idMarca}/${modulo}`, (avisos) => {
    if (avisos.length === 0 || avisos.some((a) => a.idAgente === idUsuario || conocidas.current?.has(a.idConversacion))) {
      void consulta();
    }
  });

  useEffect(() => {
    if (enVivo) return;
    const t = setInterval(() => { void consulta(); }, RESPALDO_MS);
    return () => clearInterval(t);
  }, [enVivo, consulta]);

  return null;
}

export function useNotificationContext() {
  const context = useContext(NotificationContext);
  if (context === undefined) {
    throw new Error("useNotificationContext must be used within a NotificationProvider");
  }
  return context;
}
