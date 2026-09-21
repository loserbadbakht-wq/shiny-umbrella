// src/index.js
// Telegram GUEST BOT — formats "title \n\n body" into a stylized post

// ---------- Config ----------
const LINK_TEXT = 'Thing';                 // <-- text of the footer link
const LINK_URL  = 'https://t.me/thing';    // <-- target of the footer link

// ---------- HTML escape (so user input can't break parse_mode) ----------
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------- Format: "title\n\nbody" -> HTML post ----------
function formatPost(sourceText) {
  const blocks = sourceText
    .split(/\n\s*\n/)          // split on blank lines
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

// ---------- Guest handler ----------
async function handleGuestMessage(update, env) {
  const msg = update.guest_message;
  if (!msg) return;

  const guestQueryId = msg.guest_query_id;
  if (!guestQueryId) {
    console.error('guest_message without guest_query_id:', JSON.stringify(msg));
    return;
  }

  const triggeringText = msg.text || msg.caption || '';
  const replied = msg.reply_to_message;
  const sourceText = replied
    ? (replied.text || replied.caption || '')
    : triggeringText.replace(/@\w+/g, '').trim();

  if (!sourceText) {
    return answerGuest(
      env, guestQueryId,
      '⚠️ Reply to a message containing a title and body (or send them with the @mention).'
    );
  }

  const formatted = formatPost(sourceText);
  if (!formatted) {
    return answerGuest(env, guestQueryId, '⚠️ Nothing to format.');
  }

  return answerGuest(env, guestQueryId, formatted, 'HTML');
}

// ---------- Guest reply wrapper ----------
async function answerGuest(env, guestQueryId, messageText, parseMode) {
  const inlineResult = {
    type: 'article',
    id: `guest-${Date.now()}`,
    title: 'Formatted post',
    input_message_content: {
      message_text: messageText,
      ...(parseMode ? { parse_mode: parseMode } : {}),
    },
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

      try { await handleGuestMessage(update, env); }
      catch (e) { console.error('handleGuestMessage error:', e && e.stack || e); }
      return new Response('OK', { status: 200 });
    }
    return new Response('Not Found', { status: 404 });
  },
};
