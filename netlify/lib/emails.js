'use strict';

// Contenu des deux e-mails envoyés par le webhook une fois le paiement confirmé.
// Toutes les valeurs saisies par le client sont échappées avant d'entrer dans le HTML.

const catalog = require('../../assets/js/catalog.js');
const { escapeHtml, siteUrl } = require('./shared.js');

const SUPPORT_EMAIL = 'contact@piscineipoolgo.com';
const SUPPORT_PHONE = '07 80 80 67 64';
const LEGAL_LINE = 'SAS Virage, 10 rue Louis Vicat, 75015 Paris. SIRET 892 260 712 00021.';

function euros(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? catalog.formatEUR(amount) : String(value || '');
}

// "300x120" -> "Ø 3 m × 1,20 m" quand la taille existe encore au catalogue.
// Référence courte créée avec la commande ; l'identifiant Stripe en secours.
function reference(payment) {
  return (payment.metadata && payment.metadata.reference) || payment.id;
}

function sizeText(metadata) {
  const size = catalog.getSize(metadata.modele, metadata.taille);
  return size ? catalog.sizeLabel(size) : String(metadata.taille || '');
}

function addressLines(metadata) {
  return [
    `${metadata.prenom || ''} ${metadata.nom || ''}`.trim(),
    metadata.adresse || '',
    `${metadata.code_postal || ''} ${metadata.ville || ''}`.trim(),
    'France'
  ];
}

