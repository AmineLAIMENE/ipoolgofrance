'use strict';

// Tests simulés des Netlify Functions : aucun appel réseau, `fetch` est remplacé
// par un faux Stripe / Brevo qui enregistre les requêtes reçues.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const catalog = require('../assets/js/catalog.js');
const createPayment = require('../netlify/functions/create-payment.js').handler;
const checkPayment = require('../netlify/functions/check-payment.js').handler;
const webhook = require('../netlify/functions/webhook.js').handler;

const realFetch = global.fetch;
const realConsole = { error: console.error, warn: console.warn };
const SESSION_ID = 'cs_test_a1B2c3D4e5F6g7H8i9J0kLmNoPq';
const STRIPE = 'https://api.stripe.com/v1';
const BREVO = 'https://api.brevo.com/v3/smtp/email';
const TOTAL = 1399 + catalog.SHIPPING_EUR;
let calls;

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Stripe reçoit du formulaire encodé (a[b][c]=x), Brevo du JSON.
function parseBody(options) {
  if (!options.body) return null;
  const type = (options.headers && options.headers['Content-Type']) || '';
  return type.includes('json') ? JSON.parse(options.body) : Object.fromEntries(new URLSearchParams(options.body));
}

// routes : fonction (call) => réponse, appelée pour chaque requête sortante.
function mockFetch(route) {
  calls = [];
  global.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', headers: options.headers || {}, body: parseBody(options) };
    calls.push(call);
    return route(call);
  };
}

function created() {
  return reply(200, { id: SESSION_ID, url: 'https://checkout.stripe.com/c/pay/' + SESSION_ID });
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
  return Object.assign({ modele: 'ronde', taille: '300x120', remise: 'livraison', montant: TOTAL, cgv: true, client: CUSTOMER }, overrides);
}

function post(body, headers) {
  return {
    httpMethod: 'POST',
    headers: Object.assign({ 'content-type': 'application/json', origin: 'https://ipoolgofrance.fr' }, headers),
    body: typeof body === 'string' ? body : JSON.stringify(body)
  };
}

// Session Stripe Checkout payée, telle que relue avec expand[]=payment_intent.latest_charge.
function paidSession(overrides, intentMetadata, charge) {
  return Object.assign(
    {
      id: SESSION_ID,
      object: 'checkout.session',
      status: 'complete',
      payment_status: 'paid',
      amount_total: TOTAL * 100,
      currency: 'eur',
      metadata: {
        source: 'ipoolgofrance.fr',
        reference: 'IPG-261119-ABCDE',
        modele: 'ronde',
        taille: '300x120',
        produit: 'Piscine iPoolGo Ronde Ø 3 m × 1,20 m',
        prix: '1399.00',
        livraison: catalog.formatAmount(catalog.SHIPPING_EUR),
        total: catalog.formatAmount(TOTAL),
        nom: 'Martin',
        prenom: 'Camille',
        email: 'camille.martin@example.com',
        telephone: '0612345678',
        adresse: '12 rue des Lilas',
        code_postal: '69003',
        ville: 'Lyon'
      },
      payment_intent: {
        id: 'pi_3QabcDEF',
        metadata: intentMetadata || {},
        latest_charge: Object.assign({ id: 'ch_1', amount_refunded: 0, disputed: false }, charge)
      }
    },
    overrides
  );
}

function stripeEvent(id, type) {
  return JSON.stringify({ id: 'evt_1', type: type || 'checkout.session.completed', data: { object: { id, object: 'checkout.session' } } });
}

function hook(body, headers) {
  return { httpMethod: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body };
}

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'rk_test_cle_stripe_factice';
  process.env.BREVO_API_KEY = 'cle_brevo_factice';
  process.env.SELLER_EMAIL = 'vendeur@example.com';
  process.env.SENDER_EMAIL = 'commandes@example.com';
  delete process.env.SITE_URL;
  delete process.env.STRIPE_WEBHOOK_SECRET;
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

