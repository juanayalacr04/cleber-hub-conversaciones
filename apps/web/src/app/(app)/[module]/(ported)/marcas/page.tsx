"use client";

/**
 * Marcas del hub (hub_cleber.marcas en PostgreSQL), solo super admin.
 *
 * El selector de marca de la barra lateral y las pantallas de Ventas y Servicio toman la lista de aquí (vía
 * Hub.consultaUsuarioActual); la configuración propia de cada marca en esos módulos (WhatsApp, Salesforce) sigue en
 * Firestore (organizations/{idMarca}).
 */

import { useCallback, useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import { Building2, Loader2, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { consultaMarcas, guardaMarca, type Marca } from "@/lib/hub/marcas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ZONAS = [
  "America/Mexico_City", "America/Monterrey", "America/Tijuana", "America/Cancun", "America/Chihuahua",
  "America/Bogota", "America/Lima", "America/Santiago", "America/Argentina/Buenos_Aires",
];

/** "Toyota Cumbres" → "toyota-cumbres" (sin acentos; solo letras, números y guiones). */
const aId = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

interface Form { idMarca: string; nombre: string; zonaHoraria: string; sfCodigoMarca: string; esActiva: boolean }
const VACIO: Form = { idMarca: "", nombre: "", zonaHoraria: "America/Mexico_City", sfCodigoMarca: "", esActiva: true };

export default function MarcasPage() {
  const { userData, refreshOrganizations } = useAuth();
  const [marcas, setMarcas] = useState<Marca[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abierto, setAbierto] = useState(false);
  const [editando, setEditando] = useState<Marca | null>(null);
  const [form, setForm] = useState<Form>(VACIO);
  const [idTocado, setIdTocado] = useState(false);
  const [errorCampo, setErrorCampo] = useState<{ campo: string; mensaje: string } | null>(null);
  const [guardando, setGuardando] = useState(false);

  const carga = useCallback(async () => {
    setError(null);
    const r = await consultaMarcas();
    if (r.successful) { setMarcas(r.info.marcas); return; }
    if (r.errorCode === "SESION_EXPIRADA") { signOut({ redirectTo: "/login" }); return; }
    setError(r.errorMessage || "No se pudieron cargar las marcas");
  }, []);

  useEffect(() => { carga(); }, [carga]);

  const nueva = () => { setEditando(null); setForm(VACIO); setIdTocado(false); setErrorCampo(null); setAbierto(true); };
  const edita = (m: Marca) => {
    setEditando(m);
    setForm({ idMarca: m.idMarca, nombre: m.nombre, zonaHoraria: m.zonaHoraria, sfCodigoMarca: m.sfCodigoMarca ?? "", esActiva: m.esActiva });
    setErrorCampo(null);
    setAbierto(true);
  };
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setErrorCampo(null);
    setForm((f) => {
      const n = { ...f, [k]: v };
      // En el alta el id se propone a partir del nombre hasta que se edita a mano
      if (k === "nombre" && !editando && !idTocado) n.idMarca = aId(String(v));
      return n;
    });
  };

  const guarda = async () => {
    setGuardando(true);
    const r = await guardaMarca({
      idMarca: form.idMarca.trim(), nombre: form.nombre.trim(), zonaHoraria: form.zonaHoraria,
      sfCodigoMarca: form.sfCodigoMarca.trim().toUpperCase(), esActiva: form.esActiva,
    });
    setGuardando(false);
    if (r.successful) {
      toast.success(r.info.creada ? `Marca ${r.info.marca.nombre} creada` : `Marca ${r.info.marca.nombre} guardada`);
      setAbierto(false);
      carga();
      refreshOrganizations();
      return;
    }
    if (r.errorCode === "SESION_EXPIRADA") { signOut({ redirectTo: "/login" }); return; }
    const campo = (r.info as { campo?: string } | undefined)?.campo;
    if (campo) setErrorCampo({ campo, mensaje: r.errorMessage });
    else toast.error(r.errorMessage || "No se pudo guardar la marca");
  };

  const err = (campo: string) => errorCampo?.campo === campo
    ? <p className="text-xs text-destructive" role="alert">{errorCampo.mensaje}</p> : null;

  if (!userData?.isSuperAdmin) {
    return <p className="text-muted-foreground">Solo un superadministrador administra las marcas.</p>;
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Marcas</h1>
          <p className="text-sm text-muted-foreground">Marcas de la plataforma. Los usuarios, sus roles y las agencias se asignan por marca.</p>
        </div>
        <Button onClick={nueva}><Plus className="mr-2 h-4 w-4" />Nueva marca</Button>
      </div>

      {error ? (
        <Card><CardContent className="py-8 text-center space-y-3">
          <p className="font-medium">No se pudieron cargar las marcas</p>
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" onClick={carga}>Reintentar</Button>
        </CardContent></Card>
      ) : !marcas ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : marcas.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Aún no hay marcas. Crea la primera con “Nueva marca”.</CardContent></Card>
      ) : (
        <div className="grid gap-3">
          {marcas.map((m) => (
            <Card key={m.idMarca} className={m.esActiva ? undefined : "opacity-60"}>
              <CardContent className="flex items-center justify-between gap-4 py-4">
                <div className="flex items-center gap-4 min-w-0">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <Building2 className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-semibold truncate">{m.nombre}</h3>
                    <p className="text-xs text-muted-foreground font-mono">{m.idMarca} · {m.zonaHoraria}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {m.sfCodigoMarca && <Badge variant="outline" className="text-xs font-mono">{m.sfCodigoMarca}</Badge>}
                  {!m.esActiva && <Badge variant="outline" className="text-xs">Inactiva</Badge>}
                  <Button variant="ghost" size="sm" onClick={() => edita(m)} aria-label={`Editar ${m.nombre}`}><Pencil className="h-4 w-4" /></Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={abierto} onOpenChange={setAbierto}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editando ? `Editar ${editando.nombre}` : "Nueva marca"}</DialogTitle>
            <DialogDescription>
              {editando ? "El id no se puede cambiar: lo guardan por valor las agencias, las ofertas y los clientes." : "El id se propone a partir del nombre; revísalo, después no se puede cambiar."}
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); guarda(); }}>
            <div className="space-y-2">
              <Label htmlFor="m-nombre">Nombre</Label>
              <Input id="m-nombre" value={form.nombre} onChange={(e) => set("nombre", e.target.value)} placeholder="Ej. Toyota" autoFocus />
              {err("nombre")}
            </div>
            <div className="space-y-2">
              <Label htmlFor="m-id">Id</Label>
              <Input
                id="m-id" className="font-mono" value={form.idMarca} readOnly={!!editando} placeholder="toyota"
                onChange={(e) => { setIdTocado(true); set("idMarca", e.target.value); }}
              />
              <p className="text-xs text-muted-foreground">Letras, números, guion y guion bajo.</p>
              {err("idMarca")}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="m-zona">Zona horaria</Label>
                <Select value={form.zonaHoraria} onValueChange={(v) => set("zonaHoraria", v)}>
                  <SelectTrigger id="m-zona"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(ZONAS.includes(form.zonaHoraria) ? ZONAS : [form.zonaHoraria, ...ZONAS]).map((z) => <SelectItem key={z} value={z}>{z}</SelectItem>)}
                  </SelectContent>
                </Select>
                {err("zonaHoraria")}
              </div>
              <div className="space-y-2">
                <Label htmlFor="m-sf">Código de marca en Salesforce</Label>
                <Input id="m-sf" className="font-mono" value={form.sfCodigoMarca} onChange={(e) => set("sfCodigoMarca", e.target.value)} placeholder="Ej. TO" />
                {err("sfCodigoMarca")}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.esActiva} onChange={(e) => set("esActiva", e.target.checked)} />
              Marca activa
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setAbierto(false)}>Cancelar</Button>
              <Button type="submit" disabled={guardando || !form.nombre.trim() || !form.idMarca.trim()}>
                {guardando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{editando ? "Guardar" : "Crear"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
