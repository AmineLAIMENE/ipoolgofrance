/*
 * iPoolGo France : configurateur, page de commande, page de retour de paiement
 * et bandeau cookies. Aucun appel externe avant le consentement, aucune clé d'API ici :
 * le paiement passe par les Netlify Functions.
 */
(function () {
  'use strict';

  // Identifiant de mesure Google Analytics 4 (flux Web ipoolgofrance.fr).
  // Le script Google n'est chargé qu'après un clic sur « Accepter » dans le bandeau cookies.
  var GA_MEASUREMENT_ID = 'G-N6JFV15RL5';

  var catalog = window.IPOOLGO;
  var KEYS = {
    order: 'ipoolgo.commande',
    payment: 'ipoolgo.paiement',
    cookies: 'ipoolgo.cookies'
  };
  var API = '/.netlify/functions/';
  var NBSP = '\u00a0';

  // ------------------------------------------------------------------ outils

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function read(storage, key) {
    try {
      return window[storage].getItem(key);
    } catch (error) {
      return null;
    }
  }

  function write(storage, key, value) {
    try {
      if (value === null) window[storage].removeItem(key);
      else window[storage].setItem(key, value);
    } catch (error) {
      // Stockage indisponible (navigation privée stricte) : le site reste utilisable.
    }
  }

  function readJson(storage, key) {
    try {
      var value = JSON.parse(read(storage, key));
      return value && typeof value === 'object' ? value : null;
    } catch (error) {
      return null;
    }
  }

  // Espaces insécables autour des unités, comme dans le HTML généré.
  function nb(text) {
    return String(text).replace(/ (m|×|€)/g, NBSP + '$1').replace(/(Ø|×) /g, '$1' + NBSP);
  }

  function decimal(value) {
    return String(value).replace('.', ',');
  }

  function litres(volume) {
    return String(volume).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f') + NBSP + 'L';
  }

  // ------------------------------------------------------------------ cookies et mesure d'audience

  var analyticsLoaded = false;

  function analyticsConfigured() {
    return /^G-[A-Z0-9]{6,}$/.test(GA_MEASUREMENT_ID) && GA_MEASUREMENT_ID !== 'G-XXXXXXXXXX';
  }

  // Le choix est conservé six mois, puis redemandé (recommandation de la CNIL).
  var CONSENT_MAX_AGE = 183 * 24 * 60 * 60 * 1000;

  function cookieChoice() {
    var saved = readJson('localStorage', KEYS.cookies);
    if (!saved || (saved.choix !== 'accepte' && saved.choix !== 'refuse')) return null;
    if (!(Date.now() - saved.date < CONSENT_MAX_AGE)) return null;
    return saved.choix;
  }

  function hasConsent() {
    return cookieChoice() === 'accepte';
  }

  function gtag() {
    window.dataLayer.push(arguments);
  }

  function loadAnalytics() {
    if (analyticsLoaded || !analyticsConfigured() || !hasConsent()) return;
    analyticsLoaded = true;
    window['ga-disable-' + GA_MEASUREMENT_ID] = false;
    window.dataLayer = window.dataLayer || [];
    gtag('js', new Date());
    gtag('config', GA_MEASUREMENT_ID, { cookie_expires: 395 * 24 * 60 * 60 });
    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_MEASUREMENT_ID);
    document.head.appendChild(script);
  }

  function stopAnalytics() {
    if (!analyticsConfigured()) return;
    window['ga-disable-' + GA_MEASUREMENT_ID] = true;
    var host = location.hostname;
    var domains = ['', '; domain=' + host, '; domain=.' + host.replace(/^www\./, '')];
    document.cookie.split(';').forEach(function (cookie) {
      var name = cookie.split('=')[0].trim();
      if (!/^_ga/.test(name)) return;
      domains.forEach(function (domain) {
        document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' + domain;
      });
    });
  }

  function track(name, params) {
    if (!analyticsLoaded || !hasConsent()) return;
    gtag('event', name, params);
  }

  function initCookies() {
    var banner = $('[data-cookies]');
    if (!banner) return;

    $all('[data-cookies-choix]', banner).forEach(function (button) {
      button.addEventListener('click', function () {
        var accepted = button.getAttribute('data-cookies-choix') === 'accepte';
        write('localStorage', KEYS.cookies, JSON.stringify({ choix: accepted ? 'accepte' : 'refuse', date: Date.now() }));
        banner.hidden = true;
        if (accepted) loadAnalytics();
        else stopAnalytics();
      });
    });

    $all('[data-cookies-ouvrir]').forEach(function (button) {
      button.addEventListener('click', function () {
        banner.hidden = false;
        var first = $('button', banner);
        if (first) first.focus();
      });
    });

    var choice = cookieChoice();
    if (choice === 'accepte') loadAnalytics();
    else if (choice !== 'refuse') banner.hidden = false;
  }

  // ------------------------------------------------------------------ plan à l'échelle

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var PLAN = { width: 720, height: 600, metre: 80, cx: 360, cy: 270, wall: 9 };

  function svgEl(name, attributes, parent) {
    var element = document.createElementNS(SVG_NS, name);
    Object.keys(attributes || {}).forEach(function (key) {
      element.setAttribute(key, attributes[key]);
    });
    if (parent) parent.appendChild(element);
    return element;
  }

  function createPlan(svg) {
    svg.setAttribute('viewBox', '0 0 ' + PLAN.width + ' ' + PLAN.height);
    svg.textContent = '';

    var grid = '';
    for (var x = PLAN.cx % PLAN.metre; x < PLAN.width; x += PLAN.metre) grid += 'M' + x + ' 0V' + PLAN.height;
    for (var y = PLAN.cy % PLAN.metre; y < PLAN.height; y += PLAN.metre) grid += 'M0 ' + y + 'H' + PLAN.width;
    svgEl('path', { class: 'plan__grille', d: grid }, svg);

    var shape = svgEl('g', { class: 'plan__forme' }, svg);
    var parts = {
      wall: svgEl('rect', { class: 'plan__paroi' }, shape),
      water: svgEl('rect', { class: 'plan__eau' }, shape)
    };

    // Adulte de 1,75 m allongé, vu de dessus (140 unités de long).
    var swimmer = svgEl('g', { class: 'plan__nageur', transform: 'translate(' + PLAN.cx + ' ' + PLAN.cy + ')' }, svg);
    svgEl('rect', { x: -70, y: -13, width: 66, height: 11, rx: 5.5 }, swimmer);
    svgEl('rect', { x: -70, y: 2, width: 66, height: 11, rx: 5.5 }, swimmer);
    svgEl('rect', { x: 20, y: -42, width: 12, height: 84, rx: 6 }, swimmer);
    svgEl('rect', { x: -10, y: -15, width: 56, height: 30, rx: 12 }, swimmer);
    svgEl('circle', { cx: 58, cy: 0, r: 11 }, swimmer);

    parts.widthLine = svgEl('path', { class: 'plan__cote' }, svg);
    parts.widthText = svgEl('text', { class: 'plan__texte' }, svg);
    parts.depthLine = svgEl('path', { class: 'plan__cote' }, svg);
    parts.depthText = svgEl('text', { class: 'plan__texte' }, svg);
    return parts;
  }

  function drawPlan(svg, parts, model, size) {
    var isRound = Boolean(size.diameter);
    var width = ((size.diameter || size.length) / 100) * PLAN.metre;
    var depth = ((size.diameter || size.width) / 100) * PLAN.metre;
    var left = PLAN.cx - width / 2;
    var top = PLAN.cy - depth / 2;
    var right = left + width;
    var bottom = top + depth;

    function box(rect, inset, radius) {
      rect.setAttribute('x', left + inset);
      rect.setAttribute('y', top + inset);
      rect.setAttribute('width', width - 2 * inset);
      rect.setAttribute('height', depth - 2 * inset);
      rect.setAttribute('rx', radius);
    }
    box(parts.wall, 0, isRound ? width / 2 : 12);
    box(parts.water, PLAN.wall, isRound ? width / 2 - PLAN.wall : 5);

    var lineY = bottom + 22;
    parts.widthLine.setAttribute('d', 'M' + left + ' ' + (lineY - 8) + 'v16M' + left + ' ' + lineY + 'H' + right + 'M' + right + ' ' + (lineY - 8) + 'v16');
    parts.widthText.setAttribute('x', PLAN.cx);
    parts.widthText.setAttribute('y', lineY + 42);
    parts.widthText.textContent = isRound
      ? nb('Ø ' + catalog.metres(size.diameter) + ' m')
      : nb(catalog.metres(size.length) + ' m');

    if (isRound) {
      parts.depthLine.setAttribute('d', '');
      parts.depthText.textContent = '';
    } else {
      var lineX = right + 22;
      parts.depthLine.setAttribute('d', 'M' + (lineX - 8) + ' ' + top + 'h16M' + lineX + ' ' + top + 'V' + bottom + 'M' + (lineX - 8) + ' ' + bottom + 'h16');
      parts.depthText.setAttribute('x', lineX + 44);
      parts.depthText.setAttribute('y', PLAN.cy + 10);
      parts.depthText.textContent = nb(catalog.metres(size.width) + ' m');
    }

    svg.setAttribute(
      'aria-label',
      'Plan vu de dessus à l’échelle : ' + model.name + ' ' + catalog.sizeLabel(size) +
        ', avec la silhouette d’un adulte de 1,75 m.'
    );
  }

  // ------------------------------------------------------------------ configurateur

  function urbanismHint(size) {
    var area = catalog.groundArea(size);
    var surface = decimal(area) + NBSP + 'm²';
    if (area <= 10) {
      return 'Emprise au sol de ' + surface + '. Sous 10' + NBSP + 'm², aucune formalité d’urbanisme n’est demandée hors secteur protégé.';
    }
    return 'Emprise au sol de ' + surface + '. Au-delà de 10' + NBSP + 'm², une déclaration préalable en mairie est nécessaire si la piscine reste montée plus de trois mois par an.';
  }

  function initConfigurator(root) {
    var fixedModel = root.getAttribute('data-modele');
    var isOrderForm = !fixedModel;
    var planSvg = $('[data-plan]', root);
    var planParts = planSvg ? createPlan(planSvg) : null;
    var listeners = [];
    var state = { model: fixedModel || catalog.MODEL_IDS[0], size: null, mode: catalog.DEFAULT_MODE };

    function checkedSize(modelId) {
      var input = $('input[name="taille-' + modelId + '"]:checked', root);
      return input ? input.value : catalog.getModel(modelId).defaultSize;
    }

    function render() {
      var quote = catalog.quote(state.model, state.size, state.mode);
      if (!quote) return;
      var size = quote.size;
      var pickup = quote.mode.id === 'retrait';

      $all('input[name="modele"]', root).forEach(function (input) {
        input.checked = input.value === state.model;
      });
      $all('[data-tailles]', root).forEach(function (group) {
        group.hidden = group.getAttribute('data-tailles') !== state.model;
      });
      // Une taille sans case (taille de test) ne laisse aucune autre case cochée.
      $all('input[name="taille-' + state.model + '"]', root).forEach(function (input) {
        input.checked = input.value === state.size;
      });
      $all('input[name="remise"]', root).forEach(function (input) {
        input.checked = input.value === state.mode;
      });
      $all('[data-remise]', root).forEach(function (element) {
        element.hidden = element.getAttribute('data-remise') !== state.mode;
      });

      var values = {
        produit: nb(quote.label),
        modele: size.label || quote.model.name,
        taille: nb(catalog.sizeLabel(size)),
        personnes: size.people + ' personnes',
        volume: 'environ ' + litres(size.volume),
        emprise: decimal(catalog.groundArea(size)) + NBSP + 'm²',
        prix: catalog.formatEUR(quote.price),
        livraison: quote.shipping > 0 ? catalog.formatEUR(quote.shipping) : pickup ? 'Gratuit' : 'Offerte',
        'remise-libelle': quote.mode.label,
        total: catalog.formatEUR(quote.total),
        urbanisme: urbanismHint(size)
      };
      $all('[data-out]', root).forEach(function (output) {
        var key = output.getAttribute('data-out');
        if (key in values) output.textContent = values[key];
      });

      // Sur une fiche produit, tous les liens de commande de la page suivent la taille choisie.
      $all('[data-commander]', fixedModel ? document : root).forEach(function (link) {
        link.setAttribute('href', '/commande.html?modele=' + state.model + '&taille=' + state.size);
      });

      if (planSvg) drawPlan(planSvg, planParts, quote.model, size);
    }

    function select(modelId, sizeId, silent) {
      if (fixedModel) modelId = fixedModel;
      if (!catalog.getModel(modelId)) modelId = state.model;
      if (!catalog.getSize(modelId, sizeId)) sizeId = checkedSize(modelId);
      state.model = modelId;
      state.size = sizeId;
      render();
      if (silent) return;

      var query = isOrderForm
        ? '?modele=' + modelId + '&taille=' + sizeId + (state.mode !== catalog.DEFAULT_MODE ? '&remise=' + state.mode : '')
        : '?taille=' + sizeId;
      try {
        history.replaceState(null, '', location.pathname + query + location.hash);
      } catch (error) {
        // Sans incidence : l'adresse ne reflète simplement pas la sélection.
      }
      listeners.forEach(function (listener) { listener(state); });
    }

    root.addEventListener('change', function (event) {
      var input = event.target;
      if (input.name === 'modele') select(input.value, null);
      else if (input.name === 'taille-' + state.model) select(state.model, input.value);
      else if (input.name === 'remise' && catalog.getMode(input.value)) {
        state.mode = input.value;
        select(state.model, state.size);
      }
    });

    // Sélection initiale : adresse de la page, puis commande en cours, puis valeurs par défaut.
    var params = new URLSearchParams(location.search);
    var saved = isOrderForm ? readJson('sessionStorage', KEYS.order) || {} : {};
    var model = fixedModel || (catalog.getModel(params.get('modele')) ? params.get('modele') : null);
    var size = params.get('taille');
    if (!model && saved.modele) {
      model = saved.modele;
      size = saved.taille;
    } else if (model && !catalog.getSize(model, size) && saved.modele === model) {
      size = saved.taille;
    }
    if (isOrderForm) {
      var mode = params.get('remise') || saved.remise;
      if (catalog.getMode(mode)) state.mode = mode;
    }
    select(model || state.model, size, true);

    return {
      state: state,
      select: select,
      onChange: function (listener) { listeners.push(listener); }
    };
  }

  // ------------------------------------------------------------------ formulaire de commande

  var FIELDS = ['prenom', 'nom', 'email', 'telephone', 'adresse', 'codePostal', 'ville'];
  var LIMITS = { nom: 50, prenom: 50, email: 100, telephone: 20, adresse: 120, codePostal: 5, ville: 50 };
  var EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i;
  var PHONE = /^\+?[0-9]{9,15}$/;

  function fieldError(name, value, mode) {
    if (!value) return 'Ce champ est obligatoire.';
    if (value.length > LIMITS[name]) return LIMITS[name] + ' caractères maximum.';
    if (name === 'email' && !EMAIL.test(value)) return 'Vérifiez l’adresse e-mail, par exemple prenom@exemple.fr.';
    if (name === 'telephone' && !PHONE.test(value.replace(/[\s.()-]/g, ''))) {
      return 'Indiquez un numéro à 10 chiffres, par exemple 06 12 34 56 78.';
    }
    if (name === 'codePostal') {
      if (!/^[0-9]{5}$/.test(value)) return 'Le code postal compte 5 chiffres.';
      if (mode !== 'retrait' && /^9[78]/.test(value)) return 'Nous livrons en France métropolitaine. Écrivez-nous pour une autre destination.';
    }
    return '';
  }

  function initOrderForm(form, configurator) {
    var payButton = $('[data-payer]', form);
    var payLabel = payButton ? payButton.innerHTML : '';
    var cgv = form.elements.cgv;
    var message = $('[data-message]', form);
    var sending = false;

    function input(name) {
      return form.elements[name];
    }

    function values() {
      var data = {};
      FIELDS.forEach(function (name) {
        data[name] = input(name).value.replace(/\s+/g, ' ').trim();
      });
      return data;
    }

    function save() {
      var data = values();
      data.modele = configurator.state.model;
      data.taille = configurator.state.size;
      data.remise = configurator.state.mode;
      write('sessionStorage', KEYS.order, JSON.stringify(data));
    }

    function showFieldError(name, text) {
      var field = input(name);
      var holder = field.closest('.champ');
      var error = $('.champ__erreur', holder);
      if (!text) {
        field.removeAttribute('aria-invalid');
        field.removeAttribute('aria-describedby');
        if (error) error.remove();
        return;
      }
      if (!error) {
        error = document.createElement('p');
        error.className = 'champ__erreur';
        error.id = 'erreur-' + name;
        holder.appendChild(error);
      }
      error.textContent = text;
      field.setAttribute('aria-invalid', 'true');
      field.setAttribute('aria-describedby', error.id);
    }

    function showMessage(text, kind) {
      if (!message) return;
      message.textContent = text || '';
      message.className = 'message message--' + (kind || 'erreur');
      message.hidden = !text;
    }

    function showErrors(errors) {
      var first = null;
      FIELDS.forEach(function (name) {
        showFieldError(name, errors[name] || '');
        if (errors[name] && !first) first = input(name);
      });
      if (first) first.focus();
      return !first;
    }

    function setSending(active) {
      sending = active;
      payButton.disabled = active || !cgv.checked;
      if (active) payButton.textContent = 'Ouverture du paiement sécurisé…';
      else payButton.innerHTML = payLabel;
      if (!active) configurator.select(configurator.state.model, configurator.state.size, true);
    }

    // Reprise d'une commande commencée dans cet onglet.
    var saved = readJson('sessionStorage', KEYS.order) || {};
    FIELDS.forEach(function (name) {
      if (typeof saved[name] === 'string' && !input(name).value) input(name).value = saved[name];
    });

    form.addEventListener('input', function (event) {
      if (FIELDS.indexOf(event.target.name) !== -1) {
        if (event.target.getAttribute('aria-invalid')) showFieldError(event.target.name, '');
        save();
      }
    });
    configurator.onChange(save);

    cgv.addEventListener('change', function () {
      payButton.disabled = sending || !cgv.checked;
    });
    payButton.disabled = !cgv.checked;

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (sending) return;
      showMessage('');

      var customer = values();
      var errors = {};
      FIELDS.forEach(function (name) {
        var error = fieldError(name, customer[name], configurator.state.mode);
        if (error) errors[name] = error;
      });
      if (!showErrors(errors)) return;
      if (!cgv.checked) {
        showMessage('Cochez la case d’acceptation des Conditions Générales de Vente pour payer.');
        cgv.focus();
        return;
      }

      var quote = catalog.quote(configurator.state.model, configurator.state.size, configurator.state.mode);
      save();
      setSending(true);

      fetch(API + 'create-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modele: quote.model.id,
          taille: quote.size.id,
          remise: quote.mode.id,
          montant: quote.total,
          cgv: true,
          client: customer,
          site_web: form.elements.site_web ? form.elements.site_web.value : ''
        })
      })
        .then(function (response) {
          return response.json().catch(function () { return {}; }).then(function (body) {
            return { ok: response.ok, status: response.status, body: body };
          });
        })
        .then(function (result) {
          var body = result.body;
          if (result.ok && body.paymentId && /^https:\/\//.test(body.checkoutUrl || '')) {
            write('sessionStorage', KEYS.payment, body.paymentId);
            write('localStorage', KEYS.payment, body.paymentId);
            track('begin_checkout', {
              currency: 'EUR',
              value: quote.total,
              shipping: quote.shipping,
              items: [{
                item_id: quote.model.sku + '-' + quote.size.id,
                item_name: quote.model.name,
                item_variant: catalog.sizeLabel(quote.size),
                item_brand: 'iPoolGo',
                price: quote.price,
                quantity: 1
              }]
            });
            location.assign(body.checkoutUrl);
            return;
          }
          setSending(false);
          if (body.champs && typeof body.champs === 'object') showErrors(body.champs);
          if (result.status === 409) {
            showMessage('Le prix affiché n’était plus à jour. Rechargez la page, vérifiez le total puis relancez le paiement.');
          } else {
            showMessage(body.message || 'Le paiement n’a pas pu démarrer. Réessayez dans quelques minutes ou appelez-nous au 07\u00a080\u00a080\u00a067\u00a064.');
          }
        })
        .catch(function () {
          setSending(false);
          showMessage('Connexion interrompue. Vérifiez votre réseau puis relancez le paiement. Rien n’a été débité.');
        });
    });

    // Retour arrière depuis Stripe : la page sort du cache avec le bouton encore verrouillé.
    window.addEventListener('pageshow', function (event) {
      if (event.persisted) setSending(false);
    });
  }

  // ------------------------------------------------------------------ retour de paiement (merci.html)

  function initThanks(root) {
    // Stripe renvoie ici avec ?session_id=cs_... ; l'adresse est ensuite nettoyée.
    var fromUrl = new URLSearchParams(location.search).get('session_id');
    if (fromUrl && history.replaceState) history.replaceState(null, '', location.pathname);
    var paymentId = fromUrl || read('sessionStorage', KEYS.payment) || read('localStorage', KEYS.payment);
    var attempts = 0;
    var timer = null;

    function show(name) {
      $all('[data-etat]', root).forEach(function (panel) {
        panel.hidden = panel.getAttribute('data-etat') !== name;
      });
      var title = $('[data-etat="' + name + '"] h1', root);
      if (title && name !== 'verification') {
        title.setAttribute('tabindex', '-1');
        title.focus();
      }
    }

    function fill(order) {
      var shipping = Number(order.livraison);
      var mode = catalog.getMode(order.remise) || catalog.getMode(catalog.DEFAULT_MODE);
      var values = {
        reference: order.reference || paymentId,
        produit: nb(order.produit || ''),
        prix: catalog.formatEUR(Number(order.prix)),
        livraison: shipping > 0 ? catalog.formatEUR(shipping) : mode.free ? 'Gratuit' : 'Offerte',
        'remise-libelle': mode.label,
        total: catalog.formatEUR(Number(order.total))
      };
      $all('[data-out]', root).forEach(function (output) {
        var key = output.getAttribute('data-out');
        if (key in values) output.textContent = values[key];
      });
    }

    function forgetPayment() {
      write('sessionStorage', KEYS.payment, null);
      write('localStorage', KEYS.payment, null);
    }

    function handle(result) {
      var status = result.status;
      var order = result.commande || {};
      if (status === 'paid') {
        fill(order);
        track('purchase', {
          transaction_id: order.reference || paymentId,
          currency: 'EUR',
          value: Number(order.total),
          shipping: Number(order.livraison),
          items: [{ item_id: order.modele + '-' + order.taille, item_name: order.produit, item_brand: 'iPoolGo', price: Number(order.prix), quantity: 1 }]
        });
        write('sessionStorage', KEYS.order, null);
        forgetPayment();
        show('paye');
      } else if (status === 'canceled' || status === 'failed' || status === 'expired') {
        var reasons = {
          canceled: 'Le paiement a été annulé.',
          failed: 'La banque a refusé le paiement.',
          expired: 'La session de paiement a expiré.'
        };
        var reason = $('[data-out="motif"]', root);
        if (reason) reason.textContent = reasons[status];
        forgetPayment();
        show('echec');
      } else {
        fill(order);
        show('attente');
        if (attempts < 6) timer = setTimeout(check, 4000);
      }
    }

    function check() {
      clearTimeout(timer);
      attempts += 1;
      fetch(API + 'check-payment?id=' + encodeURIComponent(paymentId), { headers: { Accept: 'application/json' } })
        .then(function (response) {
          if (response.status === 400 || response.status === 404) {
            forgetPayment();
            show('inconnu');
            return null;
          }
          if (!response.ok) throw new Error('verification');
          return response.json();
        })
        .then(function (result) {
          if (result) handle(result);
        })
        .catch(function () {
          show('erreur');
        });
    }

    $all('[data-verifier]', root).forEach(function (button) {
      button.addEventListener('click', function () {
        attempts = 0;
        show('verification');
        check();
      });
    });

    if (!paymentId) {
      show('inconnu');
      return;
    }
    check();
  }

  // ------------------------------------------------------------------ menu mobile

  function initMenu() {
    var button = $('.menu-bouton');
    var menu = button && document.getElementById(button.getAttribute('aria-controls'));
    if (!menu) return;
    var label = $('span', button);

    function toggle(open) {
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      label.textContent = open ? 'Fermer' : 'Menu';
      if (open) menu.setAttribute('data-ouvert', '');
      else menu.removeAttribute('data-ouvert');
    }

    button.addEventListener('click', function () {
      var open = button.getAttribute('aria-expanded') !== 'true';
      toggle(open);
      if (open) $('a', menu).focus();
    });
    // Un lien d'ancre (#avis) ou la touche Échap referment le panneau.
    menu.addEventListener('click', function (event) {
      if (event.target.closest('a')) toggle(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && button.getAttribute('aria-expanded') === 'true') {
        toggle(false);
        button.focus();
      }
    });
    document.addEventListener('click', function (event) {
      if (button.getAttribute('aria-expanded') === 'true' && !event.target.closest('.entete')) toggle(false);
    });
  }

  // ------------------------------------------------------------------ démarrage

  function init() {
    initCookies();
    initMenu();
    if (!catalog) return;

    $all('[data-config]').forEach(function (root) {
      var configurator = initConfigurator(root);
      if (root.matches('form[data-commande]')) {
        initOrderForm(root, configurator);
      }
    });

    var thanks = $('[data-merci]');
    if (thanks) initThanks(thanks);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
