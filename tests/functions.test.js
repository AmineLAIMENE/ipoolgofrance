'use strict';

// Tests simulés des Netlify Functions : aucun appel réseau, `fetch` est remplacé
// par un faux Mollie / Brevo qui enregistre les requêtes reçues.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const catalog = require('../assets/js/catalog.js');
const createPayment = require('../netlify/functions/create-payment.js').handler;
const checkPayment = require('../netlify/functions/check-payment.js').handler;
const webhook = require('../netlify/functions/webhook.js').handler;

const realFetch = global.fetch;
const realConsole = { error: console.error, warn: console.warn };
let calls;

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// routes : fonction (call) => réponse, appelée pour chaque requête sortante.
function mockFetch(route) {
  calls = [];
  global.fetch = async (url, options = {}) => {
    const call = {
      url: String(url),
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body ? JSON.parse(options.body) : null
    };
    calls.push(call);
    return route(call);
  };
}

const CUSTOMER = {
  nom: 'Martin',
  prenom: 'Camille',
  email: 'camille.martin@example.com',
  telephone: '06 12 34 56 78',
  adresse: '12 rue des Lilas',
  codePostal: '69003',
  ville: 'Lyon'
};

function order(overrides) {
  return Object.assign(
    { modele: 'ronde', taille: '300x120', montant: 1399 + catalog.SHIPPING_EUR, cgv: true, client: CUSTOMER },
    overrides
  );
}

function post(body, headers) {
  return {
    httpMethod: 'POST',
    headers: Object.assign({ 'content-type': 'application/json', origin: 'https://ipoolgofrance.fr' }, headers),
    body: typeof body === 'string' ? body : JSON.stringify(body)
  };
}

function paidPayment(overrides) {
  return Object.assign(
    {
      id: 'tr_WDqYK6vllg',
      status: 'paid',
      amount: { currency: 'EUR', value: catalog.formatAmount(1399 + catalog.SHIPPING_EUR) },
      metadata: {
        source: 'ipoolgofrance.fr',
        modele: 'ronde',
        taille: '300x120',
        produit: 'Piscine iPoolGo Ronde Ø 3 m × 1,20 m',
        prix: '1399.00',
        livraison: catalog.formatAmount(catalog.SHIPPING_EUR),
        total: catalog.formatAmount(1399 + catalog.SHIPPING_EUR),
        nom: 'Martin',
        prenom: 'Camille',
        email: 'camille.martin@example.com',
        telephone: '0612345678',
        adresse: '12 rue des Lilas',
        code_postal: '69003',
        ville: 'Lyon'
      }
    },
    overrides
  );
}

function mollieWebhook(body, contentType) {
  return {
    httpMethod: 'POST',
    headers: { 'content-type': contentType || 'application/x-www-form-urlencoded' },
    body
  };
}

beforeEach(() => {
  process.env.MOLLIE_API_KEY = 'test_cle_mollie_factice';
  process.env.BREVO_API_KEY = 'cle_brevo_factice';
  process.env.SELLER_EMAIL = 'vendeur@example.com';
  process.env.SENDER_EMAIL = 'commandes@example.com';
  delete process.env.SITE_URL;
  console.error = () => {};
  console.warn = () => {};
  mockFetch(() => {
    throw new Error('appel réseau inattendu');
  });
});

afterEach(() => {
  global.fetch = realFetch;
  console.error = realConsole.error;
  console.warn = realConsole.warn;
});

// ---------------------------------------------------------------- create-payment

