"use client";

/**
 * Crear o editar un bot de Valuación (hub_cleber), con las mismas pestañas que la pantalla de Ventas y Servicio
 * (app/(app)/[module]/(ported)/bots/[id]) que aplican a Valuación:
 *   General · Abacus AI · Handoff · Horarios · Avanzado · ChatLLM (solo bots ya creados y solo para quien administra)
 * No están: Twilio (el número y su proveedor se configuran en WhatsApp), Inactividad (los recordatorios aún no corren en AWS)
 * ni Situaciones (es de Ventas).
 * ChatLLM muestra lo que Abacus tiene configurado para el deployment del bot (lib/hub/abacus.ts), con la misma vista que Ventas
 * y Servicio (components/bots/ChatLLMConfigView.tsx).
 *
 * Lee con Hub.consultaConfiguracionModulo y guarda con Hub.guardaBot (administrador del módulo; los demás solo ven).
 * La conversión entre el formulario y `bots.config` está en lib/hub/bots.ts. Ninguna credencial se captura aquí: el token de
 * Abacus es uno por módulo y vive en el secreto del ambiente.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { ArrowLeft, Brain, Loader2, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import type { ModuleDef } from "@/lib/modules";
import { modulePath } from "@/lib/routes";
import { consultaConfiguracionModulo, guardaBot, type Bot as BotHub, type ConfiguracionModulo } from "@/lib/hub/configuracion";
import { consultaConfigAbacus } from "@/lib/hub/abacus";
import {
  HERRAMIENTA_RESULTADO, RESULTADOS_VALUACION, aBorrador, aConfig, borradorVacio, validaBorrador, type BorradorBot,
} from "@/lib/hub/bots";
import { mensajeError } from "@/lib/valuacion/tipos";
import { ScheduleConfigTab } from "@/components/bots/ScheduleConfigTab";
import { ChatLLMConfigView } from "@/components/bots/ChatLLMConfigView";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const MODULO = "valuacion" as const;

export function BotValuacionEditor({ mod, idBot }: { mod: ModuleDef; idBot: string | null }) {
  const router = useRouter();
  const { userData } = useAuth();
  const idMarca = userData?.organizationId ?? null;
  const [conf, setConf] = useState<ConfiguracionModulo | null>(null);
  const [bot, setBot] = useState<BotHub | null>(null);
  const [f, setF] = useState<BorradorBot>(borradorVacio);
  const [error, setError] = useState<string | null>(null);
  const [noExiste, setNoExiste] = useState(false);
  const [guardando, setGuardando] = useState(false);
  // Pestaña ChatLLM: lo que Abacus tiene configurado; se consulta al abrirla, no al cargar la pantalla
  const [abacus, setAbacus] = useState<Record<string, unknown> | null>(null);
  const [cargandoAbacus, setCargandoAbacus] = useState(false);
  const [errorAbacus, setErrorAbacus] = useState("");

  const edita = (parche: Partial<BorradorBot>) => setF((previo) => ({ ...previo, ...parche }));
  const lista = modulePath(mod.id, "/bots");
  const sesionVencida = (r: { errorCode: string; errorMessage: string }) => { toast.error(mensajeError(r)); signOut({ redirectTo: "/login" }); };

  const carga = useCallback(async () => {
    if (!idMarca) return;
    setError(null);
    const r = await consultaConfiguracionModulo({ idMarca, modulo: MODULO });
    if (!r.successful) {
      if (r.errorCode === "SESION_EXPIRADA") return sesionVencida(r);
      setError(mensajeError(r));
      return;
    }
    setConf(r.info);
    if (idBot) {
      const encontrado = r.info.bots.find((b) => b.idBot === idBot) ?? null;
      setBot(encontrado);
      setNoExiste(!encontrado);
      if (encontrado) setF(aBorrador(encontrado));
    }
  }, [idMarca, idBot]);

  useEffect(() => { setConf(null); carga(); }, [carga]);

  const cargaAbacus = async () => {
    if (!idMarca || !bot) return;
    setCargandoAbacus(true);
    setErrorAbacus("");
    const r = await consultaConfigAbacus({ idMarca, idBot: bot.idBot });
    setCargandoAbacus(false);
    if (r.successful) { setAbacus(r.info); return; }
    if (r.errorCode === "SESION_EXPIRADA") return sesionVencida(r);
    setErrorAbacus(r.errorMessage || mensajeError(r));
  };

  const guarda = async () => {
    const problema = validaBorrador(f);
    if (problema) { toast.error(problema); return; }
    if (!idMarca) return;
    setGuardando(true);
    const config = aConfig(f, bot?.config);
    const r = await guardaBot(bot
      ? { idBot: bot.idBot, nombre: f.nombre.trim(), tipo: f.tipo, config, esActivo: f.esActivo }
      : { idMarca, modulo: MODULO, nombre: f.nombre.trim(), tipo: f.tipo, config, esActivo: f.esActivo });
    setGuardando(false);
    if (!r.successful) {
      if (r.errorCode === "SESION_EXPIRADA") return sesionVencida(r);
      toast.error(mensajeError(r));
      return;
    }
    toast.success(bot ? "Bot guardado" : "Bot creado");
    router.push(lista);
  };

  if (!idMarca) return <Aviso lista={lista} texto="Necesitas pertenecer a una marca para administrar bots." />;
  if (error) return <Aviso lista={lista} texto={error} reintentar={carga} />;
  if (!conf) return <div className="flex items-center justify-center h-64"><Loader2 className="h-8 w-8 animate-spin text-gray-400" /></div>;
  if (noExiste) return <Aviso lista={lista} texto="Bot no encontrado." />;

  const puedeEditar = conf.puedeEditar;
  if (!bot && !puedeEditar) return <Aviso lista={lista} texto="Solo un administrador de Valuación puede crear bots." />;
  const numeros = bot ? conf.numeros.filter((n) => n.idBotDefault === bot.idBot) : [];

  return (
    <div>
      <div className="flex items-center gap-4 mb-8">
        <Link href={lista}><Button variant="ghost" size="icon" aria-label="Volver a Bots"><ArrowLeft className="h-5 w-5" /></Button></Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{bot ? (puedeEditar ? "Editar Bot" : "Bot") : "Crear Bot"}</h1>
          <p className="text-gray-500">{bot ? bot.nombre : "Configura un nuevo chatbot de WhatsApp de Valuación"}</p>
        </div>
        {puedeEditar && (
          <Button onClick={guarda} disabled={guardando}>
            {guardando ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            {bot ? "Guardar Cambios" : "Crear Bot"}
          </Button>
        )}
      </div>

      {!puedeEditar && <p className="mb-4 text-sm text-gray-500">Solo un administrador de Valuación puede cambiar la configuración del bot.</p>}

      <Tabs defaultValue="general" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="abacus">Abacus AI</TabsTrigger>
          <TabsTrigger value="handoff">Handoff</TabsTrigger>
          <TabsTrigger value="horarios">Horarios</TabsTrigger>
          <TabsTrigger value="avanzado">Avanzado</TabsTrigger>
          {bot && puedeEditar && (
            <TabsTrigger value="chatllm" onClick={() => { if (!abacus && !cargandoAbacus) cargaAbacus(); }}>ChatLLM</TabsTrigger>
          )}
        </TabsList>

        {/* fieldset deshabilitado: quien no administra ve todo y no puede cambiar nada */}
        <fieldset disabled={!puedeEditar || guardando} className="min-w-0 border-0 p-0 m-0">
          <TabsContent value="general">
            <Card>
              <CardHeader>
                <CardTitle>Información General</CardTitle>
                <CardDescription>Nombre y descripción del bot</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="bot-nombre">Nombre del Bot</Label>
                  <Input id="bot-nombre" value={f.nombre} onChange={(e) => edita({ nombre: e.target.value })} placeholder="Ej: Bot de Valuación Toyota" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bot-descripcion">Descripción</Label>
                  <Input id="bot-descripcion" value={f.descripcion} onChange={(e) => edita({ descripcion: e.target.value })}
                    placeholder="Ej: Responde las dudas de la oferta de compra del auto" />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="h-4 w-4 rounded border-gray-300" checked={f.esActivo} onChange={(e) => edita({ esActivo: e.target.checked })} />
                  Bot activo
                </label>
                <p className="text-xs text-gray-500">Un bot pausado no contesta: los mensajes del cliente se guardan, pero nadie responde.</p>
                {bot && (
                  <div className="pt-2 border-t text-sm">
                    <p className="font-medium">Número de WhatsApp</p>
                    {numeros.length > 0 ? (
                      <p className="text-gray-600">Atiende en: <span className="font-mono">{numeros.map((n) => n.telefono).join(", ")}</span></p>
                    ) : (
                      <p className="text-amber-700">Este bot no está asignado a ningún número.</p>
                    )}
                    <p className="text-xs text-gray-500 mt-1">
                      El bot que contesta en cada número se elige en <Link className="underline" href={modulePath(mod.id, "/whatsapp")}>WhatsApp</Link> (campo &quot;Bot por defecto&quot;).
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="abacus">
            <Card>
              <CardHeader>
                <CardTitle>Configuración de Abacus AI</CardTitle>
                <CardDescription>El bot de Abacus que contesta en este número</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="bot-tipo">Tipo de Bot</Label>
                  <Select value={f.tipo} onValueChange={(v) => edita({ tipo: v as BorradorBot["tipo"] })}>
                    <SelectTrigger id="bot-tipo"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="chatllm">ChatLLM</SelectItem>
                      <SelectItem value="workflow">AI Workflow</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-gray-500">ChatLLM usa getConversationResponse. AI Workflow usa executeSyncConversationAgent.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bot-deployment">Deployment ID</Label>
                  <Input id="bot-deployment" value={f.deploymentId} onChange={(e) => edita({ deploymentId: e.target.value })} placeholder="xxxxxxxxx" className="font-mono" />
                  <p className="text-xs text-gray-500">Lo da Abacus al crear el deployment del bot. Cada marca tiene el suyo.</p>
                </div>
                {f.tipo === "workflow" && (
                  <div className="space-y-2">
                    <Label htmlFor="bot-workflow">Nombre del argumento de entrada</Label>
                    <Input id="bot-workflow" value={f.workflowInputName} onChange={(e) => edita({ workflowInputName: e.target.value })} placeholder="message" />
                    <p className="text-xs text-gray-500">Vacío = &quot;message&quot;.</p>
                  </div>
                )}
                <div className="rounded-md border bg-muted/30 p-3 text-xs text-gray-600 space-y-1">
                  <p className="font-medium text-gray-700">Credenciales</p>
                  <p>
                    El token de Abacus no se captura aquí: es uno por módulo y lo toma el sistema del secreto del ambiente
                    (<span className="font-mono">ABACUS_DEPLOYMENT_TOKEN_VALUACION</span>). Solo hace falta el Deployment ID.
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="handoff">
            <Card>
              <CardHeader>
                <CardTitle>Configuración de Handoff</CardTitle>
                <CardDescription>Configura cuándo el bot debe transferir a un agente humano</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="bot-handoff" className="h-4 w-4 rounded border-gray-300" checked={f.handoffActivo} onChange={(e) => edita({ handoffActivo: e.target.checked })} />
                  <Label htmlFor="bot-handoff">Habilitar handoff a agentes</Label>
                </div>
                {f.handoffActivo && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="bot-palabras">Palabras clave para handoff</Label>
                      <Input id="bot-palabras" value={f.palabras} onChange={(e) => edita({ palabras: e.target.value })} placeholder="hablar con humano, asesor, agente" />
                      <p className="text-xs text-gray-500">Separadas por comas. Cuando el cliente escriba alguna de estas palabras, se transferirá a un agente.</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="bot-msg-handoff">Mensaje al escalar</Label>
                      <Input id="bot-msg-handoff" value={f.mensajeHandoff} onChange={(e) => edita({ mensajeHandoff: e.target.value })}
                        placeholder="Entendido, te comunico con un asesor. En un momento te atenderán." />
                      <p className="text-xs text-gray-500">Vacío = mensaje por defecto.</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="bot-msg-espera">Mensaje mientras espera asesor</Label>
                      <Input id="bot-msg-espera" value={f.mensajeEspera} onChange={(e) => edita({ mensajeEspera: e.target.value })}
                        placeholder="Tu mensaje fue recibido. Un asesor te atenderá pronto." />
                      <p className="text-xs text-gray-500">Vacío = mensaje por defecto.</p>
                    </div>
                  </>
                )}
                <div className="space-y-2">
                  <Label htmlFor="bot-optout">Cuando el cliente pide no ser contactado (&ldquo;stop&rdquo;)</Label>
                  <Select value={f.optOut} onValueChange={(v) => edita({ optOut: v as BorradorBot["optOut"] })}>
                    <SelectTrigger id="bot-optout"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inherit">Usar la configuración del equipo</SelectItem>
                      <SelectItem value="close">Cerrar la conversación</SelectItem>
                      <SelectItem value="handoff">Pasar a un asesor</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="horarios">
            <ScheduleConfigTab
              enabled={f.horarioActivo} onEnabledChange={(v) => edita({ horarioActivo: v })}
              timezone={f.zonaHoraria} onTimezoneChange={(v) => edita({ zonaHoraria: v })}
              outOfHoursMessage={f.mensajeFueraHorario} onOutOfHoursMessageChange={(v) => edita({ mensajeFueraHorario: v })}
              days={f.dias} onDaysChange={(v) => edita({ dias: v })}
              viaBot={f.horarioViaBot} onViaBotChange={(v) => edita({ horarioViaBot: v })}
            />
          </TabsContent>

          <TabsContent value="avanzado">
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Clasificación del resultado</CardTitle>
                  <CardDescription>
                    Cómo reporta el bot el resultado de la conversación. Lo que clasifique se avisa a Valuación y cambia la etiqueta de la oferta.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="bot-resultados">Acciones de clasificación de resultado</Label>
                    <Input id="bot-resultados" value={f.resultados} onChange={(e) => edita({ resultados: e.target.value })} className="font-mono"
                      placeholder={RESULTADOS_VALUACION.join(", ")} />
                    <p className="text-xs text-gray-500">
                      Separadas por comas. Deben ser exactamente las que reconoce Valuación; el hub descarta cualquier otra.
                      Vacío = las de Ventas y Servicio (interes_cita, otro_motivo), que Valuación no reconoce.
                    </p>
                    <Button type="button" variant="outline" size="sm" onClick={() => edita({ resultados: RESULTADOS_VALUACION.join(", ") })}>
                      Usar las de Valuación
                    </Button>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="bot-herramienta">Herramienta que reporta el resultado</Label>
                    <Input id="bot-herramienta" value={f.herramientaResultado} onChange={(e) => edita({ herramientaResultado: e.target.value })}
                      className="font-mono" placeholder={HERRAMIENTA_RESULTADO} />
                    <p className="text-xs text-gray-500">
                      Nombre de la herramienta del bot en Abacus. Hoy el bot de pruebas no tiene herramientas: estas dos opciones
                      toman efecto cuando se agreguen.
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Contexto de teléfono</CardTitle>
                  <CardDescription>Antepone el teléfono del cliente al primer mensaje que recibe el bot.</CardDescription>
                </CardHeader>
                <CardContent>
                  <Select value={f.telefonoEnContexto} onValueChange={(v) => edita({ telefonoEnContexto: v as BorradorBot["telefonoEnContexto"] })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Por defecto (solo Twilio)</SelectItem>
                      <SelectItem value="yes">Siempre</SelectItem>
                      <SelectItem value="no">Nunca</SelectItem>
                    </SelectContent>
                  </Select>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </fieldset>

        {bot && puedeEditar && (
          <TabsContent value="chatllm">
            {cargandoAbacus ? (
              <div className="flex items-center justify-center h-64"><Loader2 className="h-8 w-8 animate-spin text-gray-400" /></div>
            ) : errorAbacus ? (
              <Card>
                <CardContent className="py-8 text-center">
                  <p className="text-gray-500 mb-4">{errorAbacus}</p>
                  <Button variant="outline" onClick={cargaAbacus}><RefreshCw className="mr-2 h-4 w-4" />Reintentar</Button>
                </CardContent>
              </Card>
            ) : abacus ? (
              <ChatLLMConfigView config={abacus} onRefresh={cargaAbacus} />
            ) : (
              <Card>
                <CardContent className="py-8 text-center">
                  <p className="text-gray-500 mb-4">Carga la configuración del modelo ChatLLM desde Abacus AI.</p>
                  <Button onClick={cargaAbacus}><Brain className="mr-2 h-4 w-4" />Cargar Configuración</Button>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function Aviso({ lista, texto, reintentar }: { lista: string; texto: string; reintentar?: () => void }) {
  return (
    <div className="text-center py-12 space-y-3">
      <p className="text-gray-500">{texto}</p>
      {reintentar && <Button variant="outline" onClick={reintentar}>Reintentar</Button>}
      <div><Link href={lista}><Button variant="link">Volver a Bots</Button></Link></div>
    </div>
  );
}
