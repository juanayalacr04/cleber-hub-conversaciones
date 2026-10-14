"use client";

import { useEffect, useState, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowLeft,
  Save,
  Loader2,
  Users2,
  Phone,
  Plus,
  MoreVertical,
  Trash2,
  UserPlus,
  Settings,
  Tag,
  Pencil,
  Clock,
  UserCheck,
  UserX,
  RotateCw,
} from "lucide-react";
import { db } from "@/lib/firebase";
import {
  doc,
  collection,
  query,
  where,
  onSnapshot,
  updateDoc,
  addDoc,
  deleteDoc,
  deleteField,
  serverTimestamp,
} from "firebase/firestore";
import { useAuth } from "@/contexts/AuthContext";
import { modulePath } from "@/lib/routes";

interface TeamData {
  id: string;
  name: string;
  description: string;
  assignmentMode: "round_robin" | "least_busy" | "manual" | "salesforce";
  /** Opcional: sin valor = sin tope */
  maxConversationsPerAgent?: number | null;
  /** Qué hace la plataforma cuando el cliente escribe "stop" */
  optOutAction?: "close" | "handoff";
  vertical?: "servicio" | "ventas" | null;
  lastAssignedAgentId?: string | null;
  activeConversations: number;
  status: "active" | "inactive";
  organizationId: string;
  semaphoreThresholds?: { yellowMinutes: number; redMinutes: number };
}

interface TeamMember {
  id: string;
  name: string;
  email: string;
  photoURL: string | null;
  role: "admin" | "agent" | "viewer";
  isAvailable: boolean;
  activeConversations: number;
  teamId: string | null;
  primaryOrgId: string;
  orgTeams: Record<string, string>;
}

interface WhatsAppNumber {
  id: string;
  phoneNumber: string;
  displayName: string;
  teamId: string | null;
  status: "active" | "inactive";
}

const LABEL_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  red:    { bg: "bg-red-100 dark:bg-red-900/30",       text: "text-red-800 dark:text-red-300",     dot: "bg-red-500" },
  orange: { bg: "bg-orange-100 dark:bg-orange-900/30", text: "text-orange-800 dark:text-orange-300", dot: "bg-orange-500" },
  yellow: { bg: "bg-yellow-100 dark:bg-yellow-900/30", text: "text-yellow-800 dark:text-yellow-300", dot: "bg-yellow-500" },
  green:  { bg: "bg-green-100 dark:bg-green-900/30",   text: "text-green-800 dark:text-green-300",  dot: "bg-green-500" },
  blue:   { bg: "bg-blue-100 dark:bg-blue-900/30",     text: "text-blue-800 dark:text-blue-300",    dot: "bg-blue-500" },
  purple: { bg: "bg-purple-100 dark:bg-purple-900/30", text: "text-purple-800 dark:text-purple-300", dot: "bg-purple-500" },
  pink:   { bg: "bg-pink-100 dark:bg-pink-900/30",     text: "text-pink-800 dark:text-pink-300",    dot: "bg-pink-500" },
  gray:   { bg: "bg-gray-100 dark:bg-gray-800",        text: "text-gray-700 dark:text-gray-300",    dot: "bg-gray-400" },
};

const LABEL_COLOR_OPTIONS = Object.keys(LABEL_COLORS);

interface ConversationLabel {
  id: string;
  name: string;
  color: string;
}

