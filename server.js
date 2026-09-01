// ============================================================
// BOT WHATSAPP "TEXT-TO-VOCAL" + AGENT ADMIN CATALOGUE (DFM Solution)
//
// Deux modes selon l'expéditeur :
//  - Numéro NON-admin -> assistant vocal classique (texte/vocal -> Gemini
//    -> réponse vocale), comme dans le prototype de départ.
//  - Numéro admin (ADMIN_WHATSAPP_NUMBERS) -> Gemini avec Function Calling :
//    si le message est une commande d'ajout au catalogue ("ajoute la
//    formation X à Y FCFA..."), Gemini extrait les champs structurés,
//    l'agent les POST vers l'API du site DFM Solution (CMS), puis renvoie
//    une confirmation texte à l'admin. Sinon, réponse conversationnelle
//    normale (vocale).
//
//    L'admin peut aussi envoyer une PHOTO :
//      - avec légende ("Ajoute la formation X à Y FCFA") -> image + champs
//        extraits en un seul message, l'élément est créé avec sa photo.
//      - sans légende -> l'image est soit attachée à la dernière formation/
//        service créé(e) il y a peu (photo envoyée après le vocal), soit
//        mise en attente pour la prochaine commande catalogue (photo
//        envoyée avant le vocal). Fonctionne dans les deux ordres d'envoi.
//
// Flux commande catalogue :
//   WhatsApp (vocal/texte/photo, admin) -> Evolution API -> Gemini (function
//   calling) -> POST {CMS_API_URL}/api/admin/{formations|services} (+ upload
//   -image si une photo est fournie) -> confirmation texte -> Evolution API
//   -> WhatsApp
// ============================================================

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const googleTTS = require("google-tts-api");
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(express.json({ limit: "10mb" })); // Evolution API envoie du JSON

// ------------------------------------------------------------
// CONFIGURATION
// ------------------------------------------------------------
const {
  PORT = 3000,
  GEMINI_API_KEY,
  EVOLUTION_API_URL,
  EVOLUTION_API_KEY,
  EVOLUTION_INSTANCE_NAME,
  GEMINI_MODEL = "gemini-3.6-flash",
  // Numéros autorisés à administrer le catalogue via WhatsApp, séparés par
  // des virgules, format international SANS "+" (ex: "22990000000,22997000000").
  ADMIN_WHATSAPP_NUMBERS = "",
  // API du site DFM Solution (le CMS) et token partagé (voir
  // server/src/middleware/apiToken.js côté CMS).
  CMS_API_URL,
  CMS_API_TOKEN,
  // Base publique du site, utilisée uniquement pour construire le lien de
  // confirmation envoyé à l'admin (optionnel, cosmétique).
  SITE_PUBLIC_URL = "",
  // Garde-fou de démo/test sur un numéro WhatsApp réel : "true" pour ignorer
  // silencieusement tout message venant d'un numéro hors ADMIN_WHATSAPP_NUMBERS.
  RESTRICT_TO_ADMIN_ONLY = "false",
} = process.env;

const IS_RESTRICTED_DEMO = RESTRICT_TO_ADMIN_ONLY === "true";

if (!GEMINI_API_KEY || !EVOLUTION_API_URL || !EVOLUTION_API_KEY || !EVOLUTION_INSTANCE_NAME) {
  console.error("❌ Variables d'environnement manquantes. Vérifie ton fichier .env");
  process.exit(1);
}

const ADMIN_NUMBERS = ADMIN_WHATSAPP_NUMBERS.split(",")
  .map((n) => n.trim())
  .filter(Boolean);

if (ADMIN_NUMBERS.length > 0 && (!CMS_API_URL || !CMS_API_TOKEN)) {
  console.error(
    "❌ ADMIN_WHATSAPP_NUMBERS est configuré mais CMS_API_URL / CMS_API_TOKEN manquent. " +
      "Ces variables sont nécessaires pour publier sur le site DFM Solution."
  );
  process.exit(1);
}

if (ADMIN_NUMBERS.length === 0) {
  console.warn(
    "⚠️  Aucun ADMIN_WHATSAPP_NUMBERS configuré : le mode 'ajout au catalogue' est désactivé, " +
      "tous les messages seront traités comme de simples conversations."
  );
}

