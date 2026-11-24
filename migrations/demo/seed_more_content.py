"""Demo seed, part 2: 14 more entries across helpArticle, productCareGuide and faqItem, in en-US
plus fr-CA / de-DE translations, so the shared index has a realistic spread of brands, types and
languages. Run after seed_multi_type.py (which creates the types and linkages).

    CONTENTFUL_MANAGEMENT_TOKEN=... SPACE=... ENV=master python3 seed_more_content.py

Publishing fires the app's event handler, which syncs each entry to Data 360 and Knowledge.
"""
import time
from seed_multi_type import doc, p, t, ul, upsert_entry


def ol(*items): return {'nodeType': 'ordered-list', 'data': {}, 'content': [{'nodeType': 'list-item', 'data': {}, 'content': [p(i)]} for i in items]}


# helpArticle: title, slug, summary, body (RichText), brand, tags
HELP = [
    {'id': 'dolceGustoBlinkingLight', 'slug': 'machine-light-blinking-red', 'brand': 'Nescafé Dolce Gusto', 'tags': ['troubleshooting', 'machine'],
     'en-US': ('Why is the light on my Dolce Gusto machine blinking red?',
               'A blinking red light means the machine needs attention: usually descaling, an empty tank or a jammed capsule holder.',
               doc(p('Check these in order:'),
                   ol('Refill the water tank above MIN and seat it firmly.', 'Remove the capsule holder and take out any used capsule.',
                      'If the light keeps blinking after 2 minutes, the machine is asking to be descaled. Run the descaling programme.',
                      'Still blinking? Unplug the machine for 20 minutes, then try again. If it continues, contact the care team.'))),
     'fr-CA': ('Pourquoi le voyant de ma machine Dolce Gusto clignote-t-il en rouge?',
               'Un voyant rouge clignotant signale que la machine a besoin d’attention : détartrage, réservoir vide ou porte-capsule coincé.',
               doc(p('Vérifiez dans cet ordre :'),
                   ol('Remplissez le réservoir au-dessus de MIN et enclenchez-le bien.', 'Retirez le porte-capsule et enlevez la capsule usagée.',
                      'Si le voyant clignote encore après 2 minutes, la machine demande un détartrage. Lancez le programme de détartrage.',
                      'Toujours? Débranchez la machine 20 minutes puis réessayez. Si le problème persiste, contactez le service client.')))},
    {'id': 'dolceGustoWeakCoffee', 'slug': 'coffee-too-weak-or-cold', 'brand': 'Nescafé Dolce Gusto', 'tags': ['troubleshooting', 'taste'],
     'en-US': ('My coffee is too weak or not hot enough',
               'Weak or lukewarm coffee usually comes from the wrong volume setting, limescale or a cold cup.',
               doc(ul('Use the volume recommended on the capsule box. More water makes a weaker drink.',
                      'Pre-warm your cup with hot water, especially for small espresso drinks.',
                      'Lukewarm drinks are a classic sign of limescale. Descale every 3–4 months, or monthly with hard water.',
                      'Only use genuine Dolce Gusto capsules. Other capsules may not pierce correctly.'))),
     'de-DE': ('Mein Kaffee ist zu schwach oder nicht heiß genug',
               'Schwacher oder lauwarmer Kaffee liegt meist an der Wassermenge, an Kalk oder an einer kalten Tasse.',
               doc(ul('Die auf der Kapselpackung empfohlene Wassermenge verwenden. Mehr Wasser ergibt ein schwächeres Getränk.',
                      'Die Tasse mit heißem Wasser vorwärmen, besonders bei kleinen Espressogetränken.',
                      'Lauwarme Getränke sind ein typisches Zeichen für Kalk. Alle 3–4 Monate entkalken, bei hartem Wasser monatlich.',
                      'Nur originale Dolce Gusto Kapseln verwenden.')))},
    {'id': 'gerberStageGuide', 'slug': 'which-gerber-stage', 'brand': 'Gerber', 'tags': ['infant feeding', 'solids'],
     'en-US': ('Which Gerber stage is right for my baby?',
               'Gerber foods are grouped by developmental stage, not strictly by age. Here is how to tell when your baby is ready for each.',
               doc(p(t('Supported Sitter (1st Foods): ', True), 'single-ingredient purées, usually around 6 months, when baby sits with support and shows interest in food.'),
                   p(t('Sitter (2nd Foods): ', True), 'smooth blends of several ingredients, once baby is comfortable with 1st Foods.'),
                   p(t('Crawler (3rd Foods): ', True), 'thicker textures with small soft pieces, usually from around 8 months.'),
                   p('Always talk to your pediatrician before starting solids, and introduce one new food at a time.'))),
     'fr-CA': ('Quelle étape Gerber convient à mon bébé?',
               'Les aliments Gerber sont classés par étape de développement plutôt que par âge.',
               doc(p(t('Assis avec soutien (1res purées) : ', True), 'purées à un ingrédient, vers 6 mois, quand bébé tient assis avec soutien.'),
                   p(t('Assis (2es purées) : ', True), 'mélanges lisses de plusieurs ingrédients.'),
                   p(t('Explorateur (3es purées) : ', True), 'textures plus épaisses avec petits morceaux tendres, vers 8 mois.'),
                   p('Consultez votre pédiatre avant de commencer les solides et introduisez un nouvel aliment à la fois.')))},
    {'id': 'purinaCatNotEating', 'slug': 'cat-not-eating-new-food', 'brand': 'Purina', 'tags': ['pet food', 'cats'],
     'en-US': ('My cat won’t eat the new Purina food',
               'Cats are creatures of habit. A slow switch and a few serving tricks usually help; a cat that stops eating entirely needs a vet.',
               doc(ul('Switch gradually over 7–10 days, mixing a little more new food into the old each day.',
                      'Serve wet food at room temperature; cold food smells less appealing.',
                      'Keep the bowl in the usual quiet spot, away from the litter box.',
                      'Do not leave wet food out for more than 4 hours.'),
                   p(t('Important: ', True), 'if your cat eats nothing for more than 24 hours, contact your vet. Cats can become seriously ill quickly when they stop eating.')))},
]

