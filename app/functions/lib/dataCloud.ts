/**
 * Data 360 side: one generic Ingestion API object, ContentfulKnowledge, on the shared `Contentful`
 * connection, with one row per (entry, locale). Proven live 2026-11-24 in mca-trailsignup:
 *
 *   connection schema  PUT the FULL schema set (labels: no spaces or punctuation in object labels).
 *   DLO                created first; field X_c -> column X_c__c, PK RecordId_c.
 *   data stream        existingDataLakeObjectInfo + explicit mappings. Rows pushed before the
 *                      stream's first refresh are dropped silently (202, never land), so the
 *                      provision step pushes nothing; backfill runs after it.
 *   DMO                X_c -> X__c, mapped DLO -> DMO.
 *   search index       HYBRID, multilingual-e5-large (1024, HNSW, COSINE), passage_extraction with
 *                      strip_html on Body__c. A raw REST POST with indexConfiguration /
 *                      vectorEmbeddingRelatedFields 500s; the minimal body below works.
 *   retriever          NoCode over the index, created via /ssot/machine-learning/retrievers.
 *
 * Ingestion: POST {tenant}/api/v1/ingest/sources/{connectionLabel}/ContentfulKnowledge {data:[...]}
 * Delete:    DELETE ...?ids=a,b (max 200). Rows land in ~2-4 min; the index follows near-real-time.
 */
import { DC_NAMES } from './linkage';
import type { Article } from './render';
import { recordId } from './render';
import { SSOT_API_VERSION, sfFetch, type CdpSession, type SfSession } from './sfAuth';

export type DcType = 'Text' | 'DateTime';
export type IngestField = { name: string; label: string; dataType: DcType };

export const PRIMARY_KEY = 'RecordId_c';

export const INGEST_FIELDS: IngestField[] = [
  { name: 'RecordId_c', label: 'Record Id', dataType: 'Text' },
  { name: 'EntryId_c', label: 'Entry Id', dataType: 'Text' },
  { name: 'ContentType_c', label: 'Content Type', dataType: 'Text' },
  { name: 'Locale_c', label: 'Locale', dataType: 'Text' },
  { name: 'Title_c', label: 'Title', dataType: 'Text' },
  { name: 'Summary_c', label: 'Summary', dataType: 'Text' },
  { name: 'Body_c', label: 'Body', dataType: 'Text' },
  { name: 'Url_c', label: 'Source Url', dataType: 'Text' },
  { name: 'EditUrl_c', label: 'Edit Url', dataType: 'Text' },
  { name: 'Brand_c', label: 'Brand', dataType: 'Text' },
  { name: 'Tags_c', label: 'Tags', dataType: 'Text' },
  { name: 'PublishedAt_c', label: 'Published At', dataType: 'DateTime' },
];

export const dmoField = (ingest: string) => `${ingest.replace(/_c$/, '')}__c`;

export type IngestRow = Record<string, string>;

export function articleToRow(
  a: Article,
  meta: { entryId: string; contentTypeId: string; editUrl: string; publishedAt: string }
): IngestRow {
  return {
    RecordId_c: recordId(meta.entryId, a.locale),
    EntryId_c: meta.entryId,
    ContentType_c: meta.contentTypeId,
    Locale_c: a.sfLocale,
    Title_c: a.title,
    Summary_c: a.summary,
    // HTML, so the index's strip_html chunker sees headings/lists as boundaries.
    Body_c: a.html || a.text,
    Url_c: a.url,
    EditUrl_c: meta.editUrl,
    Brand_c: a.brand,
    Tags_c: a.tags.join(','),
    PublishedAt_c: meta.publishedAt,
  };
}

// ---------------------------------------------------------------- ingestion

const PUSH_BATCH = 100;
const DELETE_BATCH = 200;

const ingestUrl = (cdp: CdpSession, source: string) =>
  `${cdp.tenantUrl}/api/v1/ingest/sources/${encodeURIComponent(source)}/${encodeURIComponent(DC_NAMES.objectName)}`;

