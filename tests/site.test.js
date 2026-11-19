'use strict';

// Vérification automatique du site statique : pages, liens, images, balises SEO,
// données structurées, flux Google Merchant, sitemap, sécurité du dépôt.
// Aucune dépendance : node --test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { builtinModules } = require('node:module');

const catalog = require('../assets/js/catalog.js');
const sync = require('../scripts/sync-catalog.js');
const indexnow = require('../scripts/ping-indexnow.js');

const ROOT = path.join(__dirname, '..');
const SITE = 'https://ipoolgofrance.fr';
const PAGES = [
  'index.html',
  'piscine-ronde-ipoolgo.html',
  'piscine-rectangulaire-ipoolgo.html',
  'comparatif-piscine-ipoolgo.html',
  'qui-sommes-nous.html',
  'mentions-legales.html',
  'cgv.html',
  'commande.html',
  'merci.html'
];
const NOINDEX = ['commande.html', 'merci.html', '404.html'];
const ALL_HTML = PAGES.concat(['404.html']);
// Adresse publique d'une page : sans « .html » (301 dans netlify.toml), sauf les pages hors index.
const pageUrl = (file) =>
  file === 'index.html' ? `${SITE}/` : NOINDEX.includes(file) ? `${SITE}/${file}` : `${SITE}/${file.replace(/\.html$/, '')}`;
// Fichier servi pour un chemin public.
const fileOf = (pathname) => (pathname === '/' ? 'index.html' : /\.[a-z]+$/.test(pathname) ? pathname.slice(1) : `${pathname.slice(1)}.html`);
const SIZE_COUNT = catalog.MODEL_IDS.reduce((sum, id) => sum + catalog.MODELS[id].sizes.length, 0);

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(ROOT, file));
const html = Object.fromEntries(ALL_HTML.map((file) => [file, exists(file) ? read(file) : '']));

function all(text, pattern) {
  const found = [];
  let match;
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  while ((match = re.exec(text))) found.push(match);
  return found;
}

function attr(tag, name) {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? match[1] : null;
}

function decode(text) {
  return text
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&#8239;/g, '\u202f')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

function jsonLdBlocks(source) {
  return all(source, /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/).map((match) => match[1]);
}

function nodesOfType(file, type) {
  const nodes = [];
  jsonLdBlocks(html[file]).forEach((block) => {
    const data = JSON.parse(block);
    (data['@graph'] || [data]).forEach((node) => {
      const types = [].concat(node['@type'] || []);
      if (types.includes(type)) nodes.push(node);
    });
  });
  return nodes;
}

// Contrôle minimal de bonne formation XML : balises équilibrées, une seule racine, « & » échappés.
function assertWellFormedXml(xml, label) {
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/, `${label} : déclaration XML`);
  const body = xml.replace(/^<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(body), `${label} : « & » non échappé`);
  const stack = [];
  let roots = 0;
  let cursor = 0;
  const tagPattern = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g;
  let match;
  while ((match = tagPattern.exec(body))) {
    const between = body.slice(cursor, match.index);
    assert.ok(!between.includes('<') && !between.includes('>'), `${label} : balise mal formée près de « ${between.trim().slice(0, 40)} »`);
    if (!stack.length) assert.equal(between.trim(), '', `${label} : texte hors de la racine`);
    cursor = tagPattern.lastIndex;
    const [, closing, name, , selfClosing] = match;
    if (closing) {
      assert.equal(stack.pop(), name, `${label} : </${name}> ne ferme pas la bonne balise`);
    } else if (!selfClosing) {
      if (!stack.length) roots += 1;
      stack.push(name);
    }
  }
  assert.equal(body.slice(cursor).trim(), '', `${label} : contenu après la racine`);
  assert.deepEqual(stack, [], `${label} : balises non fermées`);
  assert.equal(roots, 1, `${label} : une seule racine`);
}

function repoFiles(dir = ROOT) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.git' || entry.name === 'node_modules') return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? repoFiles(full) : [path.relative(ROOT, full)];
  });
}

const TEXT_FILE = /\.(html|css|js|json|xml|txt|toml|md|svg|example)$|^\.gitignore$/;

// ------------------------------------------------------------------ pages

