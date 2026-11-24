/**
 * Sync registry for the Contentful -> Agentforce / Knowledge app: one entry per synced content
 * type. Written by app/src/locations/Page.tsx and read at runtime by the Functions
 * (app/functions/lib/linkage.ts parseLinkage) — keep field ids in lockstep.
 *
 *   npx contentful space migration --space-id $CF_SPACE_ID --environment-id master \
 *       migrations/01-agentforce-sync-linkage.js
 */
module.exports = function (migration) {
  const linkage = migration
    .createContentType('agentforceSyncLinkage')
    .name('Agentforce Sync Linkage')
    .description(
      'Routes one content type into Salesforce: Data 360 (search index + retriever for Agentforce grounding) and/or Salesforce Knowledge articles for service reps.'
    )
    .displayField('contentTypeId');

  linkage
    .createField('contentTypeId')
    .name('Content type id')
    .type('Symbol')
    .required(true)
    .localized(false)
    .validations([{ unique: true }]);
  linkage.createField('isActive').name('Active').type('Boolean').required(true).localized(false).defaultValue({ 'en-US': true });
  linkage
    .createField('syncDataCloud')
    .name('Sync to Data 360 (Agentforce retriever)')
    .type('Boolean')
    .required(true)
    .localized(false)
    .defaultValue({ 'en-US': true });
  linkage
    .createField('syncKnowledge')
    .name('Sync to Salesforce Knowledge')
    .type('Boolean')
    .required(true)
    .localized(false)
    .defaultValue({ 'en-US': false });

  linkage.createField('titleField').name('Title field id').type('Symbol').required(true).localized(false).defaultValue({ 'en-US': 'title' });
  linkage.createField('summaryField').name('Summary field id').type('Symbol').localized(false);
  linkage.createField('bodyFieldIds').name('Body field ids (in order)').type('Array').items({ type: 'Symbol' }).localized(false);
  linkage.createField('brandField').name('Brand field id').type('Symbol').localized(false);
  linkage.createField('brand').name('Static brand').type('Symbol').localized(false);
  linkage.createField('tagsField').name('Tags field id').type('Symbol').localized(false);
  linkage.createField('slugField').name('Slug field id').type('Symbol').localized(false);
  linkage
    .createField('urlTemplate')
    .name('Public URL template ({locale}, {slug}, {entryId})')
    .type('Symbol')
    .localized(false);
  linkage
    .createField('dataCategories')
    .name('Knowledge data categories (Group.Category)')
    .type('Array')
    .items({ type: 'Symbol' })
    .localized(false);

  linkage
    .createField('status')
    .name('Status')
    .type('Symbol')
    .localized(false)
    .validations([{ in: ['pending', 'ready', 'error'] }]);
  linkage.createField('lastError').name('Last error').type('Text').localized(false);
  linkage.createField('lastSyncedAt').name('Last synced at').type('Date').localized(false);

  for (const id of ['status', 'lastError', 'lastSyncedAt']) linkage.changeFieldControl(id, 'builtin', id === 'lastError' ? 'multipleLine' : id === 'status' ? 'dropdown' : 'datePicker', { helpText: 'Written by the app.' });
};