test('create-payment : commande valide, prix recalculé et payload Mollie conforme', async () => {
  mockFetch(() => reply(201, { id: 'tr_WDqYK6vllg', _links: { checkout: { href: 'https://www.mollie.com/checkout/select-method/WDqYK6vllg' } } }));

  const response = await createPayment(post(order()));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    paymentId: 'tr_WDqYK6vllg',
    checkoutUrl: 'https://www.mollie.com/checkout/select-method/WDqYK6vllg'
  });

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, 'https://api.mollie.com/v2/payments');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.Authorization, 'Bearer test_cle_mollie_factice');
  assert.deepEqual(call.body.amount, { currency: 'EUR', value: catalog.formatAmount(1399 + catalog.SHIPPING_EUR) });
  assert.equal(call.body.redirectUrl, 'https://ipoolgofrance.fr/merci.html');
  assert.equal(call.body.webhookUrl, 'https://ipoolgofrance.fr/.netlify/functions/webhook');
  assert.equal(call.body.locale, 'fr_FR');
  assert.match(call.body.description, /Ronde Ø 3 m × 1,20 m/);

  const metadata = call.body.metadata;
  assert.equal(metadata.source, 'ipoolgofrance.fr');
  assert.equal(metadata.produit, 'Piscine iPoolGo Ronde Ø 3 m × 1,20 m');
  assert.equal(metadata.taille, '300x120');
  assert.equal(metadata.prix, '1399.00');
  assert.equal(metadata.nom, 'Martin');
  assert.equal(metadata.prenom, 'Camille');
  assert.equal(metadata.email, 'camille.martin@example.com');
  assert.equal(metadata.telephone, '0612345678');
  assert.equal(metadata.adresse, '12 rue des Lilas');
  assert.equal(metadata.code_postal, '69003');
  assert.equal(metadata.ville, 'Lyon');
  assert.ok(Buffer.byteLength(JSON.stringify(metadata)) < 1000);
});

test('create-payment : la réponse ne contient jamais la clé Mollie', async () => {
  mockFetch(() => reply(401, { title: 'Unauthorized Request', detail: 'Missing authentication' }));
  const response = await createPayment(post(order()));
  assert.equal(response.statusCode, 502);
  assert.ok(!response.body.includes('test_cle_mollie_factice'));
  assert.equal(JSON.parse(response.body).error, 'paiement_indisponible');
});

test('create-payment : un montant falsifié est rejeté sans appeler Mollie', async () => {
  for (const montant of [1, 999, 1399, '1759', null, undefined]) {
    const response = await createPayment(post(order({ montant })));
    assert.equal(response.statusCode, 409, `montant ${montant}`);
    const body = JSON.parse(response.body);
    assert.equal(body.error, 'montant_invalide');
    assert.equal(body.total, 1399 + catalog.SHIPPING_EUR);
  }
  assert.equal(calls.length, 0);
});

test('create-payment : un prix glissé dans la requête est ignoré', async () => {
  mockFetch(() => reply(201, { id: 'tr_WDqYK6vllg', _links: { checkout: { href: 'https://www.mollie.com/checkout/x' } } }));
  const response = await createPayment(post(order({ prix: 1, total: 1, amount: { currency: 'EUR', value: '1.00' } })));
  assert.equal(response.statusCode, 200);
  assert.equal(calls[0].body.amount.value, catalog.formatAmount(1399 + catalog.SHIPPING_EUR));
  assert.equal(calls[0].body.metadata.total, catalog.formatAmount(1399 + catalog.SHIPPING_EUR));
});

test('create-payment : chaque taille du catalogue est facturée à son prix', async () => {
  for (const modelId of catalog.MODEL_IDS) {
    for (const size of catalog.MODELS[modelId].sizes) {
      mockFetch(() => reply(201, { id: 'tr_WDqYK6vllg', _links: { checkout: { href: 'https://www.mollie.com/checkout/x' } } }));
      const total = size.price + catalog.SHIPPING_EUR;
      const response = await createPayment(post(order({ modele: modelId, taille: size.id, montant: total })));
      assert.equal(response.statusCode, 200, `${modelId} ${size.id}`);
      assert.equal(calls[0].body.amount.value, catalog.formatAmount(total));
    }
  }
});

test('create-payment : modèle ou taille inconnus refusés', async () => {
  const cases = [
    { modele: 'ovale' },
    { taille: '900x900' },
    { modele: '__proto__' },
    { modele: 'constructor', taille: 'sizes' },
    { taille: ['300x120'] },
    { modele: 'rectangulaire', taille: '300x120' }
  ];
  for (const overrides of cases) {
    const response = await createPayment(post(order(overrides)));
    assert.equal(response.statusCode, 400, JSON.stringify(overrides));
    assert.equal(JSON.parse(response.body).error, 'produit_inconnu');
  }
  assert.equal(calls.length, 0);
});

