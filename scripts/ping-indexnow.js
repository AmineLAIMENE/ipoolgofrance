'use strict';

// Signale les pages du site à IndexNow (Bing, Yandex, Seznam, Naver...) après une mise en ligne.
//   node scripts/ping-indexnow.js            envoie toutes les URL de sitemap.xml
//   node scripts/ping-indexnow.js --dry-run  affiche ce qui serait envoyé, sans rien envoyer
// La clé IndexNow est publique par conception : c'est le fichier <clé>.txt à la racine du site.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ENDPOINT = 'https://api.indexnow.org/indexnow';

function findKey() {
  const file = fs.readdirSync(ROOT).find((name) => /^[a-f0-9]{32}\.txt$/.test(name));
  if (!file) throw new Error('Fichier de clé IndexNow introuvable à la racine (32 caractères hexadécimaux + .txt).');
  const key = file.replace(/\.txt$/, '');
  const content = fs.readFileSync(path.join(ROOT, file), 'utf8').trim();
  if (content !== key) throw new Error(`Le fichier ${file} doit contenir exactement sa propre clé.`);
  return key;
}

function sitemapUrls() {
  const xml = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
  const urls = [];
  const pattern = /<loc>([^<]+)<\/loc>/g;
  let match;
  while ((match = pattern.exec(xml))) urls.push(match[1].trim());
  if (!urls.length) throw new Error('Aucune URL trouvée dans sitemap.xml.');
  return urls;
}

function buildPayload() {
  const key = findKey();
  const urlList = sitemapUrls();
  const origin = new URL(urlList[0]).origin;
  const foreign = urlList.filter((url) => new URL(url).origin !== origin);
  if (foreign.length) throw new Error(`URL hors du domaine ${origin} : ${foreign.join(', ')}`);
  return {
    host: new URL(origin).host,
    key,
    keyLocation: `${origin}/${key}.txt`,
    urlList
  };
}

async function main() {
  const payload = buildPayload();
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload)
  });

  // 200 : URL reçues. 202 : reçues, clé en cours de vérification.
  if (response.status === 200 || response.status === 202) {
    console.log(`IndexNow : ${payload.urlList.length} URL envoyées (HTTP ${response.status}).`);
    return;
  }
  const hints = {
    400: 'requête mal formée',
    403: `clé refusée : vérifiez que ${payload.keyLocation} est bien en ligne`,
    422: 'les URL ne correspondent pas au domaine ou à la clé',
    429: 'trop de requêtes, réessayez plus tard'
  };
  throw new Error(`IndexNow a répondu HTTP ${response.status}${hints[response.status] ? ` (${hints[response.status]})` : ''}.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { buildPayload, ENDPOINT };
