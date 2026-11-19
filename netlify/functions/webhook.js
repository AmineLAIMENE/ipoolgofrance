'use strict';

// POST /.netlify/functions/webhook  (appelé par Stripe : événements
// checkout.session.completed et checkout.session.async_payment_succeeded)
//
// Le corps de la requête n'est jamais cru sur parole : seul l'identifiant de
// session est lu, puis la session est relue chez Stripe avec la clé secrète.
// Sans paiement confirmé par Stripe, rien n'est envoyé. Si STRIPE_WEBHOOK_SECRET
// est définie, la signature Stripe est en plus vérifiée.
//
// Sans base de données, l'envoi de chaque e-mail est noté dans les métadonnées
// du paiement Stripe. Si un e-mail échoue, la fonction répond 500 : Stripe
// rappelle le webhook et seul l'e-mail manquant repart. Le marquage suit l'envoi :
// deux appels simultanés peuvent donc produire un doublon, jamais une commande
// sans e-mail.

const crypto = require('crypto');
const { ORDER_SOURCE, ApiError, json, header, rawBody, isPaymentId, stripe, readSession, toPayment, sendEmail } = require('../lib/shared.js');
const { sellerEmail, customerEmail } = require('../lib/emails.js');

const FLAGS = { seller: 'mail_vendeur', customer: 'mail_client' };
const SIGNATURE_TOLERANCE_S = 300;

// En-tête Stripe-Signature : "t=horodatage,v1=signature[,v1=...]".
function validSignature(raw, signature, secret, now) {
  const parts = {};
  String(signature || '').split(',').forEach((part) => {
    const index = part.indexOf('=');
    if (index > 0) (parts[part.slice(0, index)] = parts[part.slice(0, index)] || []).push(part.slice(index + 1));
  });
  const timestamp = Number(parts.t && parts.t[0]);
  if (!timestamp || Math.abs(now / 1000 - timestamp) > SIGNATURE_TOLERANCE_S) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`, 'utf8').digest();
  return (parts.v1 || []).some((value) => {
    const given = Buffer.from(value, 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

function readSessionId(raw) {
  if (!raw || raw.length > 65536) return null;
  let body;
  try {
    body = JSON.parse(raw);
  } catch (error) {
    return null;
  }
  const object = body && body.data && body.data.object;
  const id = object && object.object === 'checkout.session' ? object.id : null;
  return isPaymentId(id) ? id : null;
}

exports.handler = async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'methode_non_autorisee' }, { Allow: 'POST' });
  }

  const raw = rawBody(event);
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (secret && !validSignature(raw, header(event, 'stripe-signature'), secret, Date.now())) {
    return json(400, { error: 'signature_invalide' });
  }

  const id = readSessionId(raw);
  if (!id) return json(200, { ok: true });

  // Anti-usurpation : seul l'état relu chez Stripe fait foi.
  let payment;
  try {
    payment = toPayment(await readSession(id));
  } catch (error) {
    if (error instanceof ApiError && [400, 404].includes(error.status)) {
      return json(200, { ok: true }); // session inconnue de ce compte Stripe
    }
    console.error('webhook : lecture Stripe impossible,', error.message);
    return json(500, { error: 'stripe_indisponible' }); // Stripe rappellera le webhook
  }

  if (payment.status !== 'paid' || !payment.intentId) return json(200, { ok: true });

  const metadata = payment.metadata;
  if (metadata.source !== ORDER_SOURCE) return json(200, { ok: true });

  // Un rappel tardif après un remboursement ou une contestation n'envoie rien.
  if (payment.refunded) return json(200, { ok: true });

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
      // Stripe fusionne les métadonnées : seules les nouvelles clés sont envoyées.
      await stripe('POST', `/payment_intents/${payment.intentId}`, { metadata: sent });
    } catch (error) {
      // Sans ce marquage, un rappel du webhook pourrait renvoyer un e-mail en double.
      console.warn(`webhook : marquage des e-mails impossible pour ${id},`, error.message);
    }
  }

  return failed ? json(500, { error: 'email_en_echec' }) : json(200, { ok: true });
};

exports.validSignature = validSignature;
