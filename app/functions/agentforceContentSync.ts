/**
 * App Event Handler: Contentful publish/unpublish/delete -> Data 360 (Agentforce grounding) and
 * Salesforce Knowledge (service reps).
 *
 * The AppEventSubscription delivers Entry.publish / unpublish / delete for every entry in the
 * space; routing is registry-driven through the agentforceSyncLinkage entry for the content type.
 * The publish payload is the full published entry (all locales), so no extra read is needed.
 */
import type { AppEventRequest, FunctionEventContext, FunctionEventHandler, FunctionTypeEnum } from '@contentful/node-apps-toolkit';
import type { EntryLike } from './lib/render';
import { missingSfParams, readSfParams } from './lib/sfAuth';
import { envOf, findActiveLinkage, firstError, syncEntries, updateLinkageFields } from './lib/sync';

// `X-Contentful-Topic: ContentManagement.Entry.publish` -> "publish"
function extractEventType(headers: Record<string, string | string[] | undefined> | undefined): string {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === 'x-contentful-topic');
  const raw = entry?.[1];
  const topic = Array.isArray(raw) ? raw[0] : raw;
  if (!topic) return 'publish';
  const parts = topic.split('.');
  return parts[parts.length - 1] || 'publish';
}

export const handler: FunctionEventHandler<FunctionTypeEnum.AppEventHandler> = async (event: AppEventRequest, context: FunctionEventContext) => {
  const body = event.body as EntryLike;
  const contentTypeId = body?.sys?.contentType?.sys?.id;
  const entryId = body?.sys?.id;
  if (!contentTypeId || !entryId) return;

  const eventType = extractEventType(event.headers as Record<string, string | string[] | undefined>);
  if (!['publish', 'unpublish', 'delete'].includes(eventType)) return;

  const env = envOf(context);
  const linkage = await findActiveLinkage(env, contentTypeId);
  if (!linkage || (!linkage.syncDataCloud && !linkage.syncKnowledge)) return;

  const sf = readSfParams(context);
  const missing = missingSfParams(sf);
  if (missing) {
    console.error(missing);
    return;
  }

  try {
    const results = await syncEntries(env, sf, linkage, {
      upserts: eventType === 'publish' ? [body] : [],
      retireEntryIds: eventType === 'publish' ? [] : [entryId],
    });
    console.log(`synced ${eventType} ${contentTypeId}/${entryId}`, JSON.stringify(results));
    const err = firstError(results);
    await updateLinkageFields(env, linkage.entryId, {
      lastSyncedAt: new Date().toISOString(),
      lastError: err ? `${eventType} ${entryId}: ${err}`.slice(0, 5000) : '',
      ...(err ? { status: 'error' } : linkage.status !== 'ready' ? { status: 'ready' } : {}),
    });
  } catch (err) {
    const message = `${eventType} ${entryId}: ${(err as Error).message}`;
    console.error('Agentforce sync failed', message);
    await updateLinkageFields(env, linkage.entryId, { status: 'error', lastError: message.slice(0, 5000) }).catch(() => undefined);
  }
};