export async function pushRows(cdp: CdpSession, source: string, rows: IngestRow[]): Promise<number> {
  for (let i = 0; i < rows.length; i += PUSH_BATCH) {
    await sfFetch(cdp, ingestUrl(cdp, source), { method: 'POST', body: { data: rows.slice(i, i + PUSH_BATCH) } });
  }
  return rows.length;
}

export async function deleteRows(cdp: CdpSession, source: string, ids: string[]): Promise<number> {
  for (let i = 0; i < ids.length; i += DELETE_BATCH) {
    const chunk = ids.slice(i, i + DELETE_BATCH).map(encodeURIComponent).join(',');
    await sfFetch(cdp, `${ingestUrl(cdp, source)}?ids=${chunk}`, { method: 'DELETE' });
  }
  return ids.length;
}

// ---------------------------------------------------------------- provisioning

const ssot = (s: SfSession) => `${s.instanceUrl}/services/data/${SSOT_API_VERSION}/ssot`;

async function getOrNull(session: SfSession, url: string): Promise<any | null> {
  try {
    return await sfFetch(session, url);
  } catch (e: any) {
    if (e?.status === 404) return null;
    if (e?.status === 400 && /not found|INVALID_INPUT|does not exist/i.test(e?.message ?? '')) return null;
    throw e;
  }
}

export type IngestConnection = { id: string; name: string; label: string };

export async function findIngestConnection(session: SfSession, label: string): Promise<IngestConnection | null> {
  const res = await sfFetch(session, `${ssot(session)}/connections?connectorType=IngestApi&limit=200`);
  const hit = (res?.connections ?? []).find((c: any) => c?.label === label);
  return hit ? { id: hit.id, name: hit.name, label: hit.label } : null;
}

export async function createIngestConnection(session: SfSession, label: string): Promise<IngestConnection> {
  const res = await sfFetch(session, `${ssot(session)}/connections?connectorType=IngestApi`, {
    method: 'POST',
    body: { connectorType: 'IngestApi', label, name: label.replace(/[^A-Za-z0-9_]+/g, '_') },
  });
  return { id: res.id, name: res.name, label: res.label };
}

export async function getIngestSchema(session: SfSession, connectionId: string): Promise<any | null> {
  const res = await sfFetch(session, `${ssot(session)}/connections/${encodeURIComponent(connectionId)}/schema`);
  return (res?.schemas ?? []).find((s: any) => s?.name === DC_NAMES.objectName) ?? null;
}

// Adds ContentfulKnowledge (or its missing fields) to the connection, keeping every other schema.
export async function upsertIngestSchema(session: SfSession, connectionId: string): Promise<string[]> {
  const current = await sfFetch(session, `${ssot(session)}/connections/${encodeURIComponent(connectionId)}/schema`);
  const schemas: any[] = current?.schemas ?? [];
  const existing = schemas.find((s) => s?.name === DC_NAMES.objectName);
  const have = new Set((existing?.fields ?? []).map((f: any) => f.name));
  const added = INGEST_FIELDS.filter((f) => !have.has(f.name));
  if (existing && !added.length) return [];
  const strip = (s: any) => ({
    name: s.name,
    label: s.label,
    schemaType: s.schemaType ?? 'IngestApi',
    fields: (s.fields ?? []).map((f: any) => ({ name: f.name, label: f.label, dataType: f.dataType })),
  });
  const next = schemas.filter((s) => s?.name !== DC_NAMES.objectName).map(strip);
  next.push({
    name: DC_NAMES.objectName,
    label: DC_NAMES.objectName, // object labels can't contain spaces
    schemaType: 'IngestApi',
    fields: [...(existing ? strip(existing).fields : []), ...added],
  });
  await sfFetch(session, `${ssot(session)}/connections/${encodeURIComponent(connectionId)}/schema`, {
    method: 'PUT',
    body: { schemas: next },
  });
  return added.map((f) => f.name);
}

export const getDlo = (s: SfSession) => getOrNull(s, `${ssot(s)}/data-lake-objects/${DC_NAMES.dloName}`);

