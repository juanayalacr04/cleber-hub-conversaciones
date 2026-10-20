"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Plus, Users, Users2, Loader2, MoreVertical, Trash2, Shield, UserCog, Building2 } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
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
import { collection, query, where, onSnapshot } from "firebase/firestore";
import { useAuth } from "@/contexts/AuthContext";
import { callHubAction } from "@/lib/hub-actions";
import { getModule } from "@/lib/modules";

interface TeamMember {
  id: string;
  name: string;
  email: string;
  photoURL: string | null;
  role: "admin" | "agent" | "viewer";
  isAvailable: boolean;
  activeConversations: number;
  teamId: string | null;
  organizationId: string | null;
  organizationIds: string[];
  orgTeams: Record<string, string>;
  lastLoginAt: Date | null;
}

interface Team {
  id: string;
  name: string;
  vertical: "servicio" | "ventas" | null;
}

export default function TeamPage() {
  const { userData, user, organizations: authOrgs } = useAuth();
  const searchParams = useSearchParams();
  const { module: moduleId } = useParams<{ module: string }>();
  const vertical = getModule(moduleId)?.vertical ?? null;
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(() => searchParams.get("invite") === "true");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "agent" | "viewer">("agent");
  const [inviting, setInviting] = useState(false);
  const [inviteOrgId, setInviteOrgId] = useState<string>("");
  const [inviteTeamId, setInviteTeamId] = useState<string>("");
  // En un módulo, los usuarios sin equipo no pertenecen a ninguno: se pueden mostrar para asignarlos
  const [showUnassigned, setShowUnassigned] = useState(false);

  useEffect(() => {
    if (!userData?.organizationId) {
      setLoading(false);
      return;
    }

    const usersRef = collection(db, "users");
    // q1: formato viejo (organizationId directo)
    const q1 = query(usersRef, where("organizationId", "==", userData.organizationId));
    // q2: formato nuevo (organizationIds array)
    const q2 = query(usersRef, where("organizationIds", "array-contains", userData.organizationId));

    // Mapas separados por query para merge correcto con deduplicación por id
    let snap1Map = new Map<string, TeamMember>();
    let snap2Map = new Map<string, TeamMember>();

    const toMember = (d: any): TeamMember => {
      const data = d.data();
      return {
        id: d.id,
        name: data.name || data.email?.split("@")[0] || "Sin nombre",
        email: data.email || "",
        photoURL: data.photoURL || null,
        role: data.role || "viewer",
        isAvailable: data.isAvailable ?? true,
        activeConversations: data.activeConversations || 0,
        teamId: data.teamId || null,
        organizationId: data.organizationId || null,
        organizationIds: data.organizationIds || (data.organizationId ? [data.organizationId] : []),
        orgTeams: data.orgTeams || {},
        lastLoginAt: data.lastLoginAt?.toDate?.() ?? null,
      };
    };

    const merge = () => {
      const merged = new Map([...snap1Map, ...snap2Map]);
      setMembers(Array.from(merged.values()));
      setLoading(false);
    };

    const unsub1 = onSnapshot(q1, (snap) => {
      snap1Map = new Map();
      snap.forEach((d) => snap1Map.set(d.id, toMember(d)));
      merge();
    }, (error) => { console.error("Error fetching team members (q1):", error); setLoading(false); });

    const unsub2 = onSnapshot(q2, (snap) => {
      snap2Map = new Map();
      snap.forEach((d) => snap2Map.set(d.id, toMember(d)));
      merge();
    }, (error) => { console.error("Error fetching team members (q2):", error); });

    // Subscribe to teams
    const teamsRef = collection(db, "teams");
    const teamsQuery = query(teamsRef, where("organizationId", "==", userData.organizationId));
    const unsubTeams = onSnapshot(teamsQuery, (snapshot) => {
      const teamsData: Team[] = [];
      snapshot.forEach((doc) => {
        teamsData.push({ id: doc.id, name: doc.data().name, vertical: doc.data().vertical ?? null });
      });
      setTeams(teamsData);
    });

    return () => {
      unsub1();
      unsub2();
      unsubTeams();
    };
  }, [userData?.organizationId]);

  // Equipos del módulo activo (en general, todos)
  const moduleTeams = vertical ? teams.filter((t) => t.vertical === vertical) : teams;

  const orgIdActive = userData?.organizationId ?? "";
  const memberTeamId = (m: TeamMember) => m.orgTeams[orgIdActive] ?? m.teamId ?? null;

  // Agentes del módulo: su equipo en la organización activa pertenece al módulo
  const visibleMembers = vertical
    ? members.filter((m) => {
        const tid = memberTeamId(m);
        if (!tid) return showUnassigned;
        return moduleTeams.some((t) => t.id === tid);
      })
    : members;

  const handleChangeRole = async (memberId: string, newRole: "admin" | "agent" | "viewer") => {
    try {
      await callHubAction(user, "member.set_role", { organizationId: userData?.organizationId, userId: memberId, role: newRole });
    } catch (error) {
      console.error("Error changing role:", error);
      alert(error instanceof Error ? error.message : "Error al cambiar el rol");
    }
  };

  const handleToggleAvailability = async (memberId: string, currentAvailability: boolean) => {
    try {
      await callHubAction(user, "member.set_availability", { organizationId: userData?.organizationId, userId: memberId, available: !currentAvailability });
    } catch (error) {
      console.error("Error toggling availability:", error);
      alert(error instanceof Error ? error.message : "Error al cambiar disponibilidad");
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!confirm("¿Estas seguro de que deseas eliminar a este miembro del equipo?")) return;

    const orgId = userData?.organizationId;
    if (!orgId) return;

    try {
      await callHubAction(user, "member.remove", { organizationId: orgId, userId: memberId });
    } catch (error) {
      console.error("Error removing member:", error);
      alert(error instanceof Error ? error.message : "Error al eliminar miembro");
    }
  };

  const handleChangeOrg = async (memberId: string, orgId: string) => {
    try {
      await callHubAction(user, "member.set_primary_org", { organizationId: orgId, userId: memberId });
      toast.success("Organización actualizada");
    } catch (error) {
      console.error("Error changing org:", error);
      alert(error instanceof Error ? error.message : "Error al cambiar organización");
    }
  };

  const handleChangeTeam = async (memberId: string, teamId: string | null) => {
    try {
      await callHubAction(user, "member.set_team", { organizationId: userData?.organizationId, userId: memberId, teamId });
    } catch (error) {
      console.error("Error changing team:", error);
      alert(error instanceof Error ? error.message : "Error al cambiar equipo");
    }
  };

  const getTeamName = (teamId: string | null) => {
    if (!teamId) return "Sin equipo";
    const team = teams.find(t => t.id === teamId);
    return team?.name || "Sin equipo";
  };

  const getOrgName = (orgId: string | null) => {
    if (!orgId) return null;
    const org = authOrgs.find(o => o.id === orgId);
    return org?.name || null;
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    if (vertical && !inviteTeamId) {
      toast.error("Selecciona un equipo del módulo");
      return;
    }

    setInviting(true);
    try {
      const { emailSent } = await callHubAction<{ emailSent: boolean }>(user, "member.invite", {
        email: inviteEmail.trim(),
        role: inviteRole,
        organizationId: inviteOrgId || userData?.organizationId,
        ...(inviteTeamId ? { teamId: inviteTeamId } : {}),
      });

      if (!emailSent) toast.warning("La invitación se creó, pero no se pudo enviar el correo. Avísale que ya puede entrar con su cuenta de Google.");
      toast.success(`Invitación enviada a ${inviteEmail}`);
      setInviteDialogOpen(false);
      setInviteEmail("");
      setInviteTeamId("");
    } catch (error) {
      console.error("Error inviting:", error);
      toast.error(error instanceof Error ? error.message : "Error al enviar invitación");
    } finally {
      setInviting(false);
    }
  };

  const isCurrentUserAdmin = userData?.role === "admin";

  const roleLabels = {
    admin: "Administrador",
    agent: "Agente",
    viewer: "Observador",
  };

  const roleColors = {
    admin: "bg-purple-100 text-purple-800",
    agent: "bg-blue-100 text-blue-800",
    viewer: "bg-gray-100 text-gray-800",
  };

  if (!userData?.organizationId) {
    return (
      <div>
        <div className="mb-8">
          <h1 className="text-2xl font-bold">Equipo</h1>
          <p className="text-gray-500">Gestiona los miembros de tu equipo</p>
        </div>
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-gray-500">
              Necesitas pertenecer a una organización para ver el equipo.
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
          <h1 className="text-2xl font-bold">Agentes</h1>
          <p className="text-gray-500">
            {visibleMembers.length} miembro{visibleMembers.length !== 1 ? "s" : ""} {vertical ? `en el módulo ${getModule(moduleId)?.label}` : "en tu organización"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {vertical && (
            <Button variant="outline" onClick={() => setShowUnassigned((v) => !v)}>
              {showUnassigned ? "Ocultar sin equipo" : "Mostrar sin equipo"}
            </Button>
          )}
          {isCurrentUserAdmin && (
            <Button onClick={() => setInviteDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Invitar
            </Button>
          )}
        </div>
      </div>

      {visibleMembers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="rounded-full bg-gray-100 p-4 mb-4">
              <Users className="h-8 w-8 text-gray-400" />
            </div>
            <h3 className="text-lg font-medium mb-2">
              Tu equipo está vacío
            </h3>
            <p className="text-gray-500 text-center mb-4">
              Invita a miembros de tu equipo para que puedan atender
              conversaciones.
            </p>
            {isCurrentUserAdmin && (
              <Button onClick={() => setInviteDialogOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Invitar
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {visibleMembers.map((member) => (
            <Card key={member.id}>
              <CardContent className="flex items-center justify-between py-4">
                <div className="flex items-center gap-4">
                  <div className="relative">
                    <Avatar>
                      <AvatarImage src={member.photoURL || undefined} />
                      <AvatarFallback>
                        {member.name
                          .split(" ")
                          .map((n) => n[0])
                          .join("")
                          .slice(0, 2)
                          .toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span
                      className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white ${
                        member.isAvailable ? "bg-green-500" : "bg-gray-400"
                      }`}
                      title={member.isAvailable ? "Disponible" : "No disponible"}
                    />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{member.name}</p>
                      {member.id === user?.uid && (
                        <Badge variant="outline" className="text-xs">Tú</Badge>
                      )}
                    </div>
                    <p className="text-sm text-gray-500">{member.email}</p>
                    <p className="text-xs text-gray-400">
                      {member.lastLoginAt
                        ? `Ultimo login: ${formatDistanceToNow(member.lastLoginAt, { addSuffix: true, locale: es })}`
                        : "Ultimo login: Nunca"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {member.role === "agent" && (
                    <span className="text-sm text-gray-500">
                      {member.activeConversations} conv. activas
                    </span>
                  )}
                  <Badge variant="outline" className="flex items-center gap-1">
                    <Users2 className="h-3 w-3" />
                    {getTeamName(member.orgTeams[userData?.organizationId ?? ""] ?? member.teamId ?? null)}
                  </Badge>
                  <Badge className={roleColors[member.role]}>
                    {roleLabels[member.role]}
                  </Badge>
                  {/* SuperAdmin can reassign their own org */}
                  {userData?.isSuperAdmin && member.id === user?.uid && authOrgs.length > 0 && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem disabled className="text-xs text-gray-500">
                          Asignar a organización:
                        </DropdownMenuItem>
                        {authOrgs.map((org) => (
                          <DropdownMenuItem
                            key={org.id}
                            onClick={() => handleChangeOrg(member.id, org.id)}
                          >
                            <Building2 className="mr-2 h-4 w-4" />
                            {org.name}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  {/* Las reglas de Firestore no dejan que un usuario edite su propio rol/equipo: solo un admin sobre otros */}
                  {isCurrentUserAdmin && member.id !== user?.uid && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleToggleAvailability(member.id, member.isAvailable)}>
                          <UserCog className="mr-2 h-4 w-4" />
                          {member.isAvailable ? "Marcar no disponible" : "Marcar disponible"}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => handleChangeRole(member.id, "admin")}>
                          <Shield className="mr-2 h-4 w-4" />
                          Hacer Administrador
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleChangeRole(member.id, "agent")}>
                          <Users className="mr-2 h-4 w-4" />
                          Hacer Agente
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleChangeRole(member.id, "viewer")}>
                          <Users className="mr-2 h-4 w-4" />
                          Hacer Observador
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {userData?.isSuperAdmin && authOrgs.length > 0 && (
                          <>
                            <DropdownMenuItem disabled className="text-xs text-gray-500">
                              Asignar a organización:
                            </DropdownMenuItem>
                            {authOrgs.map((org) => (
                              <DropdownMenuItem
                                key={org.id}
                                onClick={() => handleChangeOrg(member.id, org.id)}
                              >
                                <Building2 className="mr-2 h-4 w-4" />
                                {org.name}
                              </DropdownMenuItem>
                            ))}
                            <DropdownMenuSeparator />
                          </>
                        )}
                        {moduleTeams.length > 0 && (
                          <>
                            <DropdownMenuItem disabled className="text-xs text-gray-500">
                              Asignar a equipo:
                            </DropdownMenuItem>
                            {moduleTeams.map((team) => (
                              <DropdownMenuItem
                                key={team.id}
                                onClick={() => handleChangeTeam(member.id, team.id)}
                              >
                                <Users2 className="mr-2 h-4 w-4" />
                                {team.name}
                                {(member.orgTeams[userData?.organizationId ?? ""] ?? member.teamId) === team.id && " (actual)"}
                              </DropdownMenuItem>
                            ))}
                            <DropdownMenuItem onClick={() => handleChangeTeam(member.id, null)}>
                              <Users2 className="mr-2 h-4 w-4" />
                              Sin equipo
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                          </>
                        )}
                        <DropdownMenuItem
                          className="text-red-600"
                          onClick={() => handleRemoveMember(member.id)}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Eliminar del equipo
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Invite Dialog */}
      <Dialog open={inviteDialogOpen} onOpenChange={setInviteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invitar miembro</DialogTitle>
            <DialogDescription>
              Envía una invitación por email para unirse a tu equipo.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="email">Correo electrónico</Label>
              <Input
                id="email"
                type="email"
                placeholder="correo@ejemplo.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="role">Rol</Label>
              <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as "admin" | "agent" | "viewer")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Administrador</SelectItem>
                  <SelectItem value="agent">Agente</SelectItem>
                  <SelectItem value="viewer">Observador</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Equipo{vertical ? "" : " (opcional)"}</Label>
              <Select value={inviteTeamId} onValueChange={setInviteTeamId}>
                <SelectTrigger>
                  <SelectValue placeholder="Seleccionar equipo" />
                </SelectTrigger>
                <SelectContent>
                  {moduleTeams.map((team) => (
                    <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {authOrgs.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="org">Organización</Label>
                <Select value={inviteOrgId || userData?.organizationId || ""} onValueChange={setInviteOrgId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Seleccionar organización" />
                  </SelectTrigger>
                  <SelectContent>
                    {authOrgs.map((org) => (
                      <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleInvite} disabled={inviting || !inviteEmail.trim()}>
              {inviting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Enviar invitación
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
