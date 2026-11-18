'use strict';

// POST /.netlify/functions/webhook  (appelé par Mollie : `id=tr_xxx`)
//
// Le corps de la requête n'est jamais cru sur parole : il ne contient qu'un
// identifiant, et le statut est relu chez Mollie avec la clé secrète. Sans
// statut "paid" confirmé par Mollie, rien n'est envoyé.
//
// Sans base de données, l'envoi de chaque e-mail est noté dans les métadonnées
// du paiement Mollie. Si un e-mail échoue, la fonction répond 500 : Mollie
// rappelle le webhook et seul l'e-mail manquant repart. Le marquage suit l'envoi :
// deux appels simultanés peuvent donc produire un doublon, jamais une commande
// sans e-mail.

const { ORDER_SOURCE, ApiError, json, header, rawBody, isPaymentId, mollie, sendEmail } = require('../lib/shared.js');
const { sellerEmail, customerEmail } = require('../lib/emails.js');

const FLAGS = { seller: 'mail_vendeur', customer: 'mail_client' };

function readPaymentId(event) {
  const raw = rawBody(event).trim();
  if (!raw || raw.length > 2048) return null;

  let id = null;
  const type = header(event, 'content-type').toLowerCase();
  if (type.includes('application/json') || raw.startsWith('{')) {
    try {
      const body = JSON.parse(raw);
      id = body && typeof body === 'object' ? body.id : null;
    } catch (error) {
      id = null;
    }
  } else {
    id = new URLSearchParams(raw).get('id');
  }
  return isPaymentId(id) ? id : null;
}

function positive(amount) {
  return Boolean(amount) && Number(amount.value) > 0;
}

exports.handler = async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'methode_non_autorisee' }, { Allow: 'POST' });
  }

  const id = readPaymentId(event);
  if (!id) return json(200, { ok: true });

  // Anti-usurpation : seul le statut relu chez Mollie fait foi.
  let payment;
  try {
    payment = await mollie('GET', `/payments/${id}`);
  } catch (error) {
    if (error instanceof ApiError && [400, 404, 410, 422].includes(error.status)) {
      return json(200, { ok: true }); // identifiant inconnu de ce compte Mollie
    }
    console.error('webhook : lecture Mollie impossible,', error.message);
    return json(500, { error: 'mollie_indisponible' }); // Mollie rappellera le webhook
  }

  if (payment.status !== 'paid') return json(200, { ok: true });

  const metadata = payment.metadata || {};
  if (metadata.source !== ORDER_SOURCE) return json(200, { ok: true });

  // Mollie rappelle aussi le webhook lors d'un remboursement ou d'une contestation.
  if (positive(payment.amountRefunded) || positive(payment.amountChargedBack)) {
    return json(200, { ok: true });
  }

  const env = {
    SELLER_EMAIL: (process.env.SELLER_EMAIL || '').trim(),
    SENDER_EMAIL: (process.env.SENDER_EMAIL || '').trim()
  };
  if (!process.env.BREVO_API_KEY || !env.SELLER_EMAIL || !env.SENDER_EMAIL) {
    console.error('webhook : BREVO_API_KEY, SELLER_EMAIL ou SENDER_EMAIL absente, e-mails non envoyés pour', id);
    return json(500, { error: 'configuration_incomplete' });
  }

  // Les e-mails déjà notés lors d'un appel précédent ne repartent pas.
  const messages = [
    { flag: FLAGS.seller, build: sellerEmail },
    { flag: FLAGS.customer, build: customerEmail }
  ].filter((message) => !metadata[message.flag]);

  const results = await Promise.allSettled(messages.map((message) => sendEmail(message.build(payment, env))));

  const sent = {};
  let failed = false;
  results.forEach((result, index) => {
    const flag = messages[index].flag;
    if (result.status === 'fulfilled') {
      sent[flag] = new Date().toISOString();
    } else {
      failed = true;
      console.error(`webhook : envoi ${flag} en échec pour ${id},`, result.reason && result.reason.message);
    }
  });

  if (Object.keys(sent).length > 0) {
    try {
      await mollie('PATCH', `/payments/${id}`, { metadata: Object.assign({}, metadata, sent) });
    } catch (error) {
      // Sans ce marquage, un rappel du webhook pourrait renvoyer un e-mail en double.
      console.warn(`webhook : marquage des e-mails impossible pour ${id},`, error.message);
    }
  }

  return failed ? json(500, { error: 'email_en_echec' }) : json(200, { ok: true });
};

