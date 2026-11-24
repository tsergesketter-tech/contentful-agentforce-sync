import { describe, expect, it } from 'vitest';
import { collectAssetIds, htmlToText, localesWithContent, recordId, renderArticles, richTextToHtml } from './render';
import type { Linkage } from './linkage';

const locales = [
  { code: 'en-US', default: true, fallbackCode: null },
  { code: 'fr-CA', fallbackCode: 'en-US' },
  { code: 'de-DE', fallbackCode: 'en-US' },
];

const linkage: Linkage = {
  entryId: 'L1',
  contentTypeId: 'helpArticle',
  isActive: true,
  syncDataCloud: true,
  syncKnowledge: true,
  titleField: 'title',
  summaryField: 'summary',
  bodyFieldIds: ['body'],
  brand: 'Nescafé Dolce Gusto',
  slugField: 'slug',
  tagsField: 'tags',
  urlTemplate: 'https://example.com/{locale}/help/{slug}',
  dataCategories: [],
};

const doc = (...content: any[]) => ({ nodeType: 'document', data: {}, content });
const p = (...content: any[]) => ({ nodeType: 'paragraph', data: {}, content });
const t = (value: string, marks: string[] = []) => ({ nodeType: 'text', value, marks: marks.map((type) => ({ type })), data: {} });

describe('richTextToHtml', () => {
  it('renders blocks, marks, links, assets and drops embedded entries', () => {
    const html = richTextToHtml(
      doc(
        { nodeType: 'heading-2', data: {}, content: [t('Descale')] },
        p(t('Use '), t('only', ['bold']), t(' <citric> acid')),
        { nodeType: 'unordered-list', data: {}, content: [{ nodeType: 'list-item', data: {}, content: [p(t('Step 1'))] }] },
        p({ nodeType: 'hyperlink', data: { uri: 'https://x.test/a?b=1&c=2' }, content: [t('more')] }),
        { nodeType: 'embedded-asset-block', data: { target: { sys: { id: 'A1', linkType: 'Asset' } } }, content: [] },
        { nodeType: 'embedded-entry-block', data: { target: { sys: { id: 'E1', linkType: 'Entry' } } }, content: [] }
      ),
      new Map([['A1', 'https://images.ctfassets.net/a.png']])
    );
    expect(html).toBe(
      '<h2>Descale</h2><p>Use <strong>only</strong> &lt;citric&gt; acid</p><ul><li><p>Step 1</p></li></ul>' +
        '<p><a href="https://x.test/a?b=1&amp;c=2">more</a></p><p><img src="https://images.ctfassets.net/a.png" alt=""></p>'
    );
    expect(htmlToText(html)).toBe('Descale\nUse only <citric> acid\nStep 1\nmore');
  });
});

describe('renderArticles', () => {
  const entry = {
    sys: { id: 'E1' },
    fields: {
      title: { 'en-US': 'How to descale', 'fr-CA': 'Comment détartrer' },
      summary: { 'en-US': 'Every 3 months.' },
      body: { 'en-US': doc(p(t('English body'))), 'fr-CA': doc(p(t('Corps français'))) },
      slug: { 'en-US': 'descale' },
      tags: { 'en-US': ['descaling', 'maintenance'] },
    },
  };

  it('emits the default locale plus locales with their own title/body, not fallback-only ones', () => {
    expect(localesWithContent(entry, linkage, locales)).toEqual(['en-US', 'fr-CA']);
  });

  it('fills untranslated fields through the fallback chain', () => {
    const [en, fr] = renderArticles(entry, linkage, locales, new Map());
    expect(en).toMatchObject({ locale: 'en-US', sfLocale: 'en_US', title: 'How to descale', summary: 'Every 3 months.', text: 'English body' });
    expect(fr).toMatchObject({
      locale: 'fr-CA',
      title: 'Comment détartrer',
      summary: 'Every 3 months.',
      html: '<p>Corps français</p>',
      brand: 'Nescafé Dolce Gusto',
      tags: ['descaling', 'maintenance'],
      url: 'https://example.com/fr-CA/help/descale',
    });
  });

  it('derives a summary from the body when there is no summary field value', () => {
    const [en] = renderArticles({ ...entry, fields: { ...entry.fields, summary: undefined } }, linkage, locales, new Map());
    expect(en.summary).toBe('English body');
  });

  it('collects asset ids from body rich text', () => {
    const withAsset = {
      sys: { id: 'E2' },
      fields: { body: { 'en-US': doc({ nodeType: 'embedded-asset-block', data: { target: { sys: { id: 'A9', linkType: 'Asset' } } }, content: [] }) } },
    };
    expect(collectAssetIds(withAsset, linkage)).toEqual(['A9']);
  });

  it('builds Data 360 record ids per entry and locale', () => {
    expect(recordId('E1', 'fr-CA')).toBe('E1_fr_CA');
  });
});
