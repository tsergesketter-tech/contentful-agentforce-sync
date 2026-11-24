/**
 * Contentful entry -> one rendered service article per locale. Shared by both outputs:
 *   - Data 360 rows (ContentfulKnowledge, keyed {entryId}_{sfLocale})
 *   - Knowledge versions (Title / Summary / Contentful_Body__c HTML)
 *
 * A locale gets an article only when it has its own title or body (not a fallback), so an
 * untranslated entry doesn't show up as a duplicate English article in every market. Inside an
 * article, untranslated fields still take Contentful's fallback chain.
 */
import type { Linkage } from './linkage';

export type LocaleLike = { code: string; fallbackCode?: string | null; default?: boolean };
export type EntryLike = {
  sys: { id: string; publishedAt?: string; updatedAt?: string; contentType?: { sys?: { id?: string } } };
  fields: Record<string, Record<string, unknown> | undefined>;
};

export type Article = {
  locale: string; // Contentful code, e.g. fr-CA
  sfLocale: string; // fr_CA
  title: string;
  summary: string;
  html: string;
  text: string;
  brand: string;
  tags: string[];
  url: string;
};

export const sfLocale = (code: string) => code.replace(/-/g, '_');
export const recordId = (entryId: string, locale: string) => `${entryId}_${sfLocale(locale)}`;

export function localizedValue(entry: EntryLike, fieldId: string | undefined, locale: string, locales: LocaleLike[]): unknown {
  if (!fieldId) return undefined;
  const byLocale = entry.fields[fieldId];
  if (!byLocale) return undefined;
  const seen = new Set<string>();
  let code: string | null | undefined = locale;
  while (code && !seen.has(code)) {
    seen.add(code);
    if (byLocale[code] !== undefined && byLocale[code] !== null) return byLocale[code];
    code = locales.find((l) => l.code === code)?.fallbackCode;
  }
  const def = locales.find((l) => l.default)?.code;
  return def ? byLocale[def] : undefined;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const BLOCK_TAGS: Record<string, string> = {
  paragraph: 'p',
  'heading-1': 'h1',
  'heading-2': 'h2',
  'heading-3': 'h3',
  'heading-4': 'h4',
  'heading-5': 'h5',
  'heading-6': 'h6',
  'unordered-list': 'ul',
  'ordered-list': 'ol',
  'list-item': 'li',
  blockquote: 'blockquote',
  table: 'table',
  'table-row': 'tr',
  'table-cell': 'td',
  'table-header-cell': 'th',
};

const MARK_TAGS: Record<string, string> = { bold: 'strong', italic: 'em', underline: 'u', code: 'code', superscript: 'sup', subscript: 'sub' };

// Rich Text document -> HTML. Embedded assets become <img>/<a> (urls resolved by the caller);
// embedded entries are dropped (they're other content, not this article's text).
export function richTextToHtml(node: any, assetUrls: Map<string, string>): string {
  if (!node) return '';
  if (node.nodeType === 'text') {
    let out = esc(node.value ?? '').replace(/\n/g, '<br>');
    for (const m of node.marks ?? []) {
      const tag = MARK_TAGS[m.type];
      if (tag) out = `<${tag}>${out}</${tag}>`;
    }
    return out;
  }
  const inner = () => (node.content ?? []).map((n: any) => richTextToHtml(n, assetUrls)).join('');
  switch (node.nodeType) {
    case 'document':
      return inner();
    case 'hr':
      return '<hr>';
    case 'hyperlink':
      return `<a href="${esc(node.data?.uri ?? '')}">${inner()}</a>`;
    case 'asset-hyperlink': {
      const url = assetUrls.get(node.data?.target?.sys?.id);
      return url ? `<a href="${esc(url)}">${inner()}</a>` : inner();
    }
    case 'embedded-asset-block': {
      const url = assetUrls.get(node.data?.target?.sys?.id);
      return url ? `<p><img src="${esc(url)}" alt=""></p>` : '';
    }
    case 'embedded-entry-block':
    case 'embedded-entry-inline':
    case 'embedded-resource-block':
    case 'embedded-resource-inline':
    case 'entry-hyperlink':
    case 'resource-hyperlink':
      return node.nodeType.endsWith('hyperlink') ? inner() : '';
    default: {
      const tag = BLOCK_TAGS[node.nodeType];
      return tag ? `<${tag}>${inner()}</${tag}>` : inner();
    }
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]*\n\s*/g, '\n')
    .trim();
}

