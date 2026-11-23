"use client";

/**
 * Pestaña "ChatLLM" de un bot: lo que Abacus AI tiene configurado (deployment, modelo, tools, retriever e instrucciones).
 * La comparten la pantalla de Bots de Ventas y Servicio (Firestore, ruta /api/abacus-config) y la de Valuación (hub_cleber,
 * lib/hub/abacus.ts). Es solo presentación: recibe el resultado de lib/abacus-config.ts.
 */

import { Brain, FileText, RefreshCw, Search, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function ChatLLMConfigView({ config, onRefresh }: { config: Record<string, unknown>; onRefresh: () => void }) {
  const deployment = config.deployment as Record<string, unknown> || {};
  const model = config.model as Record<string, unknown> || {};
  const cfg = config.config as Record<string, unknown> || {};
  const retriever = config.documentRetriever as Record<string, unknown> | null;
  const bestAlgorithm = model.bestAlgorithm as Record<string, string> || {};
  const deployableAlgorithms = model.deployableAlgorithms as Array<Record<string, string>> || [];
  const customTools = cfg.customTools as string[] || [];
  const builtinTools = cfg.builtinTools as string[] || [];
  const documentRetrievers = cfg.documentRetrievers as string[] || [];

  const statusColors: Record<string, string> = {
    ACTIVE: "bg-green-100 text-green-800",
    STOPPED: "bg-red-100 text-red-800",
    PENDING: "bg-yellow-100 text-yellow-800",
    COMPLETE: "bg-green-100 text-green-800",
  };

  return (
    <div className="space-y-4">
      {/* Deployment & Model Info */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Brain className="h-5 w-5" />
              Deployment y Modelo
            </CardTitle>
            <CardDescription>
              Informacion del deployment y modelo LLM en Abacus AI
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCw className="mr-2 h-3 w-3" />
            Actualizar
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
              <div>
                <p className="text-xs text-gray-500">Deployment</p>
                <p className="text-sm font-medium">{deployment.name as string}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Status</p>
                <Badge className={statusColors[deployment.status as string] || "bg-gray-100 text-gray-800"}>
                  {deployment.status as string}
                </Badge>
              </div>
              <div>
                <p className="text-xs text-gray-500">Modelo desplegado</p>
                <p className="text-sm font-medium">{deployment.algoName as string}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Region</p>
                <p className="text-sm">{deployment.region as string}</p>
              </div>
            </div>
            <div className="space-y-3">
              <div>
                <p className="text-xs text-gray-500">Mejor algoritmo (entrenamiento)</p>
                <p className="text-sm font-medium">{bestAlgorithm.name}</p>
                <p className="text-xs text-gray-400">{bestAlgorithm.llmName}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Entrenamiento</p>
                <Badge className={statusColors[model.trainingStatus as string] || "bg-gray-100 text-gray-800"}>
                  {model.trainingStatus as string}
                </Badge>
              </div>
              <div>
                <p className="text-xs text-gray-500">Modelos disponibles</p>
                <div className="flex flex-wrap gap-1 mt-1">
                  {deployableAlgorithms.map((algo, i) => (
                    <Badge key={algo.llmName || i} variant="outline" className="text-xs">
                      {algo.name}
                    </Badge>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs text-gray-500">Auto-deploy</p>
                <p className="text-sm">{deployment.autoDeploy ? "Activado" : "Desactivado"}</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tools */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wrench className="h-5 w-5" />
            Tools
          </CardTitle>
          <CardDescription>
            Herramientas configuradas en el modelo
          </CardDescription>
        </CardHeader>
        <CardContent>
          {customTools.length === 0 && builtinTools.length === 0 ? (
            <p className="text-sm text-gray-500">No hay tools configurados</p>
          ) : (
            <div className="space-y-2">
              {customTools.map((tool) => (
                <div key={tool} className="flex items-center gap-2 p-2 rounded border">
                  <Badge variant="secondary" className="text-xs">Custom</Badge>
                  <span className="text-sm font-mono">{tool}</span>
                </div>
              ))}
              {builtinTools.map((tool) => (
                <div key={tool} className="flex items-center gap-2 p-2 rounded border">
                  <Badge variant="outline" className="text-xs">Builtin</Badge>
                  <span className="text-sm font-mono">{tool}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Document Retriever */}
      {retriever && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Search className="h-5 w-5" />
              Document Retriever
            </CardTitle>
            <CardDescription>
              Configuracion de busqueda de documentos
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-gray-500">Nombre</p>
                  <p className="text-sm font-medium">{retriever.name as string}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Feature Group</p>
                  <p className="text-sm">{retriever.featureGroupName as string}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Chunks</p>
                  <p className="text-sm">{retriever.numberOfChunks as number} chunks indexados</p>
                </div>
              </div>
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-gray-500">Chunk Size</p>
                  <p className="text-sm">{retriever.chunkSize as number} tokens</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Overlap</p>
                  <p className="text-sm">{((retriever.chunkOverlapFraction as number) * 100)}%</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Encoder</p>
                  <p className="text-sm">{retriever.textEncoder as string}</p>
                </div>
              </div>
            </div>
            {documentRetrievers.length > 0 && (
              <div className="mt-3 pt-3 border-t">
                <p className="text-xs text-gray-500 mb-1">Retrievers activos</p>
                <div className="flex flex-wrap gap-1">
                  {documentRetrievers.map((r) => (
                    <Badge key={r} variant="outline" className="text-xs">{r}</Badge>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Behavior Instructions */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Instrucciones de Comportamiento
          </CardTitle>
          <CardDescription>
            System prompt principal del modelo
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="whitespace-pre-wrap text-sm bg-gray-50 p-4 rounded-lg border max-h-96 overflow-y-auto font-mono leading-relaxed">
            {cfg.behaviorInstructions as string || "Sin instrucciones configuradas"}
          </pre>
        </CardContent>
      </Card>

      {/* Response Instructions */}
      <Card>
        <CardHeader>
          <CardTitle>Instrucciones de Respuesta</CardTitle>
          <CardDescription>
            Como debe formatear las respuestas
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="whitespace-pre-wrap text-sm bg-gray-50 p-4 rounded-lg border max-h-64 overflow-y-auto font-mono leading-relaxed">
            {cfg.responseInstructions as string || "Sin instrucciones configuradas"}
          </pre>
        </CardContent>
      </Card>

      {/* Unknown Answer Phrase */}
      <Card>
        <CardHeader>
          <CardTitle>Frase de Respuesta Desconocida</CardTitle>
          <CardDescription>
            Respuesta cuando el modelo no encuentra informacion relevante
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="bg-gray-50 p-4 rounded-lg border">
            <p className="text-sm italic">
              {cfg.unknownAnswerPhrase as string || "Sin frase configurada"}
            </p>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <span className="text-xs text-gray-500">Conocimiento general:</span>
            <Badge variant={cfg.includeGeneralKnowledge ? "default" : "secondary"}>
              {cfg.includeGeneralKnowledge ? "Activado" : "Desactivado"}
            </Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
