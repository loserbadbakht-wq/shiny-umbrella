// src/index.js
// Stateless Telegram bot — HTML → Rich Message (Bot API 10.1+)
// No KV, no cache, no IDs, no storage of any kind.

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

// ---------- Send a Rich Message as a reply ----------
async function replyWithRichMessage(message, env) {
  const text = message.text || message.caption;
  if (!text) return;

  await tg(env, 'sendRichMessage', {
    chat_id: message.chat.id,
    rich_message: { html: text },
    reply_parameters: { message_id: message.message_id },
  });
}

// ---------- Worker ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('✅ Rich Message Bot is running.', { status: 200 });
    }

    if (request.method === 'POST' && url.pathname === '/webhook') {
      let update;
      try { update = await request.json(); }
      catch { return new Response('Bad JSON', { status: 400 }); }

      try {
        const msg = update.message || update.edited_message;
        if (msg) await replyWithRichMessage(msg, env);
      } catch (e) {
        console.error('handleUpdate error:', e && e.stack || e);
      }
      return new Response('OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  },
};
