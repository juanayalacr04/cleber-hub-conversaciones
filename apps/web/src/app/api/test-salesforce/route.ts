import { NextRequest, NextResponse } from "next/server";
import { verifyAuthToken } from "@/lib/auth-middleware";
import { authorizeOrg } from "@/lib/authz";
import { getSalesforceCredentials, getSalesforceToken } from "@/lib/salesforce-env";

/** Prueba la conexión a Salesforce con las credenciales del servidor (SF_*, con override por módulo). */
export async function POST(request: NextRequest) {
  try {
    const authUser = await verifyAuthToken(request);
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { organizationId, vertical } = await request.json();
    const denied = await authorizeOrg(authUser.uid, organizationId, { admin: true });
    if (denied) return denied;

    const creds = getSalesforceCredentials(vertical);
    if (!creds) {
      return NextResponse.json({ error: "Las credenciales de Salesforce (SF_*) no están configuradas en el servidor" }, { status: 400 });
    }
    await getSalesforceToken(creds);
    return NextResponse.json({ success: true });
  } catch (error) {
    // No se devuelve el detalle: puede incluir datos de la conexión
    console.error("Error probando la conexión a Salesforce:", error);
    return NextResponse.json({ error: "No se pudo autenticar con Salesforce. Revisa las variables SF_* del servidor." }, { status: 400 });
  }
}
