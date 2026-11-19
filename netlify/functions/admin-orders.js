'use strict';

// Espace d'administration : suivi des commandes, en lecture seule.
// POST /.netlify/functions/admin-orders  { utilisateur, motDePasse }  -> { jeton, expire }
// GET  /.netlify/functions/admin-orders  Authorization: Bearer <jeton> -> { commandes, tronque }
// Le compte se règle dans les variables Netlify ADMIN_USER et ADMIN_PASSWORD. Les commandes
// ne sont stockées nulle part ailleurs que dans Stripe : elles sont relues à chaque appel.

const crypto = require('crypto');
const { ORDER_SOURCE, json, header, rawBody, isAllowedOrigin, stripe, toPayment } = require('../lib/shared.js');

const SESSION_HOURS = 8;
const FAILURE_DELAY_MS = 1000;
// 3 pages de 100 sessions : tient dans les 10 secondes d'une fonction Netlify.
const MAX_PAGES = 3;
const MAX_BODY_BYTES = 1024;

function account() {
  const user = (process.env.ADMIN_USER || '').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  return user && password ? { user, password } : null;
}

// Clé de signature des jetons : changer le mot de passe déconnecte toutes les sessions.
function signingKey(acc) {
  return crypto.createHash('sha256').update(`ipoolgo-admin\n${acc.password}\n${process.env.STRIPE_SECRET_KEY || ''}`).digest();
}

function sign(acc, expires) {
  return crypto.createHmac('sha256', signingKey(acc)).update(`${acc.user}\n${expires}`).digest('base64url');
}

// Comparaison à temps constant, quelle que soit la longueur des deux valeurs.
function same(a, b) {
  const hash = (value) => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}

function validToken(acc, token) {
  const match = /^(\d{10,13})\.([A-Za-z0-9_-]{43})$/.exec(token || '');
  if (!match) return false;
  const expires = Number(match[1]);
  return expires > Date.now() && same(match[2], sign(acc, expires));
}

function toOrder(session) {
  const payment = toPayment(session);
  const m = payment.metadata;
  return {
    reference: m.reference || session.client_reference_id || session.id,
    date: new Date(Number(session.created) * 1000).toISOString(),
    statut: payment.refunded ? 'remboursee' : payment.status === 'paid' ? 'payee' : 'en_attente',
    montant: payment.amount.value,
    devise: payment.amount.currency,
    produit: m.produit || '',
    remise: m.remise || 'livraison',
    client: {
      prenom: m.prenom || '',
      nom: m.nom || '',
      email: m.email || (session.customer_details && session.customer_details.email) || '',
      telephone: m.telephone || '',
      adresse: m.adresse || '',
      codePostal: m.code_postal || '',
      ville: m.ville || ''
    }
  };
}

async function listOrders() {
  const orders = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ limit: '100', status: 'complete' });
    query.append('expand[]', 'data.payment_intent.latest_charge');
    if (after) query.set('starting_after', after);
    const result = await stripe('GET', `/checkout/sessions?${query.toString()}`);
    const sessions = Array.isArray(result.data) ? result.data : [];
    sessions.forEach((session) => {
      if (session.metadata && session.metadata.source === ORDER_SOURCE) orders.push(toOrder(session));
    });
    if (!result.has_more || sessions.length === 0) return { orders, truncated: false };
    after = sessions[sessions.length - 1].id;
  }
  return { orders, truncated: true };
}

async function login(event, acc) {
  if (!isAllowedOrigin(header(event, 'origin'))) return json(403, { error: 'origine_refusee' });
  const body = rawBody(event);
  if (body.length > MAX_BODY_BYTES) return json(413, { error: 'requete_trop_grande' });

  let input;
  try {
    input = JSON.parse(body);
  } catch (error) {
    return json(400, { error: 'requete_invalide' });
  }
  const user = input && typeof input.utilisateur === 'string' ? input.utilisateur.trim() : '';
  const password = input && typeof input.motDePasse === 'string' ? input.motDePasse : '';

  // Les deux comparaisons sont toujours faites, pour ne pas révéler laquelle a échoué.
  const okUser = same(user, acc.user);
  const okPassword = same(password, acc.password);
  if (!okUser || !okPassword) {
    await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
    return json(401, { error: 'identifiants_invalides', message: 'Identifiant ou mot de passe incorrect.' });
  }

  const expires = Date.now() + SESSION_HOURS * 3600 * 1000;
  return json(200, { jeton: `${expires}.${sign(acc, expires)}`, expire: new Date(expires).toISOString() });
}

exports.handler = async function handler(event) {
  const acc = account();
  if (!acc) return json(503, { error: 'admin_non_configure', message: 'Le compte administrateur n’est pas configuré.' });

  if (event.httpMethod === 'POST') return login(event, acc);
  if (event.httpMethod !== 'GET') return json(405, { error: 'methode_non_autorisee' }, { Allow: 'GET, POST' });

  const token = header(event, 'authorization').replace(/^Bearer\s+/i, '');
  if (!validToken(acc, token)) return json(401, { error: 'session_expiree', message: 'Session expirée, reconnectez-vous.' });

  try {
    const { orders, truncated } = await listOrders();
    return json(200, { commandes: orders, tronque: truncated });
  } catch (error) {
    console.error('admin-orders :', error.message);
    return json(502, { error: 'stripe_indisponible', message: 'Stripe ne répond pas, réessayez dans un instant.' });
  }
};