// ------------------------------------------------------------
// ÉTAT EN MÉMOIRE (par admin) — corrélation photo <-> commande catalogue
// quand elles arrivent dans deux messages séparés (dans un ordre ou l'autre).
// Volontairement simple (process unique, pas de persistance) : c'est un
// pont éphémère de quelques minutes entre deux messages WhatsApp du même
// admin, pas un historique à conserver.
// ------------------------------------------------------------
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes
const pendingImageBySender = new Map(); // sender -> { url, at }
const lastCreatedItemBySender = new Map(); // sender -> { type, id, title, at }

function setPendingImage(sender, url) {
  pendingImageBySender.set(sender, { url, at: Date.now() });
}

// Consomme (et supprime) l'image en attente pour ce sender, si encore valide.
function takePendingImage(sender) {
  const entry = pendingImageBySender.get(sender);
  if (!entry) return null;
  pendingImageBySender.delete(sender);
  return Date.now() - entry.at <= PENDING_TTL_MS ? entry.url : null;
}

function setLastCreatedItem(sender, item) {
  lastCreatedItemBySender.set(sender, { ...item, at: Date.now() });
}

function takeRecentLastItem(sender) {
  const entry = lastCreatedItemBySender.get(sender);
  if (!entry) return null;
  lastCreatedItemBySender.delete(sender);
  return Date.now() - entry.at <= PENDING_TTL_MS ? entry : null;
}

// Evolution API (comme WhatsApp/Baileys en général) peut livrer un même
// événement `messages.upsert` plusieurs fois (retry réseau, reconnexion...).
// Constaté en test réel : une même photo légendée reçue deux fois a créé
// deux formations identiques. On déduplique par ID de message WhatsApp.
const DEDUPE_TTL_MS = 5 * 60 * 1000; // 5 minutes suffisent à couvrir un retry
const processedMessageIds = new Map(); // messageId -> timestamp de traitement

function isDuplicateMessage(messageId) {
  if (!messageId) return false; // pas d'ID -> impossible de dédupliquer, on traite
  const seenAt = processedMessageIds.get(messageId);
  if (seenAt && Date.now() - seenAt <= DEDUPE_TTL_MS) return true;
  processedMessageIds.set(messageId, Date.now());
  // Purge légère pour ne pas laisser grossir la map indéfiniment.
  if (processedMessageIds.size > 500) {
    const cutoff = Date.now() - DEDUPE_TTL_MS;
    for (const [id, ts] of processedMessageIds) {
      if (ts < cutoff) processedMessageIds.delete(id);
    }
  }
  return false;
}

// Initialisation du client Gemini (nouveau SDK @google/genai)
const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const CHAT_SYSTEM_PROMPT =
  "Tu es un assistant vocal WhatsApp amical et chaleureux. " +
  "Tu réponds TOUJOURS en 2 à 3 phrases maximum, de façon naturelle, " +
  "comme si tu parlais à voix haute. Pas de listes, pas de markdown, " +
  "pas de symboles spéciaux (pas d'astérisques, pas de tirets). " +
  "Va droit au but avec une touche de sympathie.";