# productCareGuide: productName, slug, overview, preparation (RichText), storageAndSafety (RichText), brand
GUIDES = [
    {'id': 'kitkatStorage', 'slug': 'kitkat-storage', 'brand': 'KitKat',
     'en-US': ('KitKat chocolate wafer bars',
               'How to store KitKat so the chocolate stays glossy and the wafer stays crisp.',
               doc(p('Best enjoyed at room temperature. If chilled, let the bar sit out for 10 minutes before eating for the best snap.')),
               doc(p('Store in a cool, dry place between 15 and 20 °C, away from direct sunlight and strong smells.'),
                   p('A white, dusty coating is "bloom": cocoa butter or sugar rising to the surface after temperature changes. It is safe to eat but affects texture.'),
                   p('The wrapper is not household recyclable in most areas; check local guidance.'))),
     'fr-CA': ('Barres de gaufrette au chocolat KitKat',
               'Comment conserver KitKat pour que le chocolat reste brillant et la gaufrette croustillante.',
               doc(p('À déguster à température ambiante. Si la barre sort du réfrigérateur, attendez 10 minutes.')),
               doc(p('Conservez dans un endroit frais et sec, entre 15 et 20 °C, à l’abri du soleil.'),
                   p('Un voile blanc (« blanchiment ») apparaît après des variations de température. Il est sans danger mais modifie la texture.')))},
    {'id': 'nescafeColdBrew', 'slug': 'nescafe-iced-coffee', 'brand': 'Nescafé',
     'en-US': ('Nescafé iced coffee with instant coffee',
               'Make a smooth iced coffee in two minutes with Nescafé instant coffee.',
               doc(ol('Dissolve 2 teaspoons (4 g) of Nescafé in 2 tablespoons of hot water.', 'Add sugar or syrup now, while it is warm, if you like.',
                      'Fill a glass with ice and pour 150 ml of cold milk or water over it.', 'Pour the coffee concentrate over the top and stir.')),
               doc(p('Instant coffee dissolves fully in cold water too, but takes longer to stir in. Do not store prepared iced coffee for more than 24 hours in the fridge.'))),
     'de-DE': ('Nescafé Eiskaffee mit löslichem Kaffee',
               'In zwei Minuten einen milden Eiskaffee mit Nescafé zubereiten.',
               doc(ol('2 Teelöffel (4 g) Nescafé in 2 Esslöffeln heißem Wasser auflösen.', 'Nach Wunsch jetzt Zucker oder Sirup zugeben.',
                      'Ein Glas mit Eis füllen und 150 ml kalte Milch oder Wasser darübergießen.', 'Das Kaffeekonzentrat darübergießen und umrühren.')),
               doc(p('Zubereiteten Eiskaffee höchstens 24 Stunden im Kühlschrank aufbewahren.')))},
    {'id': 'gerberPuffsSafety', 'slug': 'gerber-puffs', 'brand': 'Gerber',
     'en-US': ('Gerber Puffs cereal snack',
               'Dissolvable snacks for babies who can sit up unassisted and are learning to self-feed.',
               doc(p('Place a few Puffs on a highchair tray and let baby pick them up. Puffs are designed to dissolve quickly with saliva.')),
               doc(p(t('Always supervise ', True), 'your child while eating, with baby seated upright. Never give Puffs in a car seat or while lying down.'),
                   p('Puffs are intended for crawlers, usually from about 8 months. Check with your pediatrician if you are unsure your baby is ready.'),
                   p('Once opened, close the canister tightly and use within 4 weeks.'))),
     'fr-CA': ('Collations Gerber Puffs',
               'Collations fondantes pour les bébés qui tiennent assis seuls et apprennent à manger seuls.',
               doc(p('Déposez quelques Puffs sur le plateau de la chaise haute et laissez bébé les saisir.')),
               doc(p(t('Surveillez toujours ', True), 'votre enfant pendant qu’il mange, assis bien droit. Jamais dans un siège d’auto ni couché.'),
                   p('Une fois ouvert, refermez bien le contenant et consommez dans les 4 semaines.')))},
    {'id': 'purinaDryFoodStorage', 'slug': 'purina-dry-food-storage', 'brand': 'Purina',
     'en-US': ('Purina dry dog and cat food',
               'Keep kibble fresh, tasty and safe from pests.',
               doc(p('Measure portions with the feeding guide on the bag and adjust for your pet’s weight and activity. Always provide fresh water.')),
               doc(p('Keep food in its original bag (it has a protective lining and the batch code), rolled closed, inside an airtight container.'),
                   p('Store below 27 °C in a dry place. Use within 6 weeks of opening.'),
                   p('Wash the bowl daily. Do not top up old kibble with new.'))),
     'fr-CA': ('Nourriture sèche Purina pour chiens et chats',
               'Gardez les croquettes fraîches et à l’abri des nuisibles.',
               doc(p('Mesurez les portions selon le guide sur le sac. Offrez toujours de l’eau fraîche.')),
               doc(p('Conservez la nourriture dans son sac d’origine, bien fermé, dans un contenant hermétique.'),
                   p('Rangez sous 27 °C dans un endroit sec. Utilisez dans les 6 semaines suivant l’ouverture.')))},
    {'id': 'dolceGustoMilkCapsules', 'slug': 'milk-capsules', 'brand': 'Nescafé Dolce Gusto',
     'en-US': ('Dolce Gusto milk capsules (cappuccino, latte)',
               'Two-capsule drinks: how to brew them in the right order and how to store milk capsules.',
               doc(ol('Insert the milk capsule first and brew it at the volume shown on the box.', 'Then insert the coffee capsule and brew it into the same cup.',
                      'Stir before drinking.')),
               doc(p('Milk capsules contain milk powder and do not need refrigeration. Store the box in a cool, dry place and use before the best-before date.'),
                   p('Milk capsules contain milk. They are not suitable for people with a milk allergy.'))),
     'de-DE': ('Dolce Gusto Milchkapseln (Cappuccino, Latte)',
               'Getränke aus zwei Kapseln: richtige Reihenfolge und Lagerung.',
               doc(ol('Zuerst die Milchkapsel einsetzen und mit der angegebenen Menge zubereiten.', 'Dann die Kaffeekapsel in dieselbe Tasse brühen.', 'Vor dem Trinken umrühren.')),
               doc(p('Milchkapseln enthalten Milchpulver und müssen nicht gekühlt werden. Kühl und trocken lagern.'),
                   p('Milchkapseln enthalten Milch und sind bei Milchallergie nicht geeignet.')))},
]

