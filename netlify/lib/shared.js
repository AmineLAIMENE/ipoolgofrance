'use strict';

// Outils communs aux trois fonctions. Les clés ne sont lues que dans
// process.env (variables d'environnement Netlify), jamais renvoyées ni journalisées.

const MOLLIE_API = 'https://api.mollie.com/v2';
const BREVO_API = 'https://api.brevo.com/v3/smtp/email';
const DEFAULT_SITE_URL = require('../../assets/js/catalog.js').SITE_URL;
const ORDER_SOURCE = 'ipoolgofrance.fr';
// Le webhook enchaîne trois appels (Mollie, Brevo, Mollie) : ils doivent tenir
// dans les 10 secondes accordées à une fonction Netlify.
const TIMEOUT_MS = 3000;

const PAYMENT_ID = /^tr_[A-Za-z0-9]{6,40}$/;

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

async function mollie(method, path, body) {
  const key = process.env.MOLLIE_API_KEY;
  if (!key) throw new ApiError('Mollie', 0, 'variable MOLLIE_API_KEY absente');

  const response = await fetch(MOLLIE_API + path, {
    method,
    headers: Object.assign(
      { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      body ? { 'Content-Type': 'application/json' } : {}
    ),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError('Mollie', response.status, [data.title, data.detail].filter(Boolean).join(' - '));
  }
  return data;
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
  mollie,
  sendEmail,
  escapeHtml
};
