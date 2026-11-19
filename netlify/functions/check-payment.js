'use strict';

// GET /.netlify/functions/check-payment?id=cs_xxx
// Renvoie le statut de la session Stripe et un récapitulatif sans donnée personnelle
// (ni nom, ni e-mail, ni adresse) pour la page merci.html.
// Si le paiement est confirmé, envoie aussi les e-mails de commande qui ne sont
// pas encore partis : la commande est notifiée même sans webhook Stripe.

const { ORDER_SOURCE, ApiError, json, isPaymentId, readSession, toPayment } = require('../lib/shared.js');
const { notifyOrder } = require('../lib/notify.js');

exports.handler = async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'methode_non_autorisee' }, { Allow: 'GET' });
  }

  const id = event.queryStringParameters && event.queryStringParameters.id;
  if (!isPaymentId(id)) {
    return json(400, { error: 'identifiant_invalide' });
  }

  let payment;
  try {
    payment = toPayment(await readSession(id));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return json(404, { error: 'paiement_introuvable' });
    }
    console.error('check-payment :', error.message);
    return json(502, { error: 'verification_indisponible' });
  }

  const metadata = payment.metadata;
  if (metadata.source !== ORDER_SOURCE) {
    return json(404, { error: 'paiement_introuvable' });
  }

  // Un échec d'envoi ne bloque pas la page : le prochain appel (ou le webhook) réessaie.
  await notifyOrder(payment, 'check-payment');

  return json(200, {
    status: payment.status,
    commande: {
      reference: metadata.reference,
      modele: metadata.modele,
      taille: metadata.taille,
      produit: metadata.produit,
      prix: metadata.prix,
      remise: metadata.remise || 'livraison',
      livraison: metadata.livraison,
      total: payment.amount.value,
      devise: payment.amount.currency
    }
  });
};
