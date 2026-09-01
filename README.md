# WhatsApp Voice Agent + Admin Catalogue DFM Solution

Bot WhatsApp à deux visages :

- **Contact normal** : conversation vocale classique (texte ou note vocale ->
  Gemini -> réponse en note vocale).
- **Numéro admin** (configuré dans `ADMIN_WHATSAPP_NUMBERS`) : peut **ajouter
  des formations ou services au site DFM Solution** en envoyant simplement un
  vocal, un texte, ou une photo — Gemini extrait les champs via Function
  Calling et l'agent les publie directement sur le CMS.

```
WhatsApp (texte / vocal / photo, admin)
   -> Evolution API
   -> Gemini (function calling : extraction titre/prix/date/description)
   -> POST {CMS_API_URL}/api/admin/{formations|services}   (+ upload-image si photo)
   -> confirmation TEXTE renvoyée sur WhatsApp

WhatsApp (texte / vocal, contact normal)
   -> Evolution API -> Gemini (conversation) -> google-tts-api (MP3)
   -> Evolution API -> WhatsApp (note vocale)
```

## Fonctionnement détaillé

1. `POST /webhook/whatsapp` reçoit les événements `messages.upsert` d'Evolution API.
2. Selon l'expéditeur et le type de message :
   - **Admin + texte/vocal** : Gemini reçoit le message avec l'outil
     `add_catalog_item` (function calling). S'il détecte une commande d'ajout
     ("ajoute la formation X à Y FCFA..."), il extrait `type` (formation/
     service), `title`, `description`, `price`, `sessionDate`, `totalSeats`,
     `published`. L'agent POST ces champs vers le CMS, qui crée l'élément et
     renvoie son slug/URL. Une confirmation texte part sur WhatsApp.
   - **Admin + photo** :
     - avec légende → la légende est traitée comme une commande catalogue
       (comme ci-dessus), et la photo est uploadée puis attachée à l'élément
       créé en un seul aller-retour.
     - sans légende → si une formation/service vient d'être créé(e) il y a
       moins de 10 min, la photo lui est attachée directement ; sinon elle
       est mise en attente et sera attachée à la **prochaine** commande
       catalogue de cet admin (fonctionne dans les deux ordres d'envoi :
       photo puis vocal, ou vocal puis photo).
   - **Contact normal + texte/vocal** : réponse conversationnelle classique,
     renvoyée en note vocale via `google-tts-api`.
   - Tout autre type de message (sticker, document...) est ignoré.

## Prérequis

- Node.js 18+
- Docker (pour Evolution API + PostgreSQL + Redis)
- Une clé API Google Gemini
- Le CMS DFM Solution démarré et son endpoint `/api/admin/*` accessible
  (voir `server/src/routes/api.js` dans le dépôt du CMS)

## Installation

```bash
npm install
cp .env.example .env   # puis renseigner les valeurs
```

Lancer l'infrastructure WhatsApp :

```bash
docker compose up -d
```

Créer et connecter une instance WhatsApp dans Evolution API (scan du QR code),
puis configurer son webhook vers `http://<votre-hote>:3000/webhook/whatsapp`
(utiliser ngrok si le serveur tourne en local).

Démarrer le bot :

```bash
node server.js
```

## Variables d'environnement

Voir [`.env.example`](.env.example) — en particulier `ADMIN_WHATSAPP_NUMBERS`,
`CMS_API_URL` et `CMS_API_TOKEN` pour activer le mode admin catalogue.

## Sécurité

- Seuls les numéros listés dans `ADMIN_WHATSAPP_NUMBERS` peuvent écrire sur le
  site — tout autre expéditeur reste en simple conversation, jamais en écriture.
- L'API `/api/admin/*` du CMS est protégée par un token Bearer partagé
  (`WHATSAPP_API_TOKEN` côté CMS = `CMS_API_TOKEN` côté agent), comparé en
  temps constant, jamais par la session admin du site.
- `RESTRICT_TO_ADMIN_ONLY=true` (démo/test) ignore silencieusement tout
  message venant d'un numéro hors liste admin — utile pour tester sur un vrai
  numéro WhatsApp sans jamais répondre à un vrai contact par erreur.

## Avertissements

- **Evolution API n'est pas officiel.** Meta peut bannir le numéro WhatsApp
  utilisé, surtout en cas d'envois automatisés en volume.
- `google-tts-api` est un service non officiel (voix synthétique, segments
  limités à ~200 caractères, peut cesser de fonctionner) — utilisé uniquement
  pour les réponses conversationnelles, jamais pour les confirmations
  catalogue (toujours en texte, pour une relecture précise du prix/de la date).
- Aucune mémoire de conversation classique : chaque message est traité
  isolément (seule la corrélation photo <-> commande catalogue est mise en
  cache, en mémoire, pendant 10 minutes maximum).
- Ne jamais committer le fichier `.env`.

## Licence

ISC
