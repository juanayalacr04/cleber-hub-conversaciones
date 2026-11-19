"use client";

/**
 * Editor de usuarios de la marca activa sobre hub_cleber (PostgreSQL). Quién edita qué lo decide la base (Q39):
 * el administrador de un módulo cambia roles y equipos de ese módulo; cualquier administrador de la marca, sus agencias;
 * el super admin, todo. `permisos` de Hub.consultaUsuarios dice qué módulos puede editar quien consulta.
 *
 * Alta: correo, rol y agencias. La marca es la de la pantalla y no se cambia. Quien administra la marca (o el super admin)
 * asigna cualquier agencia de su catálogo (catálogo de Cleber, lib/hub/agencias.ts).
 *
 * Los equipos (idEquipo) siguen en Firestore (teams) hasta la Fase 4; valuación no usa equipos.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { signOut } from "next-auth/react";
import { collection, getDocs, limit, query, where } from "firebase/firestore";
import { Loader2, MoreVertical, Pencil, Plus, Trash2, UserCog, Users } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { db } from "@/lib/firebase";
import { consultaAgenciasMarca } from "@/lib/hub/agencias";
import {
  cambiaDisponibilidad, consultaRolesModulo, consultaUsuarios, enviaInvitacion, guardaUsuario, invitaUsuario, quitaUsuarioDeMarca,
  type ConsultaUsuarios, type ModuloHub, type RolModulo, type UsuarioEnMarca,
} from "@/lib/hub/usuarios";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const MODULOS: ModuloHub[] = ["ventas", "servicio", "valuacion"];
const NOMBRE_MODULO: Record<ModuloHub, string> = { ventas: "Ventas", servicio: "Servicio", valuacion: "Valuación" };
/** Módulos con equipos (teams.vertical en Firestore) */
const CON_EQUIPO: ModuloHub[] = ["ventas", "servicio"];
const SIN_ROL = "__sin_rol__";
const SIN_EQUIPO = "__sin_equipo__";

type Agencia = { id: string; nombre: string; lugar?: string };
type Asignacion = { rol: string; idEquipo: string };