test('les pages demandées existent, en français, avec leurs balises', () => {
  PAGES.forEach((file) => {
    assert.ok(exists(file), `${file} manquant`);
    const source = html[file];
    assert.match(source, /^<!doctype html>\n<html lang="fr">/, `${file} : doctype et lang="fr"`);
    assert.match(source, /<meta charset="utf-8">/, `${file} : charset`);
    assert.match(source, /<meta name="viewport" content="width=device-width, initial-scale=1">/, `${file} : viewport`);

    const title = /<title>([^<]+)<\/title>/.exec(source);
    assert.ok(title, `${file} : title`);
    const titleLength = decode(title[1]).length;
    assert.ok(titleLength >= 20 && titleLength <= 65, `${file} : title de ${titleLength} caractères`);

    const description = /<meta name="description" content="([^"]+)">/.exec(source);
    assert.ok(description, `${file} : meta description`);
    if (!NOINDEX.includes(file)) {
      const length = decode(description[1]).length;
      assert.ok(length >= 110 && length <= 165, `${file} : description de ${length} caractères`);
    }

    ['og:type', 'og:title', 'og:description', 'og:url', 'og:image', 'og:locale', 'og:site_name'].forEach((property) => {
      assert.match(source, new RegExp(`<meta property="${property}" content="[^"]+">`), `${file} : ${property}`);
    });
    ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'].forEach((name) => {
      assert.match(source, new RegExp(`<meta name="${name}" content="[^"]+">`), `${file} : ${name}`);
    });
  });
});

test('chaque page a une canonique sur https://ipoolgofrance.fr et la bonne directive robots', () => {
  ALL_HTML.forEach((file) => {
    const source = html[file];
    const canonicals = all(source, /<link rel="canonical" href="([^"]+)">/);
    assert.equal(canonicals.length, 1, `${file} : une seule canonique`);
    const expected = pageUrl(file);
    assert.equal(canonicals[0][1], expected, `${file} : canonique`);
    assert.equal(/<meta property="og:url" content="([^"]+)">/.exec(source)[1], expected, `${file} : og:url`);

    const robots = /<meta name="robots" content="([^"]+)">/.exec(source)[1];
    if (NOINDEX.includes(file)) assert.match(robots, /^noindex/, `${file} doit être en noindex`);
    else assert.match(robots, /^index, follow/, `${file} doit être indexable`);
  });
  ALL_HTML.forEach((file) => {
    assert.ok(!/ipoolgofrance\.com/.test(html[file]), `${file} ne doit pas citer le domaine .com`);
  });
});

test('un seul H1 par page et une hiérarchie de titres sans saut', () => {
  ALL_HTML.forEach((file) => {
    // Sur merci.html, un seul des panneaux d'état est visible à la fois : un H1 par panneau.
    const scopes = file === 'merci.html' ? all(html[file], /<section data-etat="[^"]+"[\s\S]*?<\/section>/).map((m) => m[0]) : [html[file]];
    scopes.forEach((scope) => {
      const levels = all(scope, /<h([1-6])[\s>]/).map((match) => Number(match[1]));
      assert.equal(levels.filter((level) => level === 1).length, 1, `${file} : un seul H1`);
      assert.equal(levels[0], 1, `${file} : le premier titre est le H1`);
      levels.forEach((level, index) => {
        if (index) assert.ok(level - levels[index - 1] <= 1, `${file} : saut de h${levels[index - 1]} à h${level}`);
      });
    });
  });
});

test('toutes les images ont un alt, des dimensions et le bon mode de chargement', () => {
  ALL_HTML.forEach((file) => {
    all(html[file], /<img\b[^>]*>/).forEach(([tag]) => {
      const alt = attr(tag, 'alt');
      const logo = /logo-ipoolgo/.test(tag);
      assert.ok(alt !== null && alt.trim().length >= (logo ? 4 : 8), `${file} : alt manquant ou trop court sur ${tag.slice(0, 90)}`);
      assert.ok(attr(tag, 'width') && attr(tag, 'height'), `${file} : width/height manquants sur ${tag.slice(0, 90)}`);
      if (attr(tag, 'fetchpriority') === 'high') {
        assert.equal(attr(tag, 'loading'), null, `${file} : l'image prioritaire ne doit pas être en lazy`);
      } else if (!logo) {
        assert.equal(attr(tag, 'loading'), 'lazy', `${file} : loading="lazy" manquant sur ${tag.slice(0, 90)}`);
      }
    });
  });
  const heroes = all(html['index.html'], /<img\b[^>]*fetchpriority="high"[^>]*>/);
  assert.equal(heroes.length, 1, 'index.html : une seule image Hero en fetchpriority="high"');
});

