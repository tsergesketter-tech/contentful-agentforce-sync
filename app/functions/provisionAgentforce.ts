/**
 * App Action: idempotent checklist for the Salesforce side. `operation=status` only checks;
 * `provision` creates what's missing, in order:
 *
 *   Data 360   Ingestion API connection -> ContentfulKnowledge schema -> DLO -> data stream -> DMO
 *              -> DLO->DMO mapping -> search index (HYBRID, multilingual) -> retriever
 *   Knowledge  ContentfulKnowledgeSync Apex endpoint reachable, record type usable, languages
 *
 * The Knowledge metadata itself (fields, record type, Apex, permission sets) ships as an SFDX
 * project (../force-app) and is deployed with `sf project deploy start`; this only verifies it.
 * Each step reports done | missing | created | pending | error. A pending step (a search index
 * still building) needs another provision run once it's READY.
 */
import type { AppActionRequest, FunctionEventContext, FunctionEventHandler, FunctionTypeEnum } from '@contentful/node-apps-toolkit';
import * as dc from './lib/dataCloud';
import { knowledgeHealth } from './lib/knowledge';
import { getCoreSession, missingSfParams, readSfParams, type SfSession } from './lib/sfAuth';

const DC_DLO = 'ContentfulKnowledge__dll';
type StepStatus = 'done' | 'missing' | 'created' | 'pending' | 'error';
type Step = { id: string; label: string; status: StepStatus; detail?: string };

export const handler: FunctionEventHandler<FunctionTypeEnum.AppActionCall> = async (event: AppActionRequest, context: FunctionEventContext) => {
  const { operation = 'status' } = (event.body ?? {}) as { operation?: string };
  const create = operation === 'provision';
  const sf = readSfParams(context);
  const missing = missingSfParams(sf);
  if (missing) return { ok: false, error: missing };

  let session: SfSession;
  try {
    session = await getCoreSession(sf);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const steps: Step[] = [];
  // Runs one check; when it's missing and we're provisioning, runs `make`. A thrown error stops
  // the Data 360 chain (later steps depend on earlier ones).
  let blocked = false;
  async function step(id: string, label: string, check: () => Promise<string | null | false>, make?: () => Promise<string | void>) {
    if (blocked) {
      steps.push({ id, label, status: 'missing', detail: 'waiting on an earlier step' });
      return;
    }
    try {
      const found = await check();
      if (found !== null && found !== false) {
        const pending = found.startsWith('pending:');
        steps.push({ id, label, status: pending ? 'pending' : 'done', detail: pending ? found.slice(8) : found });
        if (pending) blocked = true;
        return;
      }
      if (!create || !make) {
        steps.push({ id, label, status: 'missing' });
        blocked = true;
        return;
      }
      const detail = await make();
      steps.push({ id, label, status: 'created', detail: detail || undefined });
    } catch (e) {
      steps.push({ id, label, status: 'error', detail: (e as Error).message.slice(0, 1000) });
      blocked = true;
    }
  }

  let connection: dc.IngestConnection | null = null;
  await step(
    'connection',
    `Ingestion API connection "${sf.ingestSourceName}"`,
    async () => {
      connection = await dc.findIngestConnection(session, sf.ingestSourceName);
      return connection ? connection.id : null;
    },
    async () => {
      connection = await dc.createIngestConnection(session, sf.ingestSourceName);
      return connection.id;
    }
  );
  await step(
    'schema',
    'ContentfulKnowledge ingest schema',
    async () => {
      const s = await dc.getIngestSchema(session, connection!.id);
      if (!s) return null;
      const have = new Set((s.fields ?? []).map((f: any) => f.name));
      return dc.INGEST_FIELDS.every((f) => have.has(f.name)) ? `${s.fields.length} fields` : null;
    },
    async () => `added ${(await dc.upsertIngestSchema(session, connection!.id)).join(', ')}`
  );
  await step(
    'dlo',
    'Data lake object ContentfulKnowledge__dll',
    async () => ((await dc.getDlo(session)) ? 'exists' : null),
    async () => void (await dc.createDlo(session, sf.dataSpace))
  );
  await step(
    'stream',
    'Data stream',
    // Listing data streams can take >30s in busy orgs (past the Function timeout), so the check
    // reads the DLO instead: a DLO fed by a stream has refreshed at least once.
    async () => {
      const dlo = await dc.getDlo(session);
      const d = dlo?.dataLakeObjects?.[0] ?? dlo;
      return d?.lastRefreshedDate ? `feeding ${DC_DLO} (last refresh ${d.lastRefreshedDate}, ${d.totalRecords ?? '?'} rows)` : null;
    },
    async () => {
      // A stream that exists but hasn't refreshed yet looks missing above; don't create a twin.
      const existing = await dc.findDataStream(session);
      if (existing) return `${existing.name} exists, waiting for its first refresh`;
      const s = await dc.createDataStream(session, connection!.name);
      return `${s?.name ?? ''} — rows pushed before its first refresh are dropped; run Backfill after a minute`;
    }
  );
  await step(
    'dmo',
    'Data model object ContentfulKnowledge__dlm',
    async () => ((await dc.getDmo(session)) ? 'exists' : null),
    async () => void (await dc.createDmo(session, sf.dataSpace))
  );
  await step(
    'mapping',
    'DLO -> DMO field mapping',
    async () => ((await dc.hasDmoMapping(session, sf.dataSpace)) ? 'mapped' : null),
    async () => void (await dc.createDmoMapping(session, sf.dataSpace))
  );
  let searchIndexId: string | undefined;
  await step(
    'searchIndex',
    'Search index Contentful_Knowledge (hybrid, multilingual)',
    async () => {
      const si = await dc.findSearchIndex(session);
      if (!si) return null;
      searchIndexId = si.id;
      return si.runtimeStatus === 'READY' ? `READY (${si.id})` : `pending:building (${si.runtimeStatus ?? 'not ready'}) — run again in a few minutes`;
    },
    async () => {
      const r = await dc.createSearchIndex(session);
      searchIndexId = r?.id;
      blocked = true; // the retriever needs a READY index
      return `${r?.id ?? ''} — building; run Provision again when READY`;
    }
  );
  await step(
    'retriever',
    'Retriever "Contentful Knowledge Retriever"',
    async () => {
      const r = await dc.findRetriever(session);
      return r ? `${r.name ?? r.id}` : null;
    },
    async () => {
      const r = await dc.createRetriever(session, searchIndexId!, sf.dataSpace);
      return r?.name ?? r?.id;
    }
  );

  // Knowledge checks are independent of the Data 360 chain.
  blocked = false;
  await step('knowledge', 'Knowledge endpoint (ContentfulKnowledgeSync Apex)', async () => {
    const h = await knowledgeHealth(session);
    if (!h.canCreate) throw new Error(`${h.user} can't create Knowledge articles: assign the Contentful_Knowledge_Sync permission set and enable Knowledge User`);
    return `${h.user}; languages ${h.languages.join(', ')}${h.recordTypeAvailable ? '' : '; Contentful record type not available (default used)'}`;
  });

  const ok = steps.every((s) => s.status === 'done' || s.status === 'created');
  return { ok: true, ready: ok, operation, steps };
};