// ------------------------------------------------------------
// DÉCLARATION DE FONCTION GEMINI — ajout d'un élément au catalogue
// ------------------------------------------------------------
const ADD_CATALOG_ITEM_FUNCTION = {
  name: "add_catalog_item",
  description:
    "Ajoute une nouvelle formation ou un nouveau service au catalogue du site web DFM Solution. " +
    "N'appelle cette fonction QUE si l'administrateur demande explicitement d'AJOUTER, CRÉER ou " +
    "PUBLIER une formation, une offre ou un service sur le site. Ne l'appelle jamais pour une " +
    "simple question ou une conversation normale.",
  parameters: {
    type: "OBJECT",
    properties: {
      type: {
        type: "STRING",
        enum: ["formation", "service"],
        description:
          "'formation' si l'élément a une date de session et/ou un nombre de places précis " +
          "(cours, atelier, séminaire). 'service' pour une prestation sans date fixe " +
          "(accompagnement, consulting, développement, etc.).",
      },
      title: { type: "STRING", description: "Titre court et clair de la formation ou du service." },
      description: {
        type: "STRING",
        description:
          "Description commerciale de 1 à 3 phrases, reformulée proprement à partir de ce que dit " +
          "l'administrateur (corrige la grammaire, reste fidèle au sens).",
      },
      price: {
        type: "NUMBER",
        description: "Prix en Francs CFA (FCFA), nombre entier sans espace ni symbole monétaire.",
      },
      sessionDate: {
        type: "STRING",
        description:
          "Uniquement pour une formation avec une date précise. Date ISO 8601 (AAAA-MM-JJ), déduite " +
          "à partir de la date du jour donnée dans le contexte (résous les dates relatives comme " +
          "'samedi 15 du mois' ou 'la semaine prochaine'). Omets ce champ si aucune date n'est " +
          "mentionnée ou si type='service'.",
      },
      totalSeats: {
        type: "NUMBER",
        description: "Nombre de places disponibles, uniquement si l'administrateur le précise.",
      },
      published: {
        type: "BOOLEAN",
        description:
          "true si l'administrateur veut publier immédiatement (valeur par défaut si non précisé), " +
          "false s'il dit explicitement 'brouillon' ou 'ne publie pas tout de suite'.",
      },
    },
    required: ["type", "title", "description", "price"],
  },
};

function buildAdminSystemPrompt() {
  const now = new Date();
  const todayHuman = now.toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const todayIso = now.toISOString().slice(0, 10);

  return (
    "Tu es l'assistant d'administration WhatsApp du site web DFM Solution. " +
    `Nous sommes aujourd'hui ${todayHuman} (${todayIso}). ` +
    "Quand l'administrateur te demande d'ajouter, de créer ou de publier une formation, une offre " +
    "ou un service sur le site, appelle IMPÉRATIVEMENT la fonction add_catalog_item avec les champs " +
    "correctement remplis, en déduisant les dates relatives à partir de la date du jour ci-dessus. " +
    "Si une information essentielle manque (titre ou prix), n'appelle PAS la fonction : demande la " +
    "précision manquante en une phrase courte, naturelle, sans jargon technique. " +
    "Pour toute autre demande qui n'est pas un ajout au catalogue, réponds normalement en 2-3 " +
    "phrases maximum, sans appeler de fonction, sans markdown."
  );
}