test('aucun fichier local manquant : images, CSS, JS, polices, liens internes et ancres', () => {
  const ids = Object.fromEntries(ALL_HTML.map((file) => [file, new Set(all(html[file], /\sid="([^"]+)"/).map((m) => m[1]))]));

  ALL_HTML.forEach((file) => {
    const source = html[file].replace(/<link rel="canonical"[^>]*>/, '');
    const urls = new Set();
    all(source, /\s(?:href|src)="([^"]+)"/).forEach((m) => urls.add(m[1]));
    all(source, /\s(?:srcset|imagesrcset)="([^"]+)"/).forEach((m) => {
      m[1].split(',').forEach((candidate) => urls.add(candidate.trim().split(/\s+/)[0]));
    });

    urls.forEach((raw) => {
      const url = decode(raw);
      if (/^(mailto:|tel:)/.test(url)) return;
      if (/^https?:\/\//.test(url)) {
        if (url.startsWith(SITE)) assert.fail(`${file} : lien interne absolu ${url}, utilisez un chemin relatif à la racine`);
        return;
      }
      assert.ok(url.startsWith('/') || url.startsWith('#'), `${file} : URL relative inattendue ${url}`);
      const [pathname, hash] = url.split('#');
      const clean = pathname.split('?')[0];
      const target = url.startsWith('#') ? file : clean === '/' ? 'index.html' : clean.slice(1);
      assert.ok(exists(target), `${file} : ${url} pointe vers un fichier absent`);
      if (hash && target.endsWith('.html')) {
        assert.ok(ids[target].has(hash), `${file} : l'ancre #${hash} n'existe pas dans ${target}`);
      }
    });
  });

  all(read('assets/css/style.css'), /url\(["']?([^"')]+)["']?\)/).forEach((m) => {
    if (m[1].startsWith('data:')) return;
    const target = m[1].startsWith('/') ? m[1].slice(1) : path.posix.join('assets/css', m[1]);
    assert.ok(exists(target), `style.css : ${m[1]} absent`);
  });
});

test('maillage interne : menu, pied de page et liens entre pages', () => {
  const required = ['/piscine-ronde-ipoolgo.html', '/piscine-rectangulaire-ipoolgo.html', '/comparatif-piscine-ipoolgo.html', '/cgv.html', '/mentions-legales.html'];
  ALL_HTML.forEach((file) => {
    required.forEach((href) => {
      assert.ok(html[file].includes(`href="${href}"`), `${file} : lien vers ${href} manquant`);
    });
    assert.match(html[file], /data-cookies-ouvrir/, `${file} : lien « Gérer les cookies »`);
  });
});

// ------------------------------------------------------------------ données structurées

test('tous les blocs JSON-LD passent JSON.parse et portent @context et @type', () => {
  let count = 0;
  ALL_HTML.forEach((file) => {
    jsonLdBlocks(html[file]).forEach((block) => {
      let data;
      assert.doesNotThrow(() => { data = JSON.parse(block); }, `${file} : JSON-LD invalide`);
      assert.equal(data['@context'], 'https://schema.org', `${file} : @context`);
      assert.ok(data['@type'] || data['@graph'], `${file} : @type`);
      count += 1;
    });
  });
  assert.ok(count >= 14, `seulement ${count} blocs JSON-LD`);
});

test('JSON-LD : Organization/Store (SAS Virage), Product + Offer + AggregateRating + Review, FAQPage', () => {
  const organisations = ['OnlineStore', 'Store', 'Organization'].flatMap((type) => nodesOfType('index.html', type));
  assert.ok(organisations.length >= 1, 'index.html : Organization ou Store');
  assert.match(JSON.stringify(organisations[0]), /Virage/i, 'le vendeur SAS Virage doit apparaître');

  ['index.html', 'piscine-ronde-ipoolgo.html', 'piscine-rectangulaire-ipoolgo.html', 'comparatif-piscine-ipoolgo.html'].forEach((file) => {
    const faq = nodesOfType(file, 'FAQPage');
    assert.equal(faq.length, 1, `${file} : FAQPage`);
    const visible = all(html[file], /<details class="faq__item">/).length;
    assert.equal(faq[0].mainEntity.length, visible, `${file} : la FAQ balisée doit refléter la FAQ visible`);
    faq[0].mainEntity.forEach((item) => {
      assert.equal(item['@type'], 'Question');
      assert.ok(item.name && item.acceptedAnswer && item.acceptedAnswer.text, `${file} : question incomplète`);
    });
  });

  catalog.MODEL_IDS.forEach((id) => {
    const model = catalog.MODELS[id];
    const file = fileOf(model.page);
    [file].forEach((page) => {
      // ProductGroup est un sous-type de Product : une variante Product + Offer par taille.
      const product = nodesOfType(page, 'ProductGroup').find((node) => node.productGroupID === model.sku);
      assert.ok(product, `${page} : ProductGroup ${model.sku}`);
      assert.equal(product.brand.name, 'iPoolGo');
      assert.ok(product.name && product.description && product.image.length, `${page} : nom, description et image`);

      const variants = product.hasVariant;
      assert.equal(variants.length, model.sizes.length, `${page} : une variante par taille (${id})`);
      model.sizes.forEach((size) => {
        const variant = variants.find((item) => item.sku === `${model.sku}-${size.id}`);
        assert.ok(variant, `${page} : variante ${size.id}`);
        assert.equal(variant['@type'], 'Product');
        assert.ok(variant.name && variant.size && variant.image.length, `${page} : variante ${size.id} incomplète`);
        const offer = variant.offers;
        assert.equal(offer['@type'], 'Offer');
        assert.equal(Number(offer.price), size.price, `${page} : prix de ${id} ${size.id}`);
        assert.equal(offer.url, `${SITE}${model.page}?taille=${size.id}`);
        assert.equal(offer.priceCurrency, 'EUR');
        assert.equal(offer.availability, 'https://schema.org/InStock');
        assert.ok(offer.url.startsWith(`${SITE}/`), `${page} : URL d'offre absolue`);
      });

      assert.equal(product.aggregateRating['@type'], 'AggregateRating');
      const reviews = [].concat(product.review || []);
      assert.ok(reviews.length >= 1, `${page} : au moins un avis balisé (${id})`);
      assert.equal(Number(product.aggregateRating.ratingCount || product.aggregateRating.reviewCount), reviews.length, `${page} : le nombre de notes doit égaler le nombre d'avis notés`);
      reviews.forEach((review) => {
        assert.ok(review.author.name && review.reviewBody && review.reviewRating.ratingValue, `${page} : avis incomplet`);
        assert.ok(decode(html[file]).replace(/\s+/g, ' ').includes(review.author.name), `${file} : l'avis de ${review.author.name} doit être visible sur la page`);
      });
    });
  });
});

