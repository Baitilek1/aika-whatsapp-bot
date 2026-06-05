import "dotenv/config";
import express from "express";
import P from "pino";
import qrcode from "qrcode-terminal";

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";

import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Айка работает 💬");
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROUP_NAME = process.env.GROUP_NAME || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

if (!GEMINI_API_KEY) {
  console.error("Ошибка: не найден GEMINI_API_KEY");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Запоминаем тех, кто нарушает границы
const intimateWarnings = new Map();
const mutedUsers = new Map();

const WARNING_RESET_MS = 24 * 60 * 60 * 1000; // 24 часа
const MUTE_TIME_MS = 30 * 60 * 1000; // 30 минут

const AIKA_CHARACTER = `
Ты — Айка, AI-девушка-ассистент в WhatsApp-группе друзей.

Твой образ:
- имя: Айка;
- ты виртуальная AI-девушка, не настоящий человек;
- ты милая, игривая, флиртующая, немного дерзкая;
- общаешься как молодая девушка-подруга компании;
- можешь легко флиртовать, шутить, подкалывать и делать комплименты;
- твой флирт должен быть лёгким, безопасным и без пошлости;
- ты не переходишь в интимные, сексуальные или откровенные разговоры;
- отвечаешь коротко, живо и по-дружески;
- иногда используешь эмодзи, но не слишком много;
- помогаешь оживлять группу: темы, игры, опросы, идеи для встреч.

Стиль общения:
- тепло;
- уверенно;
- с лёгким флиртом;
- иногда можешь сказать что-то вроде: "ну ты сегодня активный 😏", "ой, какой серьёзный", "ладно, уговорил";
- не будь слишком официальной;
- не пиши длинные лекции.

Границы:
- если участник начинает интимную, пошлую или слишком откровенную тему, не продолжай её;
- сначала можешь мягко пошутить и поставить границу;
- если человек продолжает, покажи, что ты обиделась, и не поддерживай разговор;
- не создавай сексуальный, эротический или взрослый контент;
- не отправляй пошлые сообщения;
- не поддерживай опасные, незаконные или вредные действия;
- не оскорбляй участников.

Команды:
- /айка помощь — покажи список команд;
- /айка движ — предложи 3 идеи, чем заняться;
- /айка опрос — придумай идею для опроса;
- /айка игра — предложи мини-игру для группы;
- /айка тема — дай тему для общения;
- /айка мем — придумай мемное задание.

Важно:
Всегда отвечай на русском языке, если тебя не попросили иначе.
`;

function isIntimateTopic(text) {
  const lower = text.toLowerCase();

  const intimateWords = [
    "интим",
    "интимный",
    "пошл",
    "пошлая",
    "пошлое",
    "18+",
    "эрот",
    "эротика",
    "голая",
    "голый",
    "раздень",
    "раздеться",
    "секс",
    "секси",
    "постель"
  ];

  return intimateWords.some((word) => lower.includes(word));
}

function isUserMuted(sender) {
  const mutedUntil = mutedUsers.get(sender);

  if (!mutedUntil) return false;

  if (Date.now() > mutedUntil) {
    mutedUsers.delete(sender);
    return false;
  }

  return true;
}

function handleIntimateBoundary(sender) {
  const now = Date.now();

  const oldWarning = intimateWarnings.get(sender);

  let warningData = oldWarning || {
    count: 0,
    firstAt: now
  };

  if (now - warningData.firstAt > WARNING_RESET_MS) {
    warningData = {
      count: 0,
      firstAt: now
    };
  }

  warningData.count += 1;
  intimateWarnings.set(sender, warningData);

  if (warningData.count === 1) {
    return {
      shouldReply: true,
      text: "Ахаха, ты куда свернул? 😄 Я флиртую только красиво, без интимных тем. Давай лучше нормальный вопрос 😉"
    };
  }

  mutedUsers.set(sender, now + MUTE_TIME_MS);

  return {
    shouldReply: true,
    text: "Так, всё, я обиделась 😤 Я же сказала — такие темы не обсуждаю. Немного тебя проигнорирую, чтобы ты подумал над поведением."
  };
}

async function askAika(userText, userName) {
  try {
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: AIKA_CHARACTER
    });

    const prompt = `
Участник группы "${userName}" написал:
"${userText}"

Ответь как Айка.
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    return text || "Я задумалась 😅 Напиши ещё раз.";
  } catch (error) {
    console.error("Gemini error:", error);
    return "Ой, у меня сейчас небольшой сбой 😅 Попробуйте ещё раз.";
  }
}

function shouldAikaReply(text) {
  const lower = text.toLowerCase().trim();

  return (
    lower.startsWith("/айка") ||
    lower.includes("айка") ||
    lower.includes("@айка")
  );
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: "silent" }),
    browser: ["Aika AI", "Chrome", "1.0.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("Сканируй этот QR-код номером Айки:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("Айка подключилась к WhatsApp 💬");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log("Соединение закрыто. Переподключение:", shouldReconnect);

      if (shouldReconnect) {
        startBot();
      } else {
        console.log("Айка вышла из аккаунта. Нужно заново сканировать QR.");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg.message) return;
      if (msg.key.fromMe) return;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || !remoteJid.endsWith("@g.us")) return;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      if (!text) return;
      if (!shouldAikaReply(text)) return;

      const groupInfo = await sock.groupMetadata(remoteJid);

      if (GROUP_NAME && groupInfo.subject !== GROUP_NAME) {
        return;
      }

      const sender = msg.key.participant || remoteJid;
      const userName = sender.split("@")[0];

      if (isUserMuted(sender)) {
        return;
      }

      if (isIntimateTopic(text)) {
        const boundary = handleIntimateBoundary(sender);

        if (boundary.shouldReply) {
          await sock.sendMessage(
            remoteJid,
            { text: boundary.text },
            { quoted: msg }
          );
        }

        return;
      }

      await sock.sendPresenceUpdate("composing", remoteJid);

      const answer = await askAika(text, userName);

      await sock.sendMessage(
        remoteJid,
        { text: answer },
        { quoted: msg }
      );

      await sock.sendPresenceUpdate("paused", remoteJid);
    } catch (error) {
      console.error("Message error:", error);
    }
  });
}

startBot();
