"""Demo seed: two more content types with different field shapes, plus linkages, to show that
several content types feed the one shared ContentfulKnowledge object, search index and retriever.

    CONTENTFUL_MANAGEMENT_TOKEN=... SPACE=... ENV=master python3 seed_multi_type.py

Idempotent: content types and entries are created or updated in place, then published.
"""
import json, os, time, urllib.request, urllib.error

TOK = os.environ['CONTENTFUL_MANAGEMENT_TOKEN']
B = f"https://api.contentful.com/spaces/{os.environ['SPACE']}/environments/{os.environ.get('ENV', 'master')}"


def cma(method, path, body=None, headers=None):
    h = {'Authorization': 'Bearer ' + TOK, 'Content-Type': 'application/vnd.contentful.management.v1+json', **(headers or {})}
    req = urllib.request.Request(B + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers=h)
    try:
        r = urllib.request.urlopen(req)
        t = r.read().decode()
        return r.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:2000]


def doc(*blocks): return {'nodeType': 'document', 'data': {}, 'content': list(blocks)}
def t(v, bold=False): return {'nodeType': 'text', 'value': v, 'marks': [{'type': 'bold'}] if bold else [], 'data': {}}
def p(*c): return {'nodeType': 'paragraph', 'data': {}, 'content': [t(x) if isinstance(x, str) else x for x in c]}
def ul(*items): return {'nodeType': 'unordered-list', 'data': {}, 'content': [{'nodeType': 'list-item', 'data': {}, 'content': [p(i)]} for i in items]}


def field(id, name, type, localized=True, required=False, **extra):
    return {'id': id, 'name': name, 'type': type, 'localized': localized, 'required': required, 'validations': [], 'disabled': False, 'omitted': False, **extra}


CONTENT_TYPES = {
    'productCareGuide': {
        'name': 'Product Care Guide',
        'description': 'Preparation, storage and safety guidance for a product',
        'displayField': 'productName',
        'fields': [
            field('productName', 'Product name', 'Symbol', required=True),
            field('slug', 'Slug', 'Symbol', localized=False, required=True),
            field('overview', 'Overview', 'Text'),
            field('preparation', 'Preparation', 'RichText'),
            field('storageAndSafety', 'Storage & safety', 'RichText'),
            field('brand', 'Brand', 'Symbol', localized=False),
        ],
    },
    'faqItem': {
        'name': 'FAQ Item',
        'description': 'Short question / answer pair',
        'displayField': 'question',
        'fields': [
            field('question', 'Question', 'Symbol', required=True),
            field('answer', 'Answer', 'Text', required=True),
            field('category', 'Category', 'Symbol', localized=False),
            field('brand', 'Brand', 'Symbol', localized=False),
        ],
    },
}

GUIDES = [
    {
        'id': 'gerberFormulaPrep', 'slug': 'prepare-infant-formula', 'brand': 'Gerber',
        'en-US': ('Gerber Good Start infant formula',
                  'How to safely prepare, store and discard prepared infant formula.',
                  doc(ul('Wash your hands and sterilise bottles before each feed.', 'Boil fresh water and let it cool for no more than 30 minutes (to about 70 °C).',
                         'Pour the water first, then add one level scoop per 60 ml. Shake well.', 'Cool to body temperature and test a few drops on your wrist.')),
                  doc(p(t('Use prepared formula within 1 hour', True), ' of the feed starting, and throw away any leftovers.'),
                      p('Store unopened tins in a cool, dry place. Once opened, use within 4 weeks. Never microwave bottles: it creates hot spots.'))),
        'fr-CA': ('Préparation pour nourrissons Gerber Good Start',
                  'Comment préparer, conserver et jeter en toute sécurité la préparation pour nourrissons.',
                  doc(ul('Lavez-vous les mains et stérilisez les biberons avant chaque boire.', 'Faites bouillir de l’eau fraîche et laissez-la refroidir au plus 30 minutes (environ 70 °C).',
                         'Versez d’abord l’eau, puis ajoutez une mesurette rase par 60 ml. Agitez bien.', 'Refroidissez à la température du corps et testez quelques gouttes sur votre poignet.')),
                  doc(p(t('Utilisez la préparation dans l’heure', True), ' suivant le début du boire et jetez les restes.'),
                      p('Conservez les boîtes non ouvertes dans un endroit frais et sec. Une fois ouverte, utilisez dans les 4 semaines. Ne réchauffez jamais un biberon au micro-ondes.'))),
    },
    {
        'id': 'nescafeGoldStorage', 'slug': 'nescafe-gold-storage', 'brand': 'Nescafé',
        'en-US': ('Nescafé Gold instant coffee',
                  'Keep instant coffee fresh and dry, and recycle the jar.',
                  doc(p('Use one heaped teaspoon (2 g) per 200 ml of hot, not boiling, water.')),
                  doc(p('Close the lid tightly after use and keep the jar away from steam and humidity. Clumping means moisture got in; the coffee is still safe but loses aroma.'),
                      p('The glass jar and the paper seal are recyclable; remove the plastic lid first.'))),
        'de-DE': ('Nescafé Gold löslicher Kaffee',
                  'Löskaffee frisch und trocken lagern und das Glas recyceln.',
                  doc(p('Einen gehäuften Teelöffel (2 g) auf 200 ml heißes, nicht kochendes Wasser.')),
                  doc(p('Den Deckel nach Gebrauch fest verschließen und das Glas vor Dampf und Feuchtigkeit schützen. Verklumpter Kaffee hat Feuchtigkeit gezogen; er ist unbedenklich, verliert aber Aroma.'),
                      p('Glas und Papiersiegel sind recycelbar; vorher den Kunststoffdeckel abnehmen.'))),
    },
]