// ------------------------------------------------------------------ catalogue, flux, sitemap

test('les pages, llms.txt et le flux sont synchronisés avec le catalogue', () => {
  PAGES.forEach((file) => {
    assert.equal(sync.syncHtml(html[file]), html[file], `${file} désynchronisé : lancez npm run sync`);
  });
  assert.equal(sync.syncRegions(read('llms.txt')), read('llms.txt'), 'llms.txt désynchronisé');
  assert.equal(sync.renderFeed(), read('google-shopping.xml'), 'google-shopping.xml désynchronisé');
});

test('adresse de contact : contact@gigifrance.fr partout, plus aucune trace de l\'ancienne', () => {
  ALL_HTML.concat(['llms.txt', 'assets/js/app.js', 'netlify/lib/emails.js']).forEach((file) => {
    assert.ok(!read(file).includes('contact@piscineipoolgo.com'), `${file} : ancienne adresse de contact`);
  });
  ALL_HTML.forEach((file) => {
    assert.ok(read(file).includes('href="mailto:contact@gigifrance.fr"'), `${file} : lien mailto manquant`);
  });
});

test('piscine test à 1 € retirée : plus commandable, plus aucune trace', () => {
  assert.equal(catalog.quote('ronde', 'test-1m'), null);
  catalog.MODEL_IDS.forEach((id) => {
    assert.ok(!('testSizes' in catalog.MODELS[id]), `${id} : tailles de test`);
  });
  PAGES.concat(['llms.txt', 'google-shopping.xml', 'sitemap.xml']).forEach((file) => {
    assert.ok(!/test-1m|Piscine test/i.test(read(file)), `${file} : la piscine test ne doit pas apparaître`);
  });
});

