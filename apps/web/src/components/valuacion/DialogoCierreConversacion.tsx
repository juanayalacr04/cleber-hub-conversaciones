"use client";

/**
 * Diálogo de "Cerrar conversación" de Valuación. Son decisiones distintas y se piden por separado:
 *
 *   1. Por qué se cierra la CONVERSACIÓN (motivo, obligatorio):                  Hub.cierraConversacion
 *   2. Qué pasa con la OFERTA de esa conversación, si viene de una (opcional):
 *        - Estatus de la oferta (p. ej. "Cliente declina", cuando el cliente no está interesado)   Valuacion.registraRespuesta
 *        - Cerrar también la oferta                                                                  Valuacion.cierraOferta
 *
 * El estatus depende del motivo (ESTATUS_POR_MOTIVO): con "Sin respuesta del cliente" no se puede decir que el cliente aceptó. Un
 * estatus que no esté en esa tabla no se ofrece con ningún motivo: al agregar etiquetas al catálogo de Valuación hay que ubicarlas ahí.
 *
 * Lo de la oferta se ofrece solo si se puede: la oferta se consulta al abrir el diálogo y se respetan sus permisos (`puede`).
 * Si la oferta ya la tiene comercial (cerrada), o el usuario no puede cambiarla, el diálogo lo dice y solo cierra la conversación.
 * Un estatus de tipo CIERRE ya cierra la oferta, así que la casilla no hace falta.
 *
 * Orden: primero la conversación, luego el estatus, luego el cierre de la oferta (cada paso necesita la versión que dejó el
 * anterior). Si un paso de la oferta falla, lo ya hecho no se deshace: se avisa cuál falló y se termina desde Ofertas.
 */

import { useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cierraConversacion, type ConversacionHub } from "@/lib/hub/conversaciones";
import { cierraOferta, consultaEtiquetas, consultaOferta, registraRespuesta } from "@/lib/valuacion/acciones";
import { mensajeError } from "@/lib/hub/errores";
import { estadoInfo, type Etiqueta, type Oferta } from "@/lib/valuacion/tipos";

/** Motivos de cierre: los mismos que ofrece Ventas y Servicio. Se guarda el texto, que es el que se ve en la conversación cerrada. */
const MOTIVOS_CIERRE = ["Resuelto", "No interesado", "Duplicado", "Sin respuesta del cliente"];

/**
 * Qué estatus de la oferta tienen sentido con cada motivo de cierre (ids de valuacion.etiquetas, DB/Valuacion/Datos_maestros/etiquetas.sql).
 * Duplicado no toca la oferta: la sigue atendiendo la otra conversación.
 */
const ESTATUS_POR_MOTIVO: Record<string, string[]> = {
  "Resuelto": ["ACEPTA_VENTA_Y_COMPRA", "ACEPTA_VENTA", "EN_NEGOCIACION", "OFERTA_FINAL", "CLIENTE_ACEPTA_OFERTA_FINAL", "DESCARTADA_EN_INSPECCION", "CONTACTO_FUTURO"],
  "No interesado": ["CLIENTE_DECLINA", "CLIENTE_NO_ACEPTA_OFERTA_FINAL", "CONTACTO_FUTURO"],
  "Sin respuesta del cliente": ["NO_RESPONDE"],
  "Duplicado": [],
};
const MOTIVOS_QUE_NO_TOCAN_LA_OFERTA = ["Duplicado"];

const GRUPOS_ESTATUS: { tipo: Etiqueta["tipo"]; label: string }[] = [
  { tipo: "VIGENTE", label: "Sigue vigente" }, { tipo: "NO_VIGENTE", label: "Rechazo (queda no vigente)" }, { tipo: "CIERRE", label: "Cierra la oferta" },
];
const SIN_CAMBIO = "ninguno";

let etiquetasCache: Etiqueta[] | null = null;

