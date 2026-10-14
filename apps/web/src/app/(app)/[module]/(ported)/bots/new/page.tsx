"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Loader2, Save, Eye, EyeOff } from "lucide-react";
import { db } from "@/lib/firebase";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { useAuth } from "@/contexts/AuthContext";
import Link from "next/link";
import { getModule } from "@/lib/modules";
import { modulePath } from "@/lib/routes";

export default function NewBotPage() {
  const router = useRouter();
  const { module: moduleId } = useParams<{ module: string }>();
  const moduleVertical = getModule(moduleId)?.vertical ?? null;
  const { userData, organizations: authOrgs } = useAuth();
  const [saving, setSaving] = useState(false);
  const [formOrgId, setFormOrgId] = useState("");
  const [showAbacusToken, setShowAbacusToken] = useState(false);

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // En `general` el módulo se elige; en un módulo concreto queda fijo.
  const [chosenVertical, setChosenVertical] = useState<"servicio" | "ventas" | "">("");
  const [botType, setBotType] = useState<"chatllm" | "workflow" | "vertex_ai" | "external">("chatllm");
  const [vertexAiEndpoint, setVertexAiEndpoint] = useState("");
  const [externalEndpoint, setExternalEndpoint] = useState("");
  const [externalApiKey, setExternalApiKey] = useState("");
  const [showExternalApiKey, setShowExternalApiKey] = useState(false);
  const [abacusDeploymentId, setAbacusDeploymentId] = useState("");
  const [abacusDeploymentToken, setAbacusDeploymentToken] = useState("");
  const [handoffEnabled, setHandoffEnabled] = useState(false);
  const [handoffKeywords, setHandoffKeywords] = useState("");

  const handleCreate = async () => {
    const orgId = (userData?.isSuperAdmin && formOrgId) ? formOrgId : userData?.organizationId;
    const vertical = moduleVertical ?? (chosenVertical || null);
    if (!name.trim() || !orgId || !vertical) return;

    setSaving(true);
    try {
      const docRef = await addDoc(collection(db, "bots"), {
        name: name.trim(),
        description: description.trim(),
        type: botType,
        vertical,
        category: vertical === "servicio" ? "Servicio" : "Ventas",
        status: "active",
        organizationId: orgId,
        twilioConfig: {
          phoneNumber: "",
          accountSid: "",
          authToken: "",
        },
        abacusConfig: {
          apiUrl: "",
          deploymentId: abacusDeploymentId.trim(),
          deploymentToken: abacusDeploymentToken.trim(),
        },
        ...(botType === "vertex_ai" && vertexAiEndpoint ? {
          vertexAiConfig: {
            endpoint: vertexAiEndpoint.trim(),
          },
        } : {}),
        ...(botType === "external" && externalEndpoint ? {
          externalConfig: {
            endpoint: externalEndpoint.trim(),
            ...(externalApiKey.trim() ? { apiKey: externalApiKey.trim() } : {}),
          },
        } : {}),
        handoffConfig: {
          enabled: handoffEnabled,
          triggerKeywords: handoffKeywords
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean),
        },
        createdAt: serverTimestamp(),
      });
      router.push(modulePath(moduleId, `/bots/${docRef.id}`));
    } catch (error) {
      console.error("Error creating bot:", error);
      alert("Error al crear el bot");
    } finally {
      setSaving(false);
    }
  };

  if (!userData?.organizationId) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Necesitas pertenecer a una organizacion para crear bots.</p>
        <Link href={modulePath(moduleId, "/bots")}>
          <Button variant="link">Volver a Bots</Button>
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-8">
        <Link href={modulePath(moduleId, "/bots")}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Crear Bot</h1>
          <p className="text-gray-500">Configura un nuevo chatbot de WhatsApp</p>
        </div>
        <Button onClick={handleCreate} disabled={saving || !name.trim() || !(moduleVertical || chosenVertical)}>
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Crear Bot
        </Button>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Informacion General</CardTitle>
            <CardDescription>Nombre y descripcion de tu bot</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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
              <Label htmlFor="name">Nombre del Bot</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ej: Bot de Ventas"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Descripcion</Label>
              <Input
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Ej: Bot para atencion de clientes de ventas"
              />
            </div>
            {!moduleVertical && (
              <div className="space-y-2">
                <Label htmlFor="vertical">Modulo</Label>
                <Select value={chosenVertical} onValueChange={(v) => setChosenVertical(v as "servicio" | "ventas")}>
                  <SelectTrigger id="vertical">
                    <SelectValue placeholder="Seleccionar modulo" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="servicio">Servicio</SelectItem>
                    <SelectItem value="ventas">Ventas</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Configuracion de IA</CardTitle>
            <CardDescription>Tipo de bot y credenciales del motor de IA</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="botType">Tipo de Bot</Label>
              <Select value={botType} onValueChange={(v) => setBotType(v as "chatllm" | "workflow" | "vertex_ai" | "external")}>
                <SelectTrigger id="botType">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="chatllm">ChatLLM</SelectItem>
                  <SelectItem value="workflow">AI Workflow</SelectItem>
                  <SelectItem value="vertex_ai">Vertex AI</SelectItem>
                  <SelectItem value="external">Bot Externo (HTTP)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-500">
                ChatLLM usa getConversationResponse. AI Workflow usa executeSyncConversationAgent. Vertex AI y Bot Externo (HTTP) llaman a un endpoint que implementa el contrato de la plataforma.
              </p>
            </div>
            {!["vertex_ai", "external"].includes(botType) && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="abacusDeploymentId">Deployment ID</Label>
                  <Input
                    id="abacusDeploymentId"
                    value={abacusDeploymentId}
                    onChange={(e) => setAbacusDeploymentId(e.target.value)}
                    placeholder="xxxxxxxxx"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="abacusDeploymentToken">Deployment Token</Label>
                  <div className="relative">
                    <Input
                      id="abacusDeploymentToken"
                      type={showAbacusToken ? "text" : "password"}
                      value={abacusDeploymentToken}
                      onChange={(e) => setAbacusDeploymentToken(e.target.value)}
                      placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7"
                      onClick={() => setShowAbacusToken(!showAbacusToken)}
                    >
                      {showAbacusToken ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </>
            )}
            {botType === "vertex_ai" && (
              <div className="space-y-2">
                <Label htmlFor="vertexAiEndpoint">Endpoint del Bot</Label>
                <Input
                  id="vertexAiEndpoint"
                  value={vertexAiEndpoint}
                  onChange={(e) => setVertexAiEndpoint(e.target.value)}
                  placeholder="https://us-central1-PROJECT.cloudfunctions.net/toyota-bot-vertex-ai"
                />
                <p className="text-xs text-gray-500">
                  URL del Cloud Function o Cloud Run que ejecuta el bot con Vertex AI.
                </p>
              </div>
            )}
            {botType === "external" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="externalEndpoint">Endpoint del Bot Externo</Label>
                  <Input
                    id="externalEndpoint"
                    value={externalEndpoint}
                    onChange={(e) => setExternalEndpoint(e.target.value)}
                    placeholder="https://api.mi-agente.com/webhook"
                  />
                  <p className="text-xs text-gray-500">
                    URL del agente externo (ej. Openclaw, Hermes) que implementa el contrato HTTP de la plataforma.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="externalApiKey">API Key (opcional)</Label>
                  <div className="relative">
                    <Input
                      id="externalApiKey"
                      type={showExternalApiKey ? "text" : "password"}
                      value={externalApiKey}
                      onChange={(e) => setExternalApiKey(e.target.value)}
                      placeholder="Se envía como Authorization: Bearer ..."
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7"
                      onClick={() => setShowExternalApiKey(!showExternalApiKey)}
                    >
                      {showExternalApiKey ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <p className="text-xs text-gray-500">
                    Si se configura, se envía en el header <code>Authorization: Bearer</code> a cada request del bot.
                  </p>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Configuracion de Handoff</CardTitle>
            <CardDescription>Configura cuando el bot debe transferir a un agente humano</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="handoffEnabled"
                checked={handoffEnabled}
                onChange={(e) => setHandoffEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              <Label htmlFor="handoffEnabled">Habilitar handoff a agentes</Label>
            </div>
            {handoffEnabled && (
              <div className="space-y-2">
                <Label htmlFor="handoffKeywords">Palabras clave para handoff</Label>
                <Input
                  id="handoffKeywords"
                  value={handoffKeywords}
                  onChange={(e) => setHandoffKeywords(e.target.value)}
                  placeholder="hablar con humano, asesor, agente"
                />
                <p className="text-xs text-gray-500">
                  Separadas por comas. Cuando el cliente escriba alguna de estas palabras, se transferira a un agente.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