test('les prix « dès … € » des balises meta correspondent au catalogue', () => {
  const minimum = Math.min(...catalog.MODEL_IDS.flatMap((id) => catalog.MODELS[id].sizes.map((size) => size.price)));
  catalog.MODEL_IDS.forEach((id) => {
    const model = catalog.MODELS[id];
    const min = Math.min(...model.sizes.map((size) => size.price));
    const source = html[fileOf(model.page)];
    all(source, /<meta (?:name|property)="[^"]*(?:description|title)" content="([^"]+)">/).forEach((m) => {
      const price = /dès ([\d\s\u00a0\u202f]+)\s?€/.exec(decode(m[1]));
      if (price) assert.equal(Number(price[1].replace(/\D/g, '')), min, `${model.page} : prix d'appel`);
    });
  });
  all(html['index.html'], /<meta (?:name|property)="[^"]*(?:description|title)" content="([^"]+)">/).forEach((m) => {
    const price = /dès ([\d\s\u00a0\u202f]+)\s?€/.exec(decode(m[1]));
    if (price) assert.equal(Number(price[1].replace(/\D/g, '')), minimum, 'index.html : prix d\'appel');
  });
});

test('google-shopping.xml : RSS 2.0 bien formé, une entrée par modèle et par taille', () => {
  const xml = read('google-shopping.xml');
  assertWellFormedXml(xml, 'google-shopping.xml');
  assert.match(xml, /<rss version="2\.0" xmlns:g="http:\/\/base\.google\.com\/ns\/1\.0">/);

  const items = all(xml, /<item>([\s\S]*?)<\/item>/).map((m) => m[1]);
  assert.equal(items.length, SIZE_COUNT, 'une entrée par taille');
  const field = (item, name) => {
    const match = new RegExp(`<g:${name}>([^<]*)</g:${name}>`).exec(item);
    return match ? decode(match[1]) : null;
  };
  const seen = new Set();

  catalog.MODEL_IDS.forEach((id) => {
    const model = catalog.MODELS[id];
    model.sizes.forEach((size) => {
      const item = items.find((entry) => field(entry, 'id') === `${model.sku}-${size.id}`);
      assert.ok(item, `entrée ${model.sku}-${size.id}`);
      seen.add(field(item, 'id'));
      assert.match(field(item, 'title'), new RegExp(`^Piscine gonflable rigide iPoolGo ${model.shortName} .+ en Drop-Stitch$`));
      assert.ok(!/offert/i.test(field(item, 'title')), 'pas de texte promotionnel dans le titre');
      assert.equal(all(item, /<g:product_highlight>/).length, catalog.GIFTS.length, 'cadeaux en product_highlight');
      assert.ok(field(item, 'title').length <= 150, 'titre de 150 caractères au plus');
      assert.match(field(item, 'description'), /offerts/);
      assert.equal(field(item, 'price'), `${size.price.toFixed(2)} EUR`);
      assert.equal(field(item, 'availability'), 'in_stock');
      assert.equal(field(item, 'brand'), 'iPoolGo');
      assert.equal(field(item, 'condition'), 'new');
      assert.equal(field(item, 'identifier_exists'), 'no');

      const link = new URL(field(item, 'link'));
      assert.equal(link.origin, SITE);
      assert.ok(exists(fileOf(link.pathname)), `page ${link.pathname}`);
      assert.equal(link.searchParams.get('taille'), size.id, 'le lien présélectionne la taille');
      if (link.pathname === '/') assert.equal(link.searchParams.get('modele'), id);
      else assert.equal(link.pathname, model.page);

      const image = new URL(field(item, 'image_link'));
      assert.equal(image.origin, SITE, 'image en URL absolue');
      assert.ok(exists(image.pathname.slice(1)), `image ${image.pathname}`);
      assert.match(image.pathname, /\.(jpg|png)$/, 'image principale en JPG ou PNG');

      const shipping = /<g:shipping>([\s\S]*?)<\/g:shipping>/.exec(item)[1];
      assert.match(shipping, /<g:country>FR<\/g:country>/);
      assert.match(shipping, new RegExp(`<g:price>${catalog.SHIPPING_EUR.toFixed(2)} EUR</g:price>`));
    });
  });
  assert.equal(seen.size, SIZE_COUNT, 'identifiants uniques');
});

test('sitemap.xml : bien formé, pages indexables uniquement, URL canoniques', () => {
  const xml = read('sitemap.xml');
  assertWellFormedXml(xml, 'sitemap.xml');
  const urls = all(xml, /<loc>([^<]+)<\/loc>/).map((m) => m[1]);
  const expected = PAGES.filter((file) => !NOINDEX.includes(file)).map(pageUrl);
  assert.deepEqual(urls.slice().sort(), expected.slice().sort());
  all(xml, /<lastmod>([^<]+)<\/lastmod>/).forEach((m) => assert.match(m[1], /^\d{4}-\d{2}-\d{2}$/));
});

test('robots.txt : robots de recherche et d\'IA autorisés, sitemap déclaré', () => {
  const robots = read('robots.txt');
  ['GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'Claude-SearchBot', 'PerplexityBot', 'Google-Extended', 'Googlebot', 'Bingbot'].forEach((bot) => {
    assert.match(robots, new RegExp(`^User-agent: ${bot}$`, 'm'), `robots.txt : ${bot}`);
  });
  assert.match(robots, /^User-agent: \*\nAllow: \/$/m);
  assert.match(robots, /^Sitemap: https:\/\/ipoolgofrance\.fr\/sitemap\.xml$/m);
  assert.ok(!/^Disallow: \/$/m.test(robots), 'aucun blocage global');
});

test('llms.txt : présent, structuré et à jour des prix', () => {
  const llms = read('llms.txt');
  assert.match(llms, /^# iPoolGo France\n\n> /);
  assert.match(llms, /revendeur officiel/i);
  catalog.MODEL_IDS.forEach((id) => {
    catalog.MODELS[id].sizes.forEach((size) => {
      assert.ok(llms.includes(`${size.price.toFixed(2)} EUR`), `llms.txt : prix de ${id} ${size.id}`);
    });
  });
  all(llms, /\]\((https:\/\/ipoolgofrance\.fr[^)]*)\)/).forEach((m) => {
    const pathname = new URL(m[1]).pathname;
    assert.ok(exists(fileOf(pathname)), `llms.txt : ${m[1]}`);
  });
});

test('IndexNow : fichier de clé de 32 caractères hexadécimaux et charge utile complète', () => {
  const payload = indexnow.buildPayload();
  assert.match(payload.key, /^[a-f0-9]{32}$/);
  assert.equal(read(`${payload.key}.txt`).trim(), payload.key);
  assert.equal(payload.host, 'ipoolgofrance.fr');
  assert.equal(payload.keyLocation, `${SITE}/${payload.key}.txt`);
  assert.equal(payload.urlList.length, PAGES.filter((file) => !NOINDEX.includes(file)).length);
  assert.equal(indexnow.ENDPOINT, 'https://api.indexnow.org/indexnow');
});

// ------------------------------------------------------------------ parcours de commande

