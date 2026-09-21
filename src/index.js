// src/index.js
// Regular Telegram bot using a REPLY KEYBOARD button.
// User taps the button -> user sends a hidden token -> bot posts the
// formatted message itself. No "via @bot" tag (that only applies to inline mode).

const LINK_TEXT   = 'Thing';
const LINK_URL    = 'https://t.me/thing';
const ID_RE       = /^[0-9a-f]{12}$/;
const SEND_PREFIX = '✅ send ';

let botUsernameCache = null;

// ---------- Helpers ----------
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatPost(sourceText) {
  const blocks = sourceText.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  if (!blocks.length) return null;
  const title = blocks[0];
  const body  = blocks.slice(1).join('\n\n');
  const parts = [`🟦<b>${escapeHtml(title)}</b>`];
  if (body) parts.push(escapeHtml(body));
  parts.push(`🔹<a href="${LINK_URL}">${escapeHtml(LINK_TEXT)}</a>`);
  return parts.join('\n\n');
}

function makeShortId() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return [...a].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const txt = await res.text();
  if (!res.ok) console.error(`Telegram ${method} ${res.status}: ${txt}`);
  try { return JSON.parse(txt); } catch { return { ok: false, raw: txt }; }
}

async function getBotUsername(env) {
  if (botUsernameCache) return botUsernameCache;
  const r = await tg(env, 'getMe', {});
  if (r && r.ok) botUsernameCache = r.result.username;
  return botUsernameCache;
}

function isBotMentioned(msg, botUsername) {
  const ents = msg.entities || msg.caption_entities || [];
  for (const e of ents) {
    if (e.type === 'mention') {
      const t = (msg.text || msg.caption || '').substr(e.offset, e.length);
      if (!botUsername || t.toLowerCase() === `@${botUsername.toLowerCase()}`) return true;
    } else if (e.type === 'text_mention') {
      if (!botUsername ||
          (e.user && e.user.username &&
           e.user.username.toLowerCase() === botUsername.toLowerCase())) return true;
    }
  }
  return false;
}

function extractSource(msg) {
  if (msg.reply_to_message) {
    return msg.reply_to_message.text || msg.reply_to_message.caption || '';
  }
  return (msg.text || msg.caption || '').replace(/@\w+/g, '').trim();
}

function extractReplyTarget(msg) {
  const r = msg.reply_to_message;
  if (!r) return null;
  const hasMedia = r.photo || r.video || r.animation ||
                   r.document || r.audio || r.voice;
  return hasMedia ? { chat_id: r.chat.id, message_id: r.message_id } : null;
}

// ---------- Step 4: handle the user's "✅ send <id>" message ----------
async function handleSendToken(env, msg, id) {
  const stored = await env.POSTS.get(id);
  if (!stored) {
    return tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: '⚠️ This request has expired. Please reply to the original message and mention me again.',
      reply_markup: { remove_keyboard: true },
    });
  }

  let data;
  try { data = JSON.parse(stored); } catch { data = { text: stored }; }

  const formatted = formatPost(data.text || '');
  if (!formatted) {
    return tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: '⚠️ Nothing to format.',
      reply_markup: { remove_keyboard: true },
    });
  }

  if (data.media) {
    const caption = formatted.length > 1024
      ? formatted.slice(0, 1021) + '…'
      : formatted;
    await tg(env, 'copyMessage', {
      chat_id: msg.chat.id,
      from_chat_id: data.media.chat_id,
      message_id: data.media.message_id,
      caption,
      parse_mode: 'HTML',
      reply_markup: { remove_keyboard: true },
    });
  } else {
    await tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: formatted,
      parse_mode: 'HTML',
      reply_markup: { remove_keyboard: true },
    });
  }

  try { await env.POSTS.delete(id); } catch {}
}

// ---------- Main message handler ----------
async function handleMessage(update, env) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const text = msg.text || msg.caption || '';

  // 1) Did the user tap our reply-keyboard button?
  if (text.startsWith(SEND_PREFIX)) {
    const id = text.slice(SEND_PREFIX.length).trim();
    if (ID_RE.test(id)) return handleSendToken(env, msg, id);
  }

  const isPrivate = msg.chat.type === 'private';

  if (isPrivate && /^\/start\b/.test(text)) {
    return tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text:
        '👋 Send me a message like:\n\n' +
        '<code>تیتر\n\nمتن</code>\n\n' +
        'Or reply to any message with that format (media allowed) and mention me in a group.',
      parse_mode: 'HTML',
      reply_markup: { remove_keyboard: true },
    });
  }

  const botUsername = await getBotUsername(env);
  const mentioned = isBotMentioned(msg, botUsername);
  if (!isPrivate && !mentioned) return;

  const sourceText = extractSource(msg);
  if (!sourceText) {
    return tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: '⚠️ Reply to a message containing a title and a body, then mention me.',
      reply_parameters: { message_id: msg.message_id },
    });
  }

  // 2) Store the source and reply with a reply-keyboard button.
  const id = makeShortId();
  await env.POSTS.put(
    id,
    JSON.stringify({ text: sourceText, media: extractReplyTarget(msg) }),
    { expirationTtl: 3600 },
  );

  return tg(env, 'sendMessage', {
    chat_id: msg.chat.id,
    text: '📝 Press the button below to send the formatted message.',
    reply_parameters: { message_id: msg.message_id },
    reply_markup: {
      keyboard: [[{ text: `${SEND_PREFIX}${id}` }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

// ---------- Worker ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('✅ Bot is running.', { status: 200 });
    }
    if (request.method === 'POST' && url.pathname === '/webhook') {
      let update;
      try { update = await request.json(); }
      catch { return new Response('Bad JSON', { status: 400 }); }

      try {
        if (update.message || update.edited_message) {
          await handleMessage(update, env);
        }
      } catch (e) {
        console.error('handler error:', e && e.stack || e);
      }
      return new Response('OK', { status: 200 });
    }
    return new Response('Not Found', { status: 404 });
  },
};
