/**
 * App Action: run the same hybrid (vector + keyword) search the Agentforce retriever uses over the
 * one shared index, which holds every linked content type and locale, and return the top passages
 * with their source article. Lets editors check from the Page what an agent will find for a
 * question, and shows that a single query hits all content types and languages.
 */
import type { AppActionRequest, FunctionEventContext, FunctionEventHandler, FunctionTypeEnum } from '@contentful/node-apps-toolkit';
import { DC_NAMES } from './lib/linkage';
import { SSOT_API_VERSION, getCoreSession, missingSfParams, readSfParams, sfFetch } from './lib/sfAuth';

const INDEX_DMO = `${DC_NAMES.searchIndexName}_index__dlm`;
const CHUNK_DMO = `${DC_NAMES.searchIndexName}_chunk__dlm`;

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

export const handler: FunctionEventHandler<FunctionTypeEnum.AppActionCall> = async (event: AppActionRequest, context: FunctionEventContext) => {
  const { operation = 'search', query, contentTypeId, limit } = (event.body ?? {}) as {
    operation?: string;
    query?: string;
    contentTypeId?: string;
    limit?: string | number;
  };
  const k = Math.min(Math.max(Number(limit) || 5, 1), 20);

  const sf = readSfParams(context);
  const missing = missingSfParams(sf);
  if (missing) return { ok: false, error: missing };

  try {
    const session = await getCoreSession(sf);
    const runSql = async (sql: string) => {
      const res = await sfFetch(session, `${session.instanceUrl}/services/data/${SSOT_API_VERSION}/ssot/query-sql`, { method: 'POST', body: { sql } });
      const cols: string[] = (res?.metadata ?? []).map((m: any) => m.name);
      return (res?.data ?? []).map((row: any[]) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
    };

    if (operation === 'stats') {
      // Coverage per content type: rows in the DMO vs. rows already chunked into the index.
      const [rows, chunked] = await Promise.all([
        runSql(`select ContentType__c contentType, Locale__c locale, count(*) n from ${DC_NAMES.dmoName} group by ContentType__c, Locale__c`),
        runSql(
          `select a.ContentType__c contentType, count(distinct c.SourceRecordId__c) n from ${CHUNK_DMO} c join ${DC_NAMES.dmoName} a on c.SourceRecordId__c = a.RecordId__c group by a.ContentType__c`
        ),
      ]);
      return { ok: true, rows, chunked };
    }

    if (!query?.trim()) return { ok: false, error: 'query is required' };
    // Over-fetch when filtering by type so the filter doesn't starve the result list.
    const fetchK = contentTypeId ? k * 4 : k;
    const where = contentTypeId ? `where a.ContentType__c = ${sqlString(contentTypeId)}` : '';
    const sql = `select v.hybrid_score__c score, v.vector_score__c vscore, v.keyword_score__c kscore, c.Chunk__c chunk,
        a.RecordId__c recordId, a.EntryId__c entryId, a.ContentType__c contentType, a.Locale__c locale,
        a.Title__c title, a.Url__c url, a.EditUrl__c editUrl, a.Brand__c brand
      from hybrid_search(table(${INDEX_DMO}), ${sqlString(query.trim())}, '', ${fetchK}) v
      join ${CHUNK_DMO} c on v.RecordId__c = c.RecordId__c
      join ${DC_NAMES.dmoName} a on c.SourceRecordId__c = a.RecordId__c
      ${where}
      order by score desc limit ${k}`;
    return { ok: true, hits: await runSql(sql) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
};
