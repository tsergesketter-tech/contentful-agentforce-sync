# contentful-agentforce-sync

Contentful app + Salesforce metadata that turn published Contentful content (FAQs, how-tos,
product care guides) into service knowledge in Salesforce. It feeds two places:

1. **Data 360 → Agentforce.** Each entry, per locale, becomes a row in one generic
   `ContentfulKnowledge` Ingestion API object. That feeds a DLO, then a DMO, then a **hybrid,
   multilingual search index**, and a **retriever** that grounds Agentforce agents (Retriever action
   / Answer Questions with Knowledge over a custom retriever).
2. **Salesforce Knowledge → service reps.** Each entry becomes one `Knowledge__kav` article (record
   type `Contentful`), and each translated locale becomes a Knowledge translation. Reps search,
   attach and share it from the Service Console. Service Replies and Knowledge-based agent
   grounding work too.

For the conceptual architecture, see **[ARCHITECTURE.md](ARCHITECTURE.md)**: principles, content model, data flow, consumers and the microcopy design.

Each content type gets either output or both. After the initial backfill, every
publish / unpublish / delete in Contentful syncs automatically. Contentful stays the source of
truth: edits made in Salesforce are overwritten on the next publish.

```
Entry.publish / unpublish / delete
        │  AppEventSubscription → Contentful Function (no public endpoint)
        ▼
agentforceContentSync
  ├─ find the active agentforceSyncLinkage for the entry's content type   (context.cma)
  ├─ render one article per locale with its own title/body                (lib/render.ts)
  │     Rich Text → HTML (assets resolved to URLs, embedded entries dropped)
  ├─ Data 360  (lib/dataCloud.ts)
  │     core client-credentials token → CDP token exchange →
  │     POST   {tenant}/api/v1/ingest/sources/{connector}/ContentfulKnowledge  one row per locale
  │     DELETE …?ids=…   on unpublish/delete, and for locales whose translation was removed
  └─ Knowledge (lib/knowledge.ts)
        POST /services/apexrest/contentful/knowledge/v1   one call per entry
        → ContentfulKnowledgeSync.cls: draft → publish new version → translations → archive
```

## Multiple content types, one index

Any number of content types can be linked: help articles, care guides, FAQs, recipes and so on.
Each linkage maps that type's own fields onto one **canonical article shape**: title, summary,
body, brand, tags, URL. The shape is the same for every type, so:

```
helpArticle ──┐   linkage: title / summary / body(RichText)
productCareGuide ─┤   linkage: productName / overview / overview+preparation+storageAndSafety
faqItem ──────┘   linkage: question / answer(Text)
          ▼
ContentfulKnowledge  (one Ingestion API object; ContentType__c + Locale__c on every row)
          ▼
Contentful_Knowledge search index (one, hybrid, multilingual)  →  one retriever  →  one data library
          ▼
Agentforce "Answer Questions with Knowledge" searches every type and language at once
Knowledge__kav articles also carry Contentful_Content_Type__c (filter list views / data categories by it)
```

Why one index and not one per type:

- A customer's question doesn't say which content type has the answer. One retriever ranks
  passages from every type against each other.
- Adding a content type needs no new Data 360 schema, stream, DMO, index, retriever or agent
  change. You only add a linkage.
- You can still scope results: every row carries `ContentType__c` and `Brand__c`, so a retriever
  filter, prompt template or the Page's test search can narrow to one type or brand.

Split into separate indexes (separate linkage → object names) only when types need different
chunking or embedding settings, or different access. For example, internal-only service
procedures should be a separate index with a separate retriever that only the employee agent
uses.

## Why both outputs?

| | Data 360 retriever | Salesforce Knowledge |
|---|---|---|
| Consumer | Agentforce (Service Agent, Employee Agent) | Service reps, Service Replies, Knowledge-grounded agents |
| Granularity | Chunked passages, hybrid vector + keyword | Whole articles, data categories, article numbers |
| Locales | One row per locale; the multilingual-e5-large embedding retrieves across languages | One article, one translation per active Knowledge language |
| Latency to live | Rows reach the DLO/DMO in ~2–3 min; the search index then re-chunks on its own incremental schedule (no public refresh API; ~30 min observed) | Immediate (published synchronously) |
| Lifecycle | Upsert / delete rows | New major version per publish; archive on unpublish |

## What's in here