// ------------------------------------------------------------
// ÉTAPE 1 : ENDPOINT WEBHOOK — reçoit les événements Evolution API
// ------------------------------------------------------------
app.post("/webhook/whatsapp", async (req, res) => {
  // Déclarés ici (et non dans le try) pour rester accessibles depuis le catch :
  // si une erreur survient en cours de traitement pour un admin, on veut
  // pouvoir le prévenir par texte plutôt que le laisser sans aucune réponse.
  let senderNumber;
  let senderIsAdmin = false;

  try {
    const payload = req.body;

    // On répond tout de suite 200 à Evolution API pour ne pas bloquer le webhook
    res.status(200).json({ received: true });

    // On ne traite que les nouveaux messages entrants
    if (payload.event !== "messages.upsert") return;

    const messageData = payload.data;
    if (!messageData) return;

    // On ignore les messages envoyés par le bot lui-même (écho)
    if (messageData.key?.fromMe) return;

    // Numéro de l'expéditeur (format Evolution API : "2290000000000@s.whatsapp.net")
    senderNumber = messageData.key?.remoteJid;
    if (!senderNumber) return;

    // Anti-doublon : même message WhatsApp livré deux fois par le webhook.
    if (isDuplicateMessage(messageData.key?.id)) {
      console.log(`⏭️ Message déjà traité, doublon ignoré (id: ${messageData.key?.id}).`);
      return;
    }

    senderIsAdmin = isAdminSender(senderNumber);

    // Garde-fou de démo : si activé, on ignore silencieusement TOUT message
    // venant d'un numéro hors liste admin (aucune réponse, même pas la
    // conversation normale). Sert à tester sur un vrai numéro WhatsApp en
    // production sans jamais répondre automatiquement à de vrais contacts.
    if (IS_RESTRICTED_DEMO && !senderIsAdmin) {
      console.log(`🚫 [démo] Message ignoré (expéditeur non-admin) : ${senderNumber}`);
      return;
    }

    // Extraction du texte, quel que soit le type de message texte WhatsApp
    const text =
      messageData.message?.conversation ||
      messageData.message?.extendedTextMessage?.text ||
      null;

    // Détection d'une note vocale (audioMessage) ou d'une photo (imageMessage)
    const isVoiceNote = !!messageData.message?.audioMessage;
    const imageMessage = messageData.message?.imageMessage;

    // --- Cas photo : traitement dédié (upload CMS + éventuelle légende) ---
    if (imageMessage) {
      if (!senderIsAdmin) {
        // Une photo envoyée par un contact normal n'a aucun usage ici (le
        // chat classique ne traite ni n'analyse les images) -> on ignore,
        // comme pour tout autre type de message non pris en charge.
        console.log("⚠️ Photo reçue d'un numéro non-admin, ignorée.");
        return;
      }
      console.log(`🖼️ Photo reçue de ${senderNumber} (admin), traitement en cours...`);
      await handleAdminImageMessage(messageData, senderNumber, imageMessage.caption || "");
      return;
    }

    let aiReplyText;
    let isCatalogReply = false;

    if (text) {
      console.log(`📩 Message texte reçu de ${senderNumber} (admin: ${senderIsAdmin}) : "${text}"`);
      if (senderIsAdmin) {
        const outcome = await handleAdminMessage({ text, senderNumber });
        aiReplyText = outcome.replyText;
        isCatalogReply = outcome.wasCatalogCommand;
      } else {
        aiReplyText = await getGeminiReply(text);
      }
    } else if (isVoiceNote) {
      console.log(`🎙️ Note vocale reçue de ${senderNumber} (admin: ${senderIsAdmin}), transcription en cours...`);

      // On télécharge l'audio en base64 depuis Evolution API
      const audioData = await downloadWhatsAppMedia(messageData);

      if (senderIsAdmin) {
        const outcome = await handleAdminMessage({
          audioBase64: audioData.base64,
          mimetype: audioData.mimetype,
          senderNumber,
        });
        aiReplyText = outcome.replyText;
        isCatalogReply = outcome.wasCatalogCommand;
      } else {
        // On envoie directement l'audio à Gemini, qui comprend la voix nativement
        aiReplyText = await getGeminiReplyFromAudio(audioData.base64, audioData.mimetype);
      }
    } else {
      // --- Autre type de message (sticker, document, etc.) ---
      console.log("⚠️ Message reçu non pris en charge (ni texte, ni audio, ni photo), ignoré.");
      return;
    }

    console.log(`🤖 Réponse : "${aiReplyText}"`);

    if (isCatalogReply) {
      // Confirmation/erreur d'ajout au catalogue : en texte, pour que l'admin
      // puisse relire précisément le prix, la date et le lien du contenu créé.
      await sendWhatsAppText(senderNumber, aiReplyText);
      console.log(`✅ Confirmation texte envoyée à ${senderNumber}`);
      return;
    }

    // --- Conversation normale : réponse vocale (comportement d'origine) ---
    const audioBase64 = await textToSpeechBase64(aiReplyText);
    console.log("🔊 Audio généré avec succès (base64 prêt à envoyer).");
    await sendWhatsAppVoiceNote(senderNumber, audioBase64);
    console.log(`✅ Note vocale envoyée à ${senderNumber}`);
  } catch (error) {
    console.error("❌ Erreur dans le traitement du webhook :", error.message);

    // Un admin ne doit jamais rester sans réponse (silence = on ne sait pas
    // si la commande est passée ou non). Un contact normal, en revanche,
    // ne reçoit jamais de message non sollicité suite à une erreur interne.
    if (senderIsAdmin && senderNumber) {
      try {
        await sendWhatsAppText(
          senderNumber,
          "❌ Une erreur technique m'a empêché de traiter ton message. Réessaie dans un instant."
        );
      } catch (sendErr) {
        console.error("❌ Impossible d'envoyer le message d'erreur à l'admin :", sendErr.message);
      }
    }
  }
});

// ------------------------------------------------------------
// FONCTION : vérifier si l'expéditeur fait partie des admins autorisés
// ------------------------------------------------------------
function isAdminSender(remoteJid) {
  const number = String(remoteJid).split("@")[0];
  return ADMIN_NUMBERS.includes(number);
}

