# iPoolGo France

Site de vente des piscines gonflables rigides iPoolGo en France, édité par SAS Virage : https://ipoolgofrance.fr

Le site est statique (HTML, CSS, JavaScript, sans framework ni dépendance npm). Trois Netlify Functions gèrent le paiement Mollie et les e-mails Brevo.

## Mise en ligne sur Netlify

1. Dans Netlify, « Add new site » puis « Import an existing project », et choisissez ce dépôt. Aucune commande de build n'est nécessaire : `netlify.toml` règle tout.
2. Dans « Site configuration > Environment variables », créez les quatre variables :

   | Variable | Contenu |
   |---|---|
   | `MOLLIE_API_KEY` | Clé API Mollie (`test_...` pour essayer, `live_...` en production) |
   | `BREVO_API_KEY` | Clé API Brevo (e-mails transactionnels) |
   | `SELLER_EMAIL` | Adresse qui reçoit l'alerte « Nouvelle commande payée » |
   | `SENDER_EMAIL` | Adresse d'expédition, validée dans Brevo |

3. Dans « Domain management », ajoutez `ipoolgofrance.fr` (domaine principal) et `ipoolgofrance.com`. Les redirections 301 vers `https://ipoolgofrance.fr` sont dans `netlify.toml`.
4. Relancez un déploiement après avoir créé les variables.

Les clés ne figurent jamais dans le dépôt ni dans le code envoyé au navigateur. `.env.example` liste seulement leurs noms.

## Google Analytics 4

L'identifiant de mesure est dans `assets/js/app.js` :

```js
var GA_MEASUREMENT_ID = 'G-N6JFV15RL5';
```

Le script de Google n'est chargé qu'après un clic sur « Accepter » dans le bandeau cookies.
S'il est remis à `G-XXXXXXXXXX`, rien n'est chargé.

## Changer un prix, une taille ou les frais de livraison

Tout est dans `assets/js/catalog.js`, lu à la fois par le navigateur et par les fonctions de paiement. Après une modification :

```bash
npm run sync   # réécrit les prix dans les pages, les données structurées, llms.txt et google-shopping.xml
npm test       # vérifie le site et les fonctions
```

`SHIPPING_EUR` fixe les frais de livraison (0 pour une livraison offerte).

## Paiement

```
Formulaire  ->  create-payment  ->  page de paiement Mollie  ->  merci.html  ->  check-payment
                                              |
                                              v
                                    webhook  ->  e-mails Brevo (vendeur + client)
```

- `netlify/functions/create-payment.js` valide le modèle, la taille et les coordonnées, recalcule le prix à partir du catalogue et refuse tout montant qui ne correspond pas, puis crée le paiement Mollie.
- `netlify/functions/check-payment.js` renvoie l'état du paiement et un récapitulatif sans donnée personnelle pour `merci.html`.
- `netlify/functions/webhook.js` reçoit l'appel de Mollie, redemande l'état du paiement à Mollie avec la clé API et n'envoie les deux e-mails que si le paiement est `paid`. Chaque envoi est noté dans les métadonnées du paiement Mollie : si un e-mail échoue, la fonction répond 500, Mollie rappelle le webhook et seul l'e-mail manquant repart.

`create-payment` n'accepte que les requêtes venant du site (en-tête `Origin`). Les fonctions n'ont pas de limite de débit propre : si votre offre Netlify le permet, ajoutez une règle de « rate limiting » sur `/.netlify/functions/*`.

## Référencement

- Flux Google Merchant Center : https://ipoolgofrance.fr/google-shopping.xml (une ligne par modèle et par taille, régénéré par `npm run sync`).
- `sitemap.xml`, `robots.txt` et `llms.txt` sont à la racine.
- IndexNow : après une mise en ligne, signalez les pages aux moteurs compatibles.

  ```bash
  node scripts/ping-indexnow.js
  ```

  La clé est le fichier `befe38625b65ae77d0f4fb473575050d.txt` à la racine. Elle est publique par conception.

## Tests

```bash
npm test
```

Les tests n'ont besoin que de Node.js 18 ou plus. Ils vérifient les sept pages (liens, images, balises, données structurées, flux, sitemap) et simulent Mollie et Brevo pour les trois fonctions : prix recalculé côté serveur, montant falsifié refusé, webhook ignoré tant que Mollie ne confirme pas le paiement.

## Aperçu en local

```bash
python3 -m http.server 8080
```

Les pages s'affichent sur http://localhost:8080. Le paiement ne fonctionne qu'une fois le site déployé sur Netlify, ou avec `netlify dev`.

## Arborescence

```
index.html                           accueil, sélecteur de taille, commande
piscine-ronde-ipoolgo.html           fiche de la piscine ronde
piscine-rectangulaire-ipoolgo.html   fiche de la piscine rectangulaire
comparatif-piscine-ipoolgo.html      comparatif Drop-Stitch, autoportante, tubulaire
cgv.html, mentions-legales.html      pages légales
merci.html                           retour de paiement
404.html                             page introuvable
assets/css/style.css                 styles
assets/js/catalog.js                 modèles, tailles, prix (source unique)
assets/js/app.js                     sélecteur, formulaire, cookies, retour de paiement
assets/images/, assets/fonts/        images et polices
netlify/functions/                   create-payment, check-payment, webhook
netlify/lib/                         code partagé par les fonctions (Mollie, Brevo, e-mails)
scripts/sync-catalog.js              recopie le catalogue dans les pages et les flux
scripts/ping-indexnow.js             envoi des URL à IndexNow
tests/                               tests automatiques
```
