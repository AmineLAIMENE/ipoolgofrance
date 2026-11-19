#!/usr/bin/env node
'use strict';

/*
 * Répercute le catalogue (assets/js/catalog.js) dans les fichiers statiques :
 *   - listes de tailles et tableaux de prix des pages (zones <!-- catalog:nom -->)
 *   - montants isolés (balises portant data-catalog="clé")
 *   - offres des données structurées Product et bloc FAQPage (relu depuis la FAQ visible)
 *   - google-shopping.xml et la section prix de llms.txt
 *
 *   node scripts/sync-catalog.js           met les fichiers à jour
 *   node scripts/sync-catalog.js --check   signale les fichiers désynchronisés (code de sortie 1)
 */

const fs = require('fs');
const path = require('path');
const catalog = require('../assets/js/catalog.js');

const ROOT = path.join(__dirname, '..');
const SITE = catalog.SITE_URL;
const PAGES = [
  'index.html',
  'piscine-ronde-ipoolgo.html',
  'piscine-rectangulaire-ipoolgo.html',
  'comparatif-piscine-ipoolgo.html',
  'mentions-legales.html',
  'cgv.html',
  'commande.html',
  'merci.html'
];

const NBSP = '\u00a0';
const eur = catalog.formatEUR;

function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Espaces insécables autour des unités et des signes, pour l'affichage HTML.
function nb(text) {
  return String(text).replace(/ (m|×|€)/g, NBSP + '$1').replace(/(Ø|×) /g, '$1' + NBSP);
}

// Dans le HTML, les espaces insécables sont écrites en entités pour rester visibles à la relecture.
function entities(html) {
  return html.replace(/\u00a0/g, '&nbsp;').replace(/\u202f/g, '&#8239;');
}

function minPrice(model) {
  return Math.min.apply(null, model.sizes.map((size) => size.price));
}

function maxPrice(model) {
  return Math.max.apply(null, model.sizes.map((size) => size.price));
}

function sizeName(model, size) {
  return size.name ? `${size.name} ${catalog.footprintLabel(size)}` : catalog.sizeLabel(size);
}

function sizeDetail(model, size) {
  const people = `${size.people} personnes`;
  return size.name ? `hauteur ${catalog.heightLabel(size)}, ${people}` : people;
}

function productUrl(model, size) {
  return `${SITE}${model.page}?taille=${size.id}`;
}

function litres(volume) {
  return String(volume).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f') + NBSP + 'L';
}

// ------------------------------------------------------------------ fragments HTML

function renderSizes(modelId) {
  const model = catalog.getModel(modelId);
  const labels = model.sizes
    .map((size) => {
      const checked = size.id === model.defaultSize ? ' checked' : '';
      return [
        '<label class="taille">',
        `<input type="radio" name="taille-${model.id}" value="${size.id}"${checked}>`,
        `<span class="taille__nom">${esc(nb(sizeName(model, size)))}</span>`,
        `<span class="taille__info">${esc(nb(sizeDetail(model, size)))}</span>`,
        `<span class="taille__prix">${esc(eur(size.price))}</span>`,
        '</label>'
      ].join('');
    })
    .join('\n');
  return entities(labels);
}

