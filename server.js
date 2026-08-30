// ============================================================
// BOT WHATSAPP "TEXT-TO-VOCAL" (+ compréhension des notes vocales)
// Flux : WhatsApp (texte OU vocal) -> Evolution API -> Gemini 3.6 Flash
//        -> google-tts-api (MP3) -> Evolution API -> WhatsApp (note vocale)
// ============================================================

require("dotenv").config();
const express = require("express");
const axios = require("axios");
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
} = process.env;

if (!GEMINI_API_KEY || !EVOLUTION_API_URL || !EVOLUTION_API_KEY || !EVOLUTION_INSTANCE_NAME) {
  console.error("❌ Variables d'environnement manquantes. Vérifie ton fichier .env");
  process.exit(1);
}

// Initialisation du client Gemini (nouveau SDK @google/genai)
const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const SYSTEM_PROMPT =
  "Tu es un assistant vocal WhatsApp amical et chaleureux. " +
  "Tu réponds TOUJOURS en 2 à 3 phrases maximum, de façon naturelle, " +
  "comme si tu parlais à voix haute. Pas de listes, pas de markdown, " +
  "pas de symboles spéciaux (pas d'astérisques, pas de tirets). " +
  "Va droit au but avec une touche de sympathie.";

// ------------------------------------------------------------
// ÉTAPE 1 : ENDPOINT WEBHOOK — reçoit les événements Evolution API
// ------------------------------------------------------------
app.post("/webhook/whatsapp", async (req, res) => {
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
    const senderNumber = messageData.key?.remoteJid;
    if (!senderNumber) return;

    // Extraction du texte, quel que soit le type de message texte WhatsApp
    const text =
      messageData.message?.conversation ||
      messageData.message?.extendedTextMessage?.text ||
      null;

    // Détection d'une note vocale (audioMessage)
    const isVoiceNote = !!messageData.message?.audioMessage;

    let aiReplyText;

    if (text) {
      // --- Cas 1 : message texte classique ---
      console.log(`📩 Message texte reçu de ${senderNumber} : "${text}"`);
      aiReplyText = await getGeminiReply(text);
    } else if (isVoiceNote) {
      // --- Cas 2 : note vocale reçue ---
      console.log(`🎙️ Note vocale reçue de ${senderNumber}, transcription en cours...`);

      // On télécharge l'audio en base64 depuis Evolution API
      const audioData = await downloadWhatsAppAudio(messageData);

      // On envoie directement l'audio à Gemini, qui comprend la voix nativement
      aiReplyText = await getGeminiReplyFromAudio(audioData.base64, audioData.mimetype);
    } else {
      // --- Cas 3 : autre type de message (image, sticker, etc.) ---
      console.log("⚠️ Message reçu non pris en charge (ni texte, ni audio), ignoré.");
      return;
    }

    console.log(`🤖 Réponse Gemini : "${aiReplyText}"`);

    // --- ÉTAPE 3 : Conversion du texte en audio MP3 (base64) ---
    const audioBase64 = await textToSpeechBase64(aiReplyText);
    console.log("🔊 Audio généré avec succès (base64 prêt à envoyer).");

    // --- ÉTAPE 4 : Envoi de la note vocale sur WhatsApp via Evolution API ---
    await sendWhatsAppVoiceNote(senderNumber, audioBase64);
    console.log(`✅ Note vocale envoyée à ${senderNumber}`);
  } catch (error) {
    console.error("❌ Erreur dans le traitement du webhook :", error.message);
  }
});

// ------------------------------------------------------------
// FONCTION : Appel à Gemini pour générer une réponse texte concise
// ------------------------------------------------------------
async function getGeminiReply(userText) {
  const result = await genAI.models.generateContent({
    model: "gemini-3.6-flash",
    contents: userText,
    config: {
      systemInstruction: SYSTEM_PROMPT,
    },
  });
  return result.text.trim();
}

// ------------------------------------------------------------
// FONCTION : Télécharger l'audio d'une note vocale WhatsApp via Evolution API
// ------------------------------------------------------------
async function downloadWhatsAppAudio(messageData) {
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
    }
  );

  // Evolution API renvoie le base64 et le type mime du fichier audio d'origine
  return {
    base64: response.data.base64,
    mimetype: response.data.mimetype || "audio/ogg",
  };
}

// ------------------------------------------------------------
// FONCTION : Envoyer l'audio directement à Gemini (compréhension audio native)
// Gemini écoute la note vocale et répond directement à ce qui est dit dedans.
// ------------------------------------------------------------
async function getGeminiReplyFromAudio(audioBase64, mimetype) {
  const result = await genAI.models.generateContent({
    model: "gemini-3.6-flash",
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
      systemInstruction: SYSTEM_PROMPT,
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
});