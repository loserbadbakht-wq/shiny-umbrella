// Cloudflare Worker for Telegram bot
// Env vars: BOT_TWO_TOKEN, DB_ENCRYPTION_KEY (set via wrangler --var)
// KV binding: TAG_LIST

const TELEGRAM_API = 'https://api.telegram.org';

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('OK');
    }

    const payload = await request.json();

    if (payload.message) {
      await handleMessage(payload.message, env);
    } else if (payload.callback_query) {
      await handleCallbackQuery(payload.callback_query, env);
    }

    return new Response('OK');
  },
};

// ---------- Encryption ----------
function encryptData(data, key) {
  const jsonStr = JSON.stringify(data);
  const encoder = new TextEncoder();
  const plaintext = encoder.encode(jsonStr);
  const keyBytes = encoder.encode(key.padEnd(32, '0').slice(0, 32));
  const encrypted = new Uint8Array(plaintext.length);
  for (let i = 0; i < plaintext.length; i++) {
    encrypted[i] = plaintext[i] ^ keyBytes[i % keyBytes.length];
  }
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < encrypted.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      encrypted.subarray(i, i + CHUNK)
    );
  }
  return btoa(binary);
}

function decryptData(encryptedStr, key) {
  const encrypted = Uint8Array.from(atob(encryptedStr), (c) =>
    c.charCodeAt(0)
  );
  const keyBytes = new TextEncoder().encode(
    key.padEnd(32, '0').slice(0, 32)
  );
  const decrypted = new Uint8Array(encrypted.length);
  for (let i = 0; i < encrypted.length; i++) {
    decrypted[i] = encrypted[i] ^ keyBytes[i % keyBytes.length];
  }
  return JSON.parse(new TextDecoder().decode(decrypted));
}

function htmlEsc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c])
  );
}

// ---------- KV helpers (per-chat) ----------
function chatKey(chatId) {
  return `taglist:${chatId}`;
}

async function getTagList(env, chatId) {
  const raw = await env.TAG_LIST.get(chatKey(chatId));
  if (!raw) return [];
  try {
    return decryptData(raw, env.DB_ENCRYPTION_KEY);
  } catch {
    return [];
  }
}

async function saveTagList(env, chatId, users) {
  const encrypted = encryptData(users, env.DB_ENCRYPTION_KEY);
  await env.TAG_LIST.put(chatKey(chatId), encrypted);
  return users;
}

async function addToTagList(env, chatId, user) {
  const users = await getTagList(env, chatId);
  if (!users.find((u) => u.id === user.id)) {
    users.push({ id: user.id, name: user.name });
    await saveTagList(env, chatId, users);
  }
  return users;
}

// ---------- Message handling ----------
async function handleMessage(message, env) {
  const text = message.text || '';
  const chatId = message.chat.id;

  // ---- /paye ----
  if (text.startsWith('/paye')) {
    const gameName = text.slice('/paye'.length).trim();

    if (!gameName) {
      await sendMessage(
        env,
        chatId,
        'لطفاً نام بازی را بعد از /paye بنویسید. مثال: /paye فوتبال'
      );
      return;
    }

    const inlineKeyboard = {
      inline_keyboard: [[{ text: 'پایه هستم', callback_data: 'paye' }]],
    };

    await sendMessage(env, chatId, `کیا پایه ${gameName} هستن؟`, inlineKeyboard);
    return;
  }

  // ---- /taglist (must be checked before /tag) ----
  if (text.startsWith('/taglist')) {
    const users = await getTagList(env, chatId);
    const listText = users.map((u) => u.name).join('\n');
    const fullText =
      'کیا پایه اومدن به لیست تگ هستن؟' + (listText ? '\n' + listText : '');

    const inlineKeyboard = {
      inline_keyboard: [
        [{ text: 'پیوستن به لیست تگ', callback_data: 'taglist_join' }],
      ],
    };

    await sendMessage(env, chatId, fullText, inlineKeyboard);
    return;
  }

  // ---- /tag ----
  if (text.startsWith('/tag')) {
    const users = await getTagList(env, chatId);

    if (!users.length) {
      await sendMessage(env, chatId, 'لیست تگ خالیه!');
      return;
    }

    const mentionText = users
      .map((u) => `<a href="tg://user?id=${u.id}">${htmlEsc(u.name)}</a>`)
      .join('\n');

    await sendMessage(env, chatId, mentionText, null, 'HTML');
    return;
  }
}

async function handleCallbackQuery(callbackQuery, env) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const user = callbackQuery.from;
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ');

  await answerCallbackQuery(env, callbackQuery.id);

  // ---- /paye button ----
  if (callbackQuery.data === 'paye') {
    let currentText = callbackQuery.message.text || '';
    const userLine = `کاربر ${fullName} پایه هست!🐧`;

    if (!currentText.includes(userLine)) {
      currentText += '\n' + userLine;
    }

    const inlineKeyboard = {
      inline_keyboard: [[{ text: 'پایه هستم', callback_data: 'paye' }]],
    };

    await editMessageText(env, chatId, messageId, currentText, inlineKeyboard);
    return;
  }

  // ---- /taglist join button ----
  if (callbackQuery.data === 'taglist_join') {
    const users = await addToTagList(env, chatId, { id: user.id, name: fullName });
    const listText = users.map((u) => u.name).join('\n');
    const fullText =
      'کیا پایه اومدن به لیست تگ هستن؟' + (listText ? '\n' + listText : '');

    const inlineKeyboard = {
      inline_keyboard: [
        [{ text: 'پیوستن به لیست تگ', callback_data: 'taglist_join' }],
      ],
    };

    await editMessageText(env, chatId, messageId, fullText, inlineKeyboard);
    return;
  }
}

// ---------- Telegram helpers ----------
async function sendMessage(env, chatId, text, replyMarkup, parseMode) {
  const token = env.BOT_TWO_TOKEN;
  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  const body = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  if (parseMode) body.parse_mode = parseMode;

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function editMessageText(env, chatId, messageId, text, replyMarkup, parseMode) {
  const token = env.BOT_TWO_TOKEN;
  const url = `${TELEGRAM_API}/bot${token}/editMessageText`;
  const body = { chat_id: chatId, message_id: messageId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  if (parseMode) body.parse_mode = parseMode;

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function answerCallbackQuery(env, callbackQueryId) {
  const token = env.BOT_TWO_TOKEN;
  const url = `${TELEGRAM_API}/bot${token}/answerCallbackQuery`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
        }