function renderTable(modelId) {
  const model = catalog.getModel(modelId);
  const isRound = Boolean(model.sizes[0].diameter);
  const head = isRound
    ? ['Diamètre', 'Hauteur', 'Baigneurs', 'Volume d’eau', 'Poids à vide', 'Emprise au sol', 'Prix TTC']
    : ['Modèle', 'Longueur × largeur', 'Hauteur', 'Baigneurs', 'Volume d’eau', 'Emprise au sol', 'Prix TTC'];

  const rows = model.sizes.map((size) => {
    const link = `<a href="/commande.html?modele=${model.id}&amp;taille=${size.id}" aria-label="Commander la ${esc(model.shortName)} ${esc(catalog.sizeLabel(size))}">Commander</a>`;
    const area = `${String(catalog.groundArea(size)).replace('.', ',')}${NBSP}m²`;
    const volume = `environ ${litres(size.volume)}`;
    const price = `<td class="tableau__prix"><strong>${esc(eur(size.price))}</strong> ${link}</td>`;
    const cells = isRound
      ? [
          `<th scope="row">${esc(nb(catalog.footprintLabel(size)))}</th>`,
          `<td>${esc(nb(catalog.heightLabel(size)))}</td>`,
          `<td>${esc(size.people)}</td>`,
          `<td>${volume}</td>`,
          `<td>${size.weight ? size.weight + NBSP + 'kg' : 'sur demande'}</td>`,
          `<td>${area}</td>`,
          price
        ]
      : [
          `<th scope="row">${esc(size.name)}</th>`,
          `<td>${esc(nb(catalog.footprintLabel(size)))}</td>`,
          `<td>${esc(nb(catalog.heightLabel(size)))}</td>`,
          `<td>${esc(size.people)}</td>`,
          `<td>${volume}</td>`,
          `<td>${area}</td>`,
          price
        ];
    return `<tr>${cells.join('')}</tr>`;
  });

  return entities([
    '<thead><tr>' + head.map((label) => `<th scope="col">${label}</th>`).join('') + '</tr></thead>',
    '<tbody>',
    rows.join('\n'),
    '</tbody>'
  ].join('\n'));
}

const REGIONS = {
  'tailles-ronde': () => renderSizes('ronde'),
  'tailles-rectangulaire': () => renderSizes('rectangulaire'),
  'tableau-ronde': () => renderTable('ronde'),
  'tableau-rectangulaire': () => renderTable('rectangulaire'),
  'prix-llms': renderLlmsPrices
};

// Montants isolés : <span data-catalog="ronde.min">999 €</span>
function catalogValues() {
  const values = {
    livraison: eur(catalog.SHIPPING_EUR),
    cadeaux: eur(catalog.giftsTotal()),
    'nb-tailles': String(catalog.MODEL_IDS.reduce((sum, id) => sum + catalog.MODELS[id].sizes.length, 0))
  };
  catalog.GIFTS.forEach((gift) => {
    values[gift.id] = eur(gift.value);
  });
  catalog.MODEL_IDS.forEach((id) => {
    const model = catalog.MODELS[id];
    values[`${id}.min`] = eur(minPrice(model));
    values[`${id}.max`] = eur(maxPrice(model));
    values[`${id}.nb`] = String(model.sizes.length);
    model.sizes.forEach((size) => {
      values[`${id}.${size.id}.prix`] = eur(size.price);
      values[`${id}.${size.id}.total`] = eur(size.price + catalog.SHIPPING_EUR);
    });
  });
  return values;
}

// ------------------------------------------------------------------ données structurées

