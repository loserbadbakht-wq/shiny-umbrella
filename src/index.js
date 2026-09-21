// src/index.js
// Regular Telegram bot (chat member). Replies with a button; the button
// opens inline mode prefilled with a short id. The user sends the final post.

// ---------- Config ----------
const LINK_TEXT = 'Thing';
const LINK_URL  = 'https://t.me/thing';
const ID_RE     = /^[0-9a-f]{12}$/;

let botUsernameCache = null;

// ---------- Helpers ----------
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatPost(sourceText) {
  const blocks = sourceText
    .split(/\n\s*\n/)
    .map(b => b.trim())
    .filter(Boolean);
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

// ---------- Source extraction ----------
function extractSource(msg) {
  if (msg.reply_to_message) {
    return msg.reply_to_message.text || msg.reply_to_message.caption || '';
  }
  return (msg.text || msg.caption || '').replace(/@\w+/g, '').trim();
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

// ---------- Message handler ----------
async function handleMessage(update, env) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const isPrivate = msg.chat.type === 'private';

  // In private chat, ignore /start and other commands unless followed by text
  const text = msg.text || msg.caption || '';

  if (isPrivate && /^\/start\b/.test(text)) {
    return tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text:
        '👋 Send me a message like:\n\n' +
        '<code>تیتر\n\nمتن</code>\n\n' +
        'Or reply to any message with that format and mention me in a group. ' +
        'I will give you a button to compose the formatted post.',
      parse_mode: 'HTML',
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

  // Store the source text under a short id, so the button query stays short.
  const id = makeShortId();
  if (env.POSTS && typeof env.POSTS.put === 'function') {
    await env.POSTS.put(id, sourceText, { expirationTtl: 3600 });
  } else {
    console.warn('POSTS KV binding missing — falling back to raw text (256 char limit).');
    return tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: '⚠️ Bot is misconfigured: missing POSTS KV binding.',
      reply_parameters: { message_id: msg.message_id },
    });
  }

  return tg(env, 'sendMessage', {
    chat_id: msg.chat.id,
    text: '📝 Tap the button below to compose the formatted post.',
    reply_parameters: { message_id: msg.message_id },
    reply_markup: {
      inline_keyboard: [[
        {
          text: '✍️ Send formatted message',
          switch_inline_query_current_chat: id,
        },
      ]],
    },
  });
}

// ---------- Inline handler ----------
async function handleInline(update, env) {
  const q = update.inline_query;
  if (!q) return;

  const query = (q.query || '').trim();
  let sourceText = query;

  // If the query is a short id we stored, resolve the original text.
  if (env.POSTS && typeof env.POSTS.get === 'function' && ID_RE.test(query)) {
    const stored = await env.POSTS.get(query);
    if (stored) sourceText = stored;
  }

  const results = [];
  if (sourceText) {
    const formatted = formatPost(sourceText);
    if (formatted) {
      results.push({
        type: 'article',
        id: `post-${Date.now()}`,
        title: 'Formatted post',
        description: sourceText.slice(0, 80),
        input_message_content: {
          message_text: formatted,
          parse_mode: 'HTML',
        },
      });
    }
  }

  return tg(env, 'answerInlineQuery', {
    inline_query_id: q.id,
    results,
    cache_time: 0,
    is_personal: true,
  });
}

// ---------- Worker ----------
export default {
  async fetch(request, env, ctx) {
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
        } else if (update.inline_query) {
          await handleInline(update, env);
        }
      } catch (e) {
        console.error('handler error:', e && e.stack || e);
      }
      return new Response('OK', { status: 200 });
    }
    return new Response('Not Found', { status: 404 });
  },
};
