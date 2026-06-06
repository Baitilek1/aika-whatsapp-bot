import "dotenv/config";
import express from "express";
import P from "pino";
import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";

import { GoogleGenAI } from "@google/genai";

const app = express();
const PORT = process.env.PORT || 3000;

let latestQrImage = "";
let latestQrTime = "";
let latestPairingCode = "";
let latestPairingTime = "";
let pairingRequested = false;

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Айка Bot</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      </head>
      <body style="font-family: Arial; padding: 20px;">
        <h1>Айка работает 💬</h1>
        <p><a href="/qr">Открыть QR-код</a></p>
        <p><a href="/code">Открыть код входа</a></p>
      </body>
    </html>
  `);
});

app.get("/qr", (req, res) => {
  if (!latestQrImage) {
    res.send(`
      <html>
        <head>
          <title>QR для WhatsApp</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        </head>
        <body style="font-family: Arial; text-align: center; padding: 20px;">
          <h2>QR-код ещё не готов</h2>
          <p>Подожди 5–10 секунд. Страница обновится сама.</p>
          <script>
            setTimeout(() => location.reload(), 5000);
          </script>
        </body>
      </html>
    `);
    return;
  }

  res.send(`
    <html>
      <head>
        <title>QR для WhatsApp</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      </head>
      <body style="font-family: Arial; text-align: center; padding: 20px;">
        <h1>QR для входа WhatsApp</h1>
        <p>Время создания: ${latestQrTime}</p>

        <img 
          src="${latestQrImage}" 
          style="width: 340px; max-width: 95%; border: 1px solid #ddd; padding: 12px; background: white;" 
        />

        <p style="font-size: 18px;">
          Сканируй через:
          <br />
          <b>WhatsApp Business → Связанные устройства → Привязать устройство</b>
        </p>

        <p>Если не сканируется — перезапусти сервис в Render и открой эту страницу заново.</p>
      </body>
    </html>
  `);
});

app.get("/code", (req, res) => {
  if (!latestPairingCode) {
    res.send(`
      <html>
        <head>
          <title>Код для WhatsApp</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        </head>
        <body style="font-family: Arial; text-align: center; padding: 20px;">
          <h2>Код ещё не готов</h2>
          <p>Для входа по коду в Render надо поставить LOGIN_METHOD = code.</p>
          <p>Для QR открой <a href="/qr">/qr</a></p>
        </body>
      </html>
    `);
    return;
  }

  res.send(`
    <html>
      <head>
        <title>Код для WhatsApp</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      </head>
      <body style="font-family: Arial; text-align: center; padding: 20px;">
        <h1>Код для входа WhatsApp</h1>
        <h2 style="font-size: 44px; letter-spacing: 5px;">${latestPairingCode}</h2>
        <p>Время создания: ${latestPairingTime}</p>
        <p>
          Вводи код сразу:
          <br />
          <b>WhatsApp Business → Связанные устройства → Привязать устройство → Связать по номеру телефона</b>
        </p>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROUP_NAME = process.env.GROUP_NAME || "";
let GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
const AIKA_PHONE_NUMBER = process.env.AIKA_PHONE_NUMBER || "";
const LOGIN_METHOD = process.env.LOGIN_METHOD || "qr";

// Если в Render стоит старая модель 1.5, автоматически меняем на новую
if (GEMINI_MODEL.includes("1.5")) {
  GEMINI_MODEL = "gemini-2.5-flash";
}

if (!GEMINI_API_KEY) {
  console.error("Ошибка: не найден GEMINI_API_KEY");
  process.exit(1);
}

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});

const intimateWarnings = new Map();
const mutedUsers = new Map();

const WARNING_RESET_MS = 24 * 60 * 60 * 1000;
const MUTE_TIME_MS = 30 * 60 * 1000;

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
- можешь немного подшучивать;
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
    const prompt = `
Участник группы "${userName}" написал:
"${userText}"

Ответь как Айка.
`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        systemInstruction: AIKA_CHARACTER,
        temperature: 0.8,
        maxOutputTokens: 250
      }
    });

    const text = response.text;

    return text || "Я задумалась 😅 Напиши ещё раз.";
  } catch (error) {
    console.error("Gemini error name:", error?.name);
    console.error("Gemini error message:", error?.message);
    console.error("Gemini error status:", error?.status);
    console.error("Full Gemini error:", error);

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
      latestQrImage = await QRCode.toDataURL(qr);
      latestQrTime = new Date().toLocaleString("ru-RU");

      console.log("QR-код готов. Открой страницу /qr");
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (
      LOGIN_METHOD === "code" &&
      !sock.authState.creds.registered &&
      AIKA_PHONE_NUMBER &&
      !pairingRequested &&
      (connection === "connecting" || qr)
    ) {
      pairingRequested = true;

      try {
        const cleanNumber = AIKA_PHONE_NUMBER.replace(/\D/g, "");
        const code = await sock.requestPairingCode(cleanNumber);

        latestPairingCode = code;
        latestPairingTime = new Date().toLocaleString("ru-RU");

        console.log("======================================");
        console.log("КОД ДЛЯ ВХОДА WHATSAPP:");
        console.log(code);
        console.log("Открой страницу /code, чтобы увидеть код крупно.");
        console.log("======================================");
      } catch (error) {
        console.error("Ошибка получения pairing code:", error);
        pairingRequested = false;
      }
    }

    if (connection === "open") {
      console.log("Айка подключилась к WhatsApp 💬");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log("Соединение закрыто. Переподключение:", shouldReconnect);

      if (shouldReconnect) {
        pairingRequested = false;
        latestQrImage = "";
        latestQrTime = "";
        startBot();
      } else {
        console.log("Айка вышла из аккаунта. Нужно заново привязать устройство.");
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
        console.log(`Сообщение из другой группы: ${groupInfo.subject}`);
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
