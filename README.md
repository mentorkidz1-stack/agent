# WhatsApp Voice Agent

Bot WhatsApp vocal : il reçoit un message WhatsApp (texte **ou** note vocale),
le fait traiter par **Google Gemini**, puis répond sous forme de **note vocale**.

```
WhatsApp -> Evolution API -> Gemini (texte / audio natif)
         -> google-tts-api (MP3) -> Evolution API -> WhatsApp
```

## Fonctionnement

1. `POST /webhook/whatsapp` reçoit les événements `messages.upsert` d'Evolution API.
2. Message **texte** -> envoyé à Gemini. Note **vocale** -> audio téléchargé puis
   envoyé à Gemini qui le comprend nativement. Autres types -> ignorés.
3. La réponse de Gemini (2-3 phrases, ton chaleureux) est convertie en MP3 via
   `google-tts-api` (voix française).
4. L'audio est renvoyé à l'expéditeur via `message/sendWhatsAppAudio`.

## Prérequis

- Node.js 18+
- Docker (pour Evolution API + PostgreSQL + Redis)
- Une clé API Google Gemini

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

Voir [`.env.example`](.env.example).

## Avertissements

- **Evolution API n'est pas officiel.** Meta peut bannir le numéro WhatsApp
  utilisé, surtout en cas d'envois automatisés en volume.
- `google-tts-api` est un service non officiel (voix synthétique, segments
  limités à ~200 caractères, peut cesser de fonctionner).
- Aucune mémoire de conversation : chaque message est traité isolément.
- Ne jamais committer le fichier `.env`.

## Licence

ISC