test('formulaire de commande : champs, case CGV obligatoire, bouton bloqué par défaut', () => {
  const source = html['commande.html'];
  const form = /<form[^>]*data-commande[\s\S]*?<\/form>/.exec(source);
  assert.ok(form, 'formulaire de commande');
  ['nom', 'prenom', 'email', 'telephone', 'adresse', 'codePostal', 'ville'].forEach((name) => {
    const input = new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(form[0]);
    assert.ok(input, `champ ${name}`);
    assert.match(input[0], /\srequired/, `champ ${name} obligatoire`);
    assert.ok(attr(input[0], 'autocomplete'), `champ ${name} : autocomplete`);
  });
  const checkbox = /<input[^>]*name="cgv"[^>]*>/.exec(form[0]);
  assert.match(checkbox[0], /type="checkbox"/);
  assert.match(checkbox[0], /\srequired/);
  const label = decode(form[0]).replace(/<[^>]+>/g, '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ');
  assert.ok(label.includes('J’ai lu et j’accepte les Conditions Générales de Vente de SAS Virage'), 'libellé de la case CGV');
  assert.match(form[0], /<a href="\/cgv\.html" target="_blank" rel="noopener">/, 'lien CGV dans un nouvel onglet');
  assert.match(form[0], /<button[^>]*data-payer[^>]*\sdisabled/, 'bouton de paiement désactivé par défaut');
  assert.match(form[0], /name="site_web"/, 'champ piège anti-robots');
});

test('commande sur sa propre page : liens « Commander », logos de paiement, avis sans date', () => {
  ALL_HTML.forEach((file) => {
    assert.ok(!/href="\/(?:\?[^"]*)?#commander"/.test(html[file]), `${file} : lien de commande vers l'accueil`);
  });
  ['piscine-ronde-ipoolgo.html', 'piscine-rectangulaire-ipoolgo.html'].forEach((file) => {
    const links = all(html[file], /<a\b[^>]*data-commander[^>]*>/).map((m) => attr(m[0], 'href'));
    assert.ok(links.length >= 2, `${file} : boutons Commander`);
    links.forEach((href) => assert.match(decode(href), /^\/commande\.html\?modele=[a-z]+&taille=[0-9x]+$/, `${file} : ${href}`));
  });
  ['CB', 'Visa', 'Mastercard', 'Apple Pay'].forEach((name) => {
    assert.match(html['commande.html'], new RegExp(`aria-label="(?:Carte bancaire )?${name}"`), `logo ${name}`);
  });
  assert.match(html['commande.html'], /3D Secure/);
  ['index.html', 'piscine-ronde-ipoolgo.html', 'piscine-rectangulaire-ipoolgo.html'].forEach((file) => {
    assert.ok(!/<footer><strong>[^<]*<\/strong>, <time/.test(html[file]), `${file} : date sur un avis`);
    assert.ok(!/"datePublished"/.test(html[file]), `${file} : date dans le JSON-LD des avis`);
  });
});

test('merci.html : tous les états du paiement et le bouton « Réessayer le paiement »', () => {
  const source = html['merci.html'];
  ['verification', 'paye', 'attente', 'echec', 'inconnu', 'erreur'].forEach((state) => {
    assert.match(source, new RegExp(`data-etat="${state}"`), `état ${state}`);
  });
  const retries = all(source, /<a class="bouton[^"]*" href="\/commande\.html">Réessayer le paiement<\/a>/);
  assert.ok(retries.length >= 3, 'bouton « Réessayer le paiement » vers le formulaire');
});

test('pompe et filtration offertes, revendeur officiel et SAS Virage visibles sur les pages de vente', () => {
  ['index.html', 'piscine-ronde-ipoolgo.html', 'piscine-rectangulaire-ipoolgo.html'].forEach((file) => {
    const text = decode(html[file]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.match(text, /[Oo]ffert/, `${file} : pompe offerte`);
    assert.match(text, /pompe/i, `${file} : pompe`);
    assert.match(text, /filtration/i, `${file} : filtration`);
    assert.match(text, /revendeur officiel/i, `${file} : revendeur officiel`);
    assert.match(text, /SAS Virage/, `${file} : SAS Virage`);
    assert.match(text, /avis/i, `${file} : avis`);
  });
});

// ------------------------------------------------------------------ sécurité et propreté

test('compatibles avec la CSP : ni script en ligne, ni attribut style, ni gestionnaire on*', () => {
  ALL_HTML.forEach((file) => {
    const source = html[file];
    all(source, /<script\b([^>]*)>([\s\S]*?)<\/script>/).forEach((m) => {
      if (/type="application\/ld\+json"/.test(m[1])) return;
      assert.match(m[1], /\ssrc="\/assets\/js\/[a-z-]+\.js"/, `${file} : script externe inattendu`);
      assert.equal(m[2].trim(), '', `${file} : script en ligne`);
    });
    assert.ok(!/<style\b/.test(source), `${file} : balise <style>`);
    assert.ok(!/\sstyle="/.test(source), `${file} : attribut style`);
    assert.ok(!/\son[a-z]+="/.test(source), `${file} : gestionnaire d'événement en ligne`);
    all(source, /<(?:script|link|img|source|iframe)\b[^>]*\s(?:src|href)="(https?:[^"]+)"/).forEach((m) => {
      assert.ok(m[1].startsWith(SITE), `${file} : ressource tierce chargée d'office : ${m[1]}`);
    });
  });
});

