'use strict';

// POST /.netlify/functions/create-payment
// Valide la commande, recalcule le prix depuis le catalogue puis crée le paiement Mollie.
// Le montant envoyé par le navigateur ne sert qu'à détecter un prix affiché périmé ou falsifié.

const catalog = require('../../assets/js/catalog.js');
const { ORDER_SOURCE, siteUrl, json, header, rawBody, isAllowedOrigin, mollie } = require('../lib/shared.js');

const MAX_BODY_BYTES = 4096;
// Mollie limite les métadonnées à environ 1 ko ; le webhook y ajoute ensuite deux dates d'envoi.
const MAX_METADATA_BYTES = 900;

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

function validateCustomer(input) {
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
    } else if (/^9[78]/.test(customer.codePostal)) {
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

  const quote = catalog.quote(input.modele, input.taille);
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

  const { customer, errors } = validateCustomer(input.client);
  if (Object.keys(errors).length > 0) {
    return json(400, { error: 'champs_invalides', message: 'Certains champs sont à corriger.', champs: errors });
  }

  const metadata = {
    source: ORDER_SOURCE,
    modele: quote.model.id,
    taille: quote.size.id,
    produit: quote.label,
    prix: catalog.formatAmount(quote.price),
    livraison: catalog.formatAmount(quote.shipping),
    total: catalog.formatAmount(quote.total),
    cgv_acceptees: new Date().toISOString()
  };
  for (const field of Object.keys(FIELDS)) {
    metadata[FIELDS[field][0]] = customer[field];
  }
  if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > MAX_METADATA_BYTES) {
    return json(400, {
      error: 'champs_invalides',
      message: 'Certains champs sont à corriger.',
      champs: { adresse: 'Adresse trop longue, merci de l’abréger.' }
    });
  }

  const site = siteUrl();
  const payment = {
    amount: { currency: 'EUR', value: catalog.formatAmount(quote.total) },
    description: `iPoolGo France - ${quote.label}`,
    redirectUrl: `${site}/merci.html`,
    webhookUrl: `${site}/.netlify/functions/webhook`,
    locale: 'fr_FR',
    metadata
  };

  try {
    const created = await mollie('POST', '/payments', payment);
    const checkoutUrl = created && created._links && created._links.checkout && created._links.checkout.href;
    if (!created.id || !checkoutUrl) throw new Error('réponse Mollie sans lien de paiement');
    return json(200, { paymentId: created.id, checkoutUrl });
  } catch (error) {
    console.error('create-payment :', error.message);
    return json(502, {
      error: 'paiement_indisponible',
      message: 'Le paiement est momentanément indisponible. Réessayez dans quelques minutes ou contactez-nous.'
    });
  }
};