```
app/                         Contentful app (Vite + React + Functions)
  functions/
    agentforceContentSync.ts App Event Handler: Entry.publish / unpublish / delete
    backfillContentType.ts   App Action: sync every published entry of a linked type (25 per call, continues with skip)
    provisionAgentforce.ts   App Action: idempotent status/provision checklist for the Salesforce side
    searchKnowledge.ts       App Action: the retriever's hybrid search (Page "Test retrieval") + per-type index coverage
    lib/render.ts            entry → per-locale article (title, summary, HTML, text, URL, brand, tags)
    lib/dataCloud.ts         Ingestion API push/delete + Connect REST provisioning (schema, DLO, stream, DMO, mapping, index, retriever)
    lib/knowledge.ts         client for the Apex endpoint
    lib/sync.ts              the engine shared by event handler and backfill
  src/locations/Page.tsx     admin page: setup checklist, link content types, map fields, backfill
  src/locations/ConfigScreen.tsx  Salesforce connection (instance URL, client id/secret)
force-app/                   SFDX metadata
  classes/ContentfulKnowledgeSync.cls   Apex REST endpoint for the Knowledge lifecycle (+ test, 91%)
  objects/Knowledge__kav/               Contentful_* fields + Contentful record type
  permissionsets/                       Contentful_Knowledge_Sync (integration user), Contentful_Knowledge_Reader (reps)
  externalClientApps/ + extlClntApp*    Contentful_Agentforce_Sync External Client App (client credentials)
migrations/01-agentforce-sync-linkage.js  the routing registry content type
migrations/demo/seed_multi_type.py         demo: Product Care Guide + FAQ Item types, entries (en/fr/de) and linkages
force-app/.../aiAuthoringBundles/Contentful_Care_Agent   Agent Script service agent grounded on the retriever
agent/Contentful_Care_Agent-AgentSpec.md   its spec
```

### The linkage (routing registry)

The app creates one `agentforceSyncLinkage` entry per synced content type, from the Page. It
holds:

- `contentTypeId`, `isActive`, `syncDataCloud`, `syncKnowledge`
- Field mapping:
  - `titleField`, `summaryField` (otherwise the first 280 characters of the body are used)
  - `bodyFieldIds` (Rich Text, long text or short text, concatenated in order)
  - `brandField` or a static `brand`, `tagsField`, `slugField`
- `urlTemplate`, the public article URL, with `{locale}`, `{slug}` and `{entryId}` placeholders.
  It's stored on the row and on the article for citations.
- `dataCategories`, Knowledge data categories as `Group.Category`
- `status` / `lastError` / `lastSyncedAt`, which the Functions write

### Locales

A locale gets an article only if it has its own title or body, so untranslated entries don't show
up as duplicate English articles in every market. Inside an article, untranslated fields follow
Contentful's fallback chain.

- **Data 360 record ids** are `{entryId}_{locale}`, for example `dolceGustoDescale_fr_CA`.
- **Knowledge** maps each Contentful locale to an active Knowledge language: an exact match first
  (`en-US` → `en_US`), then the base language (`fr-CA` → `fr`). Locales with no active language
  are reported as `skipped` and not sent. The space's default locale must map to an active
  language.

## Setup

### 1. Salesforce

Prerequisites:
- Data 360 provisioned
- Knowledge enabled, with Lightning Knowledge on and translations enabled for each language you
  sync
- The integration user has the **Knowledge User** feature license

Deploy the metadata, then assign the permission sets:

```bash
sf project deploy start -o <org> -d force-app
sf org assign permset -o <org> -n Contentful_Knowledge_Sync -b <integration user>
sf org assign permset -o <org> -n Contentful_Knowledge_Reader -b <rep users>
```

Edit `extlClntAppOauthPolicies/Contentful_Agentforce_Sync_oauthPlcy.ecaOauthPlcy-meta.xml`:
- `clientCredentialsFlowUser` is the user the Functions run as.
- `commaSeparatedProfile` pre-authorizes that user's profile. Without it the token call fails with
  `user is not admin approved to access this app`.

Then copy the consumer key and secret: Setup → External Client App Manager →
*Contentful Agentforce Sync* → Settings → OAuth Settings → Consumer Key and Secret.

### 2. Contentful

