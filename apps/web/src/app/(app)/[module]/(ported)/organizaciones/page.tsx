"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Building2, Plus, Pencil, Users, Bot, Phone, Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { callHubAction } from "@/lib/hub-actions";
import { db } from "@/lib/firebase";
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  doc,
  where,
  getDocs,
} from "firebase/firestore";

interface SalesforceConfig {
  instanceUrl?: string;
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
  vehicleType?: "nuevo" | "seminuevo";
}

interface Organization {
  id: string;
  name: string;
  sfBrandCode: string | null;
  sfCalendario: string | null;
  createdAt: Date | null;
  salesforceConfig?: SalesforceConfig | null;
}

interface OrgStats {
  users: number;
  bots: number;
  whatsappNumbers: number;
  teams: number;
}

export default function OrganizationsPage() {
  const { userData, user, refreshOrganizations } = useAuth();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [orgStats, setOrgStats] = useState<Record<string, OrgStats>>({});
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingOrg, setEditingOrg] = useState<Organization | null>(null);
  const [name, setName] = useState("");
  const [sfBrandCode, setSfBrandCode] = useState("");
  const [vehicleType, setVehicleType] = useState<"nuevo" | "seminuevo">("nuevo");
  const [sfCalendario, setSfCalendario] = useState("");
  const [saving, setSaving] = useState(false);

  // Check super admin access
  if (userData && !userData.isSuperAdmin) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        Acceso restringido a super administradores
      </div>
    );
  }

  // Load organizations
  useEffect(() => {
    const q = query(collection(db, "organizations"), orderBy("name"));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const orgs: Organization[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        orgs.push({
          id: doc.id,
          name: data.name,
          sfBrandCode: data.sfBrandCode || null,
          sfCalendario: data.sfCalendario || null,
          createdAt: data.createdAt?.toDate?.() || null,
          salesforceConfig: data.salesforceConfig || null,
        });
      });
      setOrganizations(orgs);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Load stats for each org
  useEffect(() => {
    if (organizations.length === 0) return;

    const loadStats = async () => {
      const stats: Record<string, OrgStats> = {};
      for (const org of organizations) {
        const [usersSnap, botsSnap, numbersSnap, teamsSnap] = await Promise.all([
          getDocs(query(collection(db, "users"), where("organizationId", "==", org.id))),
          getDocs(query(collection(db, "bots"), where("organizationId", "==", org.id))),
          getDocs(query(collection(db, "whatsappNumbers"), where("organizationId", "==", org.id))),
          getDocs(query(collection(db, "teams"), where("organizationId", "==", org.id))),
        ]);
        stats[org.id] = {
          users: usersSnap.size,
          bots: botsSnap.size,
          whatsappNumbers: numbersSnap.size,
          teams: teamsSnap.size,
        };
      }
      setOrgStats(stats);
    };
    loadStats();
  }, [organizations]);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);

    try {
      // La unicidad del código de marca la valida la función 2 (get_whatsapp_number_by_brand resuelve la organización por él)
      const code = sfBrandCode.trim() || null;
      if (editingOrg) {
        await callHubAction(user, "organization.update", {
          id: editingOrg.id,
          set: {
            name: name.trim(),
            "salesforceConfig.vehicleType": vehicleType,
            sfBrandCode: code,
            sfCalendario: sfCalendario.trim() || null,
          },
        });
      } else {
        await callHubAction(user, "organization.create", {
          fields: {
            name: name.trim(),
            salesforceConfig: { vehicleType },
            sfBrandCode: code,
            sfCalendario: sfCalendario.trim() || null,
          },
        });
      }
      await refreshOrganizations();   // el selector de organización de las demás pantallas
      setDialogOpen(false);
      setName("");
      setEditingOrg(null);
    } catch (error) {
      console.error("Error saving organization:", error);
      alert(error instanceof Error ? error.message : "Error al guardar la organización");
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (org: Organization) => {
    setEditingOrg(org);
    setName(org.name);
    setSfBrandCode(org.sfBrandCode || "");
    setVehicleType(org.salesforceConfig?.vehicleType || "nuevo");
    setSfCalendario(org.sfCalendario || "");
    setDialogOpen(true);
  };

  const openCreate = () => {
    setEditingOrg(null);
    setName("");
    setSfBrandCode("");
    setVehicleType("nuevo");
    setSfCalendario("");
    setDialogOpen(true);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Organizaciones</h1>
          <p className="text-sm text-muted-foreground">
            Gestiona las organizaciones de la plataforma
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" />
              Nueva organizacion
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {editingOrg ? "Editar organizacion" : "Nueva organizacion"}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="name">Nombre</Label>
                <Input
                  id="name"
                  placeholder="Ej: Grupo Cleber Honda"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSave();
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sfBrandCode">Codigo de marca Salesforce</Label>
                <Input
                  id="sfBrandCode"
                  placeholder="Ej: HO, NI, TO"
                  value={sfBrandCode}
                  onChange={(e) => setSfBrandCode(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Valor del campo GCL_Marca__c en Salesforce. Se usa para enrutar leads al numero correcto.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="vehicleType">Tipo de vehiculo</Label>
                <Select value={vehicleType} onValueChange={(v) => setVehicleType(v as "nuevo" | "seminuevo")}>
                  <SelectTrigger id="vehicleType">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="nuevo">Nuevo</SelectItem>
                    <SelectItem value="seminuevo">Seminuevo</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Determina el mapeo de campos al crear leads en Salesforce (ej. GCL_TipoAuto__c).
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="sfCalendario">Calendario Salesforce</Label>
                <Input
                  id="sfCalendario"
                  placeholder="Ej: Citas Servicio KIA"
                  value={sfCalendario}
                  onChange={(e) => setSfCalendario(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Valor del campo Calendario__c en Salesforce. Filtra las citas de servicio para recordatorios y no-shows.
                </p>
              </div>
              {editingOrg && (
                <div className="space-y-2">
                  <Label>Salesforce</Label>
                  {editingOrg.salesforceConfig?.instanceUrl ? (
                    <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3 space-y-1">
                      <div className="flex items-center gap-2 text-sm font-medium text-green-600 dark:text-green-400">
                        <div className="h-2 w-2 rounded-full bg-green-500" />
                        Configurado
                      </div>
                      <p className="text-xs text-muted-foreground">{editingOrg.salesforceConfig.instanceUrl}</p>
                      <p className="text-xs text-muted-foreground">Usuario: {editingOrg.salesforceConfig.username || "—"}</p>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-orange-500/30 bg-orange-500/10 p-3">
                      <div className="flex items-center gap-2 text-sm font-medium text-orange-600 dark:text-orange-400">
                        <div className="h-2 w-2 rounded-full bg-orange-500" />
                        No configurado
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">Configura las credenciales en Configuracion al seleccionar esta organizacion.</p>
                    </div>
                  )}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancelar
                </Button>
                <Button onClick={handleSave} disabled={saving || !name.trim()}>
                  {saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : editingOrg ? (
                    "Guardar"
                  ) : (
                    "Crear"
                  )}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-4">
        {organizations.map((org) => {
          const stats = orgStats[org.id];
          return (
            <Card key={org.id}>
              <CardContent className="flex items-center justify-between py-4">
                <div className="flex items-center gap-4">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Building2 className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold">{org.name}</h3>
                    <p className="text-xs text-muted-foreground">{org.id}</p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <Badge variant={org.salesforceConfig?.instanceUrl ? "default" : "outline"} className={org.salesforceConfig?.instanceUrl ? "bg-green-600 hover:bg-green-600 text-xs" : "text-xs text-orange-500 border-orange-500/30"}>
                    SF {org.salesforceConfig?.instanceUrl ? "OK" : "—"}
                  </Badge>
                  {org.sfBrandCode && (
                    <Badge variant="outline" className="text-xs font-mono">
                      {org.sfBrandCode}
                    </Badge>
                  )}
                  {stats && (
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Users className="h-3 w-3" /> {stats.users}
                      </span>
                      <span className="flex items-center gap-1">
                        <Bot className="h-3 w-3" /> {stats.bots}
                      </span>
                      <span className="flex items-center gap-1">
                        <Phone className="h-3 w-3" /> {stats.whatsappNumbers}
                      </span>
                    </div>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openEdit(org)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
