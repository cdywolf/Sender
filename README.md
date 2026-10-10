# CV Sender

Petite plateforme locale pour envoyer votre CV à des recruteurs, avec un mail personnalisé par destinataire.

- Import d'un **CSV** d'adresses RH, ou **saisie manuelle** d'une adresse
- **Variables** dans l'objet et le message : `{{nom}}`, `{{entreprise}}`, `{{poste}}`… (toute colonne du CSV devient une variable)
- **Éditeur visuel** (gras, couleurs, listes, liens, **images**) ou **édition HTML directe**, avec aperçu pour chaque destinataire
- **Pièces jointes** (CV, lettre de motivation…) ajoutées directement en écrivant le mail, bouton 📎 Joindre
- **Identités** comme dans Thunderbird (nom, adresse, serveur d'envoi) à choisir dans « De », plus **Répondre à**, **Cc** et **Cci** pour chaque mail
- Envoi d'un **mail de test** à soi-même, envoi groupé avec pause entre chaque mail, bouton « Arrêter »
- **Modèles** de mail réutilisables et **historique** des envois (exportable en CSV)

Tout tourne sur votre ordinateur : vos identifiants restent dans `data/settings.json`, en local.

## Lancer l'application

Prérequis : [Node.js](https://nodejs.org) 18 ou plus récent.

```bash
cd cv-sender
npm install
npm start
```

Ouvrez ensuite **http://localhost:3000** dans votre navigateur.

Pour essayer sans rien envoyer : `npm run dry` (mode simulation). Les mails sont alors enregistrés
en fichiers `.eml` dans `data/outbox/` ; vous pouvez les ouvrir avec Thunderbird ou Outlook pour voir le rendu exact.
(Sous Windows, si `npm run dry` ne marche pas : `set DRY_RUN=1 && node server.js`.)

## Configurer l'envoi (onglet « Réglages »)

**Gmail** (recommandé) :
1. Activez la validation en deux étapes sur votre compte Google.
2. Créez un mot de passe d'application : https://myaccount.google.com/apppasswords
3. Dans « Réglages », cliquez sur le préréglage **Gmail**, saisissez votre adresse et ce mot de passe de 16 caractères.
4. Cliquez sur **Tester la connexion**.

Outlook et Yahoo ont aussi un préréglage ; tout autre serveur SMTP fonctionne en saisissant hôte, port et identifiants.

## Format du CSV

Séparateur `;` ou `,` détecté automatiquement. Seule la colonne `email` est obligatoire
(`mail`, `e-mail`, `courriel` sont aussi reconnus). Exemple (`exemple-rh.csv`) :

```csv
email;nom;entreprise;poste
recrutement@exemple-entreprise.fr;Mme Martin;Exemple Entreprise;Chargée de communication
rh@startup-demo.com;M. Durand;Startup Démo;Développeur web
```

Les doublons et les adresses invalides sont ignorés à l'import. Les cellules du tableau sont modifiables
directement, et chaque ligne peut être décochée pour ne pas recevoir le mail.

## Identités (« De »)

Comme dans les paramètres de compte de Thunderbird, l'onglet **Réglages → Identités** permet de créer plusieurs expéditeurs.
Chaque identité a :

- un **nom affiché** (ex. `AKAZA Fashion`) et une **adresse** (ex. `contact@akaza-fashion.fr`) ;
- des **Répondre à**, **Cc** et **Cci** par défaut, repris automatiquement quand on la choisit ;
- un **serveur d'envoi** : le serveur principal, ou un serveur SMTP propre à cette identité.

En écrivant le mail, le champ **De** propose vos identités, l'expéditeur par défaut, ou « Autre adresse… » pour une adresse ponctuelle.

L'adresse doit être une vraie adresse e-mail (avec `@`), et le serveur d'envoi doit vous autoriser à l'utiliser, exactement
comme dans Thunderbird. Avec Gmail, c'est votre adresse Gmail ou un alias ajouté dans Gmail → Paramètres → Comptes →
« Envoyer des e-mails en tant que » ; sinon Gmail remplace l'adresse par la vôtre. Pour une adresse de votre propre domaine,
renseignez dans l'identité le serveur SMTP de ce domaine (fourni par votre hébergeur : OVH, IONOS, Google Workspace…).

## Images dans le mail

- Bouton **Image** (ou copier-coller / glisser une image dans l'éditeur) : l'image est intégrée au mail
  en pièce jointe « inline », elle s'affiche donc chez le destinataire sans dépendre de votre ordinateur.
- Bouton **Image URL** : l'image est chargée depuis Internet (elle doit être publique).
- Double-cliquez sur une image pour changer sa largeur.
- En mode **HTML**, `<img src="https://…">` et les images en base64 fonctionnent aussi.

## Déployer en ligne

### Sur Render (recommandé)

1. Sur [render.com](https://render.com), cliquez sur **New + → Blueprint** et choisissez ce dépôt `Sender`.
2. Render lit `render.yaml` et vous demande :
   - `APP_PASSWORD` : le mot de passe pour accéder à votre plateforme (obligatoire, sinon n'importe qui pourrait envoyer des mails depuis votre compte) ;
   - `SMTP_USER` : votre adresse Gmail ;
   - `SMTP_PASS` : votre mot de passe d'application Gmail ;
   - `FROM_NAME` : le nom affiché (ex. « Candy Dupont »).
3. Validez. L'URL du site s'affiche une fois le déploiement terminé ; le navigateur vous demande le mot de passe
   (l'identifiant peut être n'importe quoi).

L'offre gratuite de Render bloque l'envoi de mails par SMTP : le fichier utilise l'offre **Starter** (environ 7 $/mois)
avec un petit disque pour garder vos CV, modèles et historique entre deux redémarrages.

### Avec Docker (n'importe quel hébergeur)

```bash
docker build -t cv-sender .
docker run -p 3000:3000 -v cv-sender-data:/data \
  -e APP_PASSWORD=monmotdepasse -e SMTP_USER=moi@gmail.com -e SMTP_PASS=xxxx -e FROM_NAME="Prénom Nom" \
  cv-sender
```

### Variables d'environnement

| Variable | Rôle |
|---|---|
| `APP_PASSWORD` | Mot de passe d'accès au site. Obligatoire dès que l'app est en ligne. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | Serveur d'envoi (par défaut Gmail : `smtp.gmail.com`, `465`, `true`). |
| `SMTP_USER`, `SMTP_PASS` | Identifiant et mot de passe d'application. |
| `FROM_NAME`, `FROM_EMAIL`, `REPLY_TO` | Expéditeur affiché et adresse de réponse. |
| `DELAY_SECONDS` | Pause entre deux mails (8 par défaut). |
| `STORAGE_DIR` | Dossier où sont gardés réglages, CV, images et historique. |
| `NODE_ENV=production` | Écoute sur toutes les interfaces (nécessaire en ligne). |

Ce qui est saisi dans l'onglet « Réglages » remplace ces valeurs.

## Bonnes pratiques

- Envoyez-vous toujours un **mail de test** avant l'envoi groupé.
- Gardez une pause de 5 à 15 s entre deux envois ; Gmail limite à environ 500 mails par jour.
- Un mail personnalisé (nom du recruteur, entreprise, poste) a bien plus de chances d'être lu, et d'éviter les spams.