export async function createDlo(session: SfSession, dataSpace: string): Promise<any> {
  return sfFetch(session, `${ssot(session)}/data-lake-objects`, {
    method: 'POST',
    body: {
      name: DC_NAMES.dloName.replace(/__dll$/, ''),
      label: 'Contentful Knowledge',
      category: 'Other',
      dataspaceInfo: [{ name: dataSpace }],
      dataLakeFieldInputRepresentations: INGEST_FIELDS.map((f) => ({ ...f, isPrimaryKey: f.name === PRIMARY_KEY })),
      recordModifiedFieldName: 'PublishedAt_c',
    },
  });
}

// The stream's name gets an auto suffix, so find it by the DLO it feeds.
export async function findDataStream(session: SfSession): Promise<any | null> {
  const res = await sfFetch(session, `${ssot(session)}/data-streams?limit=200`);
  const list: any[] = res?.dataStreams ?? [];
  return (
    list.find((d) => d?.dataLakeObjectInfo?.name === DC_NAMES.dloName) ??
    list.find((d) => String(d?.name ?? '').includes(`_${DC_NAMES.objectName}_`)) ??
    null
  );
}

export async function createDataStream(session: SfSession, connectionDevName: string): Promise<any> {
  return sfFetch(session, `${ssot(session)}/data-streams`, {
    method: 'POST',
    body: {
      name: 'Contentful Knowledge',
      label: 'Contentful Knowledge',
      connectorInfo: { connectorType: 'IngestApi', connectorDetails: { name: connectionDevName, events: [DC_NAMES.objectName] } },
      datastreamType: 'INGESTAPI',
      dataAccessMode: 'INGEST',
      refreshConfig: { refreshMode: 'UPSERT' },
      existingDataLakeObjectInfo: { name: DC_NAMES.dloName },
      sourceFields: INGEST_FIELDS.map((f) => ({ name: f.name, dataType: f.dataType })),
      mappings: INGEST_FIELDS.map((f) => ({ sourceFieldLabel: f.name, targetFieldName: f.name, targetFieldReturntype: f.dataType })),
    },
  });
}

export const getDmo = (s: SfSession) => getOrNull(s, `${ssot(s)}/data-model-objects/${DC_NAMES.dmoName}`);

export async function createDmo(session: SfSession, dataSpace: string): Promise<any> {
  return sfFetch(session, `${ssot(session)}/data-model-objects`, {
    method: 'POST',
    body: {
      name: DC_NAMES.dmoName.replace(/__dlm$/, ''),
      label: 'Contentful Knowledge',
      category: 'Other',
      dataSpaceName: dataSpace,
      fields: INGEST_FIELDS.map((f) => ({
        name: f.name.replace(/_c$/, ''),
        label: f.label,
        dataType: f.dataType,
        isPrimaryKey: f.name === PRIMARY_KEY,
      })),
    },
  });
}

export async function hasDmoMapping(session: SfSession, dataSpace: string): Promise<boolean> {
  const res = await getOrNull(
    session,
    `${ssot(session)}/data-model-object-mappings?dataspace=${encodeURIComponent(dataSpace)}&dmoDeveloperName=${DC_NAMES.dmoName}`
  );
  const list: any[] = res?.objectSourceTargetMaps ?? res?.mappings ?? [];
  return list.some((m) => m?.sourceEntityDeveloperName === DC_NAMES.dloName);
}

export async function createDmoMapping(session: SfSession, dataSpace: string): Promise<any> {
  const fieldMapping = [
    ...INGEST_FIELDS.map((f) => ({ sourceFieldDeveloperName: `${f.name}__c`, targetFieldDeveloperName: dmoField(f.name) })),
    { sourceFieldDeveloperName: 'DataSource__c', targetFieldDeveloperName: 'DataSource__c' },
    { sourceFieldDeveloperName: 'DataSourceObject__c', targetFieldDeveloperName: 'DataSourceObject__c' },
  ];
  return sfFetch(session, `${ssot(session)}/data-model-object-mappings?dataspace=${encodeURIComponent(dataSpace)}`, {
    method: 'POST',
    body: { sourceEntityDeveloperName: DC_NAMES.dloName, targetEntityDeveloperName: DC_NAMES.dmoName, fieldMapping },
  });
}

