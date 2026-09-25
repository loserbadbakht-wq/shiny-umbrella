// src/index.js
// Stateless Telegram bot — HTML → Rich Message (Bot API 10.1+)
// If the user replies to a message with @bot, the bot converts THAT message
// and attaches its rich reply to it (not to the @bot mention).

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

// ---------- Cache bot identity (once per Worker isolate) ----------
let BOT_INFO = null;
async function getBotInfo(env) {
  if (BOT_INFO) return BOT_INFO;
  const r = await tg(env, 'getMe', {});
  BOT_INFO = r?.result || {};
  return BOT_INFO;
}

// ---------- Strip the bot's own @mention ----------
function stripBotMention(text, username) {
  if (!text) return '';
  if (!username) return text.trim();
  const esc = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`@${esc}\\b`, 'gi');
  return text.replace(re, '').trim();
}

// ---------- Detect /debug ----------
function isDebugCommand(message, username) {
  const raw = (message.text || message.caption || '').trim();
  if (!raw) return false;
  const esc = username ? username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null;
  const re = esc ? new RegExp(`^/debug(@${esc})?\\b`, 'i') : /^\/debug\b/i;
  return re.test(raw);
}

// ---------- Resolve HTML source AND which message to reply to ----------
// Returns { html, replyToMessageId }
// - If the user replied to another message → use that message's text as HTML,
//   and attach the bot's rich reply to THAT message.
// - Otherwise → use the user's own text (mention stripped),
//   and attach the reply to the user's message.
function resolveTarget(message, username) {
  const incoming = message.text || message.caption || '';
  const replied = message.reply_to_message;

  if (replied) {
    const repliedText = replied.text || replied.caption || '';
    if (repliedText.trim()) {
      const extra = stripBotMention(incoming, username);
      return {
        html: extra ? `${repliedText}\n\n${extra}` : repliedText,
        replyToMessageId: replied.message_id,
      };
    }
  }

  return {
    html: stripBotMention(incoming, username),
    replyToMessageId: message.message_id,
  };
}

// ---------- Truncate / escape helpers ----------
function clip(s, n = 800) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n…[+${s.length - n} more chars]` : s;
}
function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------- /debug ----------
async function handleDebug(message, env, update) {
  const bot = await getBotInfo(env);
  const username = bot.username || '';
  const target = resolveTarget(message, username);

  const probe = await tg(env, 'sendRichMessage', {
    chat_id: message.chat.id,
    rich_message: { html: target.html || '<b>debug</b>' },
    reply_parameters: { message_id: target.replyToMessageId },
  });

  const lines = [
    '<b>🛠 /debug</b>',
    '',
    '<b>Bot</b>',
    `id: <code>${htmlEscape(bot.id)}</code>`,
    `username: <code>@${htmlEscape(username)}</code>`,
    `supports_inline_queries: ${bot.supports_inline_queries}`,
    '',
    '<b>Chat</b>',
    `id: <code>${htmlEscape(message.chat.id)}</code>`,
    `type: <code>${htmlEscape(message.chat.type)}</code>`,
    '',
    '<b>Incoming message</b>',
    `message_id: <code>${htmlEscape(message.message_id)}</code>`,
    `has_reply: ${!!message.reply_to_message}`,
    `replied_to_id: <code>${htmlEscape(message.reply_to_message?.message_id ?? '—')}</code>`,
    '',
    '<b>Target</b>',
    `reply_to_message_id: <code>${htmlEscape(target.replyToMessageId)}</code>`,
    `html_length: ${target.html.length}`,
    `<pre>${htmlEscape(clip(target.html))}</pre>`,
    '',
    '<b>sendRichMessage probe</b>',
    probe.ok
      ? `✅ ok — reply message_id: <code>${htmlEscape(probe.result?.message_id)}</code>`
      : `❌ failed\n<pre>${htmlEscape(clip(JSON.stringify(probe), 600))}</pre>`,
    '',
    '<b>Update keys</b>',
    `<code>${htmlEscape(Object.keys(update).join(', '))}</code>`,
  ];

  await tg(env, 'sendRichMessage', {
    chat_id: message.chat.id,
    rich_message: { html: lines.join('\n') },
    reply_parameters: { message_id: target.replyToMessageId },
  });
}

// ---------- Main dispatcher ----------
async function replyWithRichMessage(message, env, update) {
  const bot = await getBotInfo(env);
  const username = bot.username || '';

  if (isDebugCommand(message, username)) {
    return handleDebug(message, env, update);
  }

  const target = resolveTarget(message, username);
  if (!target.html) {
    console.warn('Nothing to send after stripping mention.');
    return;
  }

  const result = await tg(env, 'sendRichMessage', {
    chat_id: message.chat.id,
    rich_message: { html: target.html },
    reply_parameters: { message_id: target.replyToMessageId }, // ← attach to the SOURCE
  });

  if (!result.ok) {
    console.error('sendRichMessage failed:', JSON.stringify(result));
  }
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
        if (msg) await replyWithRichMessage(msg, env, update);
      } catch (e) {
        console.error('handleUpdate error:', e && e.stack || e);
      }
      return new Response('OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  },
};