// ------------------------------------------------------------
// FONCTION : traiter un message admin (texte ou audio) avec Function Calling
// Si une photo est en attente pour ce sender (envoyée juste avant, sans
// légende), elle est automatiquement attachée à l'élément créé.
// Retourne { wasCatalogCommand, replyText }
// ------------------------------------------------------------
async function handleAdminMessage({ text, audioBase64, mimetype, senderNumber, imageUrl }) {
  const contents = text
    ? [{ role: "user", parts: [{ text }] }]
    : [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: mimetype, data: audioBase64 } },
            { text: "Écoute cette instruction et agis en conséquence." },
          ],
        },
      ];

  const result = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction: buildAdminSystemPrompt(),
      tools: [{ functionDeclarations: [ADD_CATALOG_ITEM_FUNCTION] }],
    },
  });

  const call = result.functionCalls?.[0];

  if (!call || call.name !== "add_catalog_item") {
    // Ce n'est pas une commande d'ajout au catalogue -> réponse conversationnelle.
    return {
      wasCatalogCommand: false,
      replyText: (result.text || "Je n'ai pas bien compris, peux-tu reformuler ?").trim(),
    };
  }

  console.log("🛠️ Function call Gemini reçu :", JSON.stringify(call.args));

  // Image fournie explicitement (photo + légende dans le même message) sinon
  // photo envoyée séparément juste avant, encore en attente pour ce sender.
  const resolvedImageUrl = imageUrl || (senderNumber ? takePendingImage(senderNumber) : null);

  try {
    const item = await createCatalogItem(call.args, resolvedImageUrl);
    if (senderNumber) {
      setLastCreatedItem(senderNumber, { type: call.args.type, id: item.id, title: item.title });
    }
    return {
      wasCatalogCommand: true,
      replyText: formatSuccessMessage(item, call.args.type, Boolean(resolvedImageUrl)),
    };
  } catch (err) {
    const apiError = err.response?.data?.error || err.message;
    console.error("❌ Erreur création catalogue :", apiError);
    return {
      wasCatalogCommand: true,
      replyText:
        `❌ Désolé, je n'ai pas pu ajouter ça au site : ${apiError}. ` +
        "Peux-tu réessayer en précisant bien le titre et le prix ?",
    };
  }
}

// ------------------------------------------------------------
// FONCTION : traiter une PHOTO envoyée par l'admin (avec ou sans légende)
// ------------------------------------------------------------
async function handleAdminImageMessage(messageData, senderNumber, caption) {
  try {
    const media = await downloadWhatsAppMedia(messageData);
    const imageUrl = await uploadImageToCms(media.base64, media.mimetype);
    console.log(`🖼️ Image envoyée au CMS : ${imageUrl}`);

    if (caption && caption.trim()) {
      // Photo + légende = commande catalogue complète en un seul message.
      const outcome = await handleAdminMessage({ text: caption.trim(), senderNumber, imageUrl });
      await sendWhatsAppText(senderNumber, outcome.replyText);
      return;
    }

    // Pas de légende : la photo arrive peut-être juste APRÈS un vocal/texte
    // qui vient de créer une formation/un service -> on l'attache directement.
    const lastItem = takeRecentLastItem(senderNumber);
    if (lastItem) {
      await attachImageToItem(lastItem.type, lastItem.id, imageUrl);
      const label = lastItem.type === "service" ? "service" : "formation";
      await sendWhatsAppText(senderNumber, `✅ Image ajoutée à la ${label} "${lastItem.title}".`);
      return;
    }

    // Sinon, elle arrive AVANT la commande : on la garde en attente quelques
    // minutes, elle sera consommée par le prochain message admin.
    setPendingImage(senderNumber, imageUrl);
    await sendWhatsAppText(
      senderNumber,
      "📷 Image bien reçue ! Envoie-moi maintenant le nom, le prix (et la date si besoin) " +
        "de la formation ou du service, texte ou vocal, je l'attacherai automatiquement."
    );
  } catch (err) {
    const apiError = err.response?.data?.error || err.message;
    console.error("❌ Erreur traitement image :", apiError);
    await sendWhatsAppText(senderNumber, `❌ Désolé, je n'ai pas pu traiter cette image : ${apiError}.`);
  }
}