test('Google Analytics : rien dans le HTML, chargement conditionné au consentement dans app.js', () => {
  ALL_HTML.forEach((file) => {
    assert.ok(!/googletagmanager|google-analytics|gtag\(/.test(html[file]), `${file} : Google Analytics ne doit pas être dans le HTML`);
    assert.match(html[file], /data-cookies-choix="refuse"[^>]*>Refuser<\/button>\s*<button[^>]*data-cookies-choix="accepte"[^>]*>Accepter<\/button>/, `${file} : bandeau cookies`);
  });
  const buttons = all(html['index.html'], /<button[^>]*class="([^"]*)"[^>]*data-cookies-choix/).map((m) => m[1]);
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0], buttons[1], 'boutons Accepter et Refuser de même poids visuel');

  const app = read('assets/js/app.js');
  assert.match(app, /var GA_MEASUREMENT_ID = 'G-[A-Z0-9]{6,}';/);
  assert.equal(all(app, /googletagmanager\.com/).length, 1, 'un seul point de chargement de gtag.js');
  assert.match(app, /begin_checkout/);
  assert.match(app, /localStorage/);
});

test('aucun secret dans le dépôt, aucune clé ni API de paiement côté navigateur', () => {
  const files = repoFiles();
  assert.ok(!files.some((file) => /(^|\/)\.env($|\.(?!example$))/.test(file)), 'aucun fichier .env');
  assert.ok(!files.some((file) => file.startsWith('node_modules/')), 'aucun node_modules');

  const patterns = [
    [/xkeysib-[a-f0-9]{20,}/i, 'clé API Brevo'],
    [/xsmtpsib-[a-f0-9]{20,}/i, 'clé SMTP Brevo'],
    [/gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/, 'jeton GitHub'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'clé privée'],
    [/AKIA[0-9A-Z]{16}/, 'clé AWS'],
    [/\b(sk|rk)_(live|test)_[A-Za-z0-9]{20,}/, 'clé secrète Stripe'],
    [/whsec_[A-Za-z0-9]{20,}/, 'secret de webhook Stripe']
  ];
  files.filter((file) => TEXT_FILE.test(file) && !file.startsWith('tests/')).forEach((file) => {
    const content = read(file);
    patterns.forEach(([pattern, label]) => {
      assert.ok(!pattern.test(content), `${file} : ${label} détectée`);
    });
  });

  const env = read('.env.example');
  ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'BREVO_API_KEY'].forEach((name) => {
    assert.match(env, new RegExp(`^${name}=$`, 'm'), `.env.example : ${name} doit être listée sans valeur`);
  });
  ['SELLER_EMAIL', 'SENDER_EMAIL'].forEach((name) => {
    assert.match(env, new RegExp(`^# ${name}=`, 'm'), `.env.example : ${name} doit être listée en option`);
  });

  const front = ALL_HTML.concat(['assets/js/app.js', 'assets/js/catalog.js', 'assets/css/style.css']);
  front.forEach((file) => {
    const content = read(file);
    assert.ok(!/STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|BREVO_API_KEY|api\.stripe\.com|api\.brevo\.com|Bearer |api-key|\b(sk|rk)_(live|test)_/i.test(content), `${file} : référence à une clé ou à une API privée côté navigateur`);
  });

  const ignore = read('.gitignore');
  assert.match(ignore, /^\.env$/m);
  assert.match(ignore, /^node_modules\/$/m);
});

test('dépôt 100 % vanilla : aucune dépendance npm, aucun outil de build ou de scraping', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(Object.keys(pkg.dependencies || {}), []);
  assert.deepEqual(Object.keys(pkg.devDependencies || {}), []);
  const files = repoFiles();
  assert.ok(!files.some((file) => /package-lock\.json|yarn\.lock|pnpm-lock/.test(file)), 'aucun fichier de verrouillage');
  files.filter((file) => /\.(js|json|toml)$/.test(file) && !file.startsWith('tests/')).forEach((file) => {
    assert.ok(!/playwright|puppeteer|scrapling|cheerio/i.test(read(file)), `${file} : reste d'outil de scraping ou de test navigateur`);
  });
  files.filter((file) => file.endsWith('.js')).forEach((file) => {
    all(read(file), /require\(['"]([^'"]+)['"]\)/).forEach((m) => {
      assert.ok(m[1].startsWith('.') || m[1].startsWith('node:') || builtinModules.includes(m[1].replace(/^node:/, '')), `${file} : dépendance externe ${m[1]}`);
    });
  });
});

