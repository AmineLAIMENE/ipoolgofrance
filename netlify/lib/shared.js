'use strict';

// Outils communs aux trois fonctions. Les clés ne sont lues que dans
// process.env (variables d'environnement Netlify), jamais renvoyées ni journalisées.

const STRIPE_API = 'https://api.stripe.com/v1';
const BREVO_API = 'https://api.brevo.com/v3/smtp/email';
const DEFAULT_SITE_URL = require('../../assets/js/catalog.js').SITE_URL;
const ORDER_SOURCE = 'ipoolgofrance.fr';
// Le webhook enchaîne trois appels (Stripe, Brevo, Stripe) : ils doivent tenir
// dans les 10 secondes accordées à une fonction Netlify.
const TIMEOUT_MS = 3000;

// Identifiant d'une session Stripe Checkout (cs_live_... ou cs_test_...).
const PAYMENT_ID = /^cs_(live|test)_[A-Za-z0-9]{10,200}$/;

function siteUrl() {
  const url = (process.env.SITE_URL || DEFAULT_SITE_URL).trim().replace(/\/+$/, '');
  return /^https:\/\/[a-z0-9.-]+$/i.test(url) ? url : DEFAULT_SITE_URL;
}

function json(statusCode, body, headers) {
  return {
    statusCode,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      headers || {}
    ),
    body: JSON.stringify(body)
  };
}

function header(event, name) {
  const headers = (event && event.headers) || {};
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return String(headers[key] || '');
  }
  return '';
}

function rawBody(event) {
  if (!event || typeof event.body !== 'string') return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

function isPaymentId(value) {
  return typeof value === 'string' && PAYMENT_ID.test(value);
}

// Requêtes du site lui-même, de ses aperçus Netlify ou d'un `netlify dev` local.
// Un navigateur joint toujours l'en-tête Origin à un POST : son absence est refusée.
function isAllowedOrigin(origin) {
  if (!origin) return false;
  const allowed = [siteUrl(), DEFAULT_SITE_URL, 'https://www.ipoolgofrance.fr', process.env.URL, process.env.DEPLOY_PRIME_URL, process.env.DEPLOY_URL]
    .filter(Boolean)
    .map((url) => String(url).replace(/\/+$/, ''));
  if (allowed.includes(origin)) return true;
  return process.env.NETLIFY_DEV === 'true' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

class ApiError extends Error {
  constructor(service, status, detail) {
    super(`${service} a répondu ${status}${detail ? ` : ${detail}` : ''}`);
    this.service = service;
    this.status = status;
  }
}

// Stripe attend des paramètres encodés en formulaire : { a: { b: 1 } } -> a[b]=1.
function formEncode(params, prefix, out) {
  const pairs = out || new URLSearchParams();
  Object.keys(params || {}).forEach((key) => {
    const value = params[key];
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined || value === null) return;
    if (typeof value === 'object') formEncode(value, name, pairs);
    else pairs.append(name, String(value));
  });
  return pairs;
}

async function stripe(method, path, params) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new ApiError('Stripe', 0, 'variable STRIPE_SECRET_KEY absente');

  const response = await fetch(STRIPE_API + path, {
    method,
    headers: Object.assign(
      { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}
    ),
    body: params ? formEncode(params).toString() : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = data.error || {};
    throw new ApiError('Stripe', response.status, [error.code, error.message].filter(Boolean).join(' - '));
  }
  return data;
}

// Session Checkout lue avec son PaymentIntent et sa dernière transaction.
function readSession(id) {
  return stripe('GET', `/checkout/sessions/${id}?expand[]=payment_intent.latest_charge`);
}

// Ramène une session Stripe à la forme utilisée par les e-mails et merci.html :
// montant en euros ("1759.00"), statut simple, métadonnées de la commande.
function toPayment(session) {
  let status = 'open';
  if (session.status === 'expired') status = 'expired';
  else if (session.status === 'complete') status = session.payment_status === 'unpaid' ? 'pending' : 'paid';

  const intent = session.payment_intent && typeof session.payment_intent === 'object' ? session.payment_intent : null;
  const charge = intent && intent.latest_charge && typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
  return {
    id: session.id,
    status,
    amount: {
      currency: String(session.currency || '').toUpperCase(),
      value: (Number(session.amount_total || 0) / 100).toFixed(2)
    },
    metadata: Object.assign({}, session.metadata || {}, (intent && intent.metadata) || {}),
    intentId: intent ? intent.id : null,
    refunded: Boolean(charge && (charge.amount_refunded > 0 || charge.disputed))
  };
}

async function sendEmail(message) {
  const key = process.env.BREVO_API_KEY;
  if (!key) throw new ApiError('Brevo', 0, 'variable BREVO_API_KEY absente');

  const response = await fetch(BREVO_API, {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError('Brevo', response.status, [data.code, data.message].filter(Boolean).join(' - '));
  }
  return data;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  ORDER_SOURCE,
  ApiError,
  siteUrl,
  json,
  header,
  rawBody,
  isPaymentId,
  isAllowedOrigin,
  stripe,
  formEncode,
  readSession,
  toPayment,
  sendEmail,
  escapeHtml
};
