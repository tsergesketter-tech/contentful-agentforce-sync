@IsTest
private class ContentfulKnowledgeSyncTest {

    static String masterLang() {
        return [SELECT LanguageLocaleKey FROM Organization LIMIT 1].LanguageLocaleKey;
    }

    static ContentfulKnowledgeSync.SyncRequest request(String action, String body) {
        ContentfulKnowledgeSync.SyncRequest r = new ContentfulKnowledgeSync.SyncRequest();
        r.action = action;
        r.entryId = 'cfEntry123';
        r.contentType = 'faq';
        r.brand = 'Nescafe Dolce Gusto';
        r.sourceUrl = 'https://example.com/descaling';
        r.masterLanguage = masterLang();
        ContentfulKnowledgeSync.Version v = new ContentfulKnowledgeSync.Version();
        v.language = r.masterLanguage;
        v.title = 'How to descale your machine';
        v.summary = 'Descaling guide';
        v.body = body;
        r.versions = new List<ContentfulKnowledgeSync.Version>{ v };
        r.categories = new List<ContentfulKnowledgeSync.Category>();
        return r;
    }

    static List<Knowledge__kav> masters() {
        return [
            SELECT Id, PublishStatus, VersionNumber, Contentful_Body__c, KnowledgeArticleId
            FROM Knowledge__kav WHERE Contentful_Entry_Id__c = 'cfEntry123' AND IsMasterLanguage = true
            ORDER BY VersionNumber
        ];
    }

    @IsTest
    static void publishCreatesOnlineArticle() {
        ContentfulKnowledgeSync.SyncResponse res = ContentfulKnowledgeSync.handle(request('upsert', '<p>v1</p>'));
        System.assert(res.ok, String.join(res.errors, '; '));
        List<Knowledge__kav> m = masters();
        System.assertEquals(1, m.size());
        System.assertEquals('Online', m[0].PublishStatus);
        System.assertEquals('<p>v1</p>', m[0].Contentful_Body__c);
    }

    @IsTest
    static void republishCreatesNewVersion() {
        ContentfulKnowledgeSync.handle(request('upsert', '<p>v1</p>'));
        ContentfulKnowledgeSync.SyncResponse res = ContentfulKnowledgeSync.handle(request('upsert', '<p>v2</p>'));
        System.assert(res.ok, String.join(res.errors, '; '));
        Knowledge__kav online = [
            SELECT Contentful_Body__c FROM Knowledge__kav
            WHERE Contentful_Entry_Id__c = 'cfEntry123' AND IsMasterLanguage = true AND PublishStatus = 'Online'
        ];
        System.assertEquals('<p>v2</p>', online.Contentful_Body__c);
    }

    @IsTest
    static void archiveThenRepublishRestores() {
        ContentfulKnowledgeSync.handle(request('upsert', '<p>v1</p>'));
        ContentfulKnowledgeSync.SyncResponse a = ContentfulKnowledgeSync.handle(request('archive', null));
        System.assertEquals('archived', a.languages.get('*'));
        System.assertEquals(0, [SELECT COUNT() FROM Knowledge__kav WHERE Contentful_Entry_Id__c = 'cfEntry123' AND PublishStatus = 'Online']);

        ContentfulKnowledgeSync.SyncResponse res = ContentfulKnowledgeSync.handle(request('upsert', '<p>back</p>'));
        System.assert(res.ok, String.join(res.errors, '; '));
        System.assertEquals(1, [SELECT COUNT() FROM Knowledge__kav WHERE Contentful_Entry_Id__c = 'cfEntry123' AND PublishStatus = 'Online']);
    }

    @IsTest
    static void archiveUnknownEntryIsNoop() {
        ContentfulKnowledgeSync.SyncResponse a = ContentfulKnowledgeSync.handle(request('archive', null));
        System.assertEquals('not found', a.languages.get('*'));
    }

