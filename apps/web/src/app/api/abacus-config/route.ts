import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { verifyAuthToken } from "@/lib/auth-middleware";
import { authorizeOrg } from "@/lib/authz";

const ABACUS_API_KEY = process.env.ABACUS_API_KEY;
const ABACUS_API_BASE = "https://api.abacus.ai/api/v0";

async function abacusFetch(endpoint: string, params: Record<string, string> = {}) {
  const url = new URL(`${ABACUS_API_BASE}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { apiKey: ABACUS_API_KEY || "" },
  });

  return res.json();
}

export async function GET(request: NextRequest) {
  try {
    const authUser = await verifyAuthToken(request);
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const botId = searchParams.get("botId");

    if (!botId) {
      return NextResponse.json(
        { error: "Missing required parameter: botId" },
        { status: 400 }
      );
    }

    if (!ABACUS_API_KEY) {
      return NextResponse.json(
        { error: "ABACUS_API_KEY not configured on server" },
        { status: 500 }
      );
    }

    // Get bot config from Firestore to find deploymentId
    const botDoc = await adminDb.collection("bots").doc(botId).get();
    if (!botDoc.exists) {
      return NextResponse.json({ error: "Bot not found" }, { status: 404 });
    }

    const botData = botDoc.data();
    const denied = await authorizeOrg(authUser.uid, botData?.organizationId, { admin: true });
    if (denied) return denied;
    const deploymentId = botData?.abacusConfig?.deploymentId;

    if (!deploymentId) {
      return NextResponse.json(
        { error: "Bot does not have an Abacus deployment configured" },
        { status: 400 }
      );
    }

    // Fetch deployment info
    const deploymentRes = await abacusFetch("describeDeployment", { deploymentId });
    if (!deploymentRes.success) {
      return NextResponse.json(
        { error: deploymentRes.error || "Failed to fetch deployment" },
        { status: 502 }
      );
    }

    const deployment = deploymentRes.result;

    // Fetch model info
    let model = null;
    if (deployment.modelId) {
      const modelRes = await abacusFetch("describeModel", { modelId: deployment.modelId });
      if (modelRes.success) {
        model = modelRes.result;
      }
    }

    // Fetch document retriever info
    let documentRetriever = null;
    const retrieverIds = model?.documentRetrieverIds;
    if (retrieverIds && retrieverIds.length > 0) {
      const retrieverRes = await abacusFetch("describeDocumentRetriever", {
        documentRetrieverId: retrieverIds[0],
      });
      if (retrieverRes.success) {
        documentRetriever = retrieverRes.result;
      }
    }

    // Extract the important config from model
    const modelConfig = model?.modelConfig || model?.latestModelVersion?.modelConfig || {};
    const latestVersion = model?.latestModelVersion || {};
    const bestAlgorithm = latestVersion.bestAlgorithm || {};
    const deployableAlgorithms = latestVersion.deployableAlgorithms || [];
    const retrieverConfig = documentRetriever?.latestDocumentRetrieverVersion?.resolvedConfig || {};

    return NextResponse.json({
      success: true,
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
    });
  } catch (error) {
    console.error("Error fetching Abacus config:", error);
    return NextResponse.json(
      { error: "Failed to fetch Abacus configuration" },
      { status: 500 }
    );
  }
}