function layout(title, content) {
  return [
    '<!doctype html><html lang="fr"><head><meta charset="utf-8">',
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>`,
    '<body style="margin:0;padding:0;background:#eef7f7;font-family:Arial,Helvetica,sans-serif;color:#0b2a33;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef7f7;"><tr><td align="center" style="padding:24px 12px;">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;">',
    '<tr><td style="padding:24px 28px;background:#005f73;border-radius:12px 12px 0 0;color:#ffffff;font-size:20px;font-weight:bold;">iPoolGo France</td></tr>',
    `<tr><td style="padding:28px;font-size:16px;line-height:1.55;">${content}</td></tr>`,
    `<tr><td style="padding:18px 28px;border-top:1px solid #d9e8e8;font-size:13px;line-height:1.5;color:#4a6168;">${escapeHtml(LEGAL_LINE)}</td></tr>`,
    '</table></td></tr></table></body></html>'
  ].join('');
}

function row(label, value, strong) {
  const weight = strong ? 'font-weight:bold;' : '';
  return (
    '<tr>' +
    `<td style="padding:8px 0;border-bottom:1px solid #d9e8e8;${weight}">${label}</td>` +
    `<td align="right" style="padding:8px 0;border-bottom:1px solid #d9e8e8;white-space:nowrap;${weight}">${value}</td>` +
    '</tr>'
  );
}

function orderTable(payment) {
  const metadata = payment.metadata || {};
  const gifts = catalog.GIFTS.map((gift) =>
    row(`${escapeHtml(gift.name)} <span style="color:#4a6168;">(valeur ${escapeHtml(euros(gift.value))})</span>`, 'Offert')
  ).join('');
  const shipping = Number(metadata.livraison) > 0 ? escapeHtml(euros(metadata.livraison)) : 'Offerte';
  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;margin:8px 0 20px;">' +
    row(escapeHtml(metadata.produit), escapeHtml(euros(metadata.prix))) +
    gifts +
    row('Livraison en France métropolitaine', shipping) +
    row('Total payé TTC', escapeHtml(euros(payment.amount.value)), true) +
    '</table>'
  );
}

// Le montant encaissé doit correspondre au catalogue actuel ; sinon le vendeur est prévenu.
function amountWarning(payment) {
  const metadata = payment.metadata || {};
  const quote = catalog.quote(metadata.modele, metadata.taille);
  const paid = Math.round(Number(payment.amount && payment.amount.value) * 100);
  const euro = Boolean(payment.amount) && payment.amount.currency === 'EUR';
  if (quote && euro && paid === Math.round(quote.total * 100)) return '';
  const expected = quote ? euros(quote.total) : 'produit absent du catalogue';
  return `Attention : le montant encaissé ne correspond pas au prix catalogue actuel (${expected}). À vérifier avant expédition.`;
}

function sellerEmail(payment, env) {
  const metadata = payment.metadata || {};
  const address = addressLines(metadata);
  const warning = amountWarning(payment);
  const total = euros(payment.amount.value);

  const html = layout(
    'Nouvelle commande payée',
    [
      '<h1 style="margin:0 0 16px;font-size:22px;color:#005f73;">Nouvelle commande payée</h1>',
      warning ? `<p style="padding:12px;background:#fdecea;border-radius:8px;color:#8a1f11;">${escapeHtml(warning)}</p>` : '',
      `<p style="margin:0 0 4px;">Référence : <strong>${escapeHtml(reference(payment))}</strong></p>`,
      `<p style="margin:0 0 4px;">Session Stripe : ${escapeHtml(payment.id)}</p>`,
      `<p style="margin:0 0 4px;">Modèle : <strong>${escapeHtml(metadata.produit)}</strong></p>`,
      `<p style="margin:0 0 4px;">Taille : <strong>${escapeHtml(sizeText(metadata))}</strong></p>`,
      `<p style="margin:0 0 16px;">Montant encaissé : <strong>${escapeHtml(total)}</strong></p>`,
      orderTable(payment),
      '<h2 style="margin:0 0 8px;font-size:17px;color:#005f73;">Adresse de livraison (prête à copier)</h2>',
      `<pre style="margin:0 0 20px;padding:14px;background:#eef7f7;border-radius:8px;font-family:Consolas,Menlo,monospace;font-size:15px;line-height:1.5;white-space:pre-wrap;">${escapeHtml(address.join('\n'))}</pre>`,
      '<h2 style="margin:0 0 8px;font-size:17px;color:#005f73;">Contact client</h2>',
      `<p style="margin:0 0 4px;">E-mail : ${escapeHtml(metadata.email)}</p>`,
      `<p style="margin:0 0 16px;">Téléphone : ${escapeHtml(metadata.telephone)}</p>`,
      '<p style="margin:0;color:#4a6168;">À joindre au colis : la pompe de gonflage électrique et le système de filtration à sable offerts.</p>'
    ].join('')
  );

  const text = [
    'Nouvelle commande iPoolGo France payée',
    warning,
    `Référence : ${reference(payment)}`,
    `Session Stripe : ${payment.id}`,
    `Modèle : ${metadata.produit}`,
    `Taille : ${sizeText(metadata)}`,
    `Montant encaissé : ${total}`,
    '',
    'Adresse de livraison :',
    address.join('\n'),
    '',
    `E-mail : ${metadata.email}`,
    `Téléphone : ${metadata.telephone}`,
    '',
    'À joindre au colis : pompe de gonflage électrique et système de filtration à sable offerts.'
  ].filter((line) => line !== '').join('\n');

  return {
    sender: { name: 'Boutique iPoolGo France', email: env.SENDER_EMAIL },
    to: [{ email: env.SELLER_EMAIL }],
    replyTo: { email: metadata.email, name: address[0] },
    subject: `Nouvelle commande iPoolGo France payée : ${metadata.produit} (${total})`,
    htmlContent: html,
    textContent: text,
    tags: ['commande-vendeur']
  };
}

function customerEmail(payment, env) {
  const metadata = payment.metadata || {};
  const address = addressLines(metadata);
  const site = siteUrl();

  const html = layout(
    'Votre commande est confirmée',
    [
      `<h1 style="margin:0 0 16px;font-size:22px;color:#005f73;">Merci ${escapeHtml(metadata.prenom)}, votre commande est confirmée</h1>`,
      `<p style="margin:0 0 16px;">Nous avons bien reçu votre paiement. Votre référence de commande est <strong>${escapeHtml(reference(payment))}</strong>. Gardez cet e-mail, il vous servira pour toute demande.</p>`,
      orderTable(payment),
      '<h2 style="margin:0 0 8px;font-size:17px;color:#005f73;">Adresse de livraison</h2>',
      `<p style="margin:0 0 20px;">${address.map(escapeHtml).join('<br>')}</p>`,
      '<h2 style="margin:0 0 8px;font-size:17px;color:#005f73;">La suite</h2>',
      `<p style="margin:0 0 12px;">Nous préparons votre colis en France. Le transporteur vous appelle au ${escapeHtml(metadata.telephone)} pour fixer le jour de livraison. Comptez 5 à 10 jours ouvrés pour un modèle en stock. Si votre taille demande plus de temps, nous vous écrivons avant l’expédition.</p>`,
      '<p style="margin:0 0 20px;">Le jour de la livraison, contrôlez les colis avant de signer. Si un carton est abîmé, notez-le sur le bon du transporteur et écrivez-nous dans les 48 heures.</p>',
      '<h2 style="margin:0 0 8px;font-size:17px;color:#005f73;">Garantie et rétractation</h2>',
      `<p style="margin:0 0 20px;">Votre piscine est vendue par SAS Virage. Elle bénéficie de la garantie légale de conformité de 2 ans et de la garantie des vices cachés. Vous avez 14 jours à compter de la livraison pour vous rétracter. Le détail figure dans nos <a href="${site}/cgv.html" style="color:#005f73;">Conditions Générales de Vente</a>.</p>`,
      '<h2 style="margin:0 0 8px;font-size:17px;color:#005f73;">Une question ?</h2>',
      `<p style="margin:0;">Le service après-vente répond par e-mail à <a href="mailto:${SUPPORT_EMAIL}" style="color:#005f73;">${SUPPORT_EMAIL}</a> ou par téléphone au ${SUPPORT_PHONE}. Indiquez votre référence de commande.</p>`
    ].join('')
  );

  const gifts = catalog.GIFTS.map((gift) => `${gift.name} : offert (valeur ${euros(gift.value)})`);
  const text = [
    `Merci ${metadata.prenom}, votre commande iPoolGo France est confirmée.`,
    `Référence : ${reference(payment)}`,
    '',
    `${metadata.produit} : ${euros(metadata.prix)}`,
    gifts.join('\n'),
    `Livraison en France métropolitaine : ${Number(metadata.livraison) > 0 ? euros(metadata.livraison) : 'offerte'}`,
    `Total payé TTC : ${euros(payment.amount.value)}`,
    '',
    'Adresse de livraison :',
    address.join('\n'),
    '',
    'Le transporteur vous appelle pour fixer le jour de livraison. Comptez 5 à 10 jours ouvrés pour un modèle en stock.',
    'Garantie légale de conformité de 2 ans, garantie des vices cachés, rétractation sous 14 jours après livraison.',
    `Conditions Générales de Vente : ${site}/cgv.html`,
    '',
    `Service après-vente : ${SUPPORT_EMAIL} ou ${SUPPORT_PHONE}`,
    LEGAL_LINE
  ].join('\n');

  return {
    sender: { name: 'iPoolGo France', email: env.SENDER_EMAIL },
    to: [{ email: metadata.email, name: address[0] }],
    replyTo: { email: env.SELLER_EMAIL, name: 'iPoolGo France' },
    subject: 'Votre commande iPoolGo France est confirmée',
    htmlContent: html,
    textContent: text,
    tags: ['commande-client']
  };
}

module.exports = { sellerEmail, customerEmail };