test('create-payment : CGV obligatoires', async () => {
  for (const cgv of [false, 'true', 1, undefined]) {
    const response = await createPayment(post(order({ cgv })));
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).error, 'cgv_non_acceptees');
  }
  assert.equal(calls.length, 0);
});

test('create-payment : champs client validés côté serveur', async () => {
  const cases = [
    [{ email: 'pas-un-email' }, 'email'],
    [{ email: 'a@b.fr<script>' }, 'email'],
    [{ codePostal: '6900' }, 'codePostal'],
    [{ codePostal: '97400' }, 'codePostal'],
    [{ telephone: 'abc' }, 'telephone'],
    [{ nom: '   ' }, 'nom'],
    [{ adresse: 'x'.repeat(121) }, 'adresse'],
    [{ ville: undefined }, 'ville']
  ];
  for (const [change, field] of cases) {
    const response = await createPayment(post(order({ client: Object.assign({}, CUSTOMER, change) })));
    assert.equal(response.statusCode, 400, field);
    const body = JSON.parse(response.body);
    assert.equal(body.error, 'champs_invalides');
    assert.ok(body.champs[field], `erreur attendue sur ${field}`);
  }
  assert.equal(calls.length, 0);
});

test('create-payment : méthode, origine, JSON et champ piège', async () => {
  assert.equal((await createPayment({ httpMethod: 'GET', headers: {} })).statusCode, 405);
  assert.equal((await createPayment(post(order(), { origin: 'https://site-pirate.example' }))).statusCode, 403);
  assert.equal((await createPayment(post(order(), { origin: '' }))).statusCode, 403, 'en-tête Origin absent');
  assert.equal((await createPayment(post(order(), { origin: 'http://localhost:8888' }))).statusCode, 403, 'localhost hors netlify dev');
  assert.equal((await createPayment(post('{pas du json'))).statusCode, 400);
  assert.equal((await createPayment(post('[]'))).statusCode, 400);
  assert.equal((await createPayment(post(order({ site_web: 'https://spam.example' })))).statusCode, 400);
  assert.equal((await createPayment(post(JSON.stringify(order()) + ' '.repeat(5000)))).statusCode, 413);
  assert.equal(calls.length, 0);
});

test('create-payment : SITE_URL personnalise les URL de retour, sinon domaine officiel', async () => {
  mockFetch(() => reply(201, { id: 'tr_WDqYK6vllg', _links: { checkout: { href: 'https://www.mollie.com/checkout/x' } } }));
  process.env.SITE_URL = 'https://apercu--ipoolgofrance.netlify.app/';
  await createPayment(post(order(), { origin: 'https://apercu--ipoolgofrance.netlify.app' }));
  assert.equal(calls[0].body.redirectUrl, 'https://apercu--ipoolgofrance.netlify.app/merci.html');

  process.env.SITE_URL = 'javascript:alert(1)';
  await createPayment(post(order()));
  assert.equal(calls[1].body.webhookUrl, 'https://ipoolgofrance.fr/.netlify/functions/webhook');
});

// ---------------------------------------------------------------- check-payment

function get(id) {
  return { httpMethod: 'GET', headers: {}, queryStringParameters: id === undefined ? {} : { id } };
}

test('check-payment : identifiant invalide refusé sans appeler Mollie', async () => {
  for (const id of [undefined, '', 'abc', 'tr_', 'tr_../../customers', 'tr_abc?x=1', 'tr_abcdef/refunds']) {
    assert.equal((await checkPayment(get(id))).statusCode, 400, String(id));
  }
  assert.equal(calls.length, 0);
});

