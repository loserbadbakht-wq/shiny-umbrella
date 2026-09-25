// src/index.js
// Stateless Telegram bot — HTML → Rich Message (Bot API 10.1+)
// Strips the bot's own @mention, supports replying to a source message.
// Adds /debug for diagnostics.

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

// ---------- Resolve the source text for a message ----------
function resolveSourceText(message, username) {
  const incoming = message.text || message.caption || '';
  const replied = message.reply_to_message;

  if (replied) {
    const repliedText = replied.text || replied.caption || '';
    if (repliedText.trim()) {
      const extra = stripBotMention(incoming, username);
      return extra ? `${repliedText}\n\n${extra}` : repliedText;
    }
  }

  return stripBotMention(incoming, username);
}

// ---------- Truncate long strings for display ----------
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

// ---------- /debug handler ----------
async function handleDebug(message, env, update) {
  const bot = await getBotInfo(env);
  const username = bot.username || '';
  const html = resolveSourceText(message, username);

  // Probe sendRichMessage with a minimal payload (does not send anything visible —
  // we send it into the same chat as a reply; that IS the debug reply).
  const probePayload = {
    chat_id: message.chat.id,
    rich_message: { html: html || '<b>debug</b>' },
    reply_parameters: { message_id: message.message_id },
  };
  const probe = await tg(env, 'sendRichMessage', probePayload);

  const lines = [
    '<b>🛠 /debug</b>',
    '',
    `<b>Bot</b>`,
    `id: <code>${htmlEscape(bot.id)}</code>`,
    `username: <code>@${htmlEscape(username)}</code>`,
    `first_name: ${htmlEscape(bot.first_name || '')}`,
    `can_join_groups: ${bot.can_join_groups}`,
    `can_read_all_group_messages: ${bot.can_read_all_group_messages}`,
    `supports_inline_queries: ${bot.supports_inline_queries}`,
    '',
    `<b>Chat</b>`,
    `id: <code>${htmlEscape(message.chat.id)}</code>`,
    `type: <code>${htmlEscape(message.chat.type)}</code>`,
    `title: ${htmlEscape(message.chat.title || message.chat.username || message.chat.first_name || '')}`,
    '',
    `<b>Message</b>`,
    `message_id: <code>${htmlEscape(message.message_id)}</code>`,
    `date: <code>${htmlEscape(message.date)}</code>`,
    `has_reply: ${!!message.reply_to_message}`,
    `text_length: ${(message.text || message.caption || '').length}`,
    '',
    `<b>Update keys</b>`,
    `<code>${htmlEscape(Object.keys(update).join(', '))}</code>`,
    '',
    `<b>Resolved HTML (${html.length} chars)</b>`,
    `<pre>${htmlEscape(clip(html))}</pre>`,
    '',
    `<b>sendRichMessage probe</b>`,
    probe.ok
      ? `✅ ok — reply message_id: <code>${htmlEscape(probe.result?.message_id)}</code>`
      : `❌ failed\n<pre>${htmlEscape(clip(JSON.stringify(probe), 600))}</pre>`,
  ];

  // Send the debug report as a rich message itself
  await tg(env, 'sendRichMessage', {
    chat_id: message.chat.id,
    rich_message: { html: lines.join('\n') },
    reply_parameters: { message_id: message.message_id },
  });
}

// ---------- Send a Rich Message as a reply ----------
async function replyWithRichMessage(message, env, update) {
  const bot = await getBotInfo(env);
  const username = bot.username || '';

  if (isDebugCommand(message, username)) {
    return handleDebug(message, env, update);
  }

  const html = resolveSourceText(message, username);

  if (!html) {
    console.warn('Nothing to send after stripping mention.');
    return;
  }

  const result = await tg(env, 'sendRichMessage', {
    chat_id: message.chat.id,
    rich_message: { html },
    reply_parameters: { message_id: message.message_id },
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