function jsonLd(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

// Une variante (Product + Offer) par taille, rattachée au ProductGroup de la fiche.
function productVariants(modelId, image) {
  const model = catalog.getModel(modelId);
  return model.sizes.map((size) => ({
    '@type': 'Product',
    name: `${model.name} ${catalog.sizeLabel(size)}`,
    sku: `${model.sku}-${size.id}`,
    size: catalog.sizeLabel(size),
    image: image,
    offers: {
      '@type': 'Offer',
      url: productUrl(model, size),
      price: catalog.formatAmount(size.price),
      priceCurrency: 'EUR',
      availability: 'https://schema.org/InStock',
      itemCondition: 'https://schema.org/NewCondition',
      seller: { '@type': 'OnlineStore', '@id': `${SITE}/#organisation`, name: 'iPoolGo France' },
      shippingDetails: {
        '@type': 'OfferShippingDetails',
        shippingRate: { '@type': 'MonetaryAmount', value: catalog.formatAmount(catalog.SHIPPING_EUR), currency: 'EUR' },
        shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'FR' },
        deliveryTime: {
          '@type': 'ShippingDeliveryTime',
          businessDays: {
            '@type': 'OpeningHoursSpecification',
            dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((day) => `https://schema.org/${day}`)
          },
          transitTime: { '@type': 'QuantitativeValue', minValue: 5, maxValue: 10, unitCode: 'DAY' }
        }
      },
      hasMerchantReturnPolicy: { '@id': `${SITE}/#retours` }
    }
  }));
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;|&#8239;|[\u00a0\u202f]/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function plainText(html) {
  // Les balises de bloc séparent des phrases, les balises en ligne (liens, montants) non.
  const text = html.replace(/<\/?(p|li|ul|ol|div|br)\b[^>]*>/g, ' ').replace(/<[^>]+>/g, '');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

// Le bloc FAQPage reprend mot pour mot la FAQ visible de la page.
function faqFromHtml(html) {
  const items = [];
  const pattern = /<details class="faq__item"[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g;
  let match;
  while ((match = pattern.exec(html))) {
    items.push({
      '@type': 'Question',
      name: plainText(match[1]),
      acceptedAnswer: { '@type': 'Answer', text: plainText(match[2]) }
    });
  }
  return items.length ? { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items } : null;
}

function replaceJsonLd(html, name, update) {
  const pattern = new RegExp(`(<script type="application/ld\\+json" data-ld="${name}">)([\\s\\S]*?)(</script>)`);
  return html.replace(pattern, (whole, open, body, close) => {
    const next = update(body.trim() ? JSON.parse(body) : null);
    return next ? open + jsonLd(next) + close : whole;
  });
}

// ------------------------------------------------------------------ synchronisation

function syncRegions(text) {
  return text.replace(/(<!-- catalog:([a-z-]+) -->)[\s\S]*?(<!-- \/catalog:\2 -->)/g, (whole, open, name, close) => {
    if (!REGIONS[name]) throw new Error(`Zone inconnue : catalog:${name}`);
    return `${open}\n${REGIONS[name]()}\n${close}`;
  });
}

function syncHtml(html) {
  const values = catalogValues();
  let next = syncRegions(html);

  next = next.replace(/(<([a-z]+)\b[^>]*\sdata-catalog="([^"]+)"[^>]*>)[^<]*(<\/\2>)/g, (whole, open, tag, key, close) => {
    if (!(key in values)) throw new Error(`Clé inconnue : data-catalog="${key}"`);
    return open + entities(values[key]) + close;
  });

  next = replaceJsonLd(next, 'produit', (data) => {
    if (!data) return null;
    const modelId = catalog.MODEL_IDS.find((id) => data.productGroupID === catalog.MODELS[id].sku);
    if (!modelId) throw new Error(`Produit inconnu dans les données structurées : ${data.productGroupID}`);
    data.hasVariant = productVariants(modelId, data.image);
    return data;
  });

  next = replaceJsonLd(next, 'faq', () => faqFromHtml(next));
  return next;
}