test('create-payment : commande valide, prix recalculé et session Stripe conforme', async () => {
  mockFetch(created);

  const response = await createPayment(post(order()));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    paymentId: SESSION_ID,
    checkoutUrl: 'https://checkout.stripe.com/c/pay/' + SESSION_ID
  });

  assert.equal(calls.length, 1);
  const call = calls[0];
  const body = call.body;
  assert.equal(call.url, `${STRIPE}/checkout/sessions`);
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.Authorization, 'Bearer rk_test_cle_stripe_factice');
  assert.equal(call.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(body.mode, 'payment');
  assert.equal(body.locale, 'fr');
  assert.equal(body.customer_email, 'camille.martin@example.com');
  assert.equal(body['line_items[0][quantity]'], '1');
  assert.equal(body['line_items[0][price_data][currency]'], 'eur');
  assert.equal(body['line_items[0][price_data][unit_amount]'], '139900');
  assert.equal(body['line_items[0][price_data][product_data][name]'], 'Piscine iPoolGo Ronde Ø 3 m × 1,20 m');
  assert.equal(body['line_items[1][price_data][unit_amount]'], String(catalog.SHIPPING_EUR * 100));
  assert.equal(body['line_items[1][price_data][product_data][name]'], 'Livraison en France métropolitaine');
  assert.equal(body.success_url, 'https://ipoolgofrance.fr/merci.html?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(body.cancel_url, 'https://ipoolgofrance.fr/commande.html?modele=ronde&taille=300x120&remise=livraison');
  assert.ok(!('payment_method_types[0]' in body), 'les moyens de paiement viennent du tableau de bord Stripe');

  assert.match(body['metadata[reference]'], /^IPG-\d{6}-[A-HJ-NP-Z2-9]{5}$/);
  assert.equal(body.client_reference_id, body['metadata[reference]']);
  assert.match(body['payment_intent_data[description]'], /^iPoolGo France IPG-\d{6}-.{5} - Piscine iPoolGo Ronde Ø 3 m × 1,20 m$/);
  const expected = {
    source: 'ipoolgofrance.fr',
    produit: 'Piscine iPoolGo Ronde Ø 3 m × 1,20 m',
    taille: '300x120',
    prix: '1399.00',
    remise: 'livraison',
    livraison: catalog.formatAmount(catalog.SHIPPING_EUR),
    total: catalog.formatAmount(TOTAL),
    nom: 'Martin',
    prenom: 'Camille',
    email: 'camille.martin@example.com',
    telephone: '0612345678',
    adresse: '12 rue des Lilas',
    code_postal: '69003',
    ville: 'Lyon'
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(body[`metadata[${key}]`], value, `metadata ${key}`);
    assert.equal(body[`payment_intent_data[metadata][${key}]`], value, `metadata du paiement ${key}`);
  }
  // Limites Stripe : 50 clés, 500 caractères par valeur.
  const keys = Object.keys(body).filter((key) => key.startsWith('metadata['));
  assert.ok(keys.length <= 50);
  keys.forEach((key) => assert.ok(body[key].length <= 500, key));
});

test('create-payment : références de commande différentes à chaque commande', async () => {
  mockFetch(created);
  await createPayment(post(order()));
  await createPayment(post(order()));
  assert.notEqual(calls[0].body['metadata[reference]'], calls[1].body['metadata[reference]']);
});