FAQS = [
    {'id': 'faqPurinaSwitchFood', 'category': 'Pet food', 'brand': 'Purina',
     'en-US': ('How do I switch my dog to a new Purina food?',
               'Transition over 7 days: mix 25% new food on days 1–2, 50% on days 3–4, 75% on days 5–6, then 100%. A slower switch avoids stomach upset. If your dog has diarrhoea for more than 2 days, contact your vet.'),
     'fr-CA': ('Comment faire passer mon chien à une nouvelle nourriture Purina?',
               'Faites la transition sur 7 jours : 25 % de nouvelle nourriture les jours 1–2, 50 % les jours 3–4, 75 % les jours 5–6, puis 100 %. Si la diarrhée dure plus de 2 jours, consultez votre vétérinaire.')},
    {'id': 'faqCapsuleRecycling', 'category': 'Sustainability', 'brand': 'Nescafé Dolce Gusto',
     'en-US': ('Can I recycle Dolce Gusto capsules?',
               'Yes. Dolce Gusto capsules are recyclable through the brand’s free capsule recycling programme: collect used capsules in the recycling bag and drop them at a participating collection point. Do not put them in household recycling unless your municipality accepts them.'),
     'de-DE': ('Kann ich Dolce Gusto Kapseln recyceln?',
               'Ja. Gebrauchte Kapseln können über das kostenlose Recyclingprogramm der Marke an Sammelstellen abgegeben werden. Bitte nicht in den Gelben Sack, sofern Ihre Gemeinde das nicht ausdrücklich erlaubt.')},
]

LINKAGES = {
    'productCareGuideLinkage': {
        'contentTypeId': 'productCareGuide', 'isActive': True, 'syncDataCloud': True, 'syncKnowledge': True,
        'titleField': 'productName', 'summaryField': 'overview', 'bodyFieldIds': ['overview', 'preparation', 'storageAndSafety'],
        'brandField': 'brand', 'slugField': 'slug', 'urlTemplate': 'https://www.nestle.example/{locale}/care/{slug}', 'dataCategories': [],
    },
    'faqItemLinkage': {
        'contentTypeId': 'faqItem', 'isActive': True, 'syncDataCloud': True, 'syncKnowledge': True,
        'titleField': 'question', 'bodyFieldIds': ['answer'], 'brandField': 'brand', 'tagsField': None,
        'urlTemplate': 'https://www.nestle.example/{locale}/faq#{entryId}', 'dataCategories': [],
    },
}


def put_versioned(path, body, extra_headers=None):
    s, cur = cma('GET', path)
    h = dict(extra_headers or {})
    if s == 200:
        h['X-Contentful-Version'] = str(cur['sys']['version'])
    s, out = cma('PUT', path, body, h)
    assert s in (200, 201), (path, s, out)
    return out


def publish(path, obj):
    s, out = cma('PUT', path + '/published', None, {'X-Contentful-Version': str(obj['sys']['version'])})
    assert s == 200, (path, s, out)
    return out


def ensure_content_types():
    for ct_id, spec in CONTENT_TYPES.items():
        ct = put_versioned(f'/content_types/{ct_id}', spec)
        publish(f'/content_types/{ct_id}', ct)
        print('content type', ct_id)
    time.sleep(2)


def upsert_entry(entry_id, ct, fields):
    e = put_versioned(f'/entries/{entry_id}', {'fields': fields}, {'X-Contentful-Content-Type': ct})
    publish(f'/entries/{entry_id}', e)
    print('published', ct, entry_id, [k for k in next(iter(fields.values())).keys()])


def seed_content():
    for g in GUIDES:
        f = {'slug': {'en-US': g['slug']}, 'brand': {'en-US': g['brand']}, 'productName': {}, 'overview': {}, 'preparation': {}, 'storageAndSafety': {}}
        for loc in ('en-US', 'fr-CA', 'de-DE'):
            if loc in g:
                name, ov, prep, store = g[loc]
                f['productName'][loc], f['overview'][loc], f['preparation'][loc], f['storageAndSafety'][loc] = name, ov, prep, store
        upsert_entry(g['id'], 'productCareGuide', f)
    for q in FAQS:
        f = {'category': {'en-US': q['category']}, 'brand': {'en-US': q['brand']}, 'question': {}, 'answer': {}}
        for loc in ('en-US', 'fr-CA', 'de-DE'):
            if loc in q:
                f['question'][loc], f['answer'][loc] = q[loc]
        upsert_entry(q['id'], 'faqItem', f)


def seed_linkages():
    for entry_id, spec in LINKAGES.items():
        fields = {k: {'en-US': v} for k, v in spec.items() if v not in (None, '')}
        fields.setdefault('status', {'en-US': 'pending'})
        e = put_versioned(f'/entries/{entry_id}', {'fields': fields}, {'X-Contentful-Content-Type': 'agentforceSyncLinkage'})
        publish(f'/entries/{entry_id}', e)
        print('linkage', entry_id)


if __name__ == '__main__':
    ensure_content_types()
    seed_linkages()
    seed_content()
