/**
 * Shared sync engine for the event handler (one entry) and the backfill App Action (every
 * published entry of a linked content type).
 *
 *   publish   -> Data 360: push one ContentfulKnowledge row per locale with content, DELETE rows
 *                for locales that lost their translation.
 *                Knowledge: upsert the article (new published version + translations).
 *   unpublish / delete
 *             -> Data 360: DELETE every locale's row.  Knowledge: archive the article.
 *
 * The two outputs are independent: a Knowledge failure doesn't stop the Data 360 push.
 * Config comes from the linkage entry through context.cma.
 */
import type { FunctionEventContext } from '@contentful/node-apps-toolkit';
import { articleToRow, deleteRows, pushRows } from './dataCloud';
import { archiveInKnowledge, publishToKnowledge, type KnowledgeResult } from './knowledge';
import { LINKAGE_CONTENT_TYPE, parseLinkage, type Linkage } from './linkage';
import { collectAssetIds, editUrl, recordId, renderArticles, type EntryLike, type LocaleLike } from './render';
import { getCdpSession, getCoreSession, type CdpSession, type SfParams, type SfSession } from './sfAuth';

const PAGE_SIZE = 100;

export type Env = { cma: any; spaceId: string; environmentId: string };

export function envOf(context: FunctionEventContext): Env {
  if (!context.cma) throw new Error('CMA client is not available in this function context.');
  return { cma: retryRateLimits(context.cma), spaceId: context.spaceId, environmentId: context.environmentId };
}

// context.cma doesn't retry 429s. In hosted Functions it's an RPC stub where every property looks
// callable, so the wrapper calls cma.<namespace>.<method>(...) by name; errors arrive as plain
// Error('RateLimitExceeded: ...') without status.
const RATE_LIMIT_DELAYS_MS = [1000, 2000, 4000];
export function retryRateLimits<T extends object>(client: T, delays = RATE_LIMIT_DELAYS_MS): T {
  return new Proxy(client, {
    get: (_, namespace) =>
      new Proxy(
        {},
        {
          get:
            (__, method) =>
            async (...args: unknown[]) => {
              for (let attempt = 0; ; attempt++) {
                try {
                  return await (client as any)[namespace][method](...args);
                } catch (err: any) {
                  const limited = err?.status === 429 || /RateLimitExceeded/.test(`${err?.name} ${err?.message}`);
                  if (!limited || attempt >= delays.length) throw err;
                  await new Promise((r) => setTimeout(r, delays[attempt]));
                }
              }
            },
        }
      ),
  });
}

const ids = (env: Env) => ({ spaceId: env.spaceId, environmentId: env.environmentId });

export async function loadLocales(env: Env): Promise<LocaleLike[]> {
  const res = await env.cma.locale.getMany({ ...ids(env), query: { limit: 100 } });
  return res.items.map((l: any) => ({ code: l.code, fallbackCode: l.fallbackCode, default: l.default }));
}

export async function findActiveLinkage(env: Env, contentTypeId: string): Promise<Linkage | null> {
  const res = await env.cma.entry.getMany({
    ...ids(env),
    query: { content_type: LINKAGE_CONTENT_TYPE, 'fields.contentTypeId': contentTypeId, 'sys.archivedAt[exists]': false, limit: 10 },
  });
  return res.items.map((e: any) => parseLinkage(e)).find((l: Linkage) => l.isActive) ?? null;
}

export async function loadLinkage(env: Env, linkageEntryId: string): Promise<Linkage> {
  return parseLinkage(await env.cma.entry.get({ ...ids(env), entryId: linkageEntryId }));
}

// Bookkeeping on the linkage entry (draft update, not republished). Retries once on a conflict.
export async function updateLinkageFields(env: Env, linkageEntryId: string, values: Record<string, unknown>): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const entry = await env.cma.entry.get({ ...ids(env), entryId: linkageEntryId });
    const fields = { ...entry.fields };
    for (const [k, v] of Object.entries(values)) fields[k] = { 'en-US': v };
    try {
      await env.cma.entry.update({ ...ids(env), entryId: linkageEntryId }, { ...entry, fields });
      return;
    } catch (e: any) {
      if (attempt === 0 && /version|conflict/i.test(String(e?.message))) continue;
      throw e;
    }
  }
}

async function resolveAssetUrls(env: Env, assetIds: string[]): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  const unique = [...new Set(assetIds)];
  for (let i = 0; i < unique.length; i += PAGE_SIZE) {
    const res = await env.cma.asset.getMany({ ...ids(env), query: { 'sys.id[in]': unique.slice(i, i + PAGE_SIZE).join(','), limit: PAGE_SIZE } });
    for (const a of res.items) {
      const file = Object.values(a.fields?.file ?? {})[0] as any;
      if (file?.url) urls.set(a.sys.id, file.url.startsWith('//') ? `https:${file.url}` : file.url);
    }
  }
  return urls;
}

