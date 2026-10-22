import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { verifyAuthToken } from "@/lib/auth-middleware";
import { authorizeOrg, isReadOnlySoql } from "@/lib/authz";
import { getSalesforceCredentials, getSalesforceToken } from "@/lib/salesforce-env";

export async function POST(request: NextRequest) {
  try {
    const authUser = await verifyAuthToken(request);
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { soql, organizationId, vertical } = await request.json();

    if (!soql || !organizationId) {
      return NextResponse.json(
        { error: "soql y organizationId son requeridos" },
        { status: 400 }
      );
    }

    // Cualquier miembro de la organización puede consultar (los paneles de la bandeja lo usan), pero solo
    // lectura: con credenciales globales de Salesforce, una escritura o un `;` sería un riesgo para todas las marcas.
    const denied = await authorizeOrg(authUser.uid, organizationId);
    if (denied) return denied;
    if (!isReadOnlySoql(soql)) {
      return NextResponse.json({ error: "Solo se permiten consultas SELECT de una sentencia" }, { status: 400 });
    }

    // Get org's Salesforce config
    const orgDoc = await adminDb.collection("organizations").doc(organizationId).get();
    if (!orgDoc.exists) {
      return NextResponse.json({ error: "Organizacion no encontrada" }, { status: 404 });
    }

    const sfCreds = getSalesforceCredentials(vertical);
    if (!sfCreds) {
      return NextResponse.json(
        { error: "Salesforce no configurado (variables SF_*)" },
        { status: 400 }
      );
    }

    const { accessToken, instanceUrl } = await getSalesforceToken(sfCreds);

    const queryRes = await fetch(
      `${instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!queryRes.ok) {
      const err = await queryRes.json().catch(() => []);
      const msg = Array.isArray(err) ? err[0]?.message : "Error al consultar Salesforce";
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    const result = await queryRes.json();
    return NextResponse.json({ records: result.records || [], totalSize: result.totalSize });
  } catch (error) {
    console.error("Salesforce query error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error de conexion con Salesforce" },
      { status: 500 }
    );
  }
}