const iniciales = (u: UsuarioEnMarca) => (u.nombre || u.email).split(/[\s@.]+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Casillas de agencias del catálogo. Las asignadas que ya no están en el catálogo se muestran aparte y se pueden quitar. */
function SelectorAgencias({ opciones, valor, onChange, nombre, errorCatalogo }: {
  opciones: Agencia[]; valor: string[]; onChange: (v: string[]) => void; nombre: (id: string) => string; errorCatalogo: string | null;
}) {
  const fuera = valor.filter((id) => !opciones.some((o) => o.id === id));
  const cambia = (id: string, on: boolean) => onChange(on ? [...valor, id].sort() : valor.filter((x) => x !== id));
  if (opciones.length === 0 && fuera.length === 0) {
    return <p className="text-sm text-muted-foreground">{errorCatalogo ?? "El catálogo no tiene agencias para esta marca."}</p>;
  }
  return (
    <div className="max-h-56 overflow-y-auto rounded-md border divide-y">
      {opciones.map((o) => (
        <label key={o.id} className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-muted/50">
          <input type="checkbox" checked={valor.includes(o.id)} onChange={(e) => cambia(o.id, e.target.checked)} />
          <span className="grow">{o.nombre}{o.lugar && <span className="block text-xs text-muted-foreground">{o.lugar}</span>}</span>
          <span className="text-xs text-muted-foreground font-mono">{o.id}</span>
        </label>
      ))}
      {fuera.map((id) => (
        <label key={id} className="flex items-center gap-3 px-3 py-2 text-sm text-muted-foreground cursor-pointer hover:bg-muted/50">
          <input type="checkbox" checked onChange={() => cambia(id, false)} />
          <span className="grow">{nombre(id)}</span>
          <span className="text-xs">no está en el catálogo</span>
        </label>
      ))}
    </div>
  );
}

/** `modulo`: el del menú (filtra la lista y es el módulo del rol al invitar); null = General, se elige el módulo. */
export function UsuariosView({ modulo }: { modulo: ModuloHub | null }) {
  const { userData, currentOrgName, refreshOrganizations } = useAuth();
  const idMarca = userData?.organizationId ?? null;
  const miEmail = userData?.email?.toLowerCase() ?? "";

  const [datos, setDatos] = useState<ConsultaUsuarios | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roles, setRoles] = useState<RolModulo[]>([]);
  const [equipos, setEquipos] = useState<{ id: string; nombre: string; vertical: string | null }[]>([]);
  const [catalogo, setCatalogo] = useState<Agencia[]>([]);
  const [errorCatalogo, setErrorCatalogo] = useState<string | null>(null);
  const [todos, setTodos] = useState(modulo === null);

  // Alta
  const [invitando, setInvitando] = useState(false);
  const [alta, setAlta] = useState<{ email: string; modulo: ModuloHub | ""; rol: string; agencias: string[] }>({ email: "", modulo: "", rol: "", agencias: [] });
  // Edición
  const [editando, setEditando] = useState<UsuarioEnMarca | null>(null);
  const [asignaciones, setAsignaciones] = useState<Record<ModuloHub, Asignacion> | null>(null);
  const [agenciasEdit, setAgenciasEdit] = useState<string[]>([]);
  const [guardando, setGuardando] = useState(false);

  const fallo = useCallback((r: { errorCode: string; errorMessage: string }, porDefecto: string) => {
    if (r.errorCode === "SESION_EXPIRADA") { signOut({ redirectTo: "/login" }); return; }
    toast.error(r.errorMessage || porDefecto);
  }, []);

  const carga = useCallback(async () => {
    if (!idMarca) return;
    setError(null);
    const r = await consultaUsuarios({ idMarca, ...(modulo && !todos ? { modulo } : {}) });
    if (r.successful) { setDatos(r.info); return; }
    if (r.errorCode === "SESION_EXPIRADA") { signOut({ redirectTo: "/login" }); return; }
    setDatos(null);
    setError(r.errorCode === "SIN_PERMISO" ? "Solo un administrador de la marca puede ver y editar sus usuarios." : r.errorMessage || "No se pudieron cargar los usuarios");
  }, [idMarca, modulo, todos]);

  useEffect(() => { carga(); }, [carga]);

  useEffect(() => {
    consultaRolesModulo().then((r) => { if (r.successful) setRoles(r.info.roles); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!idMarca) return;
    let vivo = true;
    // Los equipos siguen en Firestore, bajo el documento de organizations cuyo sfBrandCode es el id (código) de la marca
    getDocs(query(collection(db, "organizations"), where("sfBrandCode", "==", idMarca), limit(1)))
      .then((o) => (o.docs[0] ? getDocs(query(collection(db, "teams"), where("organizationId", "==", o.docs[0].id))) : null))
      .then((s) => vivo && setEquipos(s ? s.docs.map((d) => ({ id: d.id, nombre: (d.data().name as string) ?? d.id, vertical: d.data().vertical ?? null })) : []))
      .catch(() => vivo && setEquipos([]));
    setCatalogo([]);
    setErrorCatalogo(null);
    consultaAgenciasMarca(idMarca)
      .then((r) => {
        if (!vivo) return;
        if (r.successful) {
          setCatalogo(r.info.agencias.map((a) => ({
            id: a.idAgencia, nombre: a.nombre, lugar: [a.municipio, a.estado].filter(Boolean).join(", ") || undefined,
          })));
        } else {
          console.error("Catálogo de agencias:", r.errorCode, r.errorMessage);
          setErrorCatalogo(`No se pudo cargar el catálogo de agencias: ${r.errorMessage}`);
        }
      })
      .catch((e) => { console.error("Catálogo de agencias:", e); if (vivo) setErrorCatalogo("No se pudo cargar el catálogo de agencias"); });
    return () => { vivo = false; };
  }, [idMarca]);

  const rolesDe = (m: ModuloHub) => roles.filter((r) => r.modulo === m);
  const nombreRol = (m: ModuloHub, rol: string) => roles.find((r) => r.modulo === m && r.rol === rol)?.nombre ?? rol;
  const nombreEquipo = (id: string | null) => (id ? equipos.find((e) => e.id === id)?.nombre ?? id : null);
  const nombreAgencia = (id: string) => catalogo.find((a) => a.id === id)?.nombre ?? id;

  const editables = useMemo(() => datos?.permisos.modulos ?? [], [datos]);
  const puedeAgencias = datos?.permisos.agencias ?? false;
  const esAdmin = editables.length > 0;
  // Módulos editables, con el del menú primero
  const modulosEditables = useMemo(
    () => (modulo && editables.includes(modulo) ? [modulo, ...editables.filter((m) => m !== modulo)] : editables),
    [editables, modulo]);

  // ---- Alta
  const moduloAlta: ModuloHub | "" = modulo && editables.includes(modulo) ? modulo : alta.modulo;
  const abreAlta = () => {
    const m = modulo && editables.includes(modulo) ? modulo : modulosEditables.length === 1 ? modulosEditables[0] : "";
    setAlta({ email: "", modulo: m, rol: "", agencias: [] });
    setInvitando(true);
  };
  const altaLista = EMAIL.test(alta.email.trim()) && !!moduloAlta && !!alta.rol && alta.agencias.length > 0;

  const invita = async () => {
    if (!idMarca || !moduloAlta || !altaLista) return;
    setGuardando(true);
    try {
      const email = alta.email.trim().toLowerCase();
      const r = await invitaUsuario({ email, idMarca, modulo: moduloAlta, rol: alta.rol, agencias: alta.agencias });
      if (!r.successful) {
        const causa = (r.info as { causa?: string } | undefined)?.causa;
        if (causa === "YA_TIENE_ROL") { toast.error(`${email} ya tiene rol en ${NOMBRE_MODULO[moduloAlta]} en esta marca: edítalo desde la lista`); return; }
        fallo(r, "No se pudo dar de alta"); return;
      }
      const textoAlta = r.info.creado ? `${email} dado de alta en ${currentOrgName ?? idMarca}` : `${email} ya existía: se le agregó ${currentOrgName ?? idMarca}`;
      const correo = await enviaInvitacion({ email, idMarca, modulo: moduloAlta, nombreMarca: currentOrgName ?? undefined });
      if (correo.successful) toast.success(`${textoAlta}. Se le envió la invitación por correo`);
      else toast.warning(`${textoAlta}, pero no se pudo enviar el correo: ${correo.errorMessage ?? "error"}. Avísale tú o reenvía la invitación`);
      setInvitando(false);
      carga();
    } finally {
      setGuardando(false);
    }
  };

  // ---- Edición
  const edita = (u: UsuarioEnMarca) => {
    setEditando(u);
    setAsignaciones(Object.fromEntries(MODULOS.map((m) => [m, { rol: u.modulos[m]?.rol ?? "", idEquipo: u.modulos[m]?.idEquipo ?? "" }])) as Record<ModuloHub, Asignacion>);
    setAgenciasEdit([...u.agencias].sort());
  };
  const setAsignacion = (m: ModuloHub, cambio: Partial<Asignacion>) =>
    setAsignaciones((a) => (a ? { ...a, [m]: { ...a[m], ...cambio } } : a));

  const guarda = async () => {
    if (!idMarca || !editando || !asignaciones) return;
    // Solo lo que cambió: así nadie choca con un módulo que no administra ni se quita su propia administración por accidente
    const cambios = modulosEditables.filter((m) => {
      const antes = editando.modulos[m];
      const a = asignaciones[m];
      return (antes?.rol ?? "") !== a.rol || (CON_EQUIPO.includes(m) && (antes?.idEquipo ?? "") !== a.idEquipo);
    });
    const agenciasCambian = puedeAgencias && agenciasEdit.join("|") !== [...editando.agencias].sort().join("|");
    if (!cambios.length && !agenciasCambian) { setEditando(null); return; }
    if (agenciasCambian && agenciasEdit.length === 0) { toast.error("El usuario debe tener al menos una agencia"); return; }
    const valor = (m: ModuloHub) => {
      const a = asignaciones[m];
      return a.rol ? { rol: a.rol, ...(CON_EQUIPO.includes(m) ? { idEquipo: a.idEquipo || null } : {}) } : null;
    };
    setGuardando(true);
    try {
      const r = await guardaUsuario({
        idUsuario: editando.idUsuario, idMarca,
        ...(cambios.length ? { modulos: Object.fromEntries(cambios.map((m) => [m, valor(m)])) } : {}),
        ...(agenciasCambian ? { agencias: agenciasEdit } : {}),
      });
      if (!r.successful) { fallo(r, "No se pudo guardar"); return; }
      toast.success(`${editando.nombre || editando.email} actualizado`);
      if (editando.email === miEmail) refreshOrganizations();   // sus propios roles: menú y módulos
      setEditando(null);
      carga();
    } finally {
      setGuardando(false);
    }
  };

  const disponibilidad = async (u: UsuarioEnMarca) => {
    const r = await cambiaDisponibilidad({ idUsuario: u.idUsuario, esDisponible: !u.esDisponible });
    if (!r.successful) { fallo(r, "No se pudo cambiar la disponibilidad"); return; }
    carga();
  };

  const quita = async (u: UsuarioEnMarca) => {
    if (!idMarca || !confirm(`¿Quitar a ${u.nombre || u.email} de la marca? Pierde sus roles y agencias en ella.`)) return;
    const r = await quitaUsuarioDeMarca({ idUsuario: u.idUsuario, idMarca });
    if (!r.successful) { fallo(r, "No se pudo quitar de la marca"); return; }
    toast.success(`${u.nombre || u.email} ya no está en la marca`);
    carga();
  };

  if (!idMarca) return <p className="text-muted-foreground">Elige una marca para ver sus usuarios.</p>;

  const usuarios = datos?.usuarios ?? [];
  const titulo = modulo === "valuacion" ? "Usuarios" : "Agentes";
  const nombreMarca = currentOrgName ?? idMarca;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">{titulo}</h1>
          <p className="text-sm text-muted-foreground">
            {datos ? `${usuarios.length} usuario${usuarios.length === 1 ? "" : "s"} ${modulo && !todos ? `con rol en ${NOMBRE_MODULO[modulo]}` : "en la marca"} · ${nombreMarca}` : `Usuarios de ${nombreMarca}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {modulo && (
            <Button variant="outline" onClick={() => setTodos((t) => !t)}>
              {todos ? `Solo ${NOMBRE_MODULO[modulo]}` : "Todos los de la marca"}
            </Button>
          )}
          {esAdmin && <Button onClick={abreAlta}><Plus className="mr-2 h-4 w-4" />Nuevo usuario</Button>}
        </div>
      </div>

      {error ? (
        <Card><CardContent className="py-8 text-center space-y-3">
          <p className="font-medium">No se pudieron cargar los usuarios</p>
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" onClick={carga}>Reintentar</Button>
        </CardContent></Card>
      ) : !datos ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : usuarios.length === 0 ? (
        <Card><CardContent className="flex flex-col items-center py-12 text-center">
          <div className="rounded-full bg-muted p-4 mb-4"><Users className="h-8 w-8 text-muted-foreground" /></div>
          <p className="font-medium">Sin usuarios {modulo && !todos ? `en ${NOMBRE_MODULO[modulo]}` : "en la marca"}</p>
          {esAdmin && <Button className="mt-4" onClick={abreAlta}><Plus className="mr-2 h-4 w-4" />Nuevo usuario</Button>}
        </CardContent></Card>
      ) : (
        <div className="grid gap-2">
          {usuarios.map((u) => {
            const yo = u.email === miEmail;
            return (
              <Card key={u.idUsuario} className={u.esActivo ? undefined : "opacity-60"}>
                <CardContent className="flex items-center justify-between gap-4 py-4 flex-wrap">
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="relative shrink-0">
                      <Avatar>
                        <AvatarImage src={u.fotoUrl || undefined} />
                        <AvatarFallback>{iniciales(u)}</AvatarFallback>
                      </Avatar>
                      <span
                        className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-background ${u.esDisponible ? "bg-green-500" : "bg-gray-400"}`}
                        title={u.esDisponible ? "Disponible" : "No disponible"}
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium truncate">{u.nombre || u.email}</p>
                        {yo && <Badge variant="outline" className="text-xs">Tú</Badge>}
                        {u.esSuperAdmin && <Badge variant="outline" className="text-xs">Super admin</Badge>}
                        {u.esInvitado && <Badge variant="outline" className="text-xs">Invitado</Badge>}
                        {!u.esActivo && <Badge variant="outline" className="text-xs">Inactivo</Badge>}
                      </div>
                      {u.nombre && <p className="text-sm text-muted-foreground truncate">{u.email}</p>}
                      <p className="text-xs text-muted-foreground">
                        {u.ultimoAccesoEn ? `Último acceso ${formatDistanceToNow(new Date(u.ultimoAccesoEn), { addSuffix: true, locale: es })}` : "Nunca ha entrado"}
                        {` · ${u.agencias.length ? `Agencias: ${u.agencias.map(nombreAgencia).join(", ")}` : "Sin agencias"}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    {MODULOS.filter((m) => u.modulos[m]).map((m) => {
                      const a = u.modulos[m]!;
                      const equipo = nombreEquipo(a.idEquipo);
                      return (
                        <Badge key={m} variant={m === modulo ? "default" : "secondary"} className="text-xs">
                          {NOMBRE_MODULO[m]} · {nombreRol(m, a.rol)}{equipo ? ` · ${equipo}` : ""}
                        </Badge>
                      );
                    })}
                    {esAdmin && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Acciones de ${u.nombre || u.email}`}><MoreVertical className="h-4 w-4" /></Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => edita(u)}><Pencil className="mr-2 h-4 w-4" />Editar roles y agencias</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => disponibilidad(u)}>
                            <UserCog className="mr-2 h-4 w-4" />{u.esDisponible ? "Marcar no disponible" : "Marcar disponible"}
                          </DropdownMenuItem>
                          {!yo && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-destructive" onClick={() => quita(u)}><Trash2 className="mr-2 h-4 w-4" />Quitar de la marca</DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Alta */}
      <Dialog open={invitando} onOpenChange={setInvitando}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Nuevo usuario</DialogTitle>
            <DialogDescription>Entra con su cuenta de Google usando este correo. Si ya existe en otra marca, solo se le agrega esta.</DialogDescription>
          </DialogHeader>
          <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); invita(); }}>
            <div className="space-y-2">
              <Label htmlFor="a-email">Correo</Label>
              <Input id="a-email" type="email" autoFocus value={alta.email} placeholder="correo@ejemplo.com"
                onChange={(e) => setAlta((a) => ({ ...a, email: e.target.value }))} />
            </div>

            {/* Módulo: fijo en Ventas, Servicio o Valuación; en General se elige */}
            {!(modulo && editables.includes(modulo)) && (
              <div className="space-y-2">
                <Label htmlFor="a-modulo">Módulo</Label>
                <Select value={alta.modulo} onValueChange={(v) => setAlta((a) => ({ ...a, modulo: v as ModuloHub, rol: "" }))}>
                  <SelectTrigger id="a-modulo"><SelectValue placeholder="Elige el módulo" /></SelectTrigger>
                  <SelectContent>
                    {modulosEditables.map((m) => <SelectItem key={m} value={m}>{NOMBRE_MODULO[m]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="a-rol">Rol{moduloAlta ? ` en ${NOMBRE_MODULO[moduloAlta]}` : ""}</Label>
              <Select value={alta.rol} onValueChange={(v) => setAlta((a) => ({ ...a, rol: v }))} disabled={!moduloAlta}>
                <SelectTrigger id="a-rol"><SelectValue placeholder="Elige el rol" /></SelectTrigger>
                <SelectContent>
                  {moduloAlta && rolesDe(moduloAlta).map((r) => <SelectItem key={r.rol} value={r.rol}>{r.nombre}</SelectItem>)}
                </SelectContent>
              </Select>
              {moduloAlta && alta.rol && (
                <p className="text-xs text-muted-foreground">{rolesDe(moduloAlta).find((r) => r.rol === alta.rol)?.descripcion}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Agencias a las que tiene acceso</Label>
              <SelectorAgencias opciones={catalogo} valor={alta.agencias} nombre={nombreAgencia} errorCatalogo={errorCatalogo}
                onChange={(v) => setAlta((a) => ({ ...a, agencias: v }))} />
            </div>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setInvitando(false)}>Cancelar</Button>
              <Button type="submit" disabled={guardando || !altaLista}>
                {guardando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Dar de alta
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edición */}
      <Dialog open={!!editando} onOpenChange={(o) => !o && setEditando(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          {editando && asignaciones && (
            <>
              <DialogHeader>
                <DialogTitle>Editar {editando.nombre || editando.email}</DialogTitle>
                <DialogDescription>Roles por módulo y agencias en {nombreMarca}. Sin rol en un módulo, no lo ve.</DialogDescription>
              </DialogHeader>
              <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); guarda(); }}>
                {modulosEditables.map((m) => {
                  const a = asignaciones[m];
                  const equiposModulo = equipos.filter((e) => e.vertical === m);
                  return (
                    <div key={m} className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor={`e-rol-${m}`}>Rol en {NOMBRE_MODULO[m]}</Label>
                        <Select value={a.rol || SIN_ROL} onValueChange={(v) => setAsignacion(m, { rol: v === SIN_ROL ? "" : v, ...(v === SIN_ROL ? { idEquipo: "" } : {}) })}>
                          <SelectTrigger id={`e-rol-${m}`}><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value={SIN_ROL}>Sin rol</SelectItem>
                            {rolesDe(m).map((r) => <SelectItem key={r.rol} value={r.rol}>{r.nombre}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      {CON_EQUIPO.includes(m) && a.rol && (
                        <div className="space-y-2">
                          <Label htmlFor={`e-eq-${m}`}>Equipo</Label>
                          <Select value={a.idEquipo || SIN_EQUIPO} onValueChange={(v) => setAsignacion(m, { idEquipo: v === SIN_EQUIPO ? "" : v })}>
                            <SelectTrigger id={`e-eq-${m}`}><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value={SIN_EQUIPO}>Sin equipo</SelectItem>
                              {a.idEquipo && !equiposModulo.some((e) => e.id === a.idEquipo) && <SelectItem value={a.idEquipo}>{nombreEquipo(a.idEquipo)}</SelectItem>}
                              {equiposModulo.map((e) => <SelectItem key={e.id} value={e.id}>{e.nombre}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </div>
                  );
                })}
                {MODULOS.filter((m) => !modulosEditables.includes(m) && editando.modulos[m]).map((m) => (
                  <p key={m} className="text-xs text-muted-foreground">
                    {NOMBRE_MODULO[m]}: {nombreRol(m, editando.modulos[m]!.rol)} (no administras este módulo)
                  </p>
                ))}

                {puedeAgencias && (
                  <div className="space-y-2">
                    <Label>Agencias a las que tiene acceso</Label>
                    <SelectorAgencias opciones={catalogo} valor={agenciasEdit} onChange={setAgenciasEdit} nombre={nombreAgencia} errorCatalogo={errorCatalogo} />
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => setEditando(null)}>Cancelar</Button>
                  <Button type="submit" disabled={guardando}>
                    {guardando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Guardar
                  </Button>
                </div>
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
