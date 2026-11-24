/**
 * Salesforce auth for the Functions. Two tokens:
 *   - core token: OAuth client-credentials against the core org (Apex REST Knowledge endpoint,
 *     /ssot provisioning: schema, DLO, stream, DMO, search index, retriever)
 *   - CDP token: core token exchanged at /services/a360/token, used against the tenant-specific
 *     endpoint for the Ingestion API (/api/v1/ingest/...)
 *
 * Every outbound host must also be listed in the manifest's allowNetworks.
 */
import type { FunctionEventContext } from '@contentful/node-apps-toolkit';

export const SSOT_API_VERSION = 'v68.0';

export type SfParams = {
  instanceUrl: string;
  clientId: string;
  clientSecret: string;
  // Label of the Ingestion API connection (the {source} segment of /api/v1/ingest/sources/...).
  ingestSourceName: string;
  dataSpace: string;
};

export function readSfParams(context: FunctionEventContext): SfParams {
  const p = (context.appInstallationParameters ?? {}) as Record<string, string | undefined>;
  return {
    instanceUrl: (p.SF_INSTANCE_URL ?? '').replace(/\/+$/, ''),
    clientId: p.SF_CLIENT_ID ?? '',
    clientSecret: p.SF_CLIENT_SECRET ?? '',
    ingestSourceName: p.D360_INGEST_SOURCE_NAME || 'Contentful',
    dataSpace: p.D360_DATASPACE || 'default',
  };
}

export function missingSfParams(params: SfParams): string | null {
  const missing = (['instanceUrl', 'clientId', 'clientSecret'] as const).filter((k) => !params[k]);
  return missing.length ? `Salesforce connection is not configured on this app installation (missing ${missing.join(', ')}).` : null;
}

export type SfSession = { instanceUrl: string; accessToken: string };
export type CdpSession = { tenantUrl: string; accessToken: string };

async function postForm(url: string, form: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token request to ${new URL(url).host} failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

export async function getCoreSession(params: SfParams): Promise<SfSession> {
  const json = await postForm(`${params.instanceUrl}/services/oauth2/token`, {
    grant_type: 'client_credentials',
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });
  return { instanceUrl: (json.instance_url ?? params.instanceUrl).replace(/\/+$/, ''), accessToken: json.access_token };
}

export async function getCdpSession(core: SfSession): Promise<CdpSession> {
  const json = await postForm(`${core.instanceUrl}/services/a360/token`, {
    grant_type: 'urn:salesforce:grant-type:external:cdp',
    subject_token: core.accessToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
  });
  const tenant = String(json.instance_url ?? '');
  return { tenantUrl: (tenant.startsWith('http') ? tenant : `https://${tenant}`).replace(/\/+$/, ''), accessToken: json.access_token };
}

export class SfApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown
  ) {
    super(message);
  }
}

export async function sfFetch(session: { accessToken: string }, url: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // leave as raw text
  }
  if (!res.ok) {
    throw new SfApiError(`${init.method ?? 'GET'} ${new URL(url).pathname} failed (${res.status}): ${text}`, res.status, body);
  }
  return body;
}
