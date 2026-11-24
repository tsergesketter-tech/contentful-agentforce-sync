/**
 * The agentforceSyncLinkage registry entry (see migrations/01-agentforce-sync-linkage.js): one per
 * synced content type. It says which fields make up a service article and where it goes:
 *   - Data 360: one ContentfulKnowledge row per (entry, locale) -> search index -> retriever
 *   - Salesforce Knowledge: one Knowledge__kav article per entry, one version per language
 * Pure helpers only, so the admin Page can import this too.
 */
export const LINKAGE_CONTENT_TYPE = 'agentforceSyncLinkage';

export type Linkage = {
  entryId: string;
  contentTypeId: string;
  isActive: boolean;
  syncDataCloud: boolean;
  syncKnowledge: boolean;
  titleField: string;
  summaryField?: string;
  // Concatenated in order into the article body (rich text, long text or short text fields).
  bodyFieldIds: string[];
  brandField?: string;
  // Static brand when no brand field, e.g. "Nescafé Dolce Gusto".
  brand?: string;
  tagsField?: string;
  slugField?: string;
  // Public article URL, with {locale}, {slug} and {entryId} placeholders.
  urlTemplate?: string;
  // Knowledge data categories applied to every article, as "Group.Category".
  dataCategories: string[];
  status?: 'pending' | 'ready' | 'error';
  lastError?: string;
  lastSyncedAt?: string;
};

type RawEntry = { sys: { id: string }; fields: Record<string, Record<string, any> | undefined> };

function f<T>(entry: RawEntry, id: string, locale: string): T | undefined {
  const byLocale = entry.fields?.[id];
  if (!byLocale) return undefined;
  return (byLocale[locale] ?? Object.values(byLocale)[0]) as T | undefined;
}

const blank = (s: string | undefined) => (s && s.trim() ? s.trim() : undefined);

export function parseLinkage(entry: RawEntry, locale = 'en-US'): Linkage {
  return {
    entryId: entry.sys.id,
    contentTypeId: f<string>(entry, 'contentTypeId', locale) ?? '',
    isActive: !!f<boolean>(entry, 'isActive', locale),
    syncDataCloud: f<boolean>(entry, 'syncDataCloud', locale) !== false,
    syncKnowledge: !!f<boolean>(entry, 'syncKnowledge', locale),
    titleField: f<string>(entry, 'titleField', locale) || 'title',
    summaryField: blank(f<string>(entry, 'summaryField', locale)),
    bodyFieldIds: f<string[]>(entry, 'bodyFieldIds', locale) ?? [],
    brandField: blank(f<string>(entry, 'brandField', locale)),
    brand: blank(f<string>(entry, 'brand', locale)),
    tagsField: blank(f<string>(entry, 'tagsField', locale)),
    slugField: blank(f<string>(entry, 'slugField', locale)),
    urlTemplate: blank(f<string>(entry, 'urlTemplate', locale)),
    dataCategories: f<string[]>(entry, 'dataCategories', locale) ?? [],
    status: f<Linkage['status']>(entry, 'status', locale),
    lastError: f<string>(entry, 'lastError', locale),
    lastSyncedAt: f<string>(entry, 'lastSyncedAt', locale),
  };
}

// Fixed Data 360 names: one generic object for every linked content type, so a single search
// index and retriever ground Agentforce on all of them. ContentType__c tells them apart.
export const DC_NAMES = {
  objectName: 'ContentfulKnowledge',
  dloName: 'ContentfulKnowledge__dll',
  dmoName: 'ContentfulKnowledge__dlm',
  searchIndexName: 'Contentful_Knowledge',
  retrieverLabel: 'Contentful Knowledge Retriever',
};
