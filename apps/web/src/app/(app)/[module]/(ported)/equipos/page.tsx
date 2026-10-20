"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Users2, Phone, Bot, Loader2, MoreVertical, Pencil, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { db } from "@/lib/firebase";
import {
  collection,
  query,
  where,
  onSnapshot,
  doc,
} from "firebase/firestore";
import { useAuth } from "@/contexts/AuthContext";
import { callHubAction } from "@/lib/hub-actions";
import { MODULES, getModule } from "@/lib/modules";
import { modulePath } from "@/lib/routes";
import type { Vertical } from "@/lib/modules";

interface Team {
  id: string;
  name: string;
  description: string;
  assignmentMode: "round_robin" | "least_busy" | "manual" | "salesforce";
  /** Opcional: sin valor = sin tope */
  maxConversationsPerAgent?: number | null;
  /** Qué hace la plataforma cuando el cliente escribe "stop" */
  optOutAction?: "close" | "handoff";
  vertical?: Vertical | null;
  lastAssignedAgentId?: string | null;
  activeConversations: number;
  status: "active" | "inactive";
}

interface TeamMember {
  id: string;
  name: string;
  email: string;
  teamId: string | null;
  isAvailable: boolean;
  role: "admin" | "agent" | "viewer";
}

interface WhatsAppNumber {
  id: string;
  phoneNumber: string;
  displayName: string;
  teamId: string;
}