test('check-payment : statut et récapitulatif sans donnée personnelle', async () => {
  for (const status of ['paid', 'canceled', 'failed', 'expired', 'open']) {
    mockFetch(() => reply(200, paidPayment({ status })));
    const response = await checkPayment(get('tr_WDqYK6vllg'));
    assert.equal(response.statusCode, 200);
    assert.equal(calls[0].url, 'https://api.mollie.com/v2/payments/tr_WDqYK6vllg');
    assert.equal(calls[0].headers.Authorization, 'Bearer test_cle_mollie_factice');
    const body = JSON.parse(response.body);
    assert.equal(body.status, status);
    assert.equal(body.commande.produit, 'Piscine iPoolGo Ronde Ø 3 m × 1,20 m');
    assert.equal(body.commande.total, catalog.formatAmount(1399 + catalog.SHIPPING_EUR));
    for (const secret of ['Martin', 'Camille', 'example.com', '0612345678', 'Lilas', '69003', 'Lyon']) {
      assert.ok(!response.body.includes(secret), `fuite de ${secret}`);
    }
  }
});

test('check-payment : paiement inconnu ou étranger au site', async () => {
  mockFetch(() => reply(404, { title: 'Not Found' }));
  assert.equal((await checkPayment(get('tr_WDqYK6vllg'))).statusCode, 404);

  mockFetch(() => reply(200, paidPayment({ metadata: { order_id: '42' } })));
  assert.equal((await checkPayment(get('tr_WDqYK6vllg'))).statusCode, 404);

  mockFetch(() => reply(503, {}));
  assert.equal((await checkPayment(get('tr_WDqYK6vllg'))).statusCode, 502);

  assert.equal((await checkPayment({ httpMethod: 'POST', headers: {} })).statusCode, 405);
});

// ---------------------------------------------------------------- webhook

function mollieAndBrevo(payment, brevoStatus) {
  mockFetch((call) => {
    if (call.url.startsWith('https://api.mollie.com/')) return reply(200, payment);
    if (call.url === 'https://api.brevo.com/v3/smtp/email') {
      const status = typeof brevoStatus === 'function' ? brevoStatus(call) : brevoStatus || 201;
      return reply(status, status === 201 ? { messageId: '<id@smtp-relay.mailin.fr>' } : { code: 'unauthorized', message: 'Key not found' });
    }
    throw new Error(`URL inattendue : ${call.url}`);
  });
}

function brevoCalls() {
  return calls.filter((call) => call.url === 'https://api.brevo.com/v3/smtp/email');
}

test('webhook : paiement payé, vérifié chez Mollie puis deux e-mails Brevo', async () => {
  mollieAndBrevo(paidPayment());
  const response = await webhook(mollieWebhook('id=tr_WDqYK6vllg'));
  assert.equal(response.statusCode, 200);

  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'https://api.mollie.com/v2/payments/tr_WDqYK6vllg');
  assert.equal(calls[0].headers.Authorization, 'Bearer test_cle_mollie_factice');

  const [seller, customer] = brevoCalls();
  assert.equal(brevoCalls().length, 2);
  for (const mail of [seller, customer]) {
    assert.equal(mail.method, 'POST');
    assert.equal(mail.headers['api-key'], 'cle_brevo_factice');
    assert.equal(mail.body.sender.email, 'commandes@example.com');
    assert.equal(typeof mail.body.subject, 'string');
    assert.ok(mail.body.htmlContent.startsWith('<!doctype html>'));
    assert.ok(mail.body.textContent.length > 50);
  }

  assert.deepEqual(seller.body.to, [{ email: 'vendeur@example.com' }]);
  assert.match(seller.body.subject, /^Nouvelle commande iPoolGo France payée/);
  assert.equal(seller.body.replyTo.email, 'camille.martin@example.com');
  for (const expected of ['tr_WDqYK6vllg', 'Piscine iPoolGo Ronde', 'Ø 3 m × 1,20 m', '12 rue des Lilas', '69003 Lyon', '0612345678']) {
    assert.ok(seller.body.htmlContent.includes(expected), `e-mail vendeur sans ${expected}`);
  }
  assert.ok(seller.body.htmlContent.includes(catalog.formatEUR(1399 + catalog.SHIPPING_EUR)));
  assert.ok(!seller.body.htmlContent.includes('Attention'));

  assert.equal(customer.body.to[0].email, 'camille.martin@example.com');
  assert.equal(customer.body.replyTo.email, 'vendeur@example.com');
  for (const expected of ['Pompe de gonflage électrique', 'Système de filtration à sable', 'Offert', 'SAS Virage', 'garantie légale de conformité de 2 ans', 'contact@piscineipoolgo.com']) {
    assert.ok(customer.body.htmlContent.includes(expected), `e-mail client sans ${expected}`);
  }

  const patch = calls[calls.length - 1];
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.url, 'https://api.mollie.com/v2/payments/tr_WDqYK6vllg');
  assert.ok(patch.body.metadata.mail_vendeur);
  assert.ok(patch.body.metadata.mail_client);
  assert.equal(patch.body.metadata.email, 'camille.martin@example.com');
});

