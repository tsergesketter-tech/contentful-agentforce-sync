import type { CMAClient } from '@contentful/app-sdk';

export type AppActionIds = { spaceId: string; environmentId: string; appDefinitionId: string };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollCallDetails(
  cma: CMAClient,
  params: AppActionIds & { appActionId: string; callId: string },
  { retries = 40, intervalMs = 1500 }: { retries?: number; intervalMs?: number } = {}
) {
  for (let i = 0; i < retries; i++) {
    try {
      const details: any = await cma.appActionCall.getCallDetails(params as any);
      if (details?.response) return details;
    } catch {
      // Call log isn't ready yet — keep retrying.
    }
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for the app action to respond.');
}

// Every App Action in this app answers in one round trip (Point PUT, Ingestion API streaming
// push, Connect REST schema calls); this polls getCallDetails because that's how the CMA
// surfaces any App Action's response. Throws on HTTP errors and on `{ ok: false }` bodies.
export async function callAppAction(
  cma: CMAClient,
  ids: AppActionIds,
  appActionId: string,
  parameters: Record<string, unknown>
): Promise<any> {
  const call = await cma.appActionCall.create({ ...ids, appActionId } as any, { parameters });
  const details = await pollCallDetails(cma, { ...ids, appActionId, callId: call.sys.id });
  const statusCode = details.response?.statusCode;
  const rawBody = details.response?.body;
  let body: any = rawBody;
  if (typeof rawBody === 'string') {
    try {
      body = JSON.parse(rawBody);
    } catch {
      // leave as raw string
    }
  }
  if (statusCode && statusCode >= 400) {
    throw new Error(`${appActionId} failed (${statusCode}): ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  if (body && typeof body === 'object' && body.ok === false) {
    throw new Error(`${appActionId}: ${body.error ?? 'failed'}`);
  }
  return body;
}
