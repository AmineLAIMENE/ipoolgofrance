'use strict';

// POST /.netlify/functions/webhook  (appelé par Stripe : événements
// checkout.session.completed et checkout.session.async_payment_succeeded)
//
// Le corps de la requête n'est jamais cru sur parole : seul l'identifiant de
// session est lu, puis la session est relue chez Stripe avec la clé secrète.
// Sans paiement confirmé par Stripe, rien n'est envoyé. Si STRIPE_WEBHOOK_SECRET
// est définie, la signature Stripe est en plus vérifiée.
//
// L'envoi et son marquage sont dans netlify/lib/notify.js. Si un e-mail échoue,
// la fonction répond 500 : Stripe rappelle le webhook et seul l'e-mail manquant
// repart. Le webhook est facultatif : check-payment envoie aussi les e-mails
// quand le client revient sur merci.html.

const crypto = require('crypto');
const { ApiError, json, header, rawBody, isPaymentId, readSession, toPayment } = require('../lib/shared.js');
const { notifyOrder } = require('../lib/notify.js');

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

  const result = await notifyOrder(payment, 'webhook');
  if (result === 'config') return json(500, { error: 'configuration_incomplete' });
  // En cas d'échec, Stripe rappelle le webhook et seul l'e-mail manquant repart.
  if (result === 'failed') return json(500, { error: 'email_en_echec' });
  return json(200, { ok: true });
};

exports.validSignature = validSignature;