// ------------------------------------------------------------
// FONCTION : POST vers l'API du CMS DFM Solution
// ------------------------------------------------------------
async function createCatalogItem(fields, imageUrl) {
  const { type, ...payload } = fields;
  if (imageUrl) payload.imageUrl = imageUrl;
  const endpoint = type === "service" ? "services" : "formations";
  const url = `${CMS_API_URL.replace(/\/$/, "")}/api/admin/${endpoint}`;

  const response = await axios.post(url, payload, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CMS_API_TOKEN}`,
    },
    timeout: 10000,
  });

  return response.data.item;
}

// ------------------------------------------------------------
// FONCTION : uploader l'image (base64) vers le CMS, renvoie son URL publique
// ------------------------------------------------------------
async function uploadImageToCms(base64, mimetype) {
  const ext = mimetype.includes("png") ? "png" : mimetype.includes("webp") ? "webp" : "jpg";
  const form = new FormData();
  form.append("image", Buffer.from(base64, "base64"), {
    filename: `whatsapp-${Date.now()}.${ext}`,
    contentType: mimetype,
  });

  const url = `${CMS_API_URL.replace(/\/$/, "")}/api/admin/upload-image`;
  const response = await axios.post(url, form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${CMS_API_TOKEN}` },
    timeout: 15000,
    maxContentLength: 15 * 1024 * 1024,
    maxBodyLength: 15 * 1024 * 1024,
  });

  return response.data.url;
}

