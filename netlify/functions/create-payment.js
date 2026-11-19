'use strict';

// POST /.netlify/functions/create-payment
// Valide la commande, recalcule le prix depuis le catalogue puis crée la session de paiement Stripe Checkout.
// Le montant envoyé par le navigateur ne sert qu'à détecter un prix affiché périmé ou falsifié.

const catalog = require('../../assets/js/catalog.js');
const crypto = require('crypto');
const { ORDER_SOURCE, siteUrl, json, header, rawBody, isAllowedOrigin, stripe } = require('../lib/shared.js');

const MAX_BODY_BYTES = 4096;
// Référence courte donnée au client (IPG-AAMMJJ-XXXXX), sans caractère ambigu.
const REFERENCE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function orderReference(now) {
  const date = now.toISOString().slice(2, 10).replace(/-/g, '');
  const bytes = crypto.randomBytes(5);
  let suffix = '';
  for (const byte of bytes) suffix += REFERENCE_CHARS[byte % REFERENCE_CHARS.length];
  return `IPG-${date}-${suffix}`;
}

function cents(amount) {
  return Math.round(amount * 100);
}

// champ du formulaire -> [clé de métadonnée, longueur maximale]
const FIELDS = {
  nom: ['nom', 50],
  prenom: ['prenom', 50],
  email: ['email', 100],
  telephone: ['telephone', 20],
  adresse: ['adresse', 120],
  codePostal: ['code_postal', 5],
  ville: ['ville', 50]
};

const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i;
const PHONE = /^\+?[0-9]{9,15}$/;
const POSTAL_CODE = /^[0-9]{5}$/;

function clean(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function validateCustomer(input, mode) {
  const customer = {};
  const errors = {};
  const source = input && typeof input === 'object' ? input : {};

  for (const field of Object.keys(FIELDS)) {
    const max = FIELDS[field][1];
    const value = clean(source[field]);
    if (!value) errors[field] = 'Ce champ est obligatoire.';
    else if (value.length > max) errors[field] = `${max} caractères maximum.`;
    customer[field] = value;
  }

  if (!errors.email && !EMAIL.test(customer.email)) {
    errors.email = 'Adresse e-mail invalide.';
  }

  if (!errors.telephone) {
    const digits = customer.telephone.replace(/[\s.()-]/g, '');
    if (PHONE.test(digits)) customer.telephone = digits;
    else errors.telephone = 'Numéro de téléphone invalide.';
  }

  if (!errors.codePostal) {
    if (!POSTAL_CODE.test(customer.codePostal)) {
      errors.codePostal = 'Code postal à 5 chiffres attendu.';
    } else if (mode === 'livraison' && /^9[78]/.test(customer.codePostal)) {
      errors.codePostal = 'Livraison en France métropolitaine uniquement. Contactez-nous pour une autre destination.';
    }
  }

  return { customer, errors };
}

exports.handler = async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'methode_non_autorisee' }, { Allow: 'POST' });
  }
  if (!isAllowedOrigin(header(event, 'origin'))) {
    return json(403, { error: 'origine_refusee' });
  }

  const raw = rawBody(event);
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return json(413, { error: 'requete_trop_longue' });
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch (error) {
    input = null;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return json(400, { error: 'requete_invalide', message: 'Requête illisible.' });
  }

  // Champ piège invisible : un humain le laisse vide.
  if (clean(input.site_web)) {
    return json(400, { error: 'requete_invalide', message: 'Requête refusée.' });
  }

  // Livraison ou retrait : choix obligatoire du client.
  const modeId = input.remise;
  if (!catalog.getMode(modeId)) {
    return json(400, { error: 'remise_invalide', message: 'Choisissez la livraison ou le retrait.' });
  }

  const quote = catalog.quote(input.modele, input.taille, modeId);
  if (!quote) {
    return json(400, { error: 'produit_inconnu', message: 'Ce modèle ou cette taille n’existe pas.' });
  }

  // Le prix fait foi côté serveur. Un montant différent côté client est refusé.
  if (typeof input.montant !== 'number' || Math.round(input.montant * 100) !== Math.round(quote.total * 100)) {
    return json(409, {
      error: 'montant_invalide',
      message: 'Le prix affiché n’est plus à jour. Rechargez la page avant de payer.',
      total: quote.total
    });
  }

  if (input.cgv !== true) {
    return json(400, {
      error: 'cgv_non_acceptees',
      message: 'Vous devez accepter les Conditions Générales de Vente pour commander.'
    });
  }

  const { customer, errors } = validateCustomer(input.client, quote.mode.id);
  if (Object.keys(errors).length > 0) {
    return json(400, { error: 'champs_invalides', message: 'Certains champs sont à corriger.', champs: errors });
  }

  const now = new Date();
  const reference = orderReference(now);
  const metadata = {
    source: ORDER_SOURCE,
    reference,
    modele: quote.model.id,
    taille: quote.size.id,
    produit: quote.label,
    prix: catalog.formatAmount(quote.price),
    remise: quote.mode.id,
    livraison: catalog.formatAmount(quote.shipping),
    total: catalog.formatAmount(quote.total),
    cgv_acceptees: now.toISOString()
  };
  for (const field of Object.keys(FIELDS)) {
    metadata[FIELDS[field][0]] = customer[field];
  }

  const lineItems = [
    { quantity: 1, price_data: { currency: 'eur', unit_amount: cents(quote.price), product_data: { name: quote.label } } }
  ];
  if (quote.shipping > 0) {
    lineItems.push({
      quantity: 1,
      price_data: { currency: 'eur', unit_amount: cents(quote.shipping), product_data: { name: 'Livraison en France métropolitaine' } }
    });
  }

  const site = siteUrl();
  const back = new URLSearchParams({ modele: quote.model.id, taille: quote.size.id, remise: quote.mode.id });
  // Les moyens de paiement proposés sont ceux activés dans le tableau de bord Stripe.
  const session = {
    mode: 'payment',
    locale: 'fr',
    line_items: lineItems,
    customer_email: customer.email,
    client_reference_id: reference,
    success_url: `${site}/merci.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${site}/commande.html?${back.toString()}`,
    metadata,
    // Copie sur le paiement : la commande se lit dans Stripe > Paiements, et le webhook y note les e-mails envoyés.
    payment_intent_data: { description: `iPoolGo France ${reference} - ${quote.label}`, metadata }
  };

  try {
    const created = await stripe('POST', '/checkout/sessions', session);
    if (!created.id || !/^https:\/\//.test(created.url || '')) throw new Error('réponse Stripe sans lien de paiement');
    return json(200, { paymentId: created.id, checkoutUrl: created.url });
  } catch (error) {
    console.error('create-payment :', error.message);
    return json(502, {
      error: 'paiement_indisponible',
      message: 'Le paiement est momentanément indisponible. Réessayez dans quelques minutes ou contactez-nous.'
    });
  }
};