test('create-payment : la réponse ne contient jamais la clé Stripe', async () => {
  mockFetch(() => reply(401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided: rk_test_****tice' } }));
  const response = await createPayment(post(order()));
  assert.equal(response.statusCode, 502);
  assert.ok(!response.body.includes('rk_test'));
  assert.equal(JSON.parse(response.body).error, 'paiement_indisponible');
});

test('create-payment : réponse Stripe sans lien de paiement, 502', async () => {
  mockFetch(() => reply(200, { id: SESSION_ID, url: null }));
  assert.equal((await createPayment(post(order()))).statusCode, 502);
});

test('create-payment : un montant falsifié est rejeté sans appeler Stripe', async () => {
  for (const montant of [1, 999, 1399, '1759', null, undefined]) {
    const response = await createPayment(post(order({ montant })));
    assert.equal(response.statusCode, 409, `montant ${montant}`);
    const body = JSON.parse(response.body);
    assert.equal(body.error, 'montant_invalide');
    assert.equal(body.total, TOTAL);
  }
  assert.equal(calls.length, 0);
});

test('create-payment : un prix glissé dans la requête est ignoré', async () => {
  mockFetch(created);
  const response = await createPayment(post(order({ prix: 1, total: 1, unit_amount: 100, line_items: [] })));
  assert.equal(response.statusCode, 200);
  assert.equal(calls[0].body['line_items[0][price_data][unit_amount]'], '139900');
  assert.equal(calls[0].body['metadata[total]'], catalog.formatAmount(TOTAL));
});

test('create-payment : chaque taille du catalogue est facturée à son prix', async () => {
  for (const modelId of catalog.MODEL_IDS) {
    for (const size of catalog.MODELS[modelId].sizes) {
      mockFetch(created);
      const total = size.price + catalog.SHIPPING_EUR;
      const response = await createPayment(post(order({ modele: modelId, taille: size.id, montant: total })));
      assert.equal(response.statusCode, 200, `${modelId} ${size.id}`);
      const body = calls[0].body;
      const charged = Number(body['line_items[0][price_data][unit_amount]']) + Number(body['line_items[1][price_data][unit_amount]'] || 0);
      assert.equal(charged, Math.round(total * 100), `${modelId} ${size.id}`);
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

test('create-payment : retrait à Noisy-le-Grand, gratuit et sans ligne de livraison', async () => {
  mockFetch(created);
  const response = await createPayment(post(order({ remise: 'retrait', montant: 1399 })));
  assert.equal(response.statusCode, 200);
  const body = calls[0].body;
  assert.equal(body['line_items[0][price_data][unit_amount]'], '139900');
  assert.ok(!('line_items[1][quantity]' in body), 'pas de ligne de livraison');
  assert.equal(body['metadata[remise]'], 'retrait');
  assert.equal(body['metadata[livraison]'], '0.00');
  assert.equal(body['metadata[total]'], '1399.00');
  assert.equal(body.cancel_url, 'https://ipoolgofrance.fr/commande.html?modele=ronde&taille=300x120&remise=retrait');

  // Le total avec livraison est refusé pour un retrait, et l'inverse.
  assert.equal((await createPayment(post(order({ remise: 'retrait' })))).statusCode, 409);
  assert.equal((await createPayment(post(order({ remise: 'livraison', montant: 1399 })))).statusCode, 409);
  assert.equal(calls.length, 1);
});

test('create-payment : retrait possible avec une adresse hors métropole, pas la livraison', async () => {
  mockFetch(created);
  const client = Object.assign({}, CUSTOMER, { codePostal: '97400', ville: 'Saint-Denis' });
  assert.equal((await createPayment(post(order({ remise: 'retrait', montant: 1399, client })))).statusCode, 200);
  const refused = await createPayment(post(order({ client })));
  assert.equal(refused.statusCode, 400);
  assert.ok(JSON.parse(refused.body).champs.codePostal);
});

test('create-payment : mode de remise inconnu refusé sans appeler Stripe', async () => {
  for (const remise of [undefined, '', 'express', null, 0, 'toString', ['retrait']]) {
    const response = await createPayment(post(order({ remise })));
    assert.equal(response.statusCode, 400, `remise ${JSON.stringify(remise)}`);
    assert.equal(JSON.parse(response.body).error, 'remise_invalide');
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
  mockFetch(created);
  process.env.SITE_URL = 'https://apercu--ipoolgofrance.netlify.app/';
  await createPayment(post(order(), { origin: 'https://apercu--ipoolgofrance.netlify.app' }));
  assert.equal(calls[0].body.success_url, 'https://apercu--ipoolgofrance.netlify.app/merci.html?session_id={CHECKOUT_SESSION_ID}');

  process.env.SITE_URL = 'javascript:alert(1)';
  await createPayment(post(order()));
  assert.match(calls[1].body.cancel_url, /^https:\/\/ipoolgofrance\.fr\/commande\.html\?/);
});

// ---------------------------------------------------------------- check-payment

function get(id) {
  return { httpMethod: 'GET', headers: {}, queryStringParameters: id === undefined ? {} : { id } };
}

test('check-payment : identifiant invalide refusé sans appeler Stripe', async () => {
  for (const id of [undefined, '', 'abc', 'cs_', 'cs_live_', 'tr_WDqYK6vllg', 'cs_test_abc/../../customers', 'cs_test_abcdefghij?expand=x', 'pi_3QabcDEFghijkl']) {
    assert.equal((await checkPayment(get(id))).statusCode, 400, String(id));
  }
  assert.equal(calls.length, 0);
});

test('check-payment : statut et récapitulatif sans donnée personnelle', async () => {
  const cases = [
    [{ status: 'complete', payment_status: 'paid' }, 'paid'],
    [{ status: 'complete', payment_status: 'no_payment_required' }, 'paid'],
    [{ status: 'complete', payment_status: 'unpaid' }, 'pending'],
    [{ status: 'open', payment_status: 'unpaid' }, 'open'],
    [{ status: 'expired', payment_status: 'unpaid' }, 'expired']
  ];
  for (const [state, expected] of cases) {
    stripeAndBrevo(paidSession(state));
    const response = await checkPayment(get(SESSION_ID));
    assert.equal(response.statusCode, 200);
    assert.equal(calls[0].url, `${STRIPE}/checkout/sessions/${SESSION_ID}?expand[]=payment_intent.latest_charge`);
    assert.equal(calls[0].headers.Authorization, 'Bearer rk_test_cle_stripe_factice');
    const body = JSON.parse(response.body);
    assert.equal(body.status, expected, JSON.stringify(state));
    assert.equal(body.commande.reference, 'IPG-261119-ABCDE');
    assert.equal(body.commande.produit, 'Piscine iPoolGo Ronde Ø 3 m × 1,20 m');
    assert.equal(body.commande.total, catalog.formatAmount(TOTAL));
    assert.equal(body.commande.devise, 'EUR');
    for (const secret of ['Martin', 'Camille', 'example.com', '0612345678', 'Lilas', '69003', 'Lyon']) {
      assert.ok(!response.body.includes(secret), `fuite de ${secret}`);
    }
  }
});

test('check-payment : session inconnue ou étrangère au site', async () => {
  mockFetch(() => reply(404, { error: { code: 'resource_missing' } }));
  assert.equal((await checkPayment(get(SESSION_ID))).statusCode, 404);

  mockFetch(() => reply(200, paidSession({ metadata: { order_id: '42' } })));
  assert.equal((await checkPayment(get(SESSION_ID))).statusCode, 404);

  mockFetch(() => reply(503, {}));
  assert.equal((await checkPayment(get(SESSION_ID))).statusCode, 502);

  assert.equal((await checkPayment({ httpMethod: 'POST', headers: {} })).statusCode, 405);
});

// ---------------------------------------------------------------- webhook

function stripeAndBrevo(session, brevoStatus) {
  mockFetch((call) => {
    if (call.url.startsWith(STRIPE)) return reply(200, call.method === 'GET' ? session : { id: 'pi_3QabcDEF' });
    if (call.url === BREVO) {
      const status = typeof brevoStatus === 'function' ? brevoStatus(call) : brevoStatus || 201;
      return reply(status, status === 201 ? { messageId: '<id@smtp-relay.mailin.fr>' } : { code: 'unauthorized', message: 'Key not found' });
    }
    throw new Error(`URL inattendue : ${call.url}`);
  });
}

function brevoCalls() {
  return calls.filter((call) => call.url === BREVO);
}

test('webhook : paiement payé, vérifié chez Stripe puis deux e-mails Brevo', async () => {
  stripeAndBrevo(paidSession());
  const response = await webhook(hook(stripeEvent(SESSION_ID)));
  assert.equal(response.statusCode, 200);

  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, `${STRIPE}/checkout/sessions/${SESSION_ID}?expand[]=payment_intent.latest_charge`);
  assert.equal(calls[0].headers.Authorization, 'Bearer rk_test_cle_stripe_factice');

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
  assert.match(seller.body.subject, /^\[iPoolGoFrance\.fr\] Nouvelle commande iPoolGo France payée/);
  assert.equal(seller.body.replyTo.email, 'camille.martin@example.com');
  for (const expected of ['IPG-261119-ABCDE', SESSION_ID, 'Piscine iPoolGo Ronde', 'Ø 3 m × 1,20 m', '12 rue des Lilas', '69003 Lyon', '0612345678']) {
    assert.ok(seller.body.htmlContent.includes(expected), `e-mail vendeur sans ${expected}`);
  }
  assert.ok(seller.body.htmlContent.includes(catalog.formatEUR(TOTAL)));
  assert.ok(!seller.body.htmlContent.includes('Attention'));
  assert.ok(seller.body.htmlContent.includes('Remise : <strong>Livraison en France métropolitaine</strong>'));
  assert.ok(!seller.body.subject.endsWith(', retrait'));

  assert.equal(customer.body.to[0].email, 'camille.martin@example.com');
  assert.equal(customer.body.replyTo.email, 'vendeur@example.com');
  assert.ok(customer.body.htmlContent.includes('IPG-261119-ABCDE'));
  assert.ok(!customer.body.htmlContent.includes(SESSION_ID), 'le client voit la référence courte');
  for (const expected of ['Pompe de gonflage électrique', 'Système de filtration à sable', 'Offert', 'SAS Virage', 'garantie légale de conformité de 2 ans', 'contact@gigifrance.fr']) {
    assert.ok(customer.body.htmlContent.includes(expected), `e-mail client sans ${expected}`);
  }

  const mark = calls[calls.length - 1];
  assert.equal(mark.method, 'POST');
  assert.equal(mark.url, `${STRIPE}/payment_intents/pi_3QabcDEF`);
  assert.ok(mark.body['metadata[mail_vendeur]']);
  assert.ok(mark.body['metadata[mail_client]']);
  assert.equal(Object.keys(mark.body).length, 2, 'seuls les marqueurs sont envoyés, Stripe fusionne');
});

test('webhook : paiement différé confirmé (async_payment_succeeded)', async () => {
  stripeAndBrevo(paidSession());
  assert.equal((await webhook(hook(stripeEvent(SESSION_ID, 'checkout.session.async_payment_succeeded')))).statusCode, 200);
  assert.equal(brevoCalls().length, 2);
});

test('webhook : corps encodé en base64 par la passerelle', async () => {
  stripeAndBrevo(paidSession());
  const event = hook(Buffer.from(stripeEvent(SESSION_ID)).toString('base64'));
  event.isBase64Encoded = true;
  assert.equal((await webhook(event)).statusCode, 200);
  assert.equal(brevoCalls().length, 2);
});

test('webhook : usurpation, un paiement "paid" annoncé dans la requête ne déclenche rien', async () => {
  const states = [
    { status: 'open', payment_status: 'unpaid' },
    { status: 'complete', payment_status: 'unpaid' },
    { status: 'expired', payment_status: 'unpaid' }
  ];
  for (const state of states) {
    stripeAndBrevo(paidSession(state));
    const forged = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { id: SESSION_ID, object: 'checkout.session', status: 'complete', payment_status: 'paid', amount_total: 1 } }
    });
    const response = await webhook(hook(forged));
    assert.equal(response.statusCode, 200, JSON.stringify(state));
    assert.equal(calls.length, 1, 'seule la vérification Stripe doit partir');
    assert.equal(calls[0].method, 'GET');
  }
});

test('webhook : identifiant absent ou malformé, 200 sans aucun appel', async () => {
  const bodies = [
    '',
    '{cassé',
    'id=cs_test_a1B2c3D4e5F6g7H8i9J0kLmNoPq',
    JSON.stringify({ data: { object: { id: SESSION_ID, object: 'payment_intent' } } }),
    JSON.stringify({ data: { object: { id: 'cs_test_abc/../../x', object: 'checkout.session' } } }),
    JSON.stringify({ data: { object: { id: { $ne: 1 }, object: 'checkout.session' } } }),
    JSON.stringify({ id: SESSION_ID })
  ];
  for (const body of bodies) {
    assert.equal((await webhook(hook(body))).statusCode, 200, body);
  }
  assert.equal(calls.length, 0);
});

test('webhook : signature vérifiée quand STRIPE_WEBHOOK_SECRET est définie', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret_factice';
  const body = stripeEvent(SESSION_ID);
  const sign = (timestamp, secret) =>
    `t=${timestamp},v1=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
  const now = Math.floor(Date.now() / 1000);

  for (const signature of ['', 't=1,v1=abc', sign(now, 'whsec_autre'), sign(now - 3600, 'whsec_test_secret_factice')]) {
    assert.equal((await webhook(hook(body, { 'stripe-signature': signature }))).statusCode, 400, signature);
  }
  assert.equal(calls.length, 0);

  stripeAndBrevo(paidSession());
  assert.equal((await webhook(hook(body, { 'Stripe-Signature': sign(now, 'whsec_test_secret_factice') }))).statusCode, 200);
  assert.equal(brevoCalls().length, 2);
});

test('webhook : session inconnue chez Stripe, 200 sans e-mail', async () => {
  mockFetch(() => reply(404, { error: { code: 'resource_missing' } }));
  assert.equal((await webhook(hook(stripeEvent(SESSION_ID)))).statusCode, 200);
  assert.equal(calls.length, 1);
});

test('webhook : Stripe injoignable, 500 pour que Stripe rappelle', async () => {
  mockFetch(() => reply(503, {}));
  assert.equal((await webhook(hook(stripeEvent(SESSION_ID)))).statusCode, 500);

  mockFetch(() => {
    throw new Error('timeout');
  });
  assert.equal((await webhook(hook(stripeEvent(SESSION_ID)))).statusCode, 500);
});

test('webhook : paiement d’un autre site, remboursé ou contesté, rien n’est envoyé', async () => {
  const cases = [
    paidSession({ metadata: { order_id: '42' } }),
    paidSession({}, {}, { amount_refunded: TOTAL * 100 }),
    paidSession({}, {}, { disputed: true }),
    paidSession({ payment_intent: null })
  ];
  for (const session of cases) {
    stripeAndBrevo(session);
    assert.equal((await webhook(hook(stripeEvent(SESSION_ID)))).statusCode, 200);
    assert.equal(brevoCalls().length, 0);
  }
});

test('webhook : e-mails déjà envoyés, aucun doublon', async () => {
  stripeAndBrevo(paidSession({}, { mail_vendeur: '2026-06-01T10:00:00.000Z', mail_client: '2026-06-01T10:00:01.000Z' }));
  assert.equal((await webhook(hook(stripeEvent(SESSION_ID)))).statusCode, 200);
  assert.equal(calls.length, 1);
});

test('webhook : un e-mail en échec, 500 et seul l’envoi réussi est marqué', async () => {
  stripeAndBrevo(paidSession(), (call) => (call.body.to[0].email === 'vendeur@example.com' ? 201 : 401));
  const response = await webhook(hook(stripeEvent(SESSION_ID)));
  assert.equal(response.statusCode, 500);
  const mark = calls[calls.length - 1];
  assert.equal(mark.url, `${STRIPE}/payment_intents/pi_3QabcDEF`);
  assert.ok(mark.body['metadata[mail_vendeur]']);
  assert.equal(mark.body['metadata[mail_client]'], undefined);

  // Rappel de Stripe : seul l'e-mail client repart.
  stripeAndBrevo(paidSession({}, { mail_vendeur: mark.body['metadata[mail_vendeur]'] }));
  assert.equal((await webhook(hook(stripeEvent(SESSION_ID)))).statusCode, 200);
  assert.equal(brevoCalls().length, 1);
  assert.equal(brevoCalls()[0].body.to[0].email, 'camille.martin@example.com');
});

test('webhook : clé Brevo absente, 500 sans envoi', async () => {
  delete process.env.BREVO_API_KEY;
  stripeAndBrevo(paidSession());
  assert.equal((await webhook(hook(stripeEvent(SESSION_ID)))).statusCode, 500);
  assert.equal(brevoCalls().length, 0);
});

test('webhook : sans SELLER_EMAIL ni SENDER_EMAIL, envoi depuis noreply@ipoolgofrance.fr, réponses vers le vendeur', async () => {
  delete process.env.SELLER_EMAIL;
  delete process.env.SENDER_EMAIL;
  stripeAndBrevo(paidSession());
  assert.equal((await webhook(hook(stripeEvent(SESSION_ID)))).statusCode, 200);
  const [seller, customer] = brevoCalls();
  assert.deepEqual(seller.body.to, [{ email: 'contact@gigifrance.fr' }]);
  assert.equal(seller.body.sender.email, 'noreply@ipoolgofrance.fr');
  assert.equal(customer.body.sender.email, 'noreply@ipoolgofrance.fr');
  assert.equal(seller.body.replyTo.email, 'camille.martin@example.com');
  assert.equal(customer.body.replyTo.email, 'contact@gigifrance.fr');
});

test('check-payment : paiement confirmé, les e-mails partent une seule fois sans webhook', async () => {
  stripeAndBrevo(paidSession());
  assert.equal((await checkPayment(get(SESSION_ID))).statusCode, 200);
  assert.equal(brevoCalls().length, 2);
  const mark = calls.find((call) => call.method === 'POST' && call.url.startsWith(STRIPE));
  assert.equal(mark.url, `${STRIPE}/payment_intents/pi_3QabcDEF`);
  assert.ok(mark.body['metadata[mail_vendeur]']);
  assert.ok(mark.body['metadata[mail_client]']);

  // Nouvel affichage de merci.html : déjà noté, rien ne repart.
  stripeAndBrevo(paidSession({}, { mail_vendeur: '2026-11-19T10:00:00Z', mail_client: '2026-11-19T10:00:00Z' }));
  assert.equal((await checkPayment(get(SESSION_ID))).statusCode, 200);
  assert.equal(brevoCalls().length, 0);
});

test('check-payment : envoi Brevo en échec, la page reçoit quand même le statut', async () => {
  stripeAndBrevo(paidSession(), 500);
  const response = await checkPayment(get(SESSION_ID));
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).status, 'paid');
  assert.equal(calls.filter((call) => call.method === 'POST' && call.url.startsWith(STRIPE)).length, 0);
});

test('check-payment : paiement non confirmé, aucun e-mail', async () => {
  stripeAndBrevo(paidSession({ status: 'open', payment_status: 'unpaid' }));
  assert.equal((await checkPayment(get(SESSION_ID))).statusCode, 200);
  assert.equal(brevoCalls().length, 0);
});

test('webhook : les champs saisis sont échappés dans les e-mails', async () => {
  const session = paidSession();
  session.metadata.nom = '<script>alert(1)</script>';
  session.metadata.adresse = '1 rue "A" <img src=x onerror=alert(1)>';
  stripeAndBrevo(session);
  await webhook(hook(stripeEvent(SESSION_ID)));
  for (const mail of brevoCalls()) {
    assert.ok(!mail.body.htmlContent.includes('<script>'));
    assert.ok(!mail.body.htmlContent.includes('<img'));
    assert.ok(mail.body.htmlContent.includes('&lt;script&gt;'));
  }
});

test('webhook : commande à retirer, e-mails adaptés et montant sans livraison accepté', async () => {
  const session = paidSession({ amount_total: 139900 });
  Object.assign(session.metadata, { remise: 'retrait', livraison: '0.00', total: '1399.00' });
  stripeAndBrevo(session);
  await webhook(hook(stripeEvent(SESSION_ID)));
  const [seller, customer] = brevoCalls();
  assert.ok(!seller.body.htmlContent.includes('Attention'), 'montant conforme pour un retrait');
  assert.match(seller.body.subject, /, retrait$/);
  for (const expected of ['Retrait au dépôt de Noisy-le-Grand', 'Adresse du client (facturation)', 'À remettre au client']) {
    assert.ok(seller.body.htmlContent.includes(expected), `e-mail vendeur sans ${expected}`);
  }
  for (const expected of ['Retrait au dépôt de Noisy-le-Grand', 'Gratuit', 'adresse exacte du retrait', 'à compter du retrait']) {
    assert.ok(customer.body.htmlContent.includes(expected), `e-mail client sans ${expected}`);
  }
  for (const mail of [seller, customer]) {
    assert.ok(!mail.body.htmlContent.includes('Livraison en France métropolitaine'));
    assert.ok(!mail.body.htmlContent.includes('transporteur'));
  }

  // Un retrait facturé au prix livré (ou l'inverse) alerte le vendeur.
  const delivered = paidSession();
  Object.assign(delivered.metadata, { remise: 'retrait' });
  stripeAndBrevo(delivered);
  await webhook(hook(stripeEvent(SESSION_ID)));
  assert.ok(brevoCalls()[0].body.htmlContent.includes('Attention'));
});

test('check-payment : le mode de remise est renvoyé à la page merci', async () => {
  const session = paidSession({ status: 'open', payment_status: 'unpaid' });
  stripeAndBrevo(session);
  assert.equal(JSON.parse((await checkPayment(get(SESSION_ID))).body).commande.remise, 'livraison', 'commande ancienne : livraison');
  session.metadata.remise = 'retrait';
  stripeAndBrevo(session);
  assert.equal(JSON.parse((await checkPayment(get(SESSION_ID))).body).commande.remise, 'retrait');
});

test('webhook : montant encaissé différent du catalogue, le vendeur est alerté', async () => {
  stripeAndBrevo(paidSession({ amount_total: 100 }));
  await webhook(hook(stripeEvent(SESSION_ID)));
  assert.ok(brevoCalls()[0].body.htmlContent.includes('Attention'));

  stripeAndBrevo(paidSession({ currency: 'usd' }));
  await webhook(hook(stripeEvent(SESSION_ID)));
  assert.ok(brevoCalls()[0].body.htmlContent.includes('Attention'));
});

test('webhook : marquage Stripe en échec, les e-mails sont partis et la réponse reste 200', async () => {
  mockFetch((call) => {
    if (call.url.startsWith(`${STRIPE}/payment_intents/`)) return reply(503, {});
    if (call.url.startsWith(STRIPE)) return reply(200, paidSession());
    return reply(201, { messageId: '<id@smtp-relay.mailin.fr>' });
  });
  assert.equal((await webhook(hook(stripeEvent(SESSION_ID)))).statusCode, 200);
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