function renderFeed() {
  const items = [];
  catalog.MODEL_IDS.forEach((id) => {
    const model = catalog.MODELS[id];
    const extraImage = id === 'ronde'
      ? '/assets/images/piscine-gonflable-rigide-ipoolgo-ronde-jardin-1248.webp'
      : '/assets/images/piscine-rectangulaire-ipoolgo-terrasse-1080.webp';
    model.sizes.forEach((size) => {
      const label = catalog.sizeLabel(size);
      const title = `Piscine Gonflable Rigide iPoolGo ${model.shortName} ${label} - Pompe Offerte`;
      const description =
        `Piscine hors-sol gonflable rigide iPoolGo ${model.shortName} ${label} en Drop-Stitch, finition ${model.finish}, ` +
        `pour ${size.people} personnes. Pompe de gonflage électrique et système de filtration à sable offerts. ` +
        'Vendue et expédiée depuis la France par SAS Virage, revendeur officiel iPoolGo en France.';
      items.push(
        [
          '    <item>',
          `      <g:id>${model.sku}-${size.id}</g:id>`,
          `      <g:item_group_id>${model.sku}</g:item_group_id>`,
          `      <g:title>${esc(title)}</g:title>`,
          `      <g:description>${esc(description)}</g:description>`,
          `      <g:link>${esc(productUrl(model, size))}</g:link>`,
          `      <g:image_link>${SITE}${model.image}</g:image_link>`,
          `      <g:additional_image_link>${SITE}${extraImage}</g:additional_image_link>`,
          '      <g:availability>in_stock</g:availability>',
          `      <g:price>${catalog.formatAmount(size.price)} EUR</g:price>`,
          '      <g:brand>iPoolGo</g:brand>',
          '      <g:condition>new</g:condition>',
          '      <g:identifier_exists>no</g:identifier_exists>',
          '      <g:google_product_category>Maison et jardin &gt; Piscine et spa &gt; Piscines</g:google_product_category>',
          `      <g:product_type>Piscines hors-sol &gt; Piscines gonflables rigides Drop-Stitch &gt; ${model.shortName}</g:product_type>`,
          `      <g:size>${esc(label)}</g:size>`,
          `      <g:color>${model.finish}</g:color>`,
          '      <g:material>PVC Drop-Stitch</g:material>',
          '      <g:shipping>',
          '        <g:country>FR</g:country>',
          '        <g:service>Livraison France métropolitaine</g:service>',
          `        <g:price>${catalog.formatAmount(catalog.SHIPPING_EUR)} EUR</g:price>`,
          '      </g:shipping>',
          '    </item>'
        ].join('\n')
      );
    });
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">',
    '  <channel>',
    '    <title>iPoolGo France</title>',
    `    <link>${SITE}/</link>`,
    '    <description>Piscines gonflables rigides iPoolGo en Drop-Stitch, vendues en France par SAS Virage, revendeur officiel.</description>',
    items.join('\n'),
    '  </channel>',
    '</rss>',
    ''
  ].join('\n');
}

function renderLlmsPrices() {
  const lines = [];
  catalog.MODEL_IDS.forEach((id) => {
    const model = catalog.MODELS[id];
    lines.push(`### ${model.name} (${model.sizes.length} tailles)`, '');
    model.sizes.forEach((size) => {
      const name = size.name ? `${size.name}, ` : '';
      lines.push(
        `- ${name}${catalog.sizeLabel(size)} : ${catalog.formatAmount(size.price)} EUR TTC, ${size.people} personnes, ` +
          `environ ${size.volume} litres. [Commander](${productUrl(model, size)})`
      );
    });
    lines.push('');
  });
  lines.push(
    `Livraison en France métropolitaine : ${catalog.formatAmount(catalog.SHIPPING_EUR)} EUR par commande. Retrait gratuit à ${catalog.PICKUP_PLACE} (Île-de-France), sur rendez-vous.`,
    `Offerts avec chaque piscine : ${catalog.GIFTS.map((gift) => `${gift.name.toLowerCase()} (valeur ${gift.value} EUR)`).join(' et ')}.`
  );
  return lines.join('\n');
}

function main() {
  const check = process.argv.includes('--check');
  const files = PAGES.map((name) => [name, syncHtml]).concat([
    ['llms.txt', syncRegions],
    ['google-shopping.xml', renderFeed]
  ]);

  const stale = [];
  files.forEach(([name, render]) => {
    const file = path.join(ROOT, name);
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const next = render(current);
    if (next === current) return;
    stale.push(name);
    if (!check) fs.writeFileSync(file, next);
  });

  if (check && stale.length) {
    console.error(`Fichiers désynchronisés du catalogue : ${stale.join(', ')}\nLancez : node scripts/sync-catalog.js`);
    process.exit(1);
  }
  console.log(stale.length ? `Mis à jour : ${stale.join(', ')}` : 'Tout est à jour.');
}

if (require.main === module) {
  main();
}

module.exports = { syncHtml, syncRegions, renderFeed };