# faqItem: question, answer, category, brand
FAQS = [
    {'id': 'faqKitkatVegan', 'category': 'Ingredients', 'brand': 'KitKat',
     'en-US': ('Is there a vegan KitKat?',
               'Yes. KitKat V is made with a rice-based alternative to milk and is certified vegan. Classic KitKat contains milk and is not vegan. KitKat V is made in a factory that also handles milk, so it may contain traces; always check the label.'),
     'fr-CA': ('Existe-t-il un KitKat végane?',
               'Oui. KitKat V est fait avec une alternative au lait à base de riz et est certifié végane. Le KitKat classique contient du lait. KitKat V peut contenir des traces de lait; vérifiez toujours l’étiquette.')},
    {'id': 'faqNescafeCaffeine', 'category': 'Ingredients', 'brand': 'Nescafé',
     'en-US': ('How much caffeine is in a cup of Nescafé?',
               'A cup made with one teaspoon (2 g) of Nescafé Original contains about 60–70 mg of caffeine. Nescafé Decaf contains less than 3 mg per cup. Values vary by product; see the label.'),
     'de-DE': ('Wie viel Koffein enthält eine Tasse Nescafé?',
               'Eine Tasse mit einem Teelöffel (2 g) Nescafé Original enthält etwa 60–70 mg Koffein. Nescafé Entkoffeiniert enthält weniger als 3 mg pro Tasse.')},
    {'id': 'faqGerberRecall', 'category': 'Product safety', 'brand': 'Gerber',
     'en-US': ('How do I find out about a Gerber product recall?',
               'Current recalls are listed on the Gerber website under Product Safety. Check the lot code and best-before date printed on the bottom of the container. If your product matches, stop using it and contact the Gerber Parent Resource Center for a refund.'),
     'fr-CA': ('Comment savoir si un produit Gerber fait l’objet d’un rappel?',
               'Les rappels en cours sont publiés sur le site Gerber, section Sécurité des produits. Vérifiez le code de lot et la date « meilleur avant » sous le contenant. Si votre produit correspond, cessez de l’utiliser et contactez Gerber pour un remboursement.')},
    {'id': 'faqPurinaPuppyFood', 'category': 'Pet food', 'brand': 'Purina',
     'en-US': ('When should my puppy move to adult food?',
               'Small and medium breeds usually switch to adult food at about 12 months; large and giant breeds at 15–24 months, because they grow for longer. Make the switch gradually over 7 days and ask your vet about your puppy’s breed and growth.'),
     'fr-CA': ('Quand mon chiot doit-il passer à la nourriture pour adulte?',
               'Les petites et moyennes races passent généralement à la nourriture adulte vers 12 mois; les grandes et très grandes races entre 15 et 24 mois. Faites la transition sur 7 jours et demandez conseil à votre vétérinaire.')},
    {'id': 'faqDolceGustoWarranty', 'category': 'Warranty', 'brand': 'Nescafé Dolce Gusto',
     'en-US': ('What does the Dolce Gusto machine warranty cover?',
               'Machines are covered for 2 years from purchase against manufacturing defects. The warranty does not cover damage from limescale (when the machine was not descaled), drops or non-genuine capsules. Keep your proof of purchase and contact the care team to start a claim.'),
     'de-DE': ('Was deckt die Garantie der Dolce Gusto Maschine ab?',
               'Maschinen haben 2 Jahre Garantie ab Kaufdatum auf Herstellungsfehler. Nicht abgedeckt sind Schäden durch Kalk (wenn nicht entkalkt wurde), Stürze oder nicht originale Kapseln. Bewahren Sie den Kaufbeleg auf und wenden Sie sich an den Kundenservice.')},
]

