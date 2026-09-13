// ============================================================
// Telegram RSS Bot for SubsPlease – Cloudflare Worker
// ============================================================

const RSS_URL = 'https://subsplease.org/rss/?t&r=1080';
const TELEGRAM_API = 'https://api.telegram.org/bot';

// ---------- Helpers ----------

/**
 * Fetch the latest RSS item title.
 */
async function fetchLatestTitle() {
  const res = await fetch(RSS_URL);
  const xml = await res.text();
  // Simple regex to grab the first <item>…<title>…</title>
  const match = xml.match(/<item>[\s\S]*?<title>(.*?)<\/title>/i);
  if (!match) return null;
  // Decode HTML entities (basic)
  return match[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Transform a SubsPlease filename to a user‑friendly message.
 * @param {string} rawTitle - e.g. "[SubsPlease] Azur Lane - Bisoku Zenshin! S2 - 11 (1080p) [1C413FA9].mkv"
 * @param {string} lang - 'en' or 'fa'
 * @returns {string}
 */
function formatTitle(rawTitle, lang = 'en') {
  // 1. Remove the "[SubsPlease] " prefix
  let title = rawTitle.replace(/^\[SubsPlease\]\s*/i, '');
  // 2. Remove the file extension .mkv (and anything after the last dot)
  title = title.replace(/\.\w+$/, '');
  // 3. Remove the CRC hash in square brackets, e.g. [1C413FA9]
  title = title.replace(/\s*\[[A-F0-9]{8}\]$/, '');
  // 4. Remove the resolution marker, e.g. (1080p) or (720p)
  title = title.replace(/\s*\(\d{3,4}p\)$/, '');
  // 5. Trim any leftover whitespace
  title = title.trim();

  // 6. Append the language‑specific suffix
  if (lang === 'fa') {
    return `انیمه ${title} اومد!`;
  }
  return `${title} Aired!`;
}

/**
 * Send a message via the Telegram Bot API.
 */
async function sendMessage(env, chatId, text, extra = {}) {
  const url = `${TELEGRAM_API}${env.BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    ...extra,
  };
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/**
 * Edit an existing message (used for language selection).
 */
async function editMessage(env, chatId, messageId, text, extra = {}) {
  const url = `${TELEGRAM_API}${env.BOT_TOKEN}/editMessageText`;
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: 'HTML',
    ...extra,
  };
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/**
 * Answer a callback query (to remove the loading spinner).
 */
async function answerCallback(env, callbackQueryId) {
  return fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

// ---------- KV Helpers ----------

/**
 * Get the language for a chat from KV. Defaults to English ('en').
 */
async function getLang(env, chatId) {
  const lang = await env.RSS_BOT_KV.get(`lang:${chatId}`);
  return lang || 'en';
}

/**
 * Set the language for a chat in KV.
 */
async function setLang(env, chatId, lang) {
  await env.RSS_BOT_KV.put(`lang:${chatId}`, lang);
}

/**
 * Register a chat (private, group, or channel) to receive broadcasts.
 * We store a set of chat IDs under the key "broadcast_chats".
 */
async function addChatToBroadcast(env, chatId) {
  const raw = await env.RSS_BOT_KV.get('broadcast_chats');
  const chats = raw ? JSON.parse(raw) : [];
  if (!chats.includes(chatId)) {
    chats.push(chatId);
    await env.RSS_BOT_KV.put('broadcast_chats', JSON.stringify(chats));
  }
}

/**
 * Remove a chat from broadcast list.
 */
async function removeChatFromBroadcast(env, chatId) {
  const raw = await env.RSS_BOT_KV.get('broadcast_chats');
  if (!raw) return;
  const chats = JSON.parse(raw).filter((id) => id !== chatId);
  await env.RSS_BOT_KV.put('broadcast_chats', JSON.stringify(chats));
}

/**
 * Get all registered broadcast chat IDs.
 */
async function getBroadcastChats(env) {
  const raw = await env.RSS_BOT_KV.get('broadcast_chats');
  return raw ? JSON.parse(raw) : [];
}

// ---------- Command Handlers ----------

/**
 * /start – welcome message.
 */
async function handleStart(env, chatId) {
  const lang = await getLang(env, chatId);
  const text =
    lang === 'fa'
      ? 'سلام! من ربات اطلاع‌رسانی انیمه هستم.\nبرای تغییر زبان از /language استفاده کنید.'
      : 'Hi! I am an anime release notification bot.\nUse /language to change the language.';
  await sendMessage(env, chatId, text);
  await addChatToBroadcast(env, chatId);
}

/**
 * /language – show inline keyboard with Persian and English buttons.
 */
async function handleLanguage(env, chatId) {
  const keyboard = {
    inline_keyboard: [
      [
        { text: 'فارسی🇮🇷', callback_data: 'lang:fa' },
        { text: '🇬🇧English', callback_data: 'lang:en' },
      ],
    ],
  };
  await sendMessage(env, chatId, '🌐 Choose your language:', {
    reply_markup: keyboard,
  });
}

/**
 * Handle callback queries (button presses).
 */
async function handleCallbackQuery(env, callbackQuery) {
  const { id, data, message } = callbackQuery;
  const chatId = message.chat.id;
  const messageId = message.message_id;

  if (data.startsWith('lang:')) {
    const lang = data.split(':')[1];
    await setLang(env, chatId, lang);
    const confirmText =
      lang === 'fa'
        ? '✅ زبان به فارسی تغییر کرد.'
        : '✅ Language changed to English.';
    await editMessage(env, chatId, messageId, confirmText);
    await answerCallback(env, id);
  }
}

// ---------- RSS Broadcast ----------

/**
 * Fetch the latest RSS title and broadcast it to all registered chats.
 * Each chat receives the message in its own preferred language.
 */
async function broadcastLatest(env) {
  const rawTitle = await fetchLatestTitle();
  if (!rawTitle) {
    console.error('No title found in RSS feed.');
    return;
  }

  const chats = await getBroadcastChats(env);
  if (chats.length === 0) return;

  // We need to send a personalised message per chat because language differs.
  for (const chatId of chats) {
    try {
      const lang = await getLang(env, chatId);
      const text = formatTitle(rawTitle, lang);
      await sendMessage(env, chatId, text);
    } catch (err) {
      console.error(`Failed to send to ${chatId}:`, err);
      // If the chat is blocked / kicked, remove it from the list.
      if (
        err.message &&
        (err.message.includes('blocked') ||
          err.message.includes('chat not found') ||
          err.message.includes('kicked'))
      ) {
        await removeChatFromBroadcast(env, chatId);
      }
    }
  }
}

// ---------- Webhook Entry Point ----------

export default {
  /**
   * HTTP fetch handler – receives Telegram updates.
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health‑check endpoint
    if (request.method === 'GET') {
      return new Response('OK', { status: 200 });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // ----- Handle messages -----
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const text = msg.text || '';

      // Register every chat that sends a message (so it receives broadcasts)
      await addChatToBroadcast(env, chatId);

      // /start
      if (text.startsWith('/start')) {
        await handleStart(env, chatId);
      }
      // /language
      else if (text.startsWith('/language')) {
        await handleLanguage(env, chatId);
      }
      // Ignore other messages
    }

    // ----- Handle callback queries (inline buttons) -----
    if (update.callback_query) {
      await handleCallbackQuery(env, update.callback_query);
    }

    // Always return 200 so Telegram doesn’t retry.
    return new Response('OK', { status: 200 });
  },

  /**
   * Scheduled event – runs on the Cron Trigger defined in wrangler.toml.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(broadcastLatest(env));
  },
};