```bash
cd app && npm install && npm run build
npx contentful-app-scripts create-app-definition     # or reuse one; locations: app-config + page
npm run upload-ci                                     # CONTENTFUL_ORG_ID / CONTENTFUL_APP_DEF_ID / CONTENTFUL_ACCESS_TOKEN
npm run upsert-actions -- --ci --manifest-file contentful-app-manifest.json \
  --organization-id $CONTENTFUL_ORG_ID --definition-id $CONTENTFUL_APP_DEF_ID --token $CONTENTFUL_ACCESS_TOKEN
# publish/unpublish/delete → the event handler Function
curl -X PUT https://api.contentful.com/organizations/$CONTENTFUL_ORG_ID/app_definitions/$CONTENTFUL_APP_DEF_ID/event_subscription \
  -H "Authorization: Bearer $CONTENTFUL_ACCESS_TOKEN" -H 'Content-Type: application/vnd.contentful.management.v1+json' \
  -d '{"topics":["Entry.publish","Entry.unpublish","Entry.delete"],"functions":{"handler":{"sys":{"type":"Link","linkType":"Function","id":"agentforceContentSync"}}}}'
npx contentful-cli space migration --space-id <space> --environment-id master migrations/01-agentforce-sync-linkage.js
```

- **Hosts:** add your org's My Domain host and Data 360 tenant host to every function's
  `allowNetworks` in `contentful-app-manifest.json`. The Functions can't reach hosts that aren't
  listed.
- **Install:** install the app in the space, then fill in the config screen with the instance URL,
  client id and secret. Leave the connector name (`Contentful`) and data space (`default`) unless
  you need something else.

### 3. Provision and link

Open the app's page:

1. **Salesforce setup → Provision missing.** It creates, in order:
   - the Ingestion API connection and the `ContentfulKnowledge` schema
   - the DLO, data stream and DMO, plus the DLO→DMO mapping
   - the search index `Contentful_Knowledge`: HYBRID, multilingual-e5-large, passage extraction
     on `Body__c` with HTML stripped
   - the retriever

   It also checks the Knowledge endpoint and integration user.

   Run it again until every step says `done`:
   - A new **data stream** drops rows pushed before its first refresh, so backfill only after the
     stream step is `done`.
   - The **search index** takes a few minutes to reach READY, and the retriever is created after
     that.
2. **Add a content type.** Map its fields, choose Data 360 and/or Knowledge, then click
   **Save & backfill**.

### 4. Agentforce

- **Included agent:** `Contentful_Care_Agent` (Agent Script). It is grounded through a RETRIEVER
  Agentforce Data Library that wraps the retriever. To recreate it:
  ```bash
  sf agent adl create --source-type retriever --retriever-id <1Cx…> --name "Contentful Knowledge" \
    --developer-name Contentful_Knowledge_Library --description "Contentful help content"
  # put ARFPC_<libraryId> in the .agent knowledge: block, set default_agent_user, then
  sf project deploy start -m AiAuthoringBundle:Contentful_Care_Agent
  ```
  The Einstein Agent User needs `AgentforceServiceAgentUser`, `GenieUserEnhancedSecurity` and the
  `GenieDataPlatformStarterPsl` license.
- **Retriever (Data 360), any agent:** in Agentforce Builder, add the standard **Answer Questions with
  Knowledge** action and set its data source to the *Contentful Knowledge Retriever*. Or use the
  retriever in a Prompt Template (Einstein Studio → Retrievers) for a custom grounded action. The
  response includes `Url__c`, `Title__c` and `Locale__c` for citations.
- **Knowledge (reps):** the articles appear in the Knowledge component on cases, in Service
  Replies, and in the standard Knowledge ADL of the Service Agent. Give reps
  `Contentful_Knowledge_Reader`.

## Behavior notes and gotchas

- **Knowledge versioning.** Every publish creates a new major version of the article.
  Unpublishing or deleting the entry archives the article in all languages. Re-publishing an
  archived entry restores it (`editArchivedArticle`) and publishes a new version, keeping the same
  article number.
- **Removed translations.** If a locale's translation is removed in Contentful, the Data 360 row
  is deleted and the Knowledge translation for that language is removed.
- **`IsVisibleInApp`** isn't writeable through Apex DML. Channel visibility comes from the record
  type / org defaults.
- **Retriever output fields** must come from the source DMO (`ContentfulKnowledge__dlm`). Listing
  a chunk DMO field returns 400.
- **Search index REST.** Use the minimal create body, as in `createSearchIndex`. Sending explicit
  `indexConfiguration` plus `vectorEmbeddingRelatedFields` returns 500 or hangs.
- **Function timeout.** Functions have about 30 s. Listing data streams can take longer than that
  in large orgs, so the status check reads the DLO's `lastRefreshedDate` instead. Backfill runs 25
  entries per call (one Apex transaction each) and the Page continues with `skip`.
- **Rate limits.** `context.cma` doesn't retry 429s. `lib/sync.ts` wraps it with backoff.

## Tests

```bash
cd app && npm run typecheck && npx vitest run      # render.ts: rich text, locale selection, fallbacks
sf apex run test -o <org> -n ContentfulKnowledgeSyncTest -r human -w 10
```
