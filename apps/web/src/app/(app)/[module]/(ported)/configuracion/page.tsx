"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { isAdmin, useAuth } from "@/contexts/AuthContext";
import { db, auth } from "@/lib/firebase";
import { getModule } from "@/lib/modules";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

interface SalesforceBrandForm {
  marcaRR: string;
  ownerId: string;
  bdcFallbackOwnerId: string;
  vehicleType: "nuevo" | "seminuevo";
  leadCreationEnabled: boolean;
  rrFlowName: string;
  seminuevoOwnerId: string;
  seminuevoRecordTypeId: string;
  defaultTemplateId: string;
  situationMap: string; // JSON
}

const EMPTY_SF: SalesforceBrandForm = {
  marcaRR: "", ownerId: "", bdcFallbackOwnerId: "", vehicleType: "nuevo", leadCreationEnabled: true,
  rrFlowName: "", seminuevoOwnerId: "", seminuevoRecordTypeId: "", defaultTemplateId: "", situationMap: "",
};

const TIMEZONES = [
  "America/Mexico_City", "America/Monterrey", "America/Tijuana", "America/Cancun", "America/Chihuahua",
  "America/Bogota", "America/Lima", "America/Santiago", "America/Argentina/Buenos_Aires",
];

export default function ConfiguracionPage() {
  const { userData } = useAuth();
  const { module: moduleId } = useParams<{ module: string }>();
  const vertical = getModule(moduleId)?.vertical ?? null;
  const admin = isAdmin(userData);
  const orgId = userData?.organizationId ?? null;

  const [loaded, setLoaded] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [sfBrandCode, setSfBrandCode] = useState("");
  const [timezone, setTimezone] = useState("America/Mexico_City");
  const [sf, setSf] = useState<SalesforceBrandForm>(EMPTY_SF);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!orgId || !admin) return;
    getDoc(doc(db, "organizations", orgId)).then((snap) => {
      const d = snap.data();
      if (d) {
        setOrgName(d.name ?? "");
        setSfBrandCode(d.sfBrandCode ?? "");
        setTimezone(d.settings?.timezone ?? "America/Mexico_City");
        const c = d.salesforceConfig ?? {};
        setSf({
          marcaRR: c.marcaRR ?? "", ownerId: c.ownerId ?? "", bdcFallbackOwnerId: c.bdcFallbackOwnerId ?? "",
          vehicleType: c.vehicleType === "seminuevo" ? "seminuevo" : "nuevo",
          leadCreationEnabled: c.leadCreationEnabled ?? true,
          rrFlowName: c.rrFlowName ?? "", seminuevoOwnerId: c.seminuevoOwnerId ?? "",
          seminuevoRecordTypeId: c.seminuevoRecordTypeId ?? "", defaultTemplateId: c.defaultTemplateId ?? "",
          situationMap: c.situationMap ? JSON.stringify(c.situationMap, null, 2) : "",
        });
      }
      setLoaded(true);
    });
  }, [orgId, admin]);

  const set = <K extends keyof SalesforceBrandForm>(k: K, v: SalesforceBrandForm[K]) => setSf((p) => ({ ...p, [k]: v }));

  async function save() {
    if (!orgId) return;
    let situationMap: unknown = null;
    if (sf.situationMap.trim()) {
      try {
        situationMap = JSON.parse(sf.situationMap);
        if (typeof situationMap !== "object" || Array.isArray(situationMap)) throw new Error();
      } catch {
        toast.error("El mapa de situaciones no es un JSON válido (debe ser un objeto)");
        return;
      }
    }
    setSaving(true);
    try {
      // Solo config por marca, nunca credenciales: esas viven en variables de entorno del servidor
      const clean = (v: string) => v.trim() || null;
      await updateDoc(doc(db, "organizations", orgId), {
        name: orgName.trim(),
        "settings.timezone": timezone,
        salesforceConfig: {
          marcaRR: clean(sf.marcaRR), ownerId: clean(sf.ownerId), bdcFallbackOwnerId: clean(sf.bdcFallbackOwnerId),
          vehicleType: sf.vehicleType, leadCreationEnabled: sf.leadCreationEnabled,
          rrFlowName: clean(sf.rrFlowName), seminuevoOwnerId: clean(sf.seminuevoOwnerId),
          seminuevoRecordTypeId: clean(sf.seminuevoRecordTypeId), defaultTemplateId: clean(sf.defaultTemplateId),
          situationMap,
        },
      });
      toast.success("Configuración guardada");
    } catch (e) {
      console.error(e);
      toast.error("No se pudo guardar. Revisa tus permisos.");
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const token = await auth.currentUser?.getIdToken();
      const res = await fetch("/api/test-salesforce", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ organizationId: orgId, vertical }),
      });
      const data = await res.json();
      setTestResult(res.ok ? { ok: true, message: "Conexión exitosa" } : { ok: false, message: data.error || "Error desconocido" });
    } catch {
      setTestResult({ ok: false, message: "Error de red" });
    } finally {
      setTesting(false);
    }
  }

  if (!admin) {
    return <p className="text-muted-foreground">Solo un administrador puede ver la configuración de la organización.</p>;
  }
  if (!loaded) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Configuración</h1>
        <p className="text-muted-foreground">Datos de la organización y de su marca en Salesforce</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Organización</CardTitle>
          <CardDescription>Es la marca. Los módulos (Servicio, Ventas) comparten estos datos.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="orgName">Nombre</Label>
            <Input id="orgName" value={orgName} onChange={(e) => setOrgName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sfBrandCode">Código de marca en Salesforce</Label>
            <Input id="sfBrandCode" value={sfBrandCode} readOnly />
            <p className="text-xs text-muted-foreground">Es único por organización y solo lo cambia un superadministrador (en Organizaciones).</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="timezone">Zona horaria</Label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger id="timezone"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES]).map((z) => <SelectItem key={z} value={z}>{z}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">La usan las citas y los recontactos que programa el bot.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Salesforce</CardTitle>
          <CardDescription>
            Configuración de esta marca. Las credenciales de la conexión no se editan aquí: se definen como variables de entorno del servidor (SF_*).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" onClick={testConnection} disabled={testing}>
              {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Probar conexión
            </Button>
            {testResult && <span className={testResult.ok ? "text-sm text-emerald-600" : "text-sm text-destructive"}>{testResult.message}</span>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="marcaRR">Marca para el round robin</Label>
              <Input id="marcaRR" value={sf.marcaRR} onChange={(e) => set("marcaRR", e.target.value)} placeholder="Honda" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rrFlowName">Flow de round robin</Label>
              <Input id="rrFlowName" value={sf.rrFlowName} onChange={(e) => set("rrFlowName", e.target.value)} placeholder="RRAgenteIACLEBER" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ownerId">Owner por defecto de los Leads</Label>
              <Input id="ownerId" value={sf.ownerId} onChange={(e) => set("ownerId", e.target.value)} placeholder="005..." />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bdcOwner">Owner de BDC (fuera de horario)</Label>
              <Input id="bdcOwner" value={sf.bdcFallbackOwnerId} onChange={(e) => set("bdcFallbackOwnerId", e.target.value)} placeholder="005..." />
            </div>
            <div className="space-y-2">
              <Label htmlFor="semiOwner">Owner de Seminuevos</Label>
              <Input id="semiOwner" value={sf.seminuevoOwnerId} onChange={(e) => set("seminuevoOwnerId", e.target.value)} placeholder="005..." />
            </div>
            <div className="space-y-2">
              <Label htmlFor="semiRT">RecordType de Seminuevos</Label>
              <Input id="semiRT" value={sf.seminuevoRecordTypeId} onChange={(e) => set("seminuevoRecordTypeId", e.target.value)} placeholder="012..." />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tplDefault">Plantilla por defecto</Label>
              <Input id="tplDefault" value={sf.defaultTemplateId} onChange={(e) => set("defaultTemplateId", e.target.value)} placeholder="T0716" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="vehicleType">Tipo de vehículo</Label>
              <Select value={sf.vehicleType} onValueChange={(v) => set("vehicleType", v as "nuevo" | "seminuevo")}>
                <SelectTrigger id="vehicleType"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="nuevo">Nuevos</SelectItem>
                  <SelectItem value="seminuevo">Seminuevos</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" className="mt-1" checked={sf.leadCreationEnabled} onChange={(e) => set("leadCreationEnabled", e.target.checked)} />
            <span>
              <span className="font-medium">Crear Leads en Salesforce</span>
              <span className="block text-xs text-muted-foreground">Apagado, la plataforma simula los Leads (Id QA-SIMULATED-…) y no escribe en Salesforce. Úsalo para pruebas.</span>
            </span>
          </label>

          <div className="space-y-2">
            <Label htmlFor="situationMap">Mapa de situaciones (JSON, opcional)</Label>
            <Textarea
              id="situationMap" rows={7} className="font-mono text-xs" value={sf.situationMap}
              onChange={(e) => set("situationMap", e.target.value)}
              placeholder={'{\n  "servicio_postventa": { "status": "Cerrado/Perdido", "razon": "Servicio" }\n}'}
            />
            <p className="text-xs text-muted-foreground">Cómo se descarta el Lead por cada situación: status, validacion y razon. Sin esto se usan los valores por defecto.</p>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Guardar cambios
        </Button>
      </div>
    </div>
  );
}
