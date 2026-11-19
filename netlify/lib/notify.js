'use strict';

// Envoi des deux e-mails d'une commande payée (vendeur et client), partagé par
// le webhook Stripe et par check-payment (retour du client sur merci.html).
// Le webhook est donc facultatif : sans lui, les e-mails partent dès que le
// client revient sur la page de confirmation.
//
// Sans base de données, l'envoi de chaque e-mail est noté dans les métadonnées
// du PaymentIntent Stripe : un e-mail déjà noté ne repart pas. Le marquage suit
// l'envoi : deux appels simultanés peuvent donc produire un doublon, jamais une
// commande sans e-mail.

const { ORDER_SOURCE, stripe, sendEmail } = require('./shared.js');
const { sellerEmail, customerEmail } = require('./emails.js');

const FLAGS = { seller: 'mail_vendeur', customer: 'mail_client' };

// Adresse du vendeur, qui reçoit les commandes et sert d'expéditeur (validée dans Brevo).
// Les variables d'environnement SELLER_EMAIL et SENDER_EMAIL la remplacent si besoin.
const DEFAULT_EMAIL = 'contact@gigifrance.fr';

function emailEnv() {
  return {
    SELLER_EMAIL: (process.env.SELLER_EMAIL || '').trim() || DEFAULT_EMAIL,
    SENDER_EMAIL: (process.env.SENDER_EMAIL || '').trim() || DEFAULT_EMAIL
  };
}

// Renvoie 'ignored' (rien à envoyer), 'sent' (tout est parti ou l'était déjà),
// 'config' (clé Brevo absente) ou 'failed' (au moins un envoi en échec).
async function notifyOrder(payment, caller) {
  if (payment.status !== 'paid' || !payment.intentId) return 'ignored';
  const metadata = payment.metadata;
  if (metadata.source !== ORDER_SOURCE) return 'ignored';

  // Un appel tardif après un remboursement ou une contestation n'envoie rien.
  if (payment.refunded) return 'ignored';

  const messages = [
    { flag: FLAGS.seller, build: sellerEmail },
    { flag: FLAGS.customer, build: customerEmail }
  ].filter((message) => !metadata[message.flag]);
  if (messages.length === 0) return 'sent';

  if (!process.env.BREVO_API_KEY) {
    console.error(`${caller} : BREVO_API_KEY absente, e-mails non envoyés pour`, payment.id);
    return 'config';
  }

  const env = emailEnv();
  const results = await Promise.allSettled(messages.map((message) => sendEmail(message.build(payment, env))));

  const sent = {};
  let failed = false;
  results.forEach((result, index) => {
    const flag = messages[index].flag;
    if (result.status === 'fulfilled') {
      sent[flag] = new Date().toISOString();
    } else {
      failed = true;
      console.error(`${caller} : envoi ${flag} en échec pour ${payment.id},`, result.reason && result.reason.message);
    }
  });

  if (Object.keys(sent).length > 0) {
    try {
      // Stripe fusionne les métadonnées : seules les nouvelles clés sont envoyées.
      await stripe('POST', `/payment_intents/${payment.intentId}`, { metadata: sent });
    } catch (error) {
      // Sans ce marquage, un nouvel appel pourrait renvoyer un e-mail en double.
      console.warn(`${caller} : marquage des e-mails impossible pour ${payment.id},`, error.message);
    }
  }

  return failed ? 'failed' : 'sent';
}

module.exports = { FLAGS, DEFAULT_EMAIL, emailEnv, notifyOrder };
