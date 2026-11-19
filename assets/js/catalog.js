/*
 * Catalogue iPoolGo France : source unique des modèles, tailles et prix.
 *
 * Ce fichier est chargé par le navigateur (window.IPOOLGO) et par les
 * Netlify Functions (require), qui recalculent le prix côté serveur.
 * Après toute modification, lancer `node scripts/sync-catalog.js` pour
 * mettre à jour le flux Google Shopping, les tableaux et les données
 * structurées des pages.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.IPOOLGO = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SITE_URL = 'https://ipoolgofrance.fr';

  // Livraison France métropolitaine, tarif unique en euros TTC (0 = livraison offerte).
  var SHIPPING_EUR = 360;

  // Modes de remise proposés à la commande, à choisir obligatoirement sur la page de
  // commande (les fiches produit affichent le prix livré). Le retrait est gratuit, sur rendez-vous ;
  // l'adresse exacte est donnée au client par e-mail après la commande.
  var PICKUP_PLACE = 'Noisy-le-Grand';
  var DELIVERY_MODES = {
    livraison: { id: 'livraison', label: 'Livraison en France métropolitaine' },
    retrait: { id: 'retrait', label: 'Retrait au dépôt de ' + PICKUP_PLACE, free: true }
  };
  var DEFAULT_MODE = 'livraison';

  // Offerts avec chaque piscine (valeurs constatées sur la boutique SAS Virage).
  var GIFTS = [
    { id: 'pompe', name: 'Pompe de gonflage électrique', value: 150 },
    { id: 'filtration', name: 'Système de filtration à sable', value: 290 }
  ];

  function round(id, diameter, height, price, people, weight, volume) {
    return {
      id: id,
      diameter: diameter,
      height: height,
      price: price,
      people: people,
      weight: weight,
      volume: volume
    };
  }

  function rect(id, name, length, width, price, people, volume) {
    return {
      id: id,
      name: name,
      length: length,
      width: width,
      height: 120,
      price: price,
      people: people,
      weight: null,
      volume: volume
    };
  }

  var MODELS = {
    ronde: {
      id: 'ronde',
      name: 'Piscine iPoolGo Ronde',
      shortName: 'Ronde',
      sku: 'IPG-RONDE',
      finish: 'Emerald Grey',
      page: '/piscine-ronde-ipoolgo.html',
      image: '/assets/images/piscine-ronde-ipoolgo-emerald-grey.jpg',
      defaultSize: '300x120',
      sizes: [
        round('200x100', 200, 100, 999, '1 à 2', 15, 2800),
        round('300x120', 300, 120, 1399, '2 à 3', 46, 7600),
        round('300x150', 300, 150, 1599, '2 à 3', 50, 9500),
        round('370x120', 370, 120, 1699, '3 à 4', 58, 11500),
        round('400x120', 400, 120, 1899, '4 à 5', null, 13300),
        round('400x150', 400, 150, 2000, '5 à 6', 78, 17000),
        round('500x120', 500, 120, 2200, '5 à 7', 88, 20700),
        round('500x150', 500, 150, 2600, '6 à 7', 110, 26000),
        round('600x150', 600, 150, 3400, '8 à 10', 135, 37300)
      ],
      // Tailles de test : commandables par leur seul lien
      // (/commande.html?modele=ronde&taille=test-1m), absentes des pages,
      // des données structurées, du flux Google Shopping et de llms.txt.
      // À supprimer avant l'ouverture de la boutique.
      testSizes: [
        Object.assign(round('test-1m', 100, 50, 1, '1', null, 350), { label: 'Piscine test ronde', shipping: 0 })
      ]
    },
    rectangulaire: {
      id: 'rectangulaire',
      name: 'Piscine iPoolGo Rectangulaire',
      shortName: 'Rectangulaire',
      sku: 'IPG-RECT',
      finish: 'Emerald Grey',
      page: '/piscine-rectangulaire-ipoolgo.html',
      image: '/assets/images/piscine-rectangulaire-ipoolgo-emerald-grey.jpg',
      defaultSize: '300x200',
      sizes: [
        rect('200x200', 'Compact', 200, 200, 1599, '2 à 3', 4200),
        rect('300x200', 'Family', 300, 200, 1999, '2 à 4', 6500),
        rect('400x300', 'Lane', 400, 300, 2999, '4 à 5', 12600),
        rect('400x400', 'Square', 400, 400, 3490, '6 à 8', 16900),
        rect('500x400', 'Lounge', 500, 400, 4490, "jusqu'à 8", 21100),
        rect('600x300', 'Swim', 600, 300, 4200, '7 à 9', 19000),
        rect('600x400', 'Family Plus', 600, 400, 4999, '8 à 10', 25500),
        rect('600x500', 'Resort', 600, 500, 5500, '10 à 12', 31700)
      ]
    }
  };

  var MODEL_IDS = ['ronde', 'rectangulaire'];

  function has(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function getModel(modelId) {
    return typeof modelId === 'string' && has(MODELS, modelId) ? MODELS[modelId] : null;
  }

  function getSize(modelId, sizeId) {
    var model = getModel(modelId);
    if (!model || typeof sizeId !== 'string') return null;
    var sizes = model.sizes.concat(model.testSizes || []);
    for (var i = 0; i < sizes.length; i++) {
      if (sizes[i].id === sizeId) return sizes[i];
    }
    return null;
  }

  // 300 -> "3", 370 -> "3,7", 120 -> "1,20" quand `fixed` vaut 2.
  function metres(cm, fixed) {
    var value = cm / 100;
    var text = fixed ? value.toFixed(fixed) : String(value);
    return text.replace('.', ',');
  }

  function heightLabel(size) {
    return metres(size.height, size.height % 100 === 0 ? 0 : 2) + ' m';
  }

  // "Ø 3 m" ou "3 × 2 m"
  function footprintLabel(size) {
    if (size.diameter) return 'Ø ' + metres(size.diameter) + ' m';
    return metres(size.length) + ' × ' + metres(size.width) + ' m';
  }

  // "Ø 3 m × 1,20 m" ou "3 × 2 × 1,20 m"
  function sizeLabel(size) {
    if (size.diameter) return footprintLabel(size) + ' × ' + heightLabel(size);
    return metres(size.length) + ' × ' + metres(size.width) + ' × ' + heightLabel(size);
  }

  // Emprise au sol en m², arrondie au dixième.
  function groundArea(size) {
    var area = size.diameter
      ? Math.PI * Math.pow(size.diameter / 200, 2)
      : (size.length / 100) * (size.width / 100);
    return Math.round(area * 10) / 10;
  }

  function giftsTotal() {
    return GIFTS.reduce(function (sum, gift) { return sum + gift.value; }, 0);
  }

  function getMode(modeId) {
    return typeof modeId === 'string' && has(DELIVERY_MODES, modeId) ? DELIVERY_MODES[modeId] : null;
  }

  // Devis recalculé à partir du modèle, de la taille et du mode de remise
  // (livraison par défaut).
  function quote(modelId, sizeId, modeId) {
    var model = getModel(modelId);
    var size = getSize(modelId, sizeId);
    var mode = getMode(modeId === undefined ? DEFAULT_MODE : modeId);
    if (!model || !size || !mode) return null;
    var shipping = mode.free ? 0 : typeof size.shipping === 'number' ? size.shipping : SHIPPING_EUR;
    return {
      model: model,
      size: size,
      mode: mode,
      label: size.label || model.name + ' ' + sizeLabel(size),
      price: size.price,
      shipping: shipping,
      total: size.price + shipping
    };
  }

  // 1399 -> "1 399 €" (espace fine insécable entre les milliers, insécable avant le symbole)
  function formatEUR(amount) {
    var fixed = Math.round(amount * 100) % 100 === 0 ? String(Math.round(amount)) : amount.toFixed(2).replace('.', ',');
    return fixed.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f') + '\u00a0€';
  }

  // 1399 -> "1399.00" (format des montants dans les métadonnées et Google Merchant)
  function formatAmount(amount) {
    return amount.toFixed(2);
  }

  return {
    SITE_URL: SITE_URL,
    SHIPPING_EUR: SHIPPING_EUR,
    PICKUP_PLACE: PICKUP_PLACE,
    DELIVERY_MODES: DELIVERY_MODES,
    DEFAULT_MODE: DEFAULT_MODE,
    GIFTS: GIFTS,
    MODELS: MODELS,
    MODEL_IDS: MODEL_IDS,
    getModel: getModel,
    getSize: getSize,
    getMode: getMode,
    quote: quote,
    giftsTotal: giftsTotal,
    metres: metres,
    heightLabel: heightLabel,
    footprintLabel: footprintLabel,
    sizeLabel: sizeLabel,
    groundArea: groundArea,
    formatEUR: formatEUR,
    formatAmount: formatAmount
  };
});