type ConsultaOferta = { tipo: "cargando" } | { tipo: "lista"; oferta: Oferta } | { tipo: "error"; razon: string };

const causa = (r: { errorCode: string; errorMessage: string; info?: unknown }) => (r.errorCode === "SESION_EXPIRADA" ? "tu sesión venció" : mensajeError(r));

export function DialogoCierreConversacion({ conv, abierto, onCerrar, onCerrada }: {
  conv: ConversacionHub;
  abierto: boolean;
  onCerrar: () => void;
  /** Terminó el diálogo con cambios: la conversación ya cerrada, o undefined si hay que volver a consultarla. */
  onCerrada: (conv?: ConversacionHub) => void;
}) {
  const idOferta = conv.fuente === "valuacion" && conv.idExterno && Number.isInteger(Number(conv.idExterno)) ? Number(conv.idExterno) : null;
  const [motivo, setMotivo] = useState("");
  const [consulta, setConsulta] = useState<ConsultaOferta | null>(null);
  const [etiquetas, setEtiquetas] = useState<Etiqueta[] | null>(etiquetasCache);
  const [idEtiqueta, setIdEtiqueta] = useState("");
  const [motivoEstatus, setMotivoEstatus] = useState("");
  const [cerrarLaOferta, setCerrarLaOferta] = useState(false);
  const [trabajando, setTrabajando] = useState(false);

  // Al abrir: todo en blanco y se consulta la oferta (permisos y estado actuales)
  useEffect(() => {
    if (!abierto) return;
    setMotivo(""); setIdEtiqueta(""); setMotivoEstatus(""); setCerrarLaOferta(false);
    if (!idOferta) { setConsulta(null); return; }
    let vigente = true;
    setConsulta({ tipo: "cargando" });
    consultaOferta(idOferta).then((r) => {
      if (!vigente) return;
      setConsulta(r.successful
        ? { tipo: "lista", oferta: r.info.oferta }
        : { tipo: "error", razon: r.errorCode === "SIN_PERMISO" ? "No tienes permiso para ver ni cambiar esta oferta." : "No se pudo consultar la oferta." });
    });
    return () => { vigente = false; };
  }, [abierto, idOferta]);

  const oferta = consulta?.tipo === "lista" ? consulta.oferta : null;
  const puedeEstatus = !!oferta?.puede.registrarRespuesta;

  // Cambiar el motivo puede dejar sin sentido el estatus que ya se había elegido: se quita
  useEffect(() => {
    if (idEtiqueta && !(ESTATUS_POR_MOTIVO[motivo] ?? []).includes(idEtiqueta)) setIdEtiqueta("");
  }, [motivo, idEtiqueta]);

  // Los estatus que el valuador registra después del envío (la base los vuelve a validar)
  useEffect(() => {
    if (!abierto || !puedeEstatus || etiquetas) return;
    consultaEtiquetas().then((r) => { if (r.successful) { etiquetasCache = r.info.etiquetas; setEtiquetas(r.info.etiquetas); } });
  }, [abierto, puedeEstatus, etiquetas]);

  const noTocaOferta = MOTIVOS_QUE_NO_TOCAN_LA_OFERTA.includes(motivo);
  const permitidas = ESTATUS_POR_MOTIVO[motivo] ?? [];
  const opciones = (etiquetas ?? []).filter((e) =>
    e.momento === "DESPUES_DE_ENVIO" && e.origenes.includes("VALUADOR") && e.idEtiqueta !== "DESCARTADA_POR_VALUADOR" && permitidas.includes(e.idEtiqueta));
  const elegida = opciones.find((e) => e.idEtiqueta === idEtiqueta) ?? null;
  const etiquetaCierra = elegida?.tipo === "CIERRE";
  const puedeCerrar = !!oferta?.puede.cerrar && !etiquetaCierra && !noTocaOferta;
  const cierraOfertaAhora = puedeCerrar && cerrarLaOferta;
  const sinAcciones = !!oferta && !puedeEstatus && !oferta.puede.cerrar;
  const hayEstatusParaElMotivo = !!motivo && !noTocaOferta && (!etiquetas || opciones.length > 0);
  const hayOferta = !!elegida || cierraOfertaAhora;
  const valido = !!motivo && (!elegida || !elegida.esRequiereMotivo || motivoEstatus.trim().length > 0);

  const confirma = async () => {
    if (!valido) return;
    setTrabajando(true);
    const r = await cierraConversacion({ idConversacion: conv.idConversacion, motivo, versionEsperada: conv.version });
    if (!r.successful) {
      setTrabajando(false);
      if (r.errorCode === "SESION_EXPIRADA") { toast.error(mensajeError(r)); signOut({ redirectTo: "/login" }); return; }
      const info = (r.info ?? {}) as { motivo?: string };
      if (r.errorCode === "CONFLICTO_VERSION" || (r.errorCode === "ESTADO_INVALIDO" && info.motivo === "ESTADO_ACTUAL")) {
        // Cambió mientras tanto (p. ej. otro la cerró): se actualiza y se avisa
        toast.error(r.errorCode === "CONFLICTO_VERSION" ? "La conversación cambió mientras tanto. Se actualizó: revisa e intenta de nuevo." : "La conversación ya estaba cerrada.");
        onCerrar();
        onCerrada();
        return;
      }
      // SIN_PERMISO trae la causa en su mensaje ("la atiende otro asesor", "tu rol no permite modificar conversaciones")
      toast.error(r.errorCode === "SIN_PERMISO" ? r.errorMessage : mensajeError(r));
      return;
    }

    // La conversación ya quedó cerrada. Ahora la oferta, paso por paso; lo que falle se avisa sin deshacer lo hecho.
    const hechos = ["Conversación cerrada"];
    const fallos: string[] = [];
    let actual: Oferta | null = oferta;
    if (oferta && elegida) {
      const ro = await registraRespuesta({ idOferta: oferta.idOferta, version: oferta.version, idEtiqueta: elegida.idEtiqueta, motivo: motivoEstatus.trim() || undefined });
      if (ro.successful) {
        actual = ro.info.oferta;
        hechos.push(etiquetaCierra ? `estatus "${elegida.nombre}" (la oferta quedó cerrada)` : `estatus de la oferta "${elegida.nombre}"`);
      } else {
        actual = null; // sin la versión nueva no se sigue con la oferta
        fallos.push(`no se pudo cambiar el estatus de la oferta (${causa(ro)})`);
      }
    }
    if (actual && cierraOfertaAhora) {
      const rc = await cierraOferta({ idOferta: actual.idOferta, version: actual.version, motivo });
      if (rc.successful) hechos.push("oferta cerrada");
      else fallos.push(`no se pudo cerrar la oferta (${causa(rc)})`);
    }

    setTrabajando(false);
    if (fallos.length > 0) toast.warning(`Conversación cerrada, pero ${fallos.join(" y ")}. Termina desde Ofertas.`);
    else toast.success(hechos.join(", "));
    onCerrar();
    onCerrada(r.info.conversacion);
  };

  return (
    <Dialog open={abierto} onOpenChange={(a) => !trabajando && !a && onCerrar()}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Cerrar conversación</DialogTitle>
          <DialogDescription>Si el cliente vuelve a escribir, se abre una conversación nueva.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Motivo de cierre de la conversación</Label>
            <Select value={motivo} onValueChange={setMotivo}>
              <SelectTrigger><SelectValue placeholder="Seleccionar motivo..." /></SelectTrigger>
              <SelectContent>
                {MOTIVOS_CIERRE.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {idOferta && (
            <section className="space-y-3 pt-4 border-t" aria-label={`Oferta ${idOferta}`}>
              <div>
                <p className="text-sm font-medium">Oferta #{idOferta}</p>
                {oferta && (
                  <p className="text-xs text-muted-foreground">
                    Estado actual: {estadoInfo(oferta.estado).label}{oferta.etiqueta ? ` · ${oferta.etiqueta.nombre}` : ""}
                  </p>
                )}
              </div>

              {consulta?.tipo === "cargando" && <p className="text-xs text-muted-foreground">Consultando la oferta…</p>}
              {consulta?.tipo === "error" && <p className="text-xs text-muted-foreground">{consulta.razon} Solo se cerrará la conversación.</p>}
              {sinAcciones && (
                <p className="text-xs text-muted-foreground">
                  {oferta?.cierre
                    ? "La oferta ya fue cerrada y la tiene comercial: no admite cambios. Solo se cerrará la conversación."
                    : "La oferta no admite cambios en su estado actual. Solo se cerrará la conversación."}
                </p>
              )}

              {oferta && noTocaOferta && (
                <p className="text-xs text-muted-foreground">Con el motivo &quot;{motivo}&quot; no se modifica la oferta: la sigue atendiendo la otra conversación.</p>
              )}

              {puedeEstatus && !noTocaOferta && (
                <div className="space-y-2">
                  <Label>Estatus de la oferta</Label>
                  <Select value={idEtiqueta || SIN_CAMBIO} onValueChange={(v) => setIdEtiqueta(v === SIN_CAMBIO ? "" : v)} disabled={!etiquetas || !motivo}>
                    <SelectTrigger><SelectValue placeholder={!motivo ? "Elige primero el motivo de cierre" : etiquetas ? "Sin cambio" : "Cargando estatus…"} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SIN_CAMBIO}>Sin cambio</SelectItem>
                      {GRUPOS_ESTATUS.map((g) => {
                        const del = opciones.filter((e) => e.tipo === g.tipo);
                        return del.length ? (
                          <SelectGroup key={g.tipo}>
                            <SelectLabel>{g.label}</SelectLabel>
                            {del.map((e) => <SelectItem key={e.idEtiqueta} value={e.idEtiqueta}>{e.nombre}</SelectItem>)}
                          </SelectGroup>
                        ) : null;
                      })}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {!motivo ? "Los estatus disponibles dependen del motivo de cierre."
                      : hayEstatusParaElMotivo ? `Solo los estatus que tienen sentido con "${motivo}".`
                      : `No hay estatus de la oferta que apliquen con "${motivo}".`}
                  </p>
                </div>
              )}

              {elegida && (
                <div className="space-y-2">
                  <Label htmlFor="cierre-motivo-estatus">Motivo del estatus {elegida.esRequiereMotivo ? "(obligatorio)" : "(opcional)"}</Label>
                  <Textarea id="cierre-motivo-estatus" rows={2} value={motivoEstatus} onChange={(e) => setMotivoEstatus(e.target.value)} />
                </div>
              )}

              {etiquetaCierra && <p className="text-xs text-muted-foreground">Este estatus cierra la oferta: pasa a comercial y ya no cambia.</p>}
              {puedeCerrar && (
                <label className="flex items-start gap-2 cursor-pointer text-sm">
                  <input type="checkbox" className="mt-1" checked={cerrarLaOferta} onChange={(e) => setCerrarLaOferta(e.target.checked)} disabled={trabajando} />
                  <span>
                    También cerrar la oferta
                    <span className="block text-xs text-muted-foreground">
                      Es definitivo: la oferta pasa a comercial y ya no cambia ni se puede retomar. Lleva el motivo de cierre de la conversación.
                    </span>
                  </span>
                </label>
              )}
            </section>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCerrar} disabled={trabajando}>Cancelar</Button>
          <Button onClick={confirma} disabled={trabajando || !valido} className="hover:opacity-90"
            style={{ background: "var(--destructive)", color: "var(--destructive-foreground)" }}>
            {trabajando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {hayOferta ? "Cerrar conversación y actualizar oferta" : "Cerrar conversación"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
