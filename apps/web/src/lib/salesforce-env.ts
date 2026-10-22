/**
 * Credenciales de Salesforce desde variables de entorno (ya no viven en organizations/{id}.salesforceConfig).
 * Globales: SF_INSTANCE_URL, SF_CLIENT_ID, SF_CLIENT_SECRET, SF_USERNAME, SF_PASSWORD.
 * Override por módulo: SF_<MODULO>_INSTANCE_URL, etc. (p. ej. SF_VENTAS_USERNAME).
 */
export interface SalesforceCredentials {
  instanceUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

export function getSalesforceCredentials(moduleId?: string | null): SalesforceCredentials | null {
  const prefix = moduleId && moduleId !== "general" ? `SF_${moduleId.toUpperCase()}_` : null;
  const read = (key: string) => (prefix ? process.env[`${prefix}${key}`] : undefined) || process.env[`SF_${key}`] || "";
  const creds = {
    instanceUrl: read("INSTANCE_URL"),
    clientId: read("CLIENT_ID"),
    clientSecret: read("CLIENT_SECRET"),
    username: read("USERNAME"),
    password: read("PASSWORD"),
  };
  return Object.values(creds).every(Boolean) ? creds : null;
}

export async function getSalesforceToken(
  creds: SalesforceCredentials
): Promise<{ accessToken: string; instanceUrl: string }> {
  const res = await fetch(`${creds.instanceUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      username: creds.username,
      password: creds.password,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error_description || "Salesforce auth failed");
  }
  const data = await res.json();
  return { accessToken: data.access_token, instanceUrl: data.instance_url };
}
