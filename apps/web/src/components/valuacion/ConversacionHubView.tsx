"use client";

/**
 * Una conversación de Valuación en hub_cleber (Hub.consultaMensajes), por ejemplo la que abrió el envío de una oferta.
 * Solo lectura: tomar, responder y cerrar llegan con las acciones del backend. Sin tiempo real todavía, se refresca
 * cada 15 s mientras la página está visible (y con el botón Actualizar).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { PageHead } from "@/components/shell/Shell";
import type { ModuleDef } from "@/lib/modules";
import { consultaMensajes, type ConversacionHub, type EstadoConversacion, type MensajeHub } from "@/lib/hub/conversaciones";
import { mensajeError } from "@/lib/valuacion/tipos";

const REFRESCO_MS = 15_000;

const ESTADOS: Record<EstadoConversacion, { texto: string; tono: string }> = {
  bot: { texto: "Con el bot", tono: "ok" },
  waiting_agent: { texto: "Esperando asesor", tono: "wait" },
  with_agent: { texto: "Con asesor", tono: "ok" },
  closed: { texto: "Cerrada", tono: "" },
};

const QUIEN: Record<MensajeHub["remitente"], string> = { customer: "Cliente", bot: "Bot", agent: "Asesor", system: "Contexto del bot" };

const hora = (s: string) => new Date(s).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
const dia = (s: string) => new Date(s).toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });
const fechaHora = (s: string | null) => (s ? new Date(s).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" }) : "—");

export function ConversacionHubView({ mod, idConversacion }: { mod: ModuleDef; idConversacion: string }) {
  const [conv, setConv] = useState<ConversacionHub | null>(null);
  const [mensajes, setMensajes] = useState<MensajeHub[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [conContexto, setConContexto] = useState(false);

  const carga = useCallback(async () => {
    setCargando(true);
    const r = await consultaMensajes({ idConversacion, incluyeSistema: conContexto, limite: 200 });
    setCargando(false);
    if (r.successful) {
      setConv(r.info.conversacion);
      setMensajes(r.info.mensajes);
      setError(null);
      return;
    }
    if (r.errorCode === "SESION_EXPIRADA") { toast.error(mensajeError(r)); signOut({ redirectTo: "/login" }); return; }
    setError(r.errorCode === "CONVERSACION_NO_ENCONTRADA"
      ? "La conversación no existe o no la puedes ver (es de otro equipo o de otra marca)."
      : mensajeError(r));
  }, [idConversacion, conContexto]);

  useEffect(() => { carga(); }, [carga]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") carga(); }, REFRESCO_MS);
    return () => clearInterval(t);
  }, [carga]);

  const volver = (
    <Link href={`/${mod.id}/ofertas`} className="btn"><ArrowLeft size={14} />Ofertas</Link>
  );

  if (error || !conv) {
    return (
      <>
        <PageHead title="Conversación" subtitle="Conversación de WhatsApp de Valuación" mod={mod} />
        <div className="view"><div className="pad" style={{ maxWidth: 900 }}>
          <div className="sect">{volver}</div>
          <div className="card">
            {error ? (
              <div className="empty">
                <b style={{ color: "var(--fg)" }}>No se pudo cargar la conversación</b><br />{error}
                <br /><button type="button" className="btn" style={{ marginTop: 12 }} onClick={carga}>Reintentar</button>
              </div>
            ) : <div className="empty"><Loader2 size={18} className="animate-spin" style={{ display: "inline" }} /> Cargando conversación…</div>}
          </div>
        </div></div>
      </>
    );
  }

  const estado = ESTADOS[conv.estado];
  const contexto = (conv.metadatos?.contexto ?? {}) as { telefonoOriginal?: string };
  // Separador por día
  let diaAnterior = "";

  return (
    <>
      <PageHead title={conv.nombreCliente || conv.telefonoCliente} subtitle={`Conversación de WhatsApp · ${conv.telefonoCliente}`} mod={mod} />
      <div className="view">
        <div className="pad" style={{ maxWidth: 900, gap: 16 }}>
          <div className="sect">
            {volver}
            <span className={`pill ${estado.tono}`}>{estado.texto}</span>
            <span className="spacer" />
            <label className="vchecks" style={{ display: "flex" }}>
              <span><input type="checkbox" checked={conContexto} onChange={(e) => setConContexto(e.target.checked)} /> Ver contexto del bot</span>
            </label>
            <button type="button" className="btn oicon" onClick={carga} disabled={cargando} aria-label="Actualizar" title="Actualizar">
              <RefreshCw size={15} className={cargando ? "animate-spin" : undefined} />
            </button>
          </div>

          <div className="card">
            <dl className="dl" style={{ padding: 16 }}>
              <dt>Cliente</dt><dd>{conv.nombreCliente || "—"}</dd>
              <dt>Teléfono</dt><dd className="num">{conv.telefonoCliente}</dd>
              {contexto.telefonoOriginal && <><dt>Teléfono real del cliente</dt><dd className="num">{contexto.telefonoOriginal} (envío de prueba redirigido)</dd></>}
              {conv.fuente === "valuacion" && <><dt>Oferta</dt><dd className="num">#{conv.idExterno}</dd></>}
              <dt>Abierta</dt><dd>{fechaHora(conv.creadoEn)}</dd>
              <dt>Último mensaje</dt><dd>{fechaHora(conv.ultimoMensajeEn)}</dd>
              {conv.cerradaEn && <><dt>Cerrada</dt><dd>{fechaHora(conv.cerradaEn)}{conv.motivoCierre ? ` · ${conv.motivoCierre}` : ""}</dd></>}
            </dl>
          </div>

          <div className="card" style={{ overflow: "hidden" }}>
            <div className="msgs" style={{ minHeight: 240 }}>
              {mensajes.length === 0 && <div className="empty">Sin mensajes todavía.</div>}
              {mensajes.map((m) => {
                const d = dia(m.creadoEn);
                const separador = d !== diaAnterior ? <div className="day">{d}</div> : null;
                diaAnterior = d;
                if (m.remitente === "system") {
                  return <div key={m.idMensaje} style={{ display: "contents" }}>{separador}<div className="sys" style={{ whiteSpace: "pre-wrap", maxWidth: "90%" }}>{m.texto}</div></div>;
                }
                const clase = m.remitente === "customer" ? "msg" : `msg ${m.remitente}`;
                return (
                  <div key={m.idMensaje} style={{ display: "contents" }}>
                    {separador}
                    <div className={clase}>
                      <span className="who">{QUIEN[m.remitente]}{m.esPlantilla ? " · plantilla" : ""}</span>
                      {m.texto && <div style={{ whiteSpace: "pre-wrap" }}>{m.texto}</div>}
                      {m.mediaUrl && <a href={m.mediaUrl} target="_blank" rel="noreferrer">📎 Archivo adjunto</a>}
                      <small>{hora(m.creadoEn)}</small>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <p className="vapply">Solo lectura. Responder, tomar y cerrar la conversación llegan con la bandeja de Valuación.</p>
        </div>
      </div>
    </>
  );
}