export default function TeamDetailPage() {
  const params = useParams();
  const moduleId = params.module as string;
  const router = useRouter();
  const { userData } = useAuth();
  const teamId = params.id as string;

  const [team, setTeam] = useState<TeamData | null>(null);
  const [members1, setMembers1] = useState<TeamMember[]>([]);
  const [members2, setMembers2] = useState<TeamMember[]>([]);
  const [allNumbers, setAllNumbers] = useState<WhatsAppNumber[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Form states for General tab
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formStatus, setFormStatus] = useState<"active" | "inactive">("active");

  // Form states for Config tab
  const [formAssignmentMode, setFormAssignmentMode] = useState<"round_robin" | "least_busy" | "manual" | "salesforce">("least_busy");
  const [formMaxConversations, setFormMaxConversations] = useState("");
  const [formOptOutAction, setFormOptOutAction] = useState<"close" | "handoff">("close");

  // Dialog states
  const [addAgentDialogOpen, setAddAgentDialogOpen] = useState(false);
  const [addNumberDialogOpen, setAddNumberDialogOpen] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [selectedNumberId, setSelectedNumberId] = useState("");

  // Semaphore states
  const [formYellowMinutes, setFormYellowMinutes] = useState(5);
  const [formRedMinutes, setFormRedMinutes] = useState(15);
  const [savingSemaphore, setSavingSemaphore] = useState(false);

  // Label states
  const [labels, setLabels] = useState<ConversationLabel[]>([]);
  const [labelDialogOpen, setLabelDialogOpen] = useState(false);
  const [editingLabel, setEditingLabel] = useState<ConversationLabel | null>(null);
  const [labelName, setLabelName] = useState("");
  const [labelColor, setLabelColor] = useState("blue");
  const [savingLabel, setSavingLabel] = useState(false);

  const isAdmin = userData?.role === "admin";

  // Subscribe to team document
  useEffect(() => {
    if (!teamId) return;

    const unsubTeam = onSnapshot(
      doc(db, "teams", teamId),
      (snapshot) => {
        if (snapshot.exists()) {
          const data = { id: snapshot.id, ...snapshot.data() } as TeamData;
          setTeam(data);
          setFormName(data.name || "");
          setFormDescription(data.description || "");
          setFormStatus(data.status || "active");
          setFormAssignmentMode(data.assignmentMode || "least_busy");
          setFormMaxConversations(data.maxConversationsPerAgent ? String(data.maxConversationsPerAgent) : "");
          setFormOptOutAction(data.optOutAction === "handoff" ? "handoff" : "close");
          if (data.semaphoreThresholds) {
            setFormYellowMinutes(data.semaphoreThresholds.yellowMinutes ?? 5);
            setFormRedMinutes(data.semaphoreThresholds.redMinutes ?? 15);
          }
        } else {
          setTeam(null);
        }
        setLoading(false);
      },
      (error) => {
        console.error("Error fetching team:", error);
        setLoading(false);
      }
    );

    return () => unsubTeam();
  }, [teamId]);

  // Subscribe to all org members (primary org + multi-org secondary)
  useEffect(() => {
    if (!userData?.organizationId) return;

    const usersRef = collection(db, "users");
    const orgId = userData.organizationId;

    const buildMember = (d: { id: string; data: () => Record<string, unknown> }): TeamMember => {
      const data = d.data();
      return {
        id: d.id,
        name: (data.name as string) || (data.email as string)?.split("@")[0] || "Sin nombre",
        email: (data.email as string) || "",
        photoURL: (data.photoURL as string | null) || null,
        role: (data.role as "admin" | "agent" | "viewer") || "viewer",
        isAvailable: (data.isAvailable as boolean) ?? true,
        activeConversations: (data.activeConversations as number) || 0,
        teamId: (data.teamId as string | null) || null,
        primaryOrgId: (data.organizationId as string) || "",
        orgTeams: (data.orgTeams as Record<string, string>) || {},
      };
    };

    const q1 = query(usersRef, where("organizationId", "==", orgId));
    const q2 = query(usersRef, where("organizationIds", "array-contains", orgId));

    const unsubUsers1 = onSnapshot(q1, (snap) => {
      const data: TeamMember[] = [];
      snap.forEach((d) => data.push(buildMember(d)));
      setMembers1(data);
    });

    const unsubUsers2 = onSnapshot(q2, (snap) => {
      const data: TeamMember[] = [];
      snap.forEach((d) => data.push(buildMember(d)));
      setMembers2(data);
    });

    return () => { unsubUsers1(); unsubUsers2(); };
  }, [userData?.organizationId]);

  // Subscribe to all org WhatsApp numbers
  useEffect(() => {
    if (!userData?.organizationId) return;

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
          teamId: data.teamId || null,
          status: data.status || "inactive",
        });
      });
      setAllNumbers(numbersData);
    });

    return () => unsubNumbers();
  }, [userData?.organizationId]);

  // Load labels for this team
  useEffect(() => {
    if (!teamId || !userData?.organizationId) return;
    const q = query(
      collection(db, "labels"),
      where("teamId", "==", teamId),
      where("organizationId", "==", userData.organizationId)
    );
    return onSnapshot(q, (snap) => {
      const data: ConversationLabel[] = [];
      snap.forEach((d) => data.push({ id: d.id, ...d.data() } as ConversationLabel));
      setLabels(data);
    });
  }, [teamId, userData?.organizationId]);

  const handleOpenCreateLabel = () => {
    setEditingLabel(null);
    setLabelName("");
    setLabelColor("blue");
    setLabelDialogOpen(true);
  };

  const handleOpenEditLabel = (label: ConversationLabel) => {
    setEditingLabel(label);
    setLabelName(label.name);
    setLabelColor(label.color);
    setLabelDialogOpen(true);
  };

  const handleSaveLabel = async () => {
    if (!labelName.trim() || !userData?.organizationId) return;
    setSavingLabel(true);
    try {
      if (editingLabel) {
        await updateDoc(doc(db, "labels", editingLabel.id), {
          name: labelName.trim(),
          color: labelColor,
        });
      } else {
        await addDoc(collection(db, "labels"), {
          name: labelName.trim(),
          color: labelColor,
          teamId,
          organizationId: userData.organizationId,
          createdAt: serverTimestamp(),
        });
      }
      setLabelDialogOpen(false);
    } catch (e) {
      console.error("Error saving label:", e);
      alert("Error al guardar la etiqueta");
    } finally {
      setSavingLabel(false);
    }
  };

  const handleDeleteLabel = async (labelId: string) => {
    if (!confirm("¿Eliminar esta etiqueta?")) return;
    try {
      await deleteDoc(doc(db, "labels", labelId));
    } catch (e) {
      console.error("Error deleting label:", e);
      alert("Error al eliminar la etiqueta");
    }
  };

  const allMembers = useMemo(() => {
    const map = new Map(members1.map((m) => [m.id, m]));
    members2.forEach((m) => { if (!map.has(m.id)) map.set(m.id, m); });
    return [...map.values()];
  }, [members1, members2]);

  const currentOrgId = userData?.organizationId ?? "";
  const getEffTeamId = (m: TeamMember) => m.orgTeams[currentOrgId] ?? m.teamId;
  const teamMembers = allMembers.filter((m) => getEffTeamId(m) === teamId);
  const availableMembers = allMembers.filter((m) => { const t = getEffTeamId(m); return !t || t !== teamId; });
  const teamNumbers = allNumbers.filter((n) => n.teamId === teamId);
  const availableNumbers = allNumbers.filter((n) => !n.teamId || n.teamId !== teamId);

  // Mismo criterio que auto_assign_agent() en main.py: elegibles = isAvailable
  // + rol admin/agent, orden estable por id. Se usa para mostrar a quién le
  // toca el siguiente turno de Round Robin.
  // Comparación ordinal (no localeCompare): sorted() en Python compara por
  // código Unicode puro, mientras que localeCompare intercala mayúsculas y
  // minúsculas por reglas de idioma — con los IDs de Firebase Auth (mezcla de
  // mayúsculas/minúsculas al azar) dan órdenes distintos y el "sigue" del
  // frontend no coincide con el agente que realmente asigna main.py.
  const eligibleForAssignment = teamMembers
    .filter((m) => m.isAvailable && (m.role === "admin" || m.role === "agent"))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Primer elegible con id mayor al último asignado (equivalente a bisect_right
  // en main.py) — si ese agente ya no es elegible, la rotación sigue desde su
  // posición alfabética en vez de reiniciar en el primero de la lista.
  let nextIdx = team?.lastAssignedAgentId
    ? eligibleForAssignment.findIndex((m) => m.id > team.lastAssignedAgentId!)
    : -1;
  if (nextIdx === -1) nextIdx = 0;
  const nextAgentId = eligibleForAssignment.length > 0
    ? eligibleForAssignment[nextIdx].id
    : null;

  const handleSaveGeneral = async () => {
    if (!team || !formName.trim()) return;

    setSaving(true);
    try {
      await updateDoc(doc(db, "teams", team.id), {
        name: formName.trim(),
        description: formDescription.trim(),
        status: formStatus,
      });
    } catch (error) {
      console.error("Error saving team:", error);
      alert("Error al guardar los cambios");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSemaphore = async () => {
    if (!team) return;
    if (formYellowMinutes <= 0 || formRedMinutes <= 0 || formYellowMinutes >= formRedMinutes) {
      alert("El tiempo amarillo debe ser menor al tiempo rojo y ambos deben ser mayores a 0.");
      return;
    }
    setSavingSemaphore(true);
    try {
      await updateDoc(doc(db, "teams", team.id), {
        semaphoreThresholds: {
          yellowMinutes: formYellowMinutes,
          redMinutes: formRedMinutes,
        },
      });
    } catch (error) {
      console.error("Error saving semaphore:", error);
      alert("Error al guardar el semaforo");
    } finally {
      setSavingSemaphore(false);
    }
  };

  const handleSaveConfig = async () => {
    if (!team) return;

    setSaving(true);
    try {
      await updateDoc(doc(db, "teams", team.id), {
        assignmentMode: formAssignmentMode,
        // Vacío = sin tope
        maxConversationsPerAgent: parseInt(formMaxConversations, 10) > 0 ? parseInt(formMaxConversations, 10) : deleteField(),
        optOutAction: formOptOutAction,
      });
    } catch (error) {
      console.error("Error saving config:", error);
      alert("Error al guardar la configuracion");
    } finally {
      setSaving(false);
    }
  };

  const handleAddAgent = async () => {
    if (!selectedAgentId || !userData?.organizationId) return;
    const member = allMembers.find((m) => m.id === selectedAgentId);
    const orgId = userData.organizationId;
    // ponytail: orgTeams for multi-org; also update legacy teamId if primary org matches
    const updates: Record<string, unknown> = { [`orgTeams.${orgId}`]: teamId };
    if (member?.primaryOrgId === orgId) updates.teamId = teamId;
    try {
      await updateDoc(doc(db, "users", selectedAgentId), updates);
      setAddAgentDialogOpen(false);
      setSelectedAgentId("");
    } catch (error) {
      console.error("Error adding agent:", error);
      alert("Error al agregar agente");
    }
  };

  const handleRemoveAgent = async (memberId: string) => {
    const member = allMembers.find((m) => m.id === memberId);
    const orgId = userData?.organizationId ?? "";
    const updates: Record<string, unknown> = { [`orgTeams.${orgId}`]: deleteField() };
    if (member?.primaryOrgId === orgId) updates.teamId = null;
    try {
      await updateDoc(doc(db, "users", memberId), updates);
    } catch (error) {
      console.error("Error removing agent:", error);
      alert("Error al quitar agente");
    }
  };

  const handleToggleAvailability = async (memberId: string, currentAvailability: boolean) => {
    try {
      await updateDoc(doc(db, "users", memberId), { isAvailable: !currentAvailability });
    } catch (error) {
      console.error("Error toggling availability:", error);
      alert("Error al cambiar disponibilidad");
    }
  };

  const handleAddNumber = async () => {
    if (!selectedNumberId) return;

    try {
      await updateDoc(doc(db, "whatsappNumbers", selectedNumberId), { teamId });
      setAddNumberDialogOpen(false);
      setSelectedNumberId("");
    } catch (error) {
      console.error("Error adding number:", error);
      alert("Error al asignar numero");
    }
  };

  const handleRemoveNumber = async (numberId: string) => {
    try {
      await updateDoc(doc(db, "whatsappNumbers", numberId), { teamId: null });
    } catch (error) {
      console.error("Error removing number:", error);
      alert("Error al quitar numero");
    }
  };

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  const assignmentModeLabels: Record<string, string> = {
    round_robin: "Round Robin",
    least_busy: "Menos ocupado",
    manual: "Manual",
    salesforce: "Asignación en Salesforce",
  };

  const roleLabels: Record<string, string> = {
    admin: "Administrador",
    agent: "Agente",
    viewer: "Observador",
  };

  const roleColors: Record<string, string> = {
    admin: "bg-purple-100 text-purple-800",
    agent: "bg-blue-100 text-blue-800",
    viewer: "bg-gray-100 text-gray-800",
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!team) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Equipo no encontrado</p>
        <Link href={modulePath(moduleId, "/equipos")}>
          <Button variant="link">Volver a Equipos</Button>
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <Link href={modulePath(moduleId, "/equipos")}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{team.name}</h1>
            <Badge variant={team.status === "active" ? "default" : "secondary"}>
              {team.status === "active" ? "Activo" : "Inactivo"}
            </Badge>
          </div>
          <p className="text-gray-500">
            {teamMembers.length} agente{teamMembers.length !== 1 ? "s" : ""} · {teamNumbers.length} numero{teamNumbers.length !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="general" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="agents">Agentes</TabsTrigger>
          <TabsTrigger value="numbers">Numeros</TabsTrigger>
          <TabsTrigger value="labels">Etiquetas</TabsTrigger>
          <TabsTrigger value="semaphore">Semaforo</TabsTrigger>
          <TabsTrigger value="config">Configuracion</TabsTrigger>
        </TabsList>

        {/* General Tab */}
        <TabsContent value="general">
          <Card>
            <CardHeader>
              <CardTitle>Informacion General</CardTitle>
              <CardDescription>
                Nombre, descripcion y estado del equipo
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="team-name">Nombre del equipo</Label>
                <Input
                  id="team-name"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="Ej: Ventas, Soporte, etc."
                  disabled={!isAdmin}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="team-description">Descripcion</Label>
                <Input
                  id="team-description"
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="Descripcion del equipo"
                  disabled={!isAdmin}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="team-status">Estado</Label>
                <Select
                  value={formStatus}
                  onValueChange={(v) => setFormStatus(v as "active" | "inactive")}
                  disabled={!isAdmin}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Activo</SelectItem>
                    <SelectItem value="inactive">Inactivo</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {isAdmin && (
                <div className="pt-4">
                  <Button onClick={handleSaveGeneral} disabled={saving || !formName.trim()}>
                    {saving ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 h-4 w-4" />
                    )}
                    Guardar Cambios
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Agents Tab */}
        <TabsContent value="agents">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>Agentes del Equipo</CardTitle>
                <CardDescription>
                  {teamMembers.length} agente{teamMembers.length !== 1 ? "s" : ""} asignado{teamMembers.length !== 1 ? "s" : ""}
                </CardDescription>
              </div>
              {isAdmin && (
                <Button
                  onClick={() => {
                    setSelectedAgentId("");
                    setAddAgentDialogOpen(true);
                  }}
                  size="sm"
                >
                  <UserPlus className="mr-2 h-4 w-4" />
                  Agregar Agente
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {teamMembers.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8">
                  <div className="rounded-full bg-gray-100 p-4 mb-4">
                    <Users2 className="h-8 w-8 text-gray-400" />
                  </div>
                  <p className="text-gray-500 text-center mb-2">
                    No hay agentes en este equipo
                  </p>
                  <p className="text-sm text-gray-400 text-center">
                    Agrega agentes para que puedan atender conversaciones de este equipo.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {teamMembers.map((member) => (
                    <div
                      key={member.id}
                      className="flex items-center justify-between p-3 rounded-lg border"
                    >
                      <div className="flex items-center gap-3">
                        <div className="relative">
                          <Avatar className="h-9 w-9">
                            <AvatarImage src={member.photoURL || undefined} />
                            <AvatarFallback className="text-xs">
                              {getInitials(member.name)}
                            </AvatarFallback>
                          </Avatar>
                          <span
                            className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-white ${
                              member.isAvailable ? "bg-green-500" : "bg-gray-400"
                            }`}
                          />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium">{member.name}</p>
                            {team.assignmentMode === "round_robin" && member.id === nextAgentId && (
                              <Badge variant="outline" className="text-xs gap-1 text-blue-700 border-blue-300">
                                <RotateCw className="h-3 w-3" />
                                Siguiente turno
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-gray-500">{member.email}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {member.role === "agent" && (
                          <span className="text-xs text-gray-500">
                            {member.activeConversations} conv.
                          </span>
                        )}
                        <Badge className={`text-xs ${roleColors[member.role]}`}>
                          {roleLabels[member.role]}
                        </Badge>
                        {isAdmin && (
                          <Button
                            variant="outline"
                            size="sm"
                            className={`h-7 text-xs gap-1 ${member.isAvailable ? "text-green-700 border-green-300" : "text-gray-500"}`}
                            onClick={() => handleToggleAvailability(member.id, member.isAvailable)}
                            title="Elegible para asignación automática de conversaciones"
                          >
                            {member.isAvailable ? <UserCheck className="h-3.5 w-3.5" /> : <UserX className="h-3.5 w-3.5" />}
                            {member.isAvailable ? "Asignable" : "No asignable"}
                          </Button>
                        )}
                        {isAdmin && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                className="text-red-600"
                                onClick={() => handleRemoveAgent(member.id)}
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Quitar del equipo
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Numbers Tab */}
        <TabsContent value="numbers">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>Numeros de WhatsApp</CardTitle>
                <CardDescription>
                  {teamNumbers.length} numero{teamNumbers.length !== 1 ? "s" : ""} asignado{teamNumbers.length !== 1 ? "s" : ""}
                </CardDescription>
              </div>
              {isAdmin && (
                <Button
                  onClick={() => {
                    setSelectedNumberId("");
                    setAddNumberDialogOpen(true);
                  }}
                  size="sm"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Asignar Numero
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {teamNumbers.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8">
                  <div className="rounded-full bg-gray-100 p-4 mb-4">
                    <Phone className="h-8 w-8 text-gray-400" />
                  </div>
                  <p className="text-gray-500 text-center mb-2">
                    No hay numeros asignados a este equipo
                  </p>
                  <p className="text-sm text-gray-400 text-center">
                    Asigna numeros de WhatsApp para recibir conversaciones en este equipo.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {teamNumbers.map((num) => (
                    <div
                      key={num.id}
                      className="flex items-center justify-between p-3 rounded-lg border"
                    >
                      <div className="flex items-center gap-3">
                        <div className="rounded-full bg-green-100 p-2">
                          <Phone className="h-4 w-4 text-green-600" />
                        </div>
                        <div>
                          <p className="text-sm font-medium">
                            {num.displayName || num.phoneNumber}
                          </p>
                          {num.displayName && (
                            <p className="text-xs text-gray-500">{num.phoneNumber}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={num.status === "active" ? "default" : "secondary"}>
                          {num.status === "active" ? "Activo" : "Inactivo"}
                        </Badge>
                        {isAdmin && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                className="text-red-600"
                                onClick={() => handleRemoveNumber(num.id)}
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Quitar del equipo
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Labels Tab */}
        <TabsContent value="labels">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>Etiquetas del Equipo</CardTitle>
                <CardDescription>
                  {labels.length} etiqueta{labels.length !== 1 ? "s" : ""} configurada{labels.length !== 1 ? "s" : ""}
                </CardDescription>
              </div>
              {isAdmin && (
                <Button onClick={handleOpenCreateLabel} size="sm">
                  <Plus className="mr-2 h-4 w-4" />
                  Nueva Etiqueta
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {labels.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8">
                  <div className="rounded-full bg-gray-100 p-4 mb-4">
                    <Tag className="h-8 w-8 text-gray-400" />
                  </div>
                  <p className="text-gray-500 text-center mb-2">No hay etiquetas configuradas</p>
                  <p className="text-sm text-gray-400 text-center">
                    {isAdmin
                      ? "Crea etiquetas para clasificar las conversaciones de este equipo."
                      : "Un administrador debe crear las etiquetas para este equipo."}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {labels.map((label) => {
                    const colors = LABEL_COLORS[label.color] || LABEL_COLORS.gray;
                    return (
                      <div
                        key={label.id}
                        className="flex items-center justify-between p-3 rounded-lg border"
                      >
                        <div className="flex items-center gap-3">
                          <span className={`h-3 w-3 rounded-full ${colors.dot}`} />
                          <span
                            className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors.bg} ${colors.text}`}
                          >
                            {label.name}
                          </span>
                        </div>
                        {isAdmin && (
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => handleOpenEditLabel(label)}
                            >
                              <Pencil className="h-4 w-4 text-gray-400" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-red-500 hover:text-red-600"
                              onClick={() => handleDeleteLabel(label.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Semaphore Tab */}
        <TabsContent value="semaphore">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="h-5 w-5" />
                Semaforo de Tiempo de Espera
              </CardTitle>
              <CardDescription>
                Configura los umbrales de tiempo para el semaforo de conversaciones esperando agente.
                El icono de reloj en cada conversacion cambia de color segun el tiempo de espera.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Preview */}
              <div className="flex items-center gap-6 p-4 rounded-lg bg-muted/50">
                <div className="flex items-center gap-2">
                  <Clock className="h-5 w-5 text-green-500" />
                  <span className="text-sm">Verde: 0 a {formYellowMinutes} min</span>
                </div>
                <div className="flex items-center gap-2">
                  <Clock className="h-5 w-5 text-yellow-500" />
                  <span className="text-sm">Amarillo: {formYellowMinutes} a {formRedMinutes} min</span>
                </div>
                <div className="flex items-center gap-2">
                  <Clock className="h-5 w-5 text-red-500" />
                  <span className="text-sm">Rojo: mas de {formRedMinutes} min</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="yellow-minutes" className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-yellow-500" />
                    Verde → Amarillo (minutos)
                  </Label>
                  <Input
                    id="yellow-minutes"
                    type="number"
                    min={1}
                    max={formRedMinutes - 1}
                    value={formYellowMinutes}
                    onChange={(e) => setFormYellowMinutes(parseInt(e.target.value) || 1)}
                    disabled={!isAdmin}
                  />
                  <p className="text-xs text-gray-500">
                    Antes de este tiempo el reloj es verde.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="red-minutes" className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-red-500" />
                    Amarillo → Rojo (minutos)
                  </Label>
                  <Input
                    id="red-minutes"
                    type="number"
                    min={formYellowMinutes + 1}
                    value={formRedMinutes}
                    onChange={(e) => setFormRedMinutes(parseInt(e.target.value) || 2)}
                    disabled={!isAdmin}
                  />
                  <p className="text-xs text-gray-500">
                    A partir de este tiempo el reloj es rojo.
                  </p>
                </div>
              </div>

              {isAdmin && (
                <div className="pt-2">
                  <Button
                    onClick={handleSaveSemaphore}
                    disabled={savingSemaphore || formYellowMinutes <= 0 || formRedMinutes <= formYellowMinutes}
                  >
                    {savingSemaphore ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 h-4 w-4" />
                    )}
                    Guardar Semaforo
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Config Tab */}
        <TabsContent value="config">
          <Card>
            <CardHeader>
              <CardTitle>Configuracion Avanzada</CardTitle>
              <CardDescription>
                Modo de asignacion y limites del equipo
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="assignment-mode">Modo de asignacion</Label>
                <Select
                  value={formAssignmentMode}
                  onValueChange={(v) => setFormAssignmentMode(v as typeof formAssignmentMode)}
                  disabled={!isAdmin}
                >
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
                <p className="text-xs text-gray-500">
                  {formAssignmentMode === "least_busy" && "Las conversaciones se asignan al agente con menos conversaciones activas."}
                  {formAssignmentMode === "round_robin" && "Las conversaciones se asignan de forma rotativa entre los agentes."}
                  {formAssignmentMode === "manual" && "Las conversaciones se asignan manualmente por un administrador."}
                  {formAssignmentMode === "salesforce" && "Al transferir, la conversación pasa directo a \"Con Agente\" sin asignar a nadie. El bot deja de contestar y la asignación se hace en Salesforce."}
                </p>
              </div>

              {formAssignmentMode === "round_robin" && (
                <div className="space-y-2 rounded-lg border p-4 bg-muted/30">
                  <Label className="flex items-center gap-2">
                    <RotateCw className="h-4 w-4" />
                    Turno de Round Robin
                  </Label>
                  {eligibleForAssignment.length === 0 ? (
                    <p className="text-xs text-gray-500">
                      No hay agentes marcados como &quot;Asignable&quot; en este equipo — las conversaciones quedaran pendientes.
                    </p>
                  ) : (
                    <>
                      <p className="text-xs text-gray-500">
                        Orden de rotación entre los agentes asignables. Se actualiza en tiempo real con cada asignación.
                      </p>
                      <div className="flex flex-wrap gap-2 pt-1">
                        {eligibleForAssignment.map((m, i) => (
                          <Badge
                            key={m.id}
                            variant={m.id === nextAgentId ? "default" : "outline"}
                            className={`text-xs gap-1 ${m.id === nextAgentId ? "bg-blue-600 hover:bg-blue-600" : ""}`}
                          >
                            {i + 1}. {m.name}
                            {m.id === nextAgentId && " ← sigue"}
                          </Badge>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="max-conversations">Max conversaciones por agente</Label>
                <Input
                  id="max-conversations"
                  type="number"
                  min={1}
                  max={50}
                  value={formMaxConversations}
                  placeholder="Sin tope"
                  onChange={(e) => setFormMaxConversations(e.target.value)}
                  disabled={!isAdmin}
                />
                <p className="text-xs text-gray-500">
                  Numero maximo de conversaciones simultaneas que puede atender un agente. Vacio = sin tope.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="opt-out-action">Cuando el cliente escribe &quot;stop&quot;</Label>
                <Select
                  value={formOptOutAction}
                  onValueChange={(v) => setFormOptOutAction(v as "close" | "handoff")}
                  disabled={!isAdmin}
                >
                  <SelectTrigger id="opt-out-action">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="close">Cerrar la conversación</SelectItem>
                    <SelectItem value="handoff">Pasar a un agente</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-gray-500">
                  Qué hace la plataforma cuando el cliente escribe stop.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Conversaciones activas</Label>
                <div>
                  <Badge variant="outline" className="text-sm">
                    {team.activeConversations || 0} conversaciones activas
                  </Badge>
                </div>
              </div>
              {isAdmin && (
                <div className="pt-4">
                  <Button onClick={handleSaveConfig} disabled={saving}>
                    {saving ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 h-4 w-4" />
                    )}
                    Guardar Configuracion
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Add Agent Dialog */}
      <Dialog open={addAgentDialogOpen} onOpenChange={setAddAgentDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Agregar Agente al Equipo</DialogTitle>
            <DialogDescription>
              Selecciona un agente para agregarlo a {team.name}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {availableMembers.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">
                No hay agentes disponibles para agregar.
              </p>
            ) : (
              <div className="space-y-2">
                <Label>Agente</Label>
                <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecciona un agente" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableMembers.map((member) => (
                      <SelectItem key={member.id} value={member.id}>
                        {member.name} ({member.email})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddAgentDialogOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={handleAddAgent}
              disabled={!selectedAgentId || availableMembers.length === 0}
            >
              Agregar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Number Dialog */}
      <Dialog open={addNumberDialogOpen} onOpenChange={setAddNumberDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Asignar Numero al Equipo</DialogTitle>
            <DialogDescription>
              Selecciona un numero de WhatsApp para asignarlo a {team.name}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {availableNumbers.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">
                No hay numeros disponibles para asignar.
              </p>
            ) : (
              <div className="space-y-2">
                <Label>Numero de WhatsApp</Label>
                <Select value={selectedNumberId} onValueChange={setSelectedNumberId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecciona un numero" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableNumbers.map((num) => (
                      <SelectItem key={num.id} value={num.id}>
                        {num.displayName || num.phoneNumber}
                        {num.displayName ? ` (${num.phoneNumber})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddNumberDialogOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={handleAddNumber}
              disabled={!selectedNumberId || availableNumbers.length === 0}
            >
              Asignar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Label Dialog */}
      <Dialog open={labelDialogOpen} onOpenChange={setLabelDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingLabel ? "Editar Etiqueta" : "Nueva Etiqueta"}</DialogTitle>
            <DialogDescription>
              {editingLabel ? "Modifica el nombre o color de la etiqueta." : "Crea una nueva etiqueta para clasificar conversaciones de este equipo."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Nombre</Label>
              <Input
                value={labelName}
                onChange={(e) => setLabelName(e.target.value)}
                placeholder="Ej: Urgente, Seguimiento, VIP..."
                maxLength={30}
              />
            </div>
            <div className="space-y-2">
              <Label>Color</Label>
              <div className="flex flex-wrap gap-2">
                {LABEL_COLOR_OPTIONS.map((colorKey) => {
                  const colors = LABEL_COLORS[colorKey];
                  return (
                    <button
                      key={colorKey}
                      onClick={() => setLabelColor(colorKey)}
                      className={`h-7 w-7 rounded-full ${colors.dot} transition-transform ${labelColor === colorKey ? "ring-2 ring-offset-2 ring-gray-400 scale-110" : "hover:scale-105"}`}
                      title={colorKey}
                    />
                  );
                })}
              </div>
              {labelName && (
                <div className="pt-2">
                  <span className="text-xs text-gray-500 mr-2">Vista previa:</span>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${LABEL_COLORS[labelColor]?.bg} ${LABEL_COLORS[labelColor]?.text}`}>
                    {labelName}
                  </span>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLabelDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleSaveLabel} disabled={savingLabel || !labelName.trim()}>
              {savingLabel ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {editingLabel ? "Guardar Cambios" : "Crear Etiqueta"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
