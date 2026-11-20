"use client";

/**
 * Bots de Valuación de la marca activa (hub_cleber), con el mismo layout que la pantalla de Ventas y Servicio
 * (app/(app)/[module]/(ported)/bots): tarjetas con cada bot y su menú de acciones.
 * Lee con Hub.consultaConfiguracionModulo y guarda con Hub.guardaBot (administrador del módulo; los demás solo ven).
 * Crear y editar se hace en las rutas /valuacion/bots/new y /valuacion/bots/[id] (BotValuacionEditor).
 *
 * No hay "Eliminar": la base no borra bots (un bot puede estar asignado a un número y tener conversaciones); se pausa.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { Bot, Clock, Loader2, MessageSquare, MoreVertical, Phone, Plus } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import type { ModuleDef } from "@/lib/modules";
import { modulePath } from "@/lib/routes";
import { consultaConfiguracionModulo, guardaBot, type Bot as BotHub, type ConfiguracionModulo } from "@/lib/hub/configuracion";
import { mensajeError } from "@/lib/valuacion/tipos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { noAbre, tarjetaClicable } from "./tarjeta";

const MODULO = "valuacion" as const;
const TIPOS: Record<string, string> = { chatllm: "ChatLLM", workflow: "AI Workflow", vertex_ai: "Vertex AI", external: "Bot externo (HTTP)" };

export function BotsValuacionView({ mod }: { mod: ModuleDef }) {
  const { userData } = useAuth();
  const router = useRouter();
  const idMarca = userData?.organizationId ?? null;
  const [conf, setConf] = useState<ConfiguracionModulo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cambiando, setCambiando] = useState<string | null>(null);

  const sesionVencida = (r: { errorCode: string; errorMessage: string }) => { toast.error(mensajeError(r)); signOut({ redirectTo: "/login" }); };

  const carga = useCallback(async () => {
    if (!idMarca) return;
    setError(null);
    const r = await consultaConfiguracionModulo({ idMarca, modulo: MODULO });
    if (r.successful) { setConf(r.info); return; }
    if (r.errorCode === "SESION_EXPIRADA") return sesionVencida(r);
    setError(mensajeError(r));
  }, [idMarca]);

  useEffect(() => { setConf(null); carga(); }, [carga]);

  const pausaOActiva = async (b: BotHub) => {
    setCambiando(b.idBot);
    const r = await guardaBot({ idBot: b.idBot, esActivo: !b.esActivo });
    setCambiando(null);
    if (!r.successful) {
      if (r.errorCode === "SESION_EXPIRADA") return sesionVencida(r);
      toast.error(mensajeError(r));
      return;
    }
    toast.success(b.esActivo ? "Bot pausado" : "Bot activado");
    carga();
  };

  if (!idMarca) {
    return (
      <div>
        <Encabezado />
        <Card><CardContent className="py-8 text-center"><p className="text-gray-500">Necesitas pertenecer a una marca para ver bots.</p></CardContent></Card>
      </div>
    );
  }
  if (error) {
    return (
      <div>
        <Encabezado />
        <Card><CardContent className="py-8 text-center space-y-3">
          <p className="text-red-600">{error}</p>
          <Button variant="outline" onClick={carga}>Reintentar</Button>
        </CardContent></Card>
      </div>
    );
  }
  if (!conf) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="h-8 w-8 animate-spin text-gray-400" /></div>;
  }

  const puedeEditar = conf.puedeEditar;
  const bots = [...conf.bots].sort((a, b) => Number(b.esActivo) - Number(a.esActivo) || a.nombre.localeCompare(b.nombre));
  const numerosDe = (idBot: string) => conf.numeros.filter((n) => n.idBotDefault === idBot);

  return (
    <div>
      <Encabezado
        accion={puedeEditar ? (
          <Link href={modulePath(mod.id, "/bots/new")}><Button><Plus className="mr-2 h-4 w-4" />Crear Bot</Button></Link>
        ) : null}
      />

      {bots.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="rounded-full bg-gray-100 p-4 mb-4"><Bot className="h-8 w-8 text-gray-400" /></div>
            <h3 className="text-lg font-medium mb-2">No tienes bots</h3>
            <p className="text-gray-500 text-center mb-4">
              {puedeEditar
                ? "Crea el bot de Valuación de la marca para que responda las dudas de los clientes por WhatsApp."
                : "Un administrador de Valuación debe crear el bot de tu marca."}
            </p>
            {puedeEditar && <Link href={modulePath(mod.id, "/bots/new")}><Button><Plus className="mr-2 h-4 w-4" />Crear Bot</Button></Link>}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {bots.map((bot) => {
            const c = bot.config ?? {};
            const numeros = numerosDe(bot.idBot);
            const clic = tarjetaClicable(() => router.push(modulePath(mod.id, `/bots/${bot.idBot}`)), `${puedeEditar ? "Editar" : "Ver"} el bot ${bot.nombre}`);
            return (
              <Card key={bot.idBot} {...clic} className={cn("relative", clic.className)}>
                <CardHeader className="flex flex-row items-start justify-between pb-2">
                  <div className="flex items-start gap-3">
                    <div className="rounded-lg bg-blue-100 p-2"><Bot className="h-5 w-5 text-blue-600" /></div>
                    <div>
                      <CardTitle className="text-lg">{bot.nombre}</CardTitle>
                      <CardDescription className="mt-1">{c.description}</CardDescription>
                    </div>
                  </div>
                  <div {...noAbre}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Acciones del bot"><MoreVertical className="h-4 w-4" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild><Link href={modulePath(mod.id, `/bots/${bot.idBot}`)}>{puedeEditar ? "Editar" : "Ver"}</Link></DropdownMenuItem>
                      {puedeEditar && (
                        <DropdownMenuItem onClick={() => pausaOActiva(bot)} disabled={cambiando === bot.idBot}>
                          {bot.esActivo ? "Pausar" : "Activar"}
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm text-gray-600">
                      <Phone className="h-4 w-4" />
                      <span>
                        {numeros.length > 0
                          ? numeros.map((n) => n.telefono).join(", ")
                          : <span className="text-amber-700">Sin número asignado (se asigna en WhatsApp)</span>}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-gray-600">
                      <MessageSquare className="h-4 w-4" />
                      <span>Handoff: {c.handoffConfig?.enabled ? "Habilitado" : "Deshabilitado"}</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-gray-600">
                      <Clock className="h-4 w-4" />
                      <span>Horario: {c.scheduleConfig?.enabled ? "Con horario de atención" : "Sin horario"}</span>
                    </div>
                    <div className="text-xs text-gray-500">
                      {TIPOS[bot.tipo] ?? bot.tipo}
                      {c.abacusConfig?.deploymentId ? <> · Deployment <span className="font-mono">{c.abacusConfig.deploymentId}</span></> : <> · <span className="text-amber-700">sin Deployment ID</span></>}
                    </div>
                    <div className="flex items-center justify-between pt-2 border-t">
                      <span className="text-xs text-gray-500">Estado</span>
                      <Badge variant={bot.esActivo ? "default" : "secondary"} className={bot.esActivo ? "bg-green-100 text-green-800 hover:bg-green-100" : ""}>
                        {bot.esActivo ? "Activo" : "Pausado"}
                      </Badge>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Encabezado({ accion }: { accion?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-8">
      <div>
        <h1 className="text-2xl font-bold">Bots</h1>
        <p className="text-gray-500">Gestiona los chatbots de WhatsApp de Valuación</p>
      </div>
      {accion}
    </div>
  );
}