    @IsTest
    static void restEndpointReportsBadRequest() {
        RestContext.request = new RestRequest();
        RestContext.response = new RestResponse();
        RestContext.request.requestBody = Blob.valueOf('{"action":"upsert"}');
        ContentfulKnowledgeSync.doPost();
        System.assertEquals(400, RestContext.response.statusCode);
    }

    @IsTest
    static void restEndpointPublishes() {
        RestContext.request = new RestRequest();
        RestContext.response = new RestResponse();
        RestContext.request.requestBody = Blob.valueOf(JSON.serialize(request('upsert', '<p>rest</p>')));
        ContentfulKnowledgeSync.doPost();
        System.assertEquals(200, RestContext.response.statusCode, RestContext.response.responseBody.toString());
    }

    // Needs French active as a Knowledge language (it is in the demo org).
    @IsTest
    static void translationsPublishUpdateAndDrop() {
        ContentfulKnowledgeSync.SyncRequest r = request('upsert', '<p>en</p>');
        ContentfulKnowledgeSync.Version fr = new ContentfulKnowledgeSync.Version();
        fr.language = 'fr';
        fr.title = 'Comment détartrer';
        fr.summary = 'Guide';
        fr.body = '<p>fr1</p>';
        r.versions.add(fr);
        ContentfulKnowledgeSync.SyncResponse res = ContentfulKnowledgeSync.handle(r);
        System.assert(res.ok, String.join(res.errors, '; '));
        System.assertEquals('published', res.languages.get('fr'));

        fr.body = '<p>fr2</p>';
        res = ContentfulKnowledgeSync.handle(r);
        System.assert(res.ok, String.join(res.errors, '; '));
        Knowledge__kav t = [
            SELECT Contentful_Body__c FROM Knowledge__kav
            WHERE Contentful_Entry_Id__c = 'cfEntry123' AND Language = 'fr' AND PublishStatus = 'Online'
        ];
        System.assertEquals('<p>fr2</p>', t.Contentful_Body__c);

        r.versions.remove(1);
        res = ContentfulKnowledgeSync.handle(r);
        System.assertEquals('removed', res.languages.get('fr'), String.join(res.errors, '; '));
    }

    @IsTest
    static void contentfulLocalesResolveToKnowledgeLanguages() {
        Set<String> active = new Set<String>{ 'en_US', 'fr', 'es_MX', 'de' };
        System.assertEquals('en_US', ContentfulKnowledgeSync.resolveLanguage('en-US', active));
        System.assertEquals('fr', ContentfulKnowledgeSync.resolveLanguage('fr-CA', active));
        System.assertEquals('es_MX', ContentfulKnowledgeSync.resolveLanguage('es-MX', active));
        System.assertEquals('de', ContentfulKnowledgeSync.resolveLanguage('de-DE', active));
        System.assertEquals(null, ContentfulKnowledgeSync.resolveLanguage('ja-JP', active));
    }

    @IsTest
    static void unknownLocaleIsSkipped() {
        ContentfulKnowledgeSync.SyncRequest r = request('upsert', '<p>en</p>');
        ContentfulKnowledgeSync.Version v = new ContentfulKnowledgeSync.Version();
        v.language = 'xx-YY';
        v.title = 'x';
        r.versions.add(v);
        ContentfulKnowledgeSync.SyncResponse res = ContentfulKnowledgeSync.handle(r);
        System.assert(res.ok, String.join(res.errors, '; '));
        System.assert(res.languages.get('xx-YY').startsWith('skipped'));
    }

    @IsTest
    static void healthCheckReportsLanguages() {
        RestContext.request = new RestRequest();
        RestContext.response = new RestResponse();
        ContentfulKnowledgeSync.doGet();
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(RestContext.response.responseBody.toString());
        System.assertEquals(true, body.get('ok'));
        System.assert(!((List<Object>) body.get('languages')).isEmpty());
    }

    @IsTest
    static void urlNameIsSafe() {
        System.assertEquals('how-to-descale-abc-1', ContentfulKnowledgeSync.urlNameFor('How to: Descale!', 'abc.1'));
        System.assertEquals('abc', ContentfulKnowledgeSync.urlNameFor('', 'abc'));
    }
}
