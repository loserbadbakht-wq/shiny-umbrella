// ============================================================
// Telegram RSS Bot for SubsPlease – Cloudflare Worker
// Persian-only, no language switching
// ============================================================

const RSS_URL = 'https://subsplease.org/rss/?t&r=1080';
const TELEGRAM_API = 'https://api.telegram.org/bot';

// ---------- Helpers ----------

async function fetchLatestTitle() {
  const res = await fetch(RSS_URL);
  const xml = await res.text();
  const match = xml.match(/<item>[\s\S]*?<title>(.*?)<\/title>/i);
  if (!match) return null;
  return match[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Transform a SubsPlease filename into a Persian message.
 * e.g. "[SubsPlease] Azur Lane - Bisoku Zenshin! S2 - 11 (1080p) [1C413FA9].mkv"
 *   -> "انیمه Azur Lane - Bisoku Zenshin! S2 - 11 اومد!"
 */
function formatTitle(rawTitle) {
  let title = rawTitle.replace(/^\[SubsPlease\]\s*/i, '');
  title = title.replace(/\.\w+$/, '');                    // remove .mkv
  title = title.replace(/\s*\[[A-F0-9]{8}\]$/, '');       // remove [CRC32]
  title = title.replace(/\s*\(\d{3,4}p\)$/, '');          // remove (1080p)
  title = title.trim();
  return `انیمه ${title} اومد!`;
}

async function sendMessage(env, chatId, text, extra = {}) {
  const url = `${TELEGRAM_API}${env.BOT_TOKEN}/sendMessage`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...extra,
    }),
  });
}

// ---------- KV Helpers (broadcast chat list only) ----------

async function addChatToBroadcast(env, chatId) {
  const raw = await env.RSS_BOT_KV.get('broadcast_chats');
  const chats = raw ? JSON.parse(raw) : [];
  if (!chats.includes(chatId)) {
    chats.push(chatId);
    await env.RSS_BOT_KV.put('broadcast_chats', JSON.stringify(chats));
  }
}

async function removeChatFromBroadcast(env, chatId) {
  const raw = await env.RSS_BOT_KV.get('broadcast_chats');
  if (!raw) return;
  const chats = JSON.parse(raw).filter((id) => id !== chatId);
  await env.RSS_BOT_KV.put('broadcast_chats', JSON.stringify(chats));
}

async function getBroadcastChats(env) {
  const raw = await env.RSS_BOT_KV.get('broadcast_chats');
  return raw ? JSON.parse(raw) : [];
}

// ---------- Command Handler ----------

async function handleStart(env, chatId) {
  await sendMessage(
    env,
    chatId,
    'سلام! من ربات اطلاع‌رسانی انیمه هستم.\nاز این به بعد قسمت‌های جدید انیمه رو براتون می‌فرستم.'
  );
  await addChatToBroadcast(env, chatId);
}

// ---------- RSS Broadcast ----------

async function broadcastLatest(env) {
  const rawTitle = await fetchLatestTitle();
  if (!rawTitle) {
    console.error('No title found in RSS feed.');
    return;
  }

  const chats = await getBroadcastChats(env);
  if (chats.length === 0) return;

  const text = formatTitle(rawTitle);

  for (const chatId of chats) {
    try {
      await sendMessage(env, chatId, text);
    } catch (err) {
      console.error(`Failed to send to ${chatId}:`, err);
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
  async fetch(request, env, ctx) {
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

    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const text = msg.text || '';

      // Register the chat so it receives broadcasts.
      await addChatToBroadcast(env, chatId);

      if (text.startsWith('/start')) {
        await handleStart(env, chatId);
      }
      // No /language command anymore.
    }

    return new Response('OK', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(broadcastLatest(env));
  },
};
