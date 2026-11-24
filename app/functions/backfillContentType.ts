/**
 * App Action: sync every published entry of a linked content type, for first-time linking, a
 * field-mapping change, or on demand from the Page. Same engine as the event handler. Entries go
 * in chunks so Knowledge calls (one Apex transaction each) stay inside the Function timeout;
 * `skip` lets the Page continue a large type in several calls.
 */
import type { AppActionRequest, FunctionEventContext, FunctionEventHandler, FunctionTypeEnum } from '@contentful/node-apps-toolkit';
import { missingSfParams, readSfParams } from './lib/sfAuth';
import { envOf, firstError, listPublishedEntries, loadLinkage, openSessions, syncEntries, updateLinkageFields } from './lib/sync';

const MAX_PER_CALL = 25;

export const handler: FunctionEventHandler<FunctionTypeEnum.AppActionCall> = async (event: AppActionRequest, context: FunctionEventContext) => {
  const { linkageEntryId, skip: rawSkip } = (event.body ?? {}) as { linkageEntryId?: string; skip?: string | number };
  if (!linkageEntryId) return { ok: false, error: 'linkageEntryId is required' };
  const skip = Number(rawSkip ?? 0) || 0;

  const env = envOf(context);
  try {
    const linkage = await loadLinkage(env, linkageEntryId);
    const sf = readSfParams(context);
    const missing = missingSfParams(sf);
    if (missing) return { ok: false, error: missing };
    if (!linkage.isActive) return { ok: false, error: 'This linkage is inactive.' };

    const all = await listPublishedEntries(env, linkage.contentTypeId);
    const slice = all.slice(skip, skip + MAX_PER_CALL);
    const sessions = await openSessions(sf, linkage);
    const results = await syncEntries(env, sf, linkage, { upserts: slice, retireEntryIds: [] }, sessions);
    const nextSkip = skip + slice.length < all.length ? skip + slice.length : null;
    const err = firstError(results);

    await updateLinkageFields(env, linkageEntryId, {
      status: err ? 'error' : 'ready',
      lastError: err ? err.slice(0, 5000) : '',
      lastSyncedAt: new Date().toISOString(),
    });
    return {
      ok: true,
      totalEntries: all.length,
      synced: slice.length,
      nextSkip,
      rows: results.reduce((n, r) => n + r.locales.length, 0),
      knowledgeErrors: results.filter((r: any) => r.knowledge && r.knowledge.ok === false).map((r: any) => ({ entryId: r.entryId, error: r.knowledge.error ?? r.knowledge.errors })),
      dataCloudError: results.find((r) => r.dataCloud?.error)?.dataCloud?.error ?? null,
    };
  } catch (err) {
    const message = (err as Error).message;
    await updateLinkageFields(env, linkageEntryId, { status: 'error', lastError: message.slice(0, 5000) }).catch(() => undefined);
    return { ok: false, error: message };
  }
};