LOCALES = ('en-US', 'fr-CA', 'de-DE')


def seed():
    for h in HELP:
        f = {'slug': {'en-US': h['slug']}, 'brand': {'en-US': h['brand']}, 'tags': {'en-US': h['tags']}, 'title': {}, 'summary': {}, 'body': {}}
        for loc in LOCALES:
            if loc in h:
                f['title'][loc], f['summary'][loc], f['body'][loc] = h[loc]
        upsert_entry(h['id'], 'helpArticle', f)
        time.sleep(1)
    for g in GUIDES:
        f = {'slug': {'en-US': g['slug']}, 'brand': {'en-US': g['brand']}, 'productName': {}, 'overview': {}, 'preparation': {}, 'storageAndSafety': {}}
        for loc in LOCALES:
            if loc in g:
                f['productName'][loc], f['overview'][loc], f['preparation'][loc], f['storageAndSafety'][loc] = g[loc]
        upsert_entry(g['id'], 'productCareGuide', f)
        time.sleep(1)
    for q in FAQS:
        f = {'category': {'en-US': q['category']}, 'brand': {'en-US': q['brand']}, 'question': {}, 'answer': {}}
        for loc in LOCALES:
            if loc in q:
                f['question'][loc], f['answer'][loc] = q[loc]
        upsert_entry(q['id'], 'faqItem', f)
        time.sleep(1)


if __name__ == '__main__':
    seed()
