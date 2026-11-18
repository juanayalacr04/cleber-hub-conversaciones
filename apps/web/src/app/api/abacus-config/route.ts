import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { verifyAuthToken } from "@/lib/auth-middleware";
import { authorizeOrg } from "@/lib/authz";
import { cargaConfigAbacus } from "@/lib/abacus-config";

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

    const config = await cargaConfigAbacus(deploymentId);
    if (!config.ok) {
      return NextResponse.json({ error: config.error }, { status: config.status });
    }
    return NextResponse.json({ success: true, result: config.result });
  } catch (error) {
    console.error("Error fetching Abacus config:", error);
    return NextResponse.json(
      { error: "Failed to fetch Abacus configuration" },
      { status: 500 }
    );
  }
}
