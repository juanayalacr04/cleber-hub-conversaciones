"use client";

/**
 * Equipos de Valuación de la marca activa (hub_cleber), con el layout de la pantalla de Equipos de Ventas y Servicio:
 * tarjetas y un diálogo para dar de alta o editar. Lee con Hub.consultaConfiguracionModulo y guarda con Hub.guardaEquipo
 * (administrador del módulo; los demás solo ven).
 *
 * El equipo decide quién ve las conversaciones (un valuador que no administra el módulo solo ve las de su equipo; el equipo
 * de la conversación es el de su número) y cómo se asignan al pasar a asesor:
 *   manual       queda "Esperando" y la toma o la asigna un administrador
 *   round_robin  el hub la asigna al siguiente valuador disponible del equipo, por turnos
 *   least_busy   el hub la asigna al valuador disponible con menos conversaciones "Con agente"
 * (Hub.asignaAgenteAutomatico). Los valuadores se ligan al equipo en Usuarios.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { Eye, EyeOff, Loader2, MoreVertical, Pencil, Phone, Plus, Users2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import type { ModuleDef } from "@/lib/modules";
import { modulePath } from "@/lib/routes";
import {
  consultaConfiguracionModulo, guardaEquipo, type ConfiguracionModulo, type Equipo, type ModoAsignacion,
} from "@/lib/hub/configuracion";
import { consultaUsuarios, type UsuarioEnMarca } from "@/lib/hub/usuarios";
import { mensajeError } from "@/lib/valuacion/tipos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const MODULO = "valuacion" as const;

const MODOS: { id: Exclude<ModoAsignacion, "salesforce">; nombre: string; descripcion: string }[] = [
  { id: "manual", nombre: "Manual", descripcion: "Al pasar a asesor queda \"Esperando\" y un administrador la toma o la asigna." },
  { id: "round_robin", nombre: "Round Robin", descripcion: "Se asigna sola al siguiente valuador disponible del equipo, por turnos." },
  { id: "least_busy", nombre: "Menos ocupado", descripcion: "Se asigna sola al valuador disponible con menos conversaciones en curso." },
];
const nombreModo = (m: ModoAsignacion) => MODOS.find((x) => x.id === m)?.nombre ?? (m === "salesforce" ? "Salesforce" : m);

const OPT_OUT_BOT = "bot";
const OPT_OUT: { id: string; nombre: string }[] = [
  { id: OPT_OUT_BOT, nombre: "Lo decide el bot (si no, cerrar)" },
  { id: "close", nombre: "Cerrar la conversación" },
  { id: "handoff", nombre: "Pasar a un valuador" },
];

interface Borrador { nombre: string; modo: Exclude<ModoAsignacion, "salesforce">; max: string; optOut: string }
const VACIO: Borrador = { nombre: "", modo: "manual", max: "", optOut: OPT_OUT_BOT };

export function EquiposValuacionView({ mod }: { mod: ModuleDef }) {
  const { userData } = useAuth();
  const idMarca = userData?.organizationId ?? null;
  const [conf, setConf] = useState<ConfiguracionModulo | null>(null);
  const [usuarios, setUsuarios] = useState<UsuarioEnMarca[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [abierto, setAbierto] = useState(false);
  const [editando, setEditando] = useState<Equipo | null>(null);
  const [form, setForm] = useState<Borrador>(VACIO);
  const [guardando, setGuardando] = useState(false);

  const sesionVencida = (r: { errorCode: string; errorMessage: string }) => { toast.error(mensajeError(r)); signOut({ redirectTo: "/login" }); };

  const carga = useCallback(async () => {
    if (!idMarca) return;
    setError(null);
    const [r, u] = await Promise.all([consultaConfiguracionModulo({ idMarca, modulo: MODULO }), consultaUsuarios({ idMarca, modulo: MODULO })]);
    if (u.successful) setUsuarios(u.info.usuarios);
    if (r.successful) { setConf(r.info); return; }
    if (r.errorCode === "SESION_EXPIRADA") return sesionVencida(r);
    setError(mensajeError(r));
  }, [idMarca]);

  useEffect(() => { setConf(null); carga(); }, [carga]);

  const valuadoresDe = (id: string) => usuarios.filter((u) => u.esActivo && u.modulos.valuacion?.idEquipo === id);
  const numerosDe = (id: string) => (conf?.numeros ?? []).filter((n) => n.idEquipo === id);

  const abreAlta = () => { setEditando(null); setForm(VACIO); setAbierto(true); };
  const abreEdicion = (e: Equipo) => {
    setEditando(e);
    setForm({
      nombre: e.nombre,
      modo: e.modoAsignacion === "salesforce" ? "manual" : e.modoAsignacion,
      max: e.maxConversacionesAgente ? String(e.maxConversacionesAgente) : "",
      optOut: e.accionOptOut ?? OPT_OUT_BOT,
    });
    setAbierto(true);
  };

  const guarda = async (cambios: Parameters<typeof guardaEquipo>[0], exito: string) => {
    setGuardando(true);
    try {
      const r = await guardaEquipo(cambios);
      if (!r.successful) {
        if (r.errorCode === "SESION_EXPIRADA") sesionVencida(r); else toast.error(mensajeError(r));
        return false;
      }
      toast.success(exito);
      await carga();
      return true;
    } finally {
      setGuardando(false);
    }
  };

  const max = form.max.trim() ? Number(form.max) : null;
  const maxValido = max === null || (Number.isInteger(max) && max >= 1 && max <= 1000);
  const valido = !!form.nombre.trim() && maxValido;

  const confirma = async () => {
    if (!idMarca || !valido) return;
    const campos = {
      nombre: form.nombre.trim(), modoAsignacion: form.modo, maxConversacionesAgente: max,
      accionOptOut: form.optOut === OPT_OUT_BOT ? null : (form.optOut as "close" | "handoff"),
    };
    const ok = editando
      ? await guarda({ idEquipo: editando.idEquipo, idMarca, modulo: MODULO, ...campos }, "Equipo actualizado")
      : await guarda({ idMarca, modulo: MODULO, ...campos }, "Equipo creado");
    if (ok) setAbierto(false);
  };

  const cambiaEstado = (e: Equipo) => {
    if (!idMarca) return;
    guarda({ idEquipo: e.idEquipo, idMarca, modulo: MODULO, esActivo: !e.esActivo }, e.esActivo ? "Equipo desactivado" : "Equipo activado");
  };

  if (!idMarca) {
    return (
      <div>
        <div className="mb-8"><h1 className="text-2xl font-bold">Equipos</h1></div>
        <Card><CardContent className="py-8 text-center"><p className="text-gray-500">Necesitas pertenecer a una marca para ver los equipos.</p></CardContent></Card>
      </div>
    );
  }
  if (error) {
    return (
      <div>
        <div className="mb-8"><h1 className="text-2xl font-bold">Equipos</h1></div>
        <Card><CardContent className="py-8 text-center space-y-3">
          <p className="text-gray-500">No se pudieron cargar los equipos: {error}</p>
          <Button variant="outline" onClick={carga}>Reintentar</Button>
        </CardContent></Card>
      </div>
    );
  }
  if (!conf) return <div className="flex items-center justify-center h-64"><Loader2 className="h-8 w-8 animate-spin text-gray-400" /></div>;

  const puedeEditar = conf.puedeEditar;
  const equipos = [...conf.equipos].sort((a, b) => Number(b.esActivo) - Number(a.esActivo) || a.nombre.localeCompare(b.nombre));
  const modo = MODOS.find((m) => m.id === form.modo);

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Equipos</h1>
          <p className="text-gray-500">Quién atiende las conversaciones de Valuación y cómo se asignan al pasar a un valuador</p>
        </div>
        {puedeEditar && <Button onClick={abreAlta}><Plus className="mr-2 h-4 w-4" />Nuevo equipo</Button>}
      </div>

      {equipos.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="rounded-full bg-gray-100 p-4 mb-4"><Users2 className="h-8 w-8 text-gray-400" /></div>
            <h3 className="text-lg font-medium mb-2">No hay equipos</h3>
            <p className="text-gray-500 text-center mb-4">Crea un equipo, asígnalo al número de WhatsApp y liga a los valuadores en Usuarios.</p>
            {puedeEditar && <Button onClick={abreAlta}><Plus className="mr-2 h-4 w-4" />Nuevo equipo</Button>}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {equipos.map((e) => {
            const valuadores = valuadoresDe(e.idEquipo);
            const disponibles = valuadores.filter((u) => u.esDisponible).length;
            const numeros = numerosDe(e.idEquipo);
            return (
              <Card key={e.idEquipo} className={e.esActivo ? "" : "opacity-60"}>
                <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                  <CardTitle className="text-lg flex items-center gap-2"><Users2 className="h-5 w-5 text-gray-500" />{e.nombre}</CardTitle>
                  {puedeEditar && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label="Acciones del equipo"><MoreVertical className="h-4 w-4" /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => abreEdicion(e)}><Pencil className="mr-2 h-4 w-4" />Editar</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => cambiaEstado(e)} disabled={guardando}>
                          {e.esActivo ? <><EyeOff className="mr-2 h-4 w-4" />Desactivar</> : <><Eye className="mr-2 h-4 w-4" />Activar</>}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    {!e.esActivo && <Badge variant="secondary">Inactivo</Badge>}
                    <Badge variant="outline">{nombreModo(e.modoAsignacion)}</Badge>
                    <span className="text-sm text-gray-500">{e.maxConversacionesAgente ? `Máx. ${e.maxConversacionesAgente} conv/valuador` : "Sin tope"}</span>
                  </div>
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2">
                      <Users2 className="h-4 w-4 text-gray-400" />
                      <span>{valuadores.length} valuador{valuadores.length !== 1 ? "es" : ""} · {disponibles} disponible{disponibles !== 1 ? "s" : ""}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Phone className="h-4 w-4 text-gray-400" />
                      <span>{numeros.length ? numeros.map((n) => n.nombre).join(", ") : <span className="text-amber-700">Sin número asignado</span>}</span>
                    </div>
                  </div>
                  {valuadores.length === 0 && e.esActivo && (
                    <p className="text-xs text-amber-700">
                      Sin valuadores: liga a los valuadores en <Link className="underline" href={modulePath(mod.id, "/agentes")}>Usuarios</Link>.
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={abierto} onOpenChange={(o) => !guardando && setAbierto(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editando ? "Editar equipo" : "Nuevo equipo"}</DialogTitle>
            <DialogDescription>Equipo de Valuación de la marca.</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); confirma(); }}>
            <div className="space-y-2">
              <Label htmlFor="eq-nombre">Nombre</Label>
              <Input id="eq-nombre" value={form.nombre} maxLength={100} onChange={(ev) => setForm((f) => ({ ...f, nombre: ev.target.value }))} placeholder="Valuación" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="eq-modo">Modo de asignación</Label>
              <Select value={form.modo} onValueChange={(v) => setForm((f) => ({ ...f, modo: v as Borrador["modo"] }))}>
                <SelectTrigger id="eq-modo"><SelectValue /></SelectTrigger>
                <SelectContent>{MODOS.map((m) => <SelectItem key={m.id} value={m.id}>{m.nombre}</SelectItem>)}</SelectContent>
              </Select>
              {modo && <p className="text-xs text-gray-500">{modo.descripcion}</p>}
            </div>
            {form.modo !== "manual" && (
              <div className="space-y-2">
                <Label htmlFor="eq-max">Máximo de conversaciones por valuador</Label>
                <Input id="eq-max" type="number" min={1} max={1000} value={form.max} placeholder="Sin tope"
                  onChange={(ev) => setForm((f) => ({ ...f, max: ev.target.value }))} />
                <p className={maxValido ? "text-xs text-gray-500" : "text-xs text-red-600"}>
                  {maxValido ? "Quien ya tiene ese número de conversaciones en curso no recibe más. Vacío: sin tope." : "Debe ser un número entre 1 y 1000."}
                </p>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="eq-optout">Cuando el cliente pide no recibir mensajes</Label>
              <Select value={form.optOut} onValueChange={(v) => setForm((f) => ({ ...f, optOut: v }))}>
                <SelectTrigger id="eq-optout"><SelectValue /></SelectTrigger>
                <SelectContent>{OPT_OUT.map((o) => <SelectItem key={o.id} value={o.id}>{o.nombre}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAbierto(false)} disabled={guardando}>Cancelar</Button>
              <Button type="submit" disabled={!valido || guardando}>
                {guardando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{editando ? "Guardar" : "Crear equipo"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
