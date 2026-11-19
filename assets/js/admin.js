/* Administration : connexion et liste des commandes (lecture seule, données relues dans Stripe). */
(function () {
  'use strict';

  var API = '/.netlify/functions/admin-orders';
  var KEY = 'ipoolgo.admin';
  var STATUS = { payee: 'Payée', en_attente: 'En attente', remboursee: 'Remboursée' };
  var MODE = { livraison: 'Livraison', retrait: 'Retrait au dépôt' };

  var loginForm = document.querySelector('[data-admin-connexion]');
  var loginError = document.querySelector('[data-admin-erreur-connexion]');
  var panel = document.querySelector('[data-admin-commandes]');
  var rows = document.querySelector('[data-admin-lignes]');
  var summary = document.querySelector('[data-admin-resume]');
  var listError = document.querySelector('[data-admin-erreur]');
  var refreshButton = document.querySelector('[data-admin-actualiser]');

  var dateFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' });
  var euros = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

  function token() {
    try { return sessionStorage.getItem(KEY) || ''; } catch (error) { return ''; }
  }

  function setToken(value) {
    try {
      if (value) sessionStorage.setItem(KEY, value);
      else sessionStorage.removeItem(KEY);
    } catch (error) {
      // Stockage indisponible : la session ne survit pas au rechargement.
    }
  }

  function show(connected) {
    loginForm.hidden = connected;
    panel.hidden = !connected;
  }

  function showError(element, text) {
    element.textContent = text || '';
    element.hidden = !text;
  }

  // Intitulés des colonnes, repris sur chaque cellule pour l'affichage en cartes sur mobile.
  var labels = Array.prototype.map.call(document.querySelectorAll('.admin__tableau th'), function (th) {
    return th.textContent;
  });

  function cell(row, lines, className) {
    var td = document.createElement('td');
    td.setAttribute('data-label', labels[row.children.length] || '');
    if (className) td.className = className;
    lines.filter(Boolean).forEach(function (line) {
      var item = document.createElement(line.href ? 'a' : 'span');
      if (line.href) item.href = line.href;
      item.textContent = line.href ? line.text : line;
      td.appendChild(item);
    });
    row.appendChild(td);
    return td;
  }

  function render(orders, truncated) {
    rows.textContent = '';
    var paid = orders.filter(function (order) { return order.statut === 'payee'; });
    var total = paid.reduce(function (sum, order) { return sum + Number(order.montant); }, 0);
    summary.textContent = orders.length
      ? orders.length + ' commande' + (orders.length > 1 ? 's' : '') + ', dont ' + paid.length + ' payée' + (paid.length > 1 ? 's' : '') +
        ' pour ' + euros.format(total) + '.' + (truncated ? ' Seules les plus récentes sont affichées.' : '')
      : 'Aucune commande pour l’instant.';

    orders.forEach(function (order) {
      var c = order.client;
      var tr = document.createElement('tr');
      cell(tr, [dateFormat.format(new Date(order.date))]);
      cell(tr, [order.reference], 'admin__reference');
      cell(tr, [
        (c.prenom + ' ' + c.nom).trim(),
        c.email && { href: 'mailto:' + c.email, text: c.email },
        c.telephone && { href: 'tel:' + c.telephone.replace(/\s+/g, ''), text: c.telephone },
        c.adresse,
        (c.codePostal + ' ' + c.ville).trim()
      ]);
      cell(tr, [order.produit, MODE[order.remise] || order.remise]);
      cell(tr, [euros.format(Number(order.montant))], 'admin__montant');
      var status = cell(tr, [STATUS[order.statut] || order.statut]);
      status.className = 'admin__statut admin__statut--' + order.statut;
      rows.appendChild(tr);
    });
  }

  function load() {
    showError(listError, '');
    refreshButton.disabled = true;
    summary.textContent = 'Chargement…';
    fetch(API, { headers: { Authorization: 'Bearer ' + token() }, cache: 'no-store' })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (response.status === 401) {
            setToken('');
            show(false);
            showError(loginError, data.message || 'Session expirée, reconnectez-vous.');
            return;
          }
          if (!response.ok) throw new Error(data.message || 'Chargement impossible.');
          render(data.commandes || [], data.tronque);
        });
      })
      .catch(function (error) {
        summary.textContent = '';
        showError(listError, error.message || 'Chargement impossible.');
      })
      .then(function () { refreshButton.disabled = false; });
  }

  loginForm.addEventListener('submit', function (event) {
    event.preventDefault();
    showError(loginError, '');
    var button = loginForm.querySelector('button[type="submit"]');
    button.disabled = true;
    fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ utilisateur: loginForm.utilisateur.value, motDePasse: loginForm.motDePasse.value })
    })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok || !data.jeton) throw new Error(data.message || 'Connexion impossible.');
          setToken(data.jeton);
          loginForm.motDePasse.value = '';
          show(true);
          load();
        });
      })
      .catch(function (error) {
        showError(loginError, error.message);
        loginForm.motDePasse.focus();
      })
      .then(function () { button.disabled = false; });
  });

  refreshButton.addEventListener('click', load);
  document.querySelector('[data-admin-deconnexion]').addEventListener('click', function () {
    setToken('');
    rows.textContent = '';
    show(false);
    loginForm.utilisateur.focus();
  });

  if (token()) {
    show(true);
    load();
  }
})();