test('webhook : accepte aussi un corps JSON', async () => {
  mollieAndBrevo(paidPayment());
  const response = await webhook(mollieWebhook(JSON.stringify({ id: 'tr_WDqYK6vllg' }), 'application/json'));
  assert.equal(response.statusCode, 200);
  assert.equal(brevoCalls().length, 2);
});

test('webhook : corps encodé en base64 par la passerelle', async () => {
  mollieAndBrevo(paidPayment());
  const event = mollieWebhook(Buffer.from('id=tr_WDqYK6vllg').toString('base64'));
  event.isBase64Encoded = true;
  assert.equal((await webhook(event)).statusCode, 200);
  assert.equal(brevoCalls().length, 2);
});

test('webhook : usurpation, un statut "paid" annoncé dans la requête ne déclenche rien', async () => {
  for (const status of ['open', 'pending', 'authorized', 'canceled', 'expired', 'failed']) {
    mollieAndBrevo(paidPayment({ status }));
    const forged = JSON.stringify({ id: 'tr_WDqYK6vllg', status: 'paid', amount: { value: '0.01' } });
    const response = await webhook(mollieWebhook(forged, 'application/json'));
    assert.equal(response.statusCode, 200, status);
    assert.equal(calls.length, 1, 'seule la vérification Mollie doit partir');
    assert.equal(calls[0].method, 'GET');
  }
});

test('webhook : identifiant absent ou malformé, 200 sans aucun appel', async () => {
  for (const body of ['', 'id=', 'id=abc', 'id=tr_../../refunds', 'foo=bar', '{"id":{"$ne":1}}', '{cassé']) {
    assert.equal((await webhook(mollieWebhook(body))).statusCode, 200, body);
  }
  assert.equal(calls.length, 0);
});

test('webhook : paiement inconnu chez Mollie, 200 sans e-mail', async () => {
  mockFetch(() => reply(404, { title: 'Not Found' }));
  assert.equal((await webhook(mollieWebhook('id=tr_WDqYK6vllg'))).statusCode, 200);
  assert.equal(calls.length, 1);
});

test('webhook : Mollie injoignable, 500 pour que Mollie rappelle', async () => {
  mockFetch(() => reply(503, {}));
  assert.equal((await webhook(mollieWebhook('id=tr_WDqYK6vllg'))).statusCode, 500);

  mockFetch(() => {
    throw new Error('timeout');
  });
  assert.equal((await webhook(mollieWebhook('id=tr_WDqYK6vllg'))).statusCode, 500);
});

test('webhook : paiement d’un autre site ou remboursé, rien n’est envoyé', async () => {
  mollieAndBrevo(paidPayment({ metadata: { order_id: '42' } }));
  assert.equal((await webhook(mollieWebhook('id=tr_WDqYK6vllg'))).statusCode, 200);
  assert.equal(brevoCalls().length, 0);

  mollieAndBrevo(paidPayment({ amountRefunded: { currency: 'EUR', value: '1759.00' } }));
  assert.equal((await webhook(mollieWebhook('id=tr_WDqYK6vllg'))).statusCode, 200);
  assert.equal(brevoCalls().length, 0);
});

