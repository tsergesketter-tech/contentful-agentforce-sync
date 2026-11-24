/**
 * Salesforce Knowledge side: one call per entry to the ContentfulKnowledgeSync Apex REST endpoint
 * (force-app/main/default/classes/ContentfulKnowledgeSync.cls), which runs the whole article
 * lifecycle in one transaction: draft -> publish new version -> translations -> archive.
 * Translation publishing and archiving only exist in KbManagement.PublishingService (Apex), not
 * REST, hence the endpoint. Languages are sent as Contentful codes; Apex resolves them to active
 * Knowledge languages (fr-CA -> fr) and skips the rest.
 */
import type { Linkage } from './linkage';
import type { Article } from './render';
import { sfFetch, type SfSession } from './sfAuth';

const ENDPOINT = '/services/apexrest/contentful/knowledge/v1';

export type KnowledgeResult = {
  ok: boolean;
  action: string;
  knowledgeArticleId?: string;
  articleNumber?: string;
  masterVersionId?: string;
  languages: Record<string, string>;
  errors: string[];
};

export async function knowledgeHealth(session: SfSession): Promise<{ user: string; languages: string[]; recordTypeAvailable: boolean; canCreate: boolean }> {
  return sfFetch(session, `${session.instanceUrl}${ENDPOINT}`);
}

function categories(linkage: Linkage) {
  return linkage.dataCategories
    .map((c) => c.split('.'))
    .filter((p) => p.length === 2 && p[0] && p[1])
    .map(([groupName, name]) => ({ groupName, name }));
}

export async function publishToKnowledge(
  session: SfSession,
  linkage: Linkage,
  input: { entryId: string; masterLocale: string; editUrl: string; articles: Article[] }
): Promise<KnowledgeResult> {
  const master = input.articles.find((a) => a.locale === input.masterLocale) ?? input.articles[0];
  return callEndpoint(session, {
    action: 'upsert',
    entryId: input.entryId,
    contentType: linkage.contentTypeId,
    brand: master?.brand,
    sourceUrl: master?.url || undefined,
    editUrl: input.editUrl,
    masterLanguage: input.masterLocale,
    categories: categories(linkage),
    versions: input.articles.map((a) => ({ language: a.locale, title: a.title, summary: a.summary, body: a.html })),
  });
}

export async function archiveInKnowledge(session: SfSession, entryId: string): Promise<KnowledgeResult> {
  return callEndpoint(session, { action: 'archive', entryId });
}

// The endpoint answers 400 with the same body when ok=false; surface it as a result, not a throw.
async function callEndpoint(session: SfSession, body: Record<string, unknown>): Promise<KnowledgeResult> {
  try {
    return await sfFetch(session, `${session.instanceUrl}${ENDPOINT}`, { method: 'POST', body });
  } catch (e: any) {
    if (e?.status === 400 && e?.body && typeof e.body === 'object' && 'errors' in e.body) return e.body as KnowledgeResult;
    throw e;
  }
}