// ------------------------------------------------------------
// FONCTION : attacher une image à une formation/un service déjà créé(e)
// ------------------------------------------------------------
async function attachImageToItem(type, id, imageUrl) {
  const endpoint = type === "service" ? "services" : "formations";
  const url = `${CMS_API_URL.replace(/\/$/, "")}/api/admin/${endpoint}/${id}/image`;

  await axios.patch(
    url,
    { imageUrl },
    {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${CMS_API_TOKEN}` },
      timeout: 10000,
    }
  );
}

// ------------------------------------------------------------
// FONCTION : formater le message de confirmation envoyé à l'admin
// ------------------------------------------------------------
function formatSuccessMessage(item, type, hadImage) {
  const label = type === "service" ? "service" : "formation";
  const prix =
    item.price !== null && item.price !== undefined
      ? `${Number(item.price).toLocaleString("fr-FR")} FCFA`
      : "prix sur devis";

  let msg = `✅ Succès ! La ${label} "${item.title}" (${prix}) a été ajoutée au site DFM Solution.`;

  if (item.sessionDate) {
    const dateHuman = new Date(item.sessionDate).toLocaleDateString("fr-FR", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
    msg += ` Date : ${dateHuman}.`;
  }
  if (item.totalSeats) {
    msg += ` Places : ${item.totalSeats}.`;
  }
  if (hadImage) {
    msg += " 📷 Image ajoutée.";
  }
  if (SITE_PUBLIC_URL) {
    const path = type === "service" ? "services" : "formations";
    msg += `\n🔗 ${SITE_PUBLIC_URL.replace(/\/$/, "")}/${path}/${item.slug}`;
  }

  return msg;
}

// ------------------------------------------------------------
// FONCTION : Appel à Gemini pour générer une réponse texte concise
// ------------------------------------------------------------
async function getGeminiReply(userText) {
  const result = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: userText,
    config: {
      systemInstruction: CHAT_SYSTEM_PROMPT,
    },
  });
  return result.text.trim();
}

// ------------------------------------------------------------
// FONCTION : Télécharger un média WhatsApp (audio OU image) via Evolution API
// ------------------------------------------------------------
async function downloadWhatsAppMedia(messageData) {
  const url = `${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${EVOLUTION_INSTANCE_NAME}`;

  const response = await axios.post(
    url,
    {
      message: {
        key: messageData.key,
      },
      convertToMp4: false,
    },
    {
      headers: {
        "Content-Type": "application/json",
        apikey: EVOLUTION_API_KEY,
      },
      // Sans timeout, une requête qu'Evolution n'arrive pas à servir (média
      // introuvable/déchiffrement en échec côté Baileys, etc.) reste en
      // attente indéfiniment et le message correspondant ne reçoit jamais
      // de réponse. Constaté en test réel avec une note vocale.
      timeout: 20000,
    }
  );

  // Evolution API renvoie le base64 et le type mime du fichier d'origine.
  // Si l'API ne le précise pas, on retombe sur le mimetype déjà présent dans
  // l'événement webhook lui-même (audioMessage/imageMessage.mimetype).
  const fallbackMimetype =
    messageData.message?.audioMessage?.mimetype ||
    messageData.message?.imageMessage?.mimetype ||
    "application/octet-stream";

  return {
    base64: response.data.base64,
    mimetype: response.data.mimetype || fallbackMimetype,
  };
}

// ------------------------------------------------------------
// FONCTION : Envoyer l'audio directement à Gemini (compréhension audio native)
// Gemini écoute la note vocale et répond directement à ce qui est dit dedans.
// ------------------------------------------------------------
async function getGeminiReplyFromAudio(audioBase64, mimetype) {
  const result = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: mimetype, data: audioBase64 } },
          { text: "Écoute ce message vocal et réponds-y directement, comme dans une conversation." },
        ],
      },
    ],
    config: {
      systemInstruction: CHAT_SYSTEM_PROMPT,
    },
  });
  return result.text.trim();
}

// ------------------------------------------------------------
// FONCTION : Conversion texte -> audio MP3 en base64 via google-tts-api
// (gratuit, sans clé API, utilise le moteur TTS de Google Translate)
// ------------------------------------------------------------
async function textToSpeechBase64(text) {
  // google-tts-api limite chaque segment à ~200 caractères.
  // getAllAudioUrls découpe automatiquement le texte en plusieurs segments.
  const urls = googleTTS.getAllAudioUrls(text, {
    lang: "fr", // change en "en" si tu veux une voix anglaise
    slow: false,
    host: "https://translate.google.com",
  });

  // On télécharge chaque segment audio et on les concatène en un seul buffer MP3
  const audioBuffers = [];
  for (const segment of urls) {
    const response = await axios.get(segment.url, { responseType: "arraybuffer" });
    audioBuffers.push(Buffer.from(response.data));
  }

  const finalBuffer = Buffer.concat(audioBuffers);
  return finalBuffer.toString("base64");
}

// ------------------------------------------------------------
// FONCTION : Envoi d'un message TEXTE via Evolution API
// ------------------------------------------------------------
async function sendWhatsAppText(number, text) {
  const url = `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE_NAME}`;

  await axios.post(
    url,
    {
      number: number,
      text: text,
      delay: 800,
    },
    {
      headers: {
        "Content-Type": "application/json",
        apikey: EVOLUTION_API_KEY,
      },
    }
  );
}

// ------------------------------------------------------------
// FONCTION : Envoi de la note vocale via Evolution API
// ------------------------------------------------------------
async function sendWhatsAppVoiceNote(number, audioBase64) {
  const url = `${EVOLUTION_API_URL}/message/sendWhatsAppAudio/${EVOLUTION_INSTANCE_NAME}`;

  await axios.post(
    url,
    {
      number: number,
      audio: audioBase64, // Evolution API accepte le base64 brut (sans préfixe data:)
      delay: 1200, // petit délai en ms pour simuler un envoi naturel
      encoding: true, // indique à Evolution API que c'est bien du base64
    },
    {
      headers: {
        "Content-Type": "application/json",
        apikey: EVOLUTION_API_KEY,
      },
    }
  );
}

// ------------------------------------------------------------
// DÉMARRAGE DU SERVEUR
// ------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Serveur webhook démarré sur http://localhost:${PORT}`);
  console.log(`📡 Endpoint webhook : POST http://localhost:${PORT}/webhook/whatsapp`);
  console.log(
    ADMIN_NUMBERS.length > 0
      ? `🛠️ Mode admin catalogue actif pour : ${ADMIN_NUMBERS.join(", ")}`
      : "💬 Mode conversation uniquement (pas d'admin configuré)."
  );
  if (IS_RESTRICTED_DEMO) {
    console.log("🔒 DÉMO RESTREINTE : tout message hors liste admin est ignoré (aucune réponse envoyée).");
  }
});

module.exports = {
  isAdminSender,
  handleAdminMessage,
  handleAdminImageMessage,
  formatSuccessMessage,
};