export async function findSearchIndex(session: SfSession): Promise<any | null> {
  const res = await sfFetch(session, `${ssot(session)}/search-index?limit=200`);
  return (res?.semanticSearchDefinitionDetails ?? []).find((s: any) => s?.developerName === DC_NAMES.searchIndexName) ?? null;
}

export async function createSearchIndex(session: SfSession): Promise<any> {
  const dmo = DC_NAMES.dmoName;
  return sfFetch(session, `${ssot(session)}/search-index`, {
    method: 'POST',
    body: {
      label: 'Contentful Knowledge',
      developerName: DC_NAMES.searchIndexName,
      description: 'Published Contentful service content, one row per entry per locale, for Agentforce grounding.',
      sourceDmoDeveloperName: dmo,
      chunkDmoName: 'Contentful Knowledge chunk',
      chunkDmoDeveloperName: `${DC_NAMES.searchIndexName}_chunk`,
      vectorDmoName: 'Contentful Knowledge index',
      vectorDmoDeveloperName: `${DC_NAMES.searchIndexName}_index`,
      searchType: 'HYBRID',
      chunkingConfiguration: {
        fieldLevelConfigurations: [
          {
            sourceDmoDeveloperName: dmo,
            sourceDmoFieldDeveloperName: 'Body__c',
            decorators: [],
            config: {
              id: 'passage_extraction',
              userValues: [
                { id: 'strip_html', value: 'true' },
                { id: 'max_tokens', value: '512' },
              ],
            },
          },
        ],
      },
      // Multilingual: one index serves every market's language.
      vectorEmbeddingConfiguration: {
        embeddingModel: {
          id: 'multilingual-e5-large',
          userValues: [
            { id: 'dimension', value: '1024' },
            { id: 'max_token_limit', value: '512' },
          ],
        },
        index: {
          id: 'HNSW',
          userValues: [
            { id: 'hnswEfConstruction', value: '2000' },
            { id: 'M', value: '64' },
          ],
        },
        similarityMetric: 'COSINE',
      },
      vectorEmbedding: { vectorEmbeddingRelatedFields: [] },
      transformConfigurations: [],
    },
  });
}

const retrieversUrl = (s: SfSession) => `${ssot(s)}/machine-learning/retrievers`;

export async function findRetriever(session: SfSession): Promise<any | null> {
  const res = await sfFetch(session, `${retrieversUrl(session)}?limit=200`);
  return (res?.retrievers ?? []).find((r: any) => r?.label === DC_NAMES.retrieverLabel) ?? null;
}

// Output fields the agent sees per hit, beside the chunk text (always returned): the article's
// identity and links, so answers can cite the Contentful source and filter by market/brand.
// Output fields must live on the index's source DMO; the chunk DMO is rejected (400).
export const RETRIEVER_OUTPUT_FIELDS: [string, string][] = [
  ['Title__c', 'Title'],
  ['Summary__c', 'Summary'],
  ['Locale__c', 'Locale'],
  ['Brand__c', 'Brand'],
  ['ContentType__c', 'Content Type'],
  ['Url__c', 'Source Url'],
  ['EditUrl__c', 'Edit Url'],
  ['EntryId__c', 'Entry Id'],
];

export async function createRetriever(session: SfSession, searchIndexId: string, dataSpace: string): Promise<any> {
  return sfFetch(session, retrieversUrl(session), {
    method: 'POST',
    body: {
      label: DC_NAMES.retrieverLabel,
      description: 'Top Contentful service-content passages for Agentforce grounding.',
      dataSourceType: 'SearchIndex',
      dataSpaces: [dataSpace],
      configuration: {
        queryType: 'NoCode',
        input: { id: searchIndexId },
        numberOfResults: 5,
        isActive: true,
        isCitationEnabled: true,
        outputFields: RETRIEVER_OUTPUT_FIELDS.map(([field, label]) => ({
          relatedDmoName: DC_NAMES.dmoName,
          relatedDmoFieldName: field,
          label,
          relationships: [],
        })),
      },
    },
  });
}