// Published entries as their *published* snapshot (CMA /public/entries), so a backfill never
// syncs unpublished draft edits.
export async function listPublishedEntries(env: Env, contentTypeId: string): Promise<EntryLike[]> {
  const out: EntryLike[] = [];
  for (let skip = 0; ; skip += PAGE_SIZE) {
    const page = await env.cma.entry.getPublished({ ...ids(env), query: { content_type: contentTypeId, limit: PAGE_SIZE, skip } });
    out.push(...page.items);
    if (page.items.length < PAGE_SIZE) break;
  }
  return out;
}

export type Sessions = { core: SfSession; cdp?: CdpSession };

export async function openSessions(sf: SfParams, linkage: Linkage): Promise<Sessions> {
  const core = await getCoreSession(sf);
  return { core, cdp: linkage.syncDataCloud ? await getCdpSession(core) : undefined };
}

export type EntryResult = {
  entryId: string;
  locales: string[];
  dataCloud?: { pushed: number; deleted: number; error?: string };
  knowledge?: KnowledgeResult | { ok: false; error: string };
};

export type SyncBatch = { upserts: EntryLike[]; retireEntryIds: string[] };

export async function syncEntries(env: Env, sf: SfParams, linkage: Linkage, batch: SyncBatch, sessions?: Sessions): Promise<EntryResult[]> {
  const s = sessions ?? (await openSessions(sf, linkage));
  const locales = await loadLocales(env);
  const masterLocale = locales.find((l) => l.default)?.code ?? 'en-US';
  const assetUrls = await resolveAssetUrls(env, batch.upserts.flatMap((e) => collectAssetIds(e, linkage)));
  const results: EntryResult[] = [];

  // Data 360 rows for the whole batch go out in bulk; Knowledge is one call per entry.
  const rows: Record<string, string>[] = [];
  const staleIds: string[] = [];

  for (const entry of batch.upserts) {
    const articles = renderArticles(entry, linkage, locales, assetUrls);
    const edit = editUrl(env.spaceId, env.environmentId, entry.sys.id);
    const result: EntryResult = { entryId: entry.sys.id, locales: articles.map((a) => a.locale) };
    if (linkage.syncDataCloud) {
      const publishedAt = entry.sys.publishedAt ?? entry.sys.updatedAt ?? new Date().toISOString();
      rows.push(...articles.map((a) => articleToRow(a, { entryId: entry.sys.id, contentTypeId: linkage.contentTypeId, editUrl: edit, publishedAt })));
      const present = new Set(articles.map((a) => a.locale));
      staleIds.push(...locales.filter((l) => !present.has(l.code)).map((l) => recordId(entry.sys.id, l.code)));
    }
    if (linkage.syncKnowledge) {
      try {
        result.knowledge = await publishToKnowledge(s.core, linkage, { entryId: entry.sys.id, masterLocale, editUrl: edit, articles });
      } catch (e) {
        result.knowledge = { ok: false, error: (e as Error).message };
      }
    }
    results.push(result);
  }

  for (const entryId of batch.retireEntryIds) {
    const result: EntryResult = { entryId, locales: [] };
    if (linkage.syncDataCloud) staleIds.push(...locales.map((l) => recordId(entryId, l.code)));
    if (linkage.syncKnowledge) {
      try {
        result.knowledge = await archiveInKnowledge(s.core, entryId);
      } catch (e) {
        result.knowledge = { ok: false, error: (e as Error).message };
      }
    }
    results.push(result);
  }

  if (linkage.syncDataCloud && s.cdp) {
    let dc: EntryResult['dataCloud'];
    try {
      // Deleting ids that never existed is a no-op for the Ingestion API.
      dc = { pushed: await pushRows(s.cdp, sf.ingestSourceName, rows), deleted: await deleteRows(s.cdp, sf.ingestSourceName, staleIds) };
    } catch (e) {
      dc = { pushed: 0, deleted: 0, error: (e as Error).message };
    }
    // Per-entry results share the batch outcome; the counts are batch totals.
    for (const r of results) r.dataCloud = dc;
  }
  return results;
}

export function firstError(results: EntryResult[]): string | null {
  for (const r of results) {
    if (r.dataCloud?.error) return `Data 360: ${r.dataCloud.error}`;
    const k: any = r.knowledge;
    if (k && k.ok === false) return `Knowledge ${r.entryId}: ${k.error ?? (k.errors ?? []).join('; ')}`;
  }
  return null;
}