test('webhook : e-mails déjà envoyés, aucun doublon', async () => {
  const payment = paidPayment();
  payment.metadata.mail_vendeur = '2026-06-01T10:00:00.000Z';
  payment.metadata.mail_client = '2026-06-01T10:00:01.000Z';
  mollieAndBrevo(payment);
  assert.equal((await webhook(mollieWebhook('id=tr_WDqYK6vllg'))).statusCode, 200);
  assert.equal(calls.length, 1);
});

test('webhook : un e-mail en échec, 500 et seul l’envoi réussi est marqué', async () => {
  mollieAndBrevo(paidPayment(), (call) => (call.body.to[0].email === 'vendeur@example.com' ? 201 : 401));
  const response = await webhook(mollieWebhook('id=tr_WDqYK6vllg'));
  assert.equal(response.statusCode, 500);
  const patch = calls[calls.length - 1];
  assert.equal(patch.method, 'PATCH');
  assert.ok(patch.body.metadata.mail_vendeur);
  assert.equal(patch.body.metadata.mail_client, undefined);

  // Rappel de Mollie : seul l'e-mail client repart.
  const retried = paidPayment();
  retried.metadata.mail_vendeur = patch.body.metadata.mail_vendeur;
  mollieAndBrevo(retried);
  assert.equal((await webhook(mollieWebhook('id=tr_WDqYK6vllg'))).statusCode, 200);
  assert.equal(brevoCalls().length, 1);
  assert.equal(brevoCalls()[0].body.to[0].email, 'camille.martin@example.com');
});

test('webhook : configuration Brevo incomplète, 500 sans envoi', async () => {
  delete process.env.SELLER_EMAIL;
  mollieAndBrevo(paidPayment());
  assert.equal((await webhook(mollieWebhook('id=tr_WDqYK6vllg'))).statusCode, 500);
  assert.equal(brevoCalls().length, 0);
});

test('webhook : les champs saisis sont échappés dans les e-mails', async () => {
  const payment = paidPayment();
  payment.metadata.nom = '<script>alert(1)</script>';
  payment.metadata.adresse = '1 rue "A" <img src=x onerror=alert(1)>';
  mollieAndBrevo(payment);
  await webhook(mollieWebhook('id=tr_WDqYK6vllg'));
  for (const mail of brevoCalls()) {
    assert.ok(!mail.body.htmlContent.includes('<script>'));
    assert.ok(!mail.body.htmlContent.includes('<img'));
    assert.ok(mail.body.htmlContent.includes('&lt;script&gt;'));
  }
});

test('webhook : montant encaissé différent du catalogue, le vendeur est alerté', async () => {
  mollieAndBrevo(paidPayment({ amount: { currency: 'EUR', value: '1.00' } }));
  await webhook(mollieWebhook('id=tr_WDqYK6vllg'));
  assert.ok(brevoCalls()[0].body.htmlContent.includes('Attention'));

  mollieAndBrevo(paidPayment({ amount: { currency: 'USD', value: catalog.formatAmount(1399 + catalog.SHIPPING_EUR) } }));
  await webhook(mollieWebhook('id=tr_WDqYK6vllg'));
  assert.ok(brevoCalls()[0].body.htmlContent.includes('Attention'));
});

test('webhook : marquage Mollie en échec, les e-mails sont partis et la réponse reste 200', async () => {
  mockFetch((call) => {
    if (call.method === 'PATCH') return reply(503, {});
    if (call.url.startsWith('https://api.mollie.com/')) return reply(200, paidPayment());
    return reply(201, { messageId: '<id@smtp-relay.mailin.fr>' });
  });
  assert.equal((await webhook(mollieWebhook('id=tr_WDqYK6vllg'))).statusCode, 200);
  assert.equal(brevoCalls().length, 2);
});

test('fonctions : réponses JSON non mises en cache et sans détection de type', async () => {
  const response = await webhook({ httpMethod: 'GET', headers: {} });
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
});

test('webhook : méthode GET refusée', async () => {
  assert.equal((await webhook({ httpMethod: 'GET', headers: {} })).statusCode, 405);
});