test('netlify.toml : redirections 301 du .com vers le .fr, en-têtes de sécurité, cache, XML', () => {
  const toml = read('netlify.toml');
  ['https://ipoolgofrance.com/*', 'https://www.ipoolgofrance.com/*', 'https://www.ipoolgofrance.fr/*'].forEach((from) => {
    const block = new RegExp(`from = "${from.replace(/[.*/]/g, '\\$&')}"\\n\\s+to = "https://ipoolgofrance\\.fr/:splat"\\n\\s+status = 301\\n\\s+force = true`);
    assert.match(toml, block, `redirection 301 depuis ${from}`);
  });
  ['Content-Security-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options = "nosniff"', 'X-Frame-Options = "DENY"', 'Referrer-Policy', 'Permissions-Policy'].forEach((header) => {
    assert.ok(toml.includes(header), `en-tête ${header}`);
  });
  const csp = /Content-Security-Policy = "([^"]+)"/.exec(toml)[1];
  assert.match(csp, /default-src 'self'/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), 'CSP sans unsafe-inline ni unsafe-eval');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(toml, /for = "\/assets\/images\/\*"\n\s+\[headers\.values\]\n\s+Cache-Control = "public, max-age=31536000, immutable"/);
  ['/sitemap.xml', '/google-shopping.xml'].forEach((file) => {
    assert.match(toml, new RegExp(`for = "${file.replace(/[./]/g, '\\$&')}"\\n\\s+\\[headers\\.values\\]\\n\\s+Content-Type = "application/xml; charset=utf-8"`), `Content-Type XML pour ${file}`);
  });
  assert.match(toml, /functions = "netlify\/functions"/);
  assert.ok(!/(KEY|TOKEN|SECRET|PASSWORD)\s*=\s*"[^"]+"/i.test(toml), 'aucune clé dans netlify.toml');
});

test('typographie : pas d\'espace insécable littérale dans le JavaScript, pas de tiret cadratin dans les pages', () => {
  repoFiles().filter((file) => file.endsWith('.js')).forEach((file) => {
    assert.ok(!/[\u00a0\u202f]/.test(read(file)), `${file} : espace insécable littérale (utilisez \\u00a0 ou \\u202f)`);
  });
  ALL_HTML.forEach((file) => {
    assert.ok(!/[—–]/.test(html[file]), `${file} : tiret cadratin ou demi-cadratin`);
  });
});

// ------------------------------------------------------------------ serveur local

test('serveur local : les pages et leurs ressources répondent en 200', async () => {
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.xml': 'application/xml', '.txt': 'text/plain', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.join(ROOT, path.normalize(pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const assets = new Set(['/sitemap.xml', '/google-shopping.xml', '/robots.txt', '/llms.txt', '/favicon.ico']);
    for (const file of PAGES) {
      const response = await fetch(`${base}/${file === 'index.html' ? '' : file}`);
      assert.equal(response.status, 200, `${file} : HTTP ${response.status}`);
      assert.match(response.headers.get('content-type'), /text\/html/);
      const body = await response.text();
      assert.match(body, /<h1[\s>]/, `${file} : H1 servi`);
      all(body, /\s(?:href|src)="(\/assets\/[^"#?]+)"/).forEach((m) => assets.add(m[1]));
      all(body, /\s(?:srcset|imagesrcset)="([^"]+)"/).forEach((m) => {
        m[1].split(',').forEach((candidate) => assets.add(candidate.trim().split(/\s+/)[0]));
      });
    }
    assert.ok(assets.size > 20, 'ressources détectées');
    for (const asset of assets) {
      const response = await fetch(base + asset);
      assert.equal(response.status, 200, `${asset} : HTTP ${response.status}`);
      await response.arrayBuffer();
    }
    assert.equal((await fetch(`${base}/page-inexistante.html`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('administration : page noindex, hors sitemap, sans analytics ni script en ligne, en-têtes Netlify', () => {
  const source = read('admin.html');
  assert.match(source, /<meta name="robots" content="noindex, nofollow">/);
  assert.ok(!/app\.js|googletagmanager|gtag/.test(source), 'pas de Google Analytics ni de bandeau cookies');
  assert.ok(!/<script\b(?![^>]*\ssrc="\/assets\/js\/admin\.js")[^>]*>/.test(source), 'seul admin.js est chargé');
  assert.ok(!/<style\b|\sstyle="|\son[a-z]+="/.test(source), 'compatible CSP');
  assert.ok(!read('sitemap.xml').includes('admin'), 'absente du sitemap');
  const toml = read('netlify.toml');
  assert.match(toml, /for = "\/admin\*"\n  \[headers\.values\]\n    X-Robots-Tag = "noindex, nofollow"\n    Cache-Control = "no-store"/);
});
