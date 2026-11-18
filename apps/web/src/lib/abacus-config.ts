/**
 * Lo que Abacus AI tiene configurado para un deployment: el deployment, su modelo y el Document Retriever. Solo servidor.
 *
 * La usan la ruta /api/abacus-config (bots de Ventas y Servicio, en Firestore) y lib/hub/abacus.ts (bots de Valuación, en
 * hub_cleber). Cada una resuelve el `deploymentId` y los permisos a su manera; aquí solo se le pregunta a Abacus, con la llave
 * ABACUS_API_KEY del servidor web (no es la del secreto de las Lambdas del hub).
 */

const ABACUS_API_BASE = "https://api.abacus.ai/api/v0";

async function abacusFetch(endpoint: string, params: Record<string, string> = {}) {
  const url = new URL(`${ABACUS_API_BASE}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { method: "GET", headers: { apiKey: process.env.ABACUS_API_KEY || "" } });
  return res.json();
}

export type ResultadoConfigAbacus =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string; status: number };

export async function cargaConfigAbacus(deploymentId: string): Promise<ResultadoConfigAbacus> {
  if (!process.env.ABACUS_API_KEY) {
    return { ok: false, error: "ABACUS_API_KEY not configured on server", status: 500 };
  }

  const deploymentRes = await abacusFetch("describeDeployment", { deploymentId });
  if (!deploymentRes.success) {
    return { ok: false, error: deploymentRes.error || "Failed to fetch deployment", status: 502 };
  }
  const deployment = deploymentRes.result;

  let model = null;
  if (deployment.modelId) {
    const modelRes = await abacusFetch("describeModel", { modelId: deployment.modelId });
    if (modelRes.success) model = modelRes.result;
  }

  let documentRetriever = null;
  const retrieverIds = model?.documentRetrieverIds;
  if (retrieverIds && retrieverIds.length > 0) {
    const retrieverRes = await abacusFetch("describeDocumentRetriever", { documentRetrieverId: retrieverIds[0] });
    if (retrieverRes.success) documentRetriever = retrieverRes.result;
  }

  const modelConfig = model?.modelConfig || model?.latestModelVersion?.modelConfig || {};
  const latestVersion = model?.latestModelVersion || {};
  const bestAlgorithm = latestVersion.bestAlgorithm || {};
  const deployableAlgorithms = latestVersion.deployableAlgorithms || [];
  const retrieverConfig = documentRetriever?.latestDocumentRetrieverVersion?.resolvedConfig || {};

  return {
    ok: true,
    result: {
      deployment: {
        deploymentId: deployment.deploymentId,
        name: deployment.name,
        status: deployment.status,
        algoName: deployment.algoName,
        region: deployment.regions?.[0]?.name || "N/A",
        autoDeploy: deployment.autoDeploy,
        createdAt: deployment.createdAt,
      },
      model: {
        modelId: model?.modelId,
        name: model?.name,
        bestAlgorithm: {
          name: bestAlgorithm.name,
          llmName: bestAlgorithm.llm_name || bestAlgorithm.llmName,
        },
        deployableAlgorithms: deployableAlgorithms.map((a: { name: string; llmName?: string; llm_name?: string }) => ({
          name: a.name,
          llmName: a.llmName || a.llm_name,
        })),
        trainingStatus: latestVersion.status,
        trainedAt: latestVersion.trainingCompletedAt,
      },
      config: {
        behaviorInstructions: modelConfig.BEHAVIOR_INSTRUCTIONS || "",
        responseInstructions: modelConfig.RESPONSE_INSTRUCTIONS || "",
        unknownAnswerPhrase: modelConfig.UNKNOWN_ANSWER_PHRASE || "",
        includeGeneralKnowledge: modelConfig.INCLUDE_GENERAL_KNOWLEDGE || false,
        customTools: modelConfig.CUSTOM_TOOLS || [],
        builtinTools: modelConfig.BUILTIN_TOOLS || [],
        mcpServers: modelConfig.MCP_SERVERS || [],
        documentRetrievers: modelConfig.DOCUMENT_RETRIEVERS || [],
      },
      documentRetriever: documentRetriever
        ? {
            name: documentRetriever.name,
            featureGroupName: documentRetriever.featureGroupName,
            numberOfChunks: documentRetriever.latestDocumentRetrieverVersion?.numberOfChunks,
            chunkSize: retrieverConfig.chunkSize,
            chunkOverlapFraction: retrieverConfig.chunkOverlapFraction,
            textEncoder: retrieverConfig.textEncoder,
            status: documentRetriever.latestDocumentRetrieverVersion?.status,
          }
        : null,
      refreshSchedules: model?.refreshSchedules || [],
    },
  };
}