// Long text is treated as Markdown-ish plain text: paragraphs on blank lines.
function textToHtml(s: string): string {
  return s
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function valueToHtml(v: unknown, assetUrls: Map<string, string>): string {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'object' && (v as any).nodeType === 'document') return richTextToHtml(v, assetUrls);
  if (Array.isArray(v)) return v.length ? `<ul>${v.map((x) => `<li>${esc(String(x))}</li>`).join('')}</ul>` : '';
  return textToHtml(String(v));
}

const asText = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object' && (v as any).nodeType === 'document') return htmlToText(richTextToHtml(v, new Map()));
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
};

// Asset ids referenced by the body rich text, so callers can resolve URLs in one batch.
export function collectAssetIds(entry: EntryLike, linkage: Linkage): string[] {
  const ids = new Set<string>();
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return;
    const id = n.data?.target?.sys?.linkType === 'Asset' ? n.data.target.sys.id : undefined;
    if (id) ids.add(id);
    (n.content ?? []).forEach(walk);
  };
  for (const fid of linkage.bodyFieldIds) for (const v of Object.values(entry.fields[fid] ?? {})) walk(v);
  return [...ids];
}

function hasOwnValue(entry: EntryLike, fieldId: string | undefined, locale: string): boolean {
  if (!fieldId) return false;
  const v = entry.fields[fieldId]?.[locale];
  return v !== undefined && v !== null && v !== '';
}

export function localesWithContent(entry: EntryLike, linkage: Linkage, locales: LocaleLike[]): string[] {
  const def = locales.find((l) => l.default)?.code;
  return locales
    .map((l) => l.code)
    .filter((code) => code === def || [linkage.titleField, ...linkage.bodyFieldIds].some((fid) => hasOwnValue(entry, fid, code)));
}

export function fillUrl(template: string | undefined, vars: { locale: string; slug: string; entryId: string }): string {
  if (!template) return '';
  return template
    .replace(/\{locale\}/g, encodeURIComponent(vars.locale))
    .replace(/\{slug\}/g, encodeURIComponent(vars.slug))
    .replace(/\{entryId\}/g, encodeURIComponent(vars.entryId));
}

export function renderArticles(entry: EntryLike, linkage: Linkage, locales: LocaleLike[], assetUrls: Map<string, string>): Article[] {
  return localesWithContent(entry, linkage, locales).map((code) => {
    const v = (fid?: string) => localizedValue(entry, fid, code, locales);
    const html = linkage.bodyFieldIds.map((fid) => valueToHtml(v(fid), assetUrls)).join('');
    const text = htmlToText(html);
    const title = asText(v(linkage.titleField)).trim() || entry.sys.id;
    const summary = asText(v(linkage.summaryField)).trim() || text.slice(0, 280);
    const rawTags = v(linkage.tagsField);
    return {
      locale: code,
      sfLocale: sfLocale(code),
      title,
      summary,
      html,
      text,
      brand: asText(v(linkage.brandField)).trim() || linkage.brand || '',
      tags: Array.isArray(rawTags) ? rawTags.map(String) : rawTags ? String(rawTags).split(',').map((s) => s.trim()) : [],
      url: fillUrl(linkage.urlTemplate, { locale: code, slug: asText(v(linkage.slugField)) || entry.sys.id, entryId: entry.sys.id }),
    };
  });
}

export function editUrl(spaceId: string, environmentId: string, entryId: string): string {
  return `https://app.contentful.com/spaces/${spaceId}/environments/${environmentId}/entries/${entryId}`;
}
