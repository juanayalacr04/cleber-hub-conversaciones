import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { verifyAuthToken } from "@/lib/auth-middleware";
import { authorizeOrg } from "@/lib/authz";
import { getSalesforceCredentials, getSalesforceToken } from "@/lib/salesforce-env";

export interface SFTemplate {
  id: string;
  name: string;
  uniqueName: string;
  messageBody: string;
  structure: string;
  objectApiName: string;
}

export async function GET(request: NextRequest) {
  const authUser = await verifyAuthToken(request);
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const organizationId = searchParams.get("organizationId");

  if (!organizationId) {
    return NextResponse.json({ error: "organizationId is required" }, { status: 400 });
  }

  const denied = await authorizeOrg(authUser.uid, organizationId, { write: true });
  if (denied) return denied;

  const orgDoc = await adminDb.collection("organizations").doc(organizationId).get();
  if (!orgDoc.exists) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  const orgData = orgDoc.data()!;
  const sfBrandCode = orgData.sfBrandCode;

  const sfCreds = getSalesforceCredentials(searchParams.get("vertical"));
  if (!sfCreds) {
    return NextResponse.json({ error: "Salesforce no configurado (variables SF_*)" }, { status: 400 });
  }

  if (!sfBrandCode) {
    return NextResponse.json({ error: "sfBrandCode not configured for this organization" }, { status: 400 });
  }

  const { accessToken, instanceUrl } = await getSalesforceToken(sfCreds);

  const vertical = searchParams.get("vertical");
  const area = vertical === "ventas" ? "Ventas" : "Servicio";
  const soql = `SELECT Name, rsplus__Template_name__c, rsplus__Object_API_Name__c, rsplus__WA_template_unique_nam__c, rsplus__WA_template_structure__c, rsplus__Message_Body__c FROM rsplus__RSP_Templates__c WHERE rsplus__Inactive__c = false AND Marca__c = '${sfBrandCode}' AND Area__c = '${area}'`;

  const res = await fetch(
    `${instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!res.ok) {
    const err = await res.text();
    return NextResponse.json({ error: `Salesforce query failed: ${err}` }, { status: 500 });
  }

  const data = await res.json();
  const templates: SFTemplate[] = (data.records || []).map((r: Record<string, string>) => ({
    id: r.Name,
    name: r.rsplus__Template_name__c || r.Name,
    uniqueName: r.rsplus__WA_template_unique_nam__c || "",
    messageBody: r.rsplus__Message_Body__c || "",
    structure: r.rsplus__WA_template_structure__c || "",
    objectApiName: r.rsplus__Object_API_Name__c || "",
  }));

  return NextResponse.json({ templates });
}
