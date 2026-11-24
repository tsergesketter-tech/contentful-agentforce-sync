/**
 * Contentful -> Salesforce Knowledge sync endpoint.
 *
 *   POST /services/apexrest/contentful/knowledge/v1
 *
 * One call per Contentful entry. The Contentful Function sends the entry already rendered (title,
 * summary, HTML body per language) and this class runs the whole Knowledge lifecycle in one
 * transaction, because translation publishing (completeTranslation) and archiving are only
 * exposed through KbManagement.PublishingService, not REST:
 *
 *   action=upsert   master: create, or open a draft of the online version (or the archived one),
 *                   write fields + data categories, publish as a new major version.
 *                   Each other language: open/submit a translation draft, write, complete.
 *                   Online translations for languages no longer in the request are removed.
 *   action=archive  archive the online article (all languages) and drop any open drafts.
 *
 * Articles are found by Contentful_Entry_Id__c on the master version (not unique: Knowledge copies
 * it onto every version and translation). Contentful stays the source of truth: any edit made in
 * Salesforce is overwritten on the next publish.
 */
@RestResource(urlMapping='/contentful/knowledge/v1')
global with sharing class ContentfulKnowledgeSync {

    global class Category {
        public String groupName;
        public String name;
    }

    global class Version {
        public String language;   // Salesforce code, e.g. en_US, fr
        public String title;
        public String summary;
        public String body;       // HTML
    }

    global class SyncRequest {
        public String action;          // upsert | archive
        public String entryId;
        public String contentType;
        public String brand;
        public String sourceUrl;
        public String editUrl;
        public String masterLanguage;  // must be an active Knowledge language
        public String recordType;      // developer name; defaults to Contentful
        public Boolean visibleInPkb;
        public Boolean visibleInCsp;
        public List<Category> categories;
        public List<Version> versions;
    }

    global class SyncResponse {
        public Boolean ok = true;
        public String action;
        public String knowledgeArticleId;
        public String articleNumber;
        public String masterVersionId;
        public Map<String, String> languages = new Map<String, String>();
        public List<String> errors = new List<String>();
    }

    @HttpPost
    global static void doPost() {
        RestResponse res = RestContext.response;
        res.addHeader('Content-Type', 'application/json');
        SyncResponse out;
        try {
            SyncRequest req = (SyncRequest) JSON.deserialize(RestContext.request.requestBody.toString(), SyncRequest.class);
            out = handle(req);
        } catch (Exception e) {
            out = new SyncResponse();
            out.ok = false;
            out.errors.add(e.getTypeName() + ': ' + e.getMessage());
        }
        res.statusCode = out.ok ? 200 : 400;
        res.responseBody = Blob.valueOf(JSON.serialize(out));
    }

    // Health check for the app's provisioning checklist: who the integration user is, which
    // Knowledge languages are active, and whether the record type is usable.
    @HttpGet
    global static void doGet() {
        RestResponse res = RestContext.response;
        res.addHeader('Content-Type', 'application/json');
        Id rt = recordTypeId(null);
        res.responseBody = Blob.valueOf(JSON.serialize(new Map<String, Object>{
            'ok' => true,
            'user' => UserInfo.getUserName(),
            'languages' => new List<String>(activeLanguages()),
            'recordTypeAvailable' => rt != null,
            'canCreate' => Schema.SObjectType.Knowledge__kav.isCreateable()
        }));
    }

    public static SyncResponse handle(SyncRequest req) {
        if (String.isBlank(req.entryId)) throw new SyncException('entryId is required');
        if (req.action == 'archive') return archive(req);
        if (req.action == 'upsert') return publishEntry(req);
        throw new SyncException('Unknown action: ' + req.action);
    }

    // ---------------------------------------------------------------- upsert

    static SyncResponse publishEntry(SyncRequest req) {
        SyncResponse out = new SyncResponse();
        out.action = 'upsert';
        if (req.versions == null || req.versions.isEmpty()) throw new SyncException('versions is required');

        // Languages arrive as Contentful locale codes (or Salesforce codes) and are resolved to
        // active Knowledge languages. Unmatched or duplicate locales are skipped, not fatal.
        Set<String> active = activeLanguages();
        String masterLang = resolveLanguage(req.masterLanguage, active);
        if (masterLang == null) throw new SyncException('masterLanguage ' + req.masterLanguage + ' is not an active Knowledge language');
        req.masterLanguage = masterLang;
        Version master = null;
        Map<String, Version> translations = new Map<String, Version>();
        for (Version v : req.versions) {
            String lang = resolveLanguage(v.language, active);
            if (lang == null) {
                out.languages.put(v.language, 'skipped: not an active Knowledge language');
                continue;
            }
            if (lang == masterLang ? master != null : translations.containsKey(lang)) {
                out.languages.put(v.language, 'skipped: duplicate of ' + lang);
                continue;
            }
            v.language = lang;
            if (lang == masterLang) master = v;
            else translations.put(lang, v);
        }
        if (master == null) throw new SyncException('No version for masterLanguage ' + req.masterLanguage);

        // Master version.
        Knowledge__kav latest = latestMaster(req.entryId);
        Id draftId;
        String urlName;
        if (latest == null) {
            urlName = urlNameFor(master.title, req.entryId);
            Knowledge__kav draft = new Knowledge__kav(Language = req.masterLanguage, UrlName = urlName);
            Id rt = recordTypeId(req.recordType);
            if (rt != null) draft.RecordTypeId = rt;
            applyFields(draft, req, master);
            insert draft;
            draftId = draft.Id;
        } else {
            urlName = latest.UrlName;
            draftId = openMasterDraft(latest);
            Knowledge__kav draft = new Knowledge__kav(Id = draftId);
            applyFields(draft, req, master);
            update draft;
        }
        setCategories(draftId, req.categories, out);

        Knowledge__kav draftRow = [SELECT KnowledgeArticleId FROM Knowledge__kav WHERE Id = :draftId];
        Id articleId = draftRow.KnowledgeArticleId;
        KbManagement.PublishingService.publishArticle(articleId, true);
        out.knowledgeArticleId = articleId;
        out.languages.put(req.masterLanguage, 'published');

        // Translations: only after the master is online.
        Map<String, Knowledge__kav> existing = new Map<String, Knowledge__kav>();
        Map<String, Knowledge__kav> existingDrafts = new Map<String, Knowledge__kav>();
        for (Knowledge__kav t : [
            SELECT Id, Language, PublishStatus FROM Knowledge__kav
            WHERE KnowledgeArticleId = :articleId AND IsMasterLanguage = false AND PublishStatus IN ('Online', 'Draft')
        ]) {
            if (t.PublishStatus == 'Draft') existingDrafts.put(t.Language, t);
            else existing.put(t.Language, t);
        }

        for (Version v : translations.values()) {
            try {
                Id tDraft;
                if (existingDrafts.containsKey(v.language)) tDraft = existingDrafts.get(v.language).Id;
                else if (existing.containsKey(v.language)) tDraft = KbManagement.PublishingService.editPublishedTranslation(articleId, v.language, false);
                else tDraft = KbManagement.PublishingService.submitForTranslation(articleId, v.language, UserInfo.getUserId(), null);
                Knowledge__kav t = new Knowledge__kav(Id = tDraft, UrlName = urlName);
                applyFields(t, req, v);
                update t;
                KbManagement.PublishingService.completeTranslation(tDraft);
                out.languages.put(v.language, 'published');
            } catch (Exception e) {
                out.languages.put(v.language, 'error');
                out.errors.add(v.language + ': ' + e.getMessage());
            }
        }

        // Languages Contentful no longer has a translation for.
        Set<String> gone = new Set<String>(existing.keySet());
        gone.addAll(existingDrafts.keySet());
        gone.removeAll(translations.keySet());
        for (String lang : gone) {
            try {
                Id d = existingDrafts.containsKey(lang)
                    ? existingDrafts.get(lang).Id
                    : KbManagement.PublishingService.editPublishedTranslation(articleId, lang, true);
                KbManagement.PublishingService.deleteDraftTranslation(d);
                out.languages.put(lang, 'removed');
            } catch (Exception e) {
                out.errors.add(lang + ' (remove): ' + e.getMessage());
            }
        }

        Knowledge__kav online = [
            SELECT Id, ArticleNumber FROM Knowledge__kav
            WHERE KnowledgeArticleId = :articleId AND IsMasterLanguage = true AND PublishStatus = 'Online' LIMIT 1
        ];
        out.masterVersionId = online.Id;
        out.articleNumber = online.ArticleNumber;
        out.ok = out.errors.isEmpty();
        return out;
    }

    // Draft to edit for an existing article: reuse an open draft, else open one from the online
    // version, else reopen the archived one (the entry was unpublished and is back).
    static Id openMasterDraft(Knowledge__kav latest) {
        if (latest.PublishStatus == 'Draft') return latest.Id;
        if (latest.PublishStatus == 'Online') return KbManagement.PublishingService.editOnlineArticle(latest.KnowledgeArticleId, false);
        // restoreOldVersion rejects an article whose latest version is archived; editArchivedArticle
        // opens a draft from it, which publishArticle brings back online as the next version.
        return KbManagement.PublishingService.editArchivedArticle(latest.KnowledgeArticleId);
    }

    // ---------------------------------------------------------------- archive

    static SyncResponse archive(SyncRequest req) {
        SyncResponse out = new SyncResponse();
        out.action = 'archive';
        Knowledge__kav latest = latestMaster(req.entryId);
        if (latest == null) {
            out.languages.put('*', 'not found');
            return out;
        }
        Id articleId = latest.KnowledgeArticleId;
        out.knowledgeArticleId = articleId;
        List<Knowledge__kav> drafts = [
            SELECT Id, IsMasterLanguage FROM Knowledge__kav WHERE KnowledgeArticleId = :articleId AND PublishStatus = 'Draft'
        ];
        Boolean hasOnline = [SELECT COUNT() FROM Knowledge__kav WHERE KnowledgeArticleId = :articleId AND PublishStatus = 'Online'] > 0;
        for (Knowledge__kav d : drafts) {
            if (d.IsMasterLanguage) {
                // A master draft beside an online version is a pending edit; with no online version
                // it is the whole (never-published) article.
                KbManagement.PublishingService.deleteDraftArticle(articleId);
            } else {
                KbManagement.PublishingService.deleteDraftTranslation(d.Id);
            }
        }
        if (hasOnline) {
            KbManagement.PublishingService.archiveOnlineArticle(articleId, null);
            out.languages.put('*', 'archived');
        } else {
            out.languages.put('*', drafts.isEmpty() ? 'already archived' : 'draft deleted');
        }
        return out;
    }

    // ---------------------------------------------------------------- helpers

    // Most recent master version for the entry, preferring Draft > Online > Archived.
    static Knowledge__kav latestMaster(String entryId) {
        Knowledge__kav best = null;
        Map<String, Integer> rank = new Map<String, Integer>{ 'Draft' => 3, 'Online' => 2, 'Archived' => 1 };
        for (Knowledge__kav k : [
            SELECT Id, KnowledgeArticleId, PublishStatus, VersionNumber, UrlName FROM Knowledge__kav
            WHERE Contentful_Entry_Id__c = :entryId AND IsMasterLanguage = true
            ORDER BY VersionNumber DESC LIMIT 20
        ]) {
            if (best == null || rank.get(k.PublishStatus) > rank.get(best.PublishStatus)) best = k;
        }
        return best;
    }

    static void applyFields(Knowledge__kav k, SyncRequest req, Version v) {
        k.Title = truncate(v.title, 255);
        k.Summary = truncate(v.summary, 1000);
        k.Contentful_Body__c = truncate(v.body, 131072);
        k.Contentful_Entry_Id__c = req.entryId;
        k.Contentful_Content_Type__c = truncate(req.contentType, 64);
        k.Contentful_Brand__c = truncate(req.brand, 128);
        k.Contentful_Source_Url__c = truncate(req.sourceUrl, 255);
        k.Contentful_Edit_Url__c = truncate(req.editUrl, 255);
        k.IsVisibleInPkb = req.visibleInPkb != false;
        k.IsVisibleInCsp = req.visibleInCsp != false;
    }

    // Replace the draft's data category selections. Bad group/category names are reported, not fatal.
    static void setCategories(Id draftId, List<Category> categories, SyncResponse out) {
        if (categories == null) return;
        delete [SELECT Id FROM Knowledge__DataCategorySelection WHERE ParentId = :draftId];
        for (Category c : categories) {
            try {
                insert new Knowledge__DataCategorySelection(ParentId = draftId, DataCategoryGroupName = c.groupName, DataCategoryName = c.name);
            } catch (Exception e) {
                out.errors.add('category ' + c.groupName + '.' + c.name + ': ' + e.getMessage());
            }
        }
    }

    static Set<String> activeLanguages() {
        Set<String> out = new Set<String>();
        for (Schema.PicklistEntry p : Knowledge__kav.Language.getDescribe().getPicklistValues()) {
            if (p.isActive()) out.add(p.getValue());
        }
        return out;
    }

    // en-US -> en_US if active, else the base language (fr-CA -> fr). Case-insensitive.
    @TestVisible
    static String resolveLanguage(String code, Set<String> active) {
        if (String.isBlank(code)) return null;
        Map<String, String> byLower = new Map<String, String>();
        for (String a : active) byLower.put(a.toLowerCase(), a);
        String c = code.replace('-', '_').toLowerCase();
        if (byLower.containsKey(c)) return byLower.get(c);
        String base = c.substringBefore('_');
        return byLower.get(base);
    }

    static Id recordTypeId(String developerName) {
        String dev = String.isBlank(developerName) ? 'Contentful' : developerName;
        Schema.RecordTypeInfo info = Schema.SObjectType.Knowledge__kav.getRecordTypeInfosByDeveloperName().get(dev);
        return info != null && info.isAvailable() ? info.getRecordTypeId() : null;
    }

    // URL names: letters, digits and hyphens, unique per language. The entry id suffix keeps them unique.
    @TestVisible
    static String urlNameFor(String title, String entryId) {
        String slug = String.isBlank(title) ? '' : title.toLowerCase().replaceAll('[^a-z0-9]+', '-').replaceAll('^-+|-+$', '');
        String suffix = entryId.replaceAll('[^A-Za-z0-9]+', '-');
        slug = slug.left(Math.max(0, 200 - suffix.length())).replaceAll('-+$', '');
        return String.isBlank(slug) ? suffix : slug + '-' + suffix;
    }

    static String truncate(String s, Integer max) {
        return s == null ? null : s.left(max);
    }

    public class SyncException extends Exception {}
}
