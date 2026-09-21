// src/index.js
// Telegram GUEST BOT — replies with a button; the button opens inline mode
// prefilled with the source text, and the USER sends the formatted post.

// ---------- Config ----------
const LINK_TEXT = 'Thing';
const LINK_URL  = 'https://t.me/thing';

// ---------- HTML escape ----------
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------- Format: "title\n\nbody" -> HTML post ----------
function formatPost(sourceText) {
  const blocks = sourceText
    .split(/\n\s*\n/)
    .map(b => b.trim())
    .filter(Boolean);

  if (blocks.length === 0) return null;

  const title = blocks[0];
  const body  = blocks.slice(1).join('\n\n');

  const parts = [`🟦<b>${escapeHtml(title)}</b>`];
  if (body) parts.push(escapeHtml(body));
  parts.push(`🔹<a href="${LINK_URL}">${escapeHtml(LINK_TEXT)}</a>`);

  return parts.join('\n\n');
}

// ---------- Telegram helper ----------
async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const txt = await res.text();
  if (!res.ok) console.error(`Telegram ${method} failed: ${res.status} ${txt}`);
  try { return JSON.parse(txt); } catch { return { ok: false, raw: txt }; }
}

// ---------- Extract source text from a guest_message ----------
function extractSource(msg) {
  const triggeringText = msg.text || msg.caption || '';
  const replied = msg.reply_to_message;
  return replied
    ? (replied.text || replied.caption || '')
    : triggeringText.replace(/@\w+/g, '').trim();
}

// ---------- Guest handler: just show a button ----------
async function handleGuestMessage(update, env) {
  const msg = update.guest_message;
  if (!msg) return;

  const guestQueryId = msg.guest_query_id;
  if (!guestQueryId) {
    console.error('guest_message without guest_query_id:', JSON.stringify(msg));
    return;
  }

  const sourceText = extractSource(msg);
  if (!sourceText) {
    return answerGuest(env, guestQueryId, {
      message_text: '⚠️ Reply to a message with a title and a body, then @mention me.',
    });
  }

  // The card the user will send: a short prompt with a button attached.
  // Pressing the button opens inline mode in this chat, prefilled with sourceText.
  return answerGuest(env, guestQueryId, {
    message_text: '📝 Tap the button below to compose the formatted post.',
    reply_markup: {
      inline_keyboard: [[
        {
          text: '✍️ Send formatted message',
          switch_inline_query_current_chat: sourceText,
        },
      ]],
    },
  });
}

// ---------- Inline handler: produce the formatted post for the user to send ----------
async function handleInlineQuery(update, env) {
  const q = update.inline_query;
  if (!q) return;

  const sourceText = (q.query || '').trim();

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

// ---------- Guest reply wrapper ----------
async function answerGuest(env, guestQueryId, input_message_content) {
  const inlineResult = {
    type: 'article',
    id: `guest-${Date.now()}`,
    title: 'Compose formatted post',
    input_message_content,
  };
  return tg(env, 'answerGuestQuery', {
    guest_query_id: String(guestQueryId),
    result: inlineResult,
  });
}

// ---------- Worker ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('✅ Guest Bot is running.', { status: 200 });
    }
    if (request.method === 'POST' && url.pathname === '/webhook') {
      let update;
      try { update = await request.json(); }
      catch { return new Response('Bad JSON', { status: 400 }); }

      try {
        if (update.guest_message) {
          await handleGuestMessage(update, env);
        } else if (update.inline_query) {
          await handleInlineQuery(update, env);
        }
      } catch (e) {
        console.error('handler error:', e && e.stack || e);
      }
      return new Response('OK', { status: 200 });
    }
    return new Response('Not Found', { status: 404 });
  },
};