export default function TeamsPage() {
  const { userData, user, organizations: authOrgs } = useAuth();
  const { module: moduleId } = useParams<{ module: string }>();
  const vertical = getModule(moduleId)?.vertical ?? null;
  const [allTeams, setAllTeams] = useState<Team[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [whatsappNumbers, setWhatsappNumbers] = useState<WhatsAppNumber[]>([]);
  const [loading, setLoading] = useState(true);

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);

  // Form states
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formAssignmentMode, setFormAssignmentMode] = useState<"round_robin" | "least_busy" | "manual" | "salesforce">("least_busy");
  const [formMaxConversations, setFormMaxConversations] = useState("");
  const [formOptOutAction, setFormOptOutAction] = useState<"close" | "handoff">("close");
  const [formVertical, setFormVertical] = useState<Vertical | "">("");
  const [formOrgId, setFormOrgId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!userData?.organizationId) {
      setLoading(false);
      return;
    }

    // Subscribe to teams
    const teamsRef = collection(db, "teams");
    const teamsQuery = query(teamsRef, where("organizationId", "==", userData.organizationId));

    const unsubTeams = onSnapshot(teamsQuery, (snapshot) => {
      const teamsData: Team[] = [];
      snapshot.forEach((doc) => {
        teamsData.push({ id: doc.id, ...doc.data() } as Team);
      });
      setAllTeams(teamsData);
      setLoading(false);
    });

    // Subscribe to users (to show team members)
    const usersRef = collection(db, "users");
    const usersQuery = query(usersRef, where("organizationId", "==", userData.organizationId));

    const unsubUsers = onSnapshot(usersQuery, (snapshot) => {
      const usersData: TeamMember[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        usersData.push({
          id: doc.id,
          name: data.name || data.email?.split("@")[0] || "Sin nombre",
          email: data.email || "",
          // Equipo en la organización activa (orgTeams) o el legacy teamId
          teamId: data.orgTeams?.[userData.organizationId as string] || data.teamId || null,
          isAvailable: data.isAvailable ?? true,
          role: data.role || "viewer",
        });
      });
      setMembers(usersData);
    });

    // Subscribe to WhatsApp numbers
    const numbersRef = collection(db, "whatsappNumbers");
    const numbersQuery = query(numbersRef, where("organizationId", "==", userData.organizationId));

    const unsubNumbers = onSnapshot(numbersQuery, (snapshot) => {
      const numbersData: WhatsAppNumber[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        numbersData.push({
          id: doc.id,
          phoneNumber: data.phoneNumber || "",
          displayName: data.displayName || "",
          teamId: data.teamId || "",
        });
      });
      setWhatsappNumbers(numbersData);
    });

    return () => {
      unsubTeams();
      unsubUsers();
      unsubNumbers();
    };
  }, [userData?.organizationId]);

  // Equipos del módulo activo (en general, todos)
  const teams = vertical ? allTeams.filter((t) => t.vertical === vertical) : allTeams;

  const parseMax = (v: string): number | null => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const resetForm = () => {
    setFormName("");
    setFormDescription("");
    setFormAssignmentMode("least_busy");
    setFormMaxConversations("");
    setFormOptOutAction("close");
    setFormVertical("");
    setSelectedTeam(null);
  };

  const handleCreateTeam = async () => {
    const orgId = (userData?.isSuperAdmin && formOrgId) ? formOrgId : userData?.organizationId;
    const teamVertical = vertical ?? (formVertical || null);
    if (!formName.trim()) return;
    if (!orgId) {
      alert("No hay una organización activa. Si eres superadmin, crea una en Organizaciones y elígela en el selector.");
      return;
    }
    if (!teamVertical) {
      alert("Selecciona el módulo del equipo");
      return;
    }

    setSaving(true);
    try {
      const maxConversations = parseMax(formMaxConversations);
      await callHubAction(user, "team.create", {
        organizationId: orgId,
        fields: {
          name: formName.trim(),
          description: formDescription.trim(),
          assignmentMode: formAssignmentMode,
          ...(maxConversations !== null ? { maxConversationsPerAgent: maxConversations } : {}),
          optOutAction: formOptOutAction,
          vertical: teamVertical,
        },
      });
      setCreateDialogOpen(false);
      resetForm();
    } catch (error) {
      console.error("Error creating team:", error);
      alert(error instanceof Error ? error.message : "Error al crear el equipo");
    } finally {
      setSaving(false);
    }
  };

  const handleEditTeam = async () => {
    if (!selectedTeam || !formName.trim()) return;

    setSaving(true);
    try {
      const maxConversations = parseMax(formMaxConversations);
      const set: Record<string, unknown> = {
        name: formName.trim(),
        description: formDescription.trim(),
        assignmentMode: formAssignmentMode,
        optOutAction: formOptOutAction,
      };
      // Vacío = sin tope
      if (maxConversations !== null) set.maxConversationsPerAgent = maxConversations;
      // Equipos antiguos sin módulo: al editar dentro de un módulo se les asigna
      if (vertical && !selectedTeam.vertical) set.vertical = vertical;
      if (userData?.isSuperAdmin && formOrgId) set.organizationId = formOrgId;
      await callHubAction(user, "team.update", {
        id: selectedTeam.id,
        set,
        ...(maxConversations === null ? { unset: ["maxConversationsPerAgent"] } : {}),
      });
      setEditDialogOpen(false);
      resetForm();
    } catch (error) {
      console.error("Error updating team:", error);
      alert(error instanceof Error ? error.message : "Error al actualizar el equipo");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteTeam = async (teamId: string) => {
    if (!confirm("¿Estas seguro de que deseas eliminar este equipo? Los agentes y numeros asignados quedaran sin equipo.")) return;

    try {
      // La función 2 deja sin equipo a sus agentes y números antes de borrarlo
      await callHubAction(user, "team.delete", { id: teamId });
    } catch (error) {
      console.error("Error deleting team:", error);
      alert(error instanceof Error ? error.message : "Error al eliminar el equipo");
    }
  };

  const openEditDialog = (team: Team) => {
    setSelectedTeam(team);
    setFormName(team.name);
    setFormDescription(team.description);
    setFormAssignmentMode(team.assignmentMode);
    setFormMaxConversations(team.maxConversationsPerAgent ? String(team.maxConversationsPerAgent) : "");
    setFormOptOutAction(team.optOutAction ?? "close");
    setEditDialogOpen(true);
  };

  const getTeamMembers = (teamId: string) => {
    return members.filter(m => m.teamId === teamId);
  };

  const getTeamNumbers = (teamId: string) => {
    return whatsappNumbers.filter(n => n.teamId === teamId);
  };

  const assignmentModeLabels = {
    round_robin: "Round Robin",
    least_busy: "Menos ocupado",
    manual: "Manual",
    salesforce: "Asignación en Salesforce",
  };

  const isCurrentUserAdmin = userData?.role === "admin";

  if (!userData?.organizationId) {
    return (
      <div>
        <div className="mb-8">
          <h1 className="text-2xl font-bold">Equipos</h1>
          <p className="text-gray-500">Gestiona los equipos de trabajo (queues)</p>
        </div>
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-gray-500">
              Necesitas pertenecer a una organizacion para ver los equipos.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Equipos</h1>
          <p className="text-gray-500">
            {teams.length} equipo{teams.length !== 1 ? "s" : ""} configurado{teams.length !== 1 ? "s" : ""}
          </p>
        </div>
        {isCurrentUserAdmin && (
          <Button onClick={() => { resetForm(); setCreateDialogOpen(true); }}>
            <Plus className="mr-2 h-4 w-4" />
            Nuevo Equipo
          </Button>
        )}
      </div>

      {teams.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="rounded-full bg-gray-100 p-4 mb-4">
              <Users2 className="h-8 w-8 text-gray-400" />
            </div>
            <h3 className="text-lg font-medium mb-2">
              No hay equipos configurados
            </h3>
            <p className="text-gray-500 text-center mb-4">
              Crea equipos para organizar a tus agentes y numeros de WhatsApp.
            </p>
            {isCurrentUserAdmin && (
              <Button onClick={() => { resetForm(); setCreateDialogOpen(true); }}>
                <Plus className="mr-2 h-4 w-4" />
                Crear Equipo
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {teams.map((team) => {
            const teamMembers = getTeamMembers(team.id);
            const teamNumbers = getTeamNumbers(team.id);

            return (
              <Link key={team.id} href={modulePath(moduleId, `/equipos/${team.id}`)}>
              <Card className="cursor-pointer transition-colors hover:border-gray-400">
                <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                  <div>
                    <CardTitle className="text-lg">{team.name}</CardTitle>
                    {team.description && (
                      <p className="text-sm text-gray-500 mt-1">{team.description}</p>
                    )}
                  </div>
                  {isCurrentUserAdmin && (
                    <div onClick={(e) => e.preventDefault()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEditDialog(team)}>
                          <Pencil className="mr-2 h-4 w-4" />
                          Editar
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-red-600"
                          onClick={() => handleDeleteTeam(team.id)}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Eliminar
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    </div>
                  )}
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Badge variant="outline">
                        {assignmentModeLabels[team.assignmentMode]}
                      </Badge>
                      <span className="text-sm text-gray-500">
                        {team.maxConversationsPerAgent ? `Max: ${team.maxConversationsPerAgent} conv/agente` : "Sin tope"}
                      </span>
                    </div>

                    {team.assignmentMode === "round_robin" && (() => {
                      // Comparación ordinal (no localeCompare): debe coincidir con
                      // sorted() de Python en main.py, ver comentario en equipos/[id]/page.tsx
                      const eligible = teamMembers
                        .filter((m) => m.isAvailable && (m.role === "admin" || m.role === "agent"))
                        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
                      if (eligible.length === 0) return null;
                      // Primer elegible con id mayor al último asignado (equivalente a
                      // bisect_right en main.py) — si ya no es elegible, sigue desde su
                      // posición alfabética en vez de reiniciar en el primero.
                      let nextIdx = team.lastAssignedAgentId
                        ? eligible.findIndex((a) => a.id > team.lastAssignedAgentId!)
                        : -1;
                      if (nextIdx === -1) nextIdx = 0;
                      const next = eligible[nextIdx];
                      return (
                        <div className="text-sm text-gray-500">
                          Sigue: <span className="font-medium text-gray-700">{next.name}</span>
                        </div>
                      );
                    })()}

                    <div className="flex items-center gap-4 text-sm">
                      <div className="flex items-center gap-1">
                        <Users2 className="h-4 w-4 text-gray-400" />
                        <span>{teamMembers.length} agentes</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Phone className="h-4 w-4 text-gray-400" />
                        <span>{teamNumbers.length} numeros</span>
                      </div>
                    </div>

                    {teamMembers.length > 0 && (
                      <div className="pt-2 border-t">
                        <p className="text-xs text-gray-500 mb-1">Agentes:</p>
                        <div className="flex flex-wrap gap-1">
                          {teamMembers.slice(0, 3).map((member) => (
                            <Badge key={member.id} variant="secondary" className="text-xs">
                              {member.name}
                            </Badge>
                          ))}
                          {teamMembers.length > 3 && (
                            <Badge variant="secondary" className="text-xs">
                              +{teamMembers.length - 3} mas
                            </Badge>
                          )}
                        </div>
                      </div>
                    )}

                    {teamNumbers.length > 0 && (
                      <div className="pt-2 border-t">
                        <p className="text-xs text-gray-500 mb-1">Numeros:</p>
                        <div className="flex flex-wrap gap-1">
                          {teamNumbers.map((num) => (
                            <Badge key={num.id} variant="outline" className="text-xs">
                              {num.displayName || num.phoneNumber}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
              </Link>
            );
          })}
        </div>
      )}

      {/* Create Team Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Crear Equipo</DialogTitle>
            <DialogDescription>
              Configura un nuevo equipo para organizar agentes y numeros de WhatsApp.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {userData?.isSuperAdmin && authOrgs.length > 0 && (
              <div className="space-y-2">
                <Label>Organizacion</Label>
                <Select value={formOrgId || userData?.organizationId || ""} onValueChange={setFormOrgId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Seleccionar organizacion" />
                  </SelectTrigger>
                  <SelectContent>
                    {authOrgs.map((org) => (
                      <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {!vertical && (
              <div className="space-y-2">
                <Label>Módulo</Label>
                <Select value={formVertical} onValueChange={(v) => setFormVertical(v as Vertical)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Seleccionar módulo" />
                  </SelectTrigger>
                  <SelectContent>
                    {MODULES.filter((m) => m.vertical).map((m) => (
                      <SelectItem key={m.id} value={m.vertical as string}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="name">Nombre del equipo</Label>
              <Input
                id="name"
                placeholder="Ej: Ventas, Soporte, etc."
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Descripcion (opcional)</Label>
              <Input
                id="description"
                placeholder="Descripcion del equipo"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="assignmentMode">Modo de asignacion</Label>
              <Select value={formAssignmentMode} onValueChange={(v) => setFormAssignmentMode(v as typeof formAssignmentMode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="least_busy">Menos ocupado</SelectItem>
                  <SelectItem value="round_robin">Round Robin</SelectItem>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="salesforce">Asignación en Salesforce</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxConversations">Max conversaciones por agente</Label>
              <Input
                id="maxConversations"
                type="number"
                min={1}
                max={50}
                placeholder="Sin tope"
                value={formMaxConversations}
                onChange={(e) => setFormMaxConversations(e.target.value)}
              />
              <p className="text-xs text-gray-500">Déjalo vacío para no limitar las conversaciones por agente.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="optOutAction">Cuando el cliente escribe &quot;stop&quot;</Label>
              <Select value={formOptOutAction} onValueChange={(v) => setFormOptOutAction(v as "close" | "handoff")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="close">Cerrar la conversación</SelectItem>
                  <SelectItem value="handoff">Pasar a un agente</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-500">Qué hace la plataforma cuando el cliente escribe stop.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleCreateTeam} disabled={saving || !formName.trim()}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Crear Equipo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Team Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Editar Equipo</DialogTitle>
            <DialogDescription>
              Modifica la configuracion del equipo.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {userData?.isSuperAdmin && authOrgs.length > 0 && (
              <div className="space-y-2">
                <Label>Organizacion</Label>
                <Select value={formOrgId || userData?.organizationId || ""} onValueChange={setFormOrgId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Seleccionar organizacion" />
                  </SelectTrigger>
                  <SelectContent>
                    {authOrgs.map((org) => (
                      <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="edit-name">Nombre del equipo</Label>
              <Input
                id="edit-name"
                placeholder="Ej: Ventas, Soporte, etc."
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-description">Descripcion (opcional)</Label>
              <Input
                id="edit-description"
                placeholder="Descripcion del equipo"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-assignmentMode">Modo de asignacion</Label>
              <Select value={formAssignmentMode} onValueChange={(v) => setFormAssignmentMode(v as typeof formAssignmentMode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="least_busy">Menos ocupado</SelectItem>
                  <SelectItem value="round_robin">Round Robin</SelectItem>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="salesforce">Asignación en Salesforce</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-maxConversations">Max conversaciones por agente</Label>
              <Input
                id="edit-maxConversations"
                type="number"
                min={1}
                max={50}
                placeholder="Sin tope"
                value={formMaxConversations}
                onChange={(e) => setFormMaxConversations(e.target.value)}
              />
              <p className="text-xs text-gray-500">Déjalo vacío para no limitar las conversaciones por agente.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-optOutAction">Cuando el cliente escribe &quot;stop&quot;</Label>
              <Select value={formOptOutAction} onValueChange={(v) => setFormOptOutAction(v as "close" | "handoff")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="close">Cerrar la conversación</SelectItem>
                  <SelectItem value="handoff">Pasar a un agente</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-500">Qué hace la plataforma cuando el cliente escribe stop.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleEditTeam} disabled={saving || !formName.trim()}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Guardar Cambios
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
