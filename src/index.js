// src/index.js
// Diagnostic build — dumps the ENTIRE update as raw JSON so we can see
// exactly which fields Telegram sends, especially inside reply_to_message.

const DEBUG = true;

// ---------- Telegram ----------
async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const txt = await res.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = { ok: false, raw: txt }; }
  if (!res.ok || data.ok === false) console.error(`[tg:${method}] ${res.status}:`, txt.slice(0, 600));
  return data;
}

let BOT_INFO = null;
async function getBotInfo(env) {
  if (BOT_INFO) return BOT_INFO;
  BOT_INFO = (await tg(env, 'getMe', {}))?.result || {};
  return BOT_INFO;
}

// ---------- Dump helpers ----------
function jsonBlock(obj, max = 3500) {
  let s;
  try { s = JSON.stringify(obj, null, 2); } catch { s = String(obj); }
  if (s.length > max) s = s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
  return s;
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- Send helpers ----------
function sendRich(env, chatId, replyToId, html) {
  return tg(env, 'sendRichMessage', {
    chat_id: chatId,
    rich_message: { html },
    reply_parameters: { message_id: replyToId, allow_sending_without_reply: true },
  });
}
function sendPlain(env, chatId, replyToId, text) {
  return tg(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_parameters: { message_id: replyToId, allow_sending_without_reply: true },
  });
}

// ---------- Commands ----------
async function handlePing(message, env) {
  await sendPlain(env, message.chat.id, message.message_id,
    `🏓 pong\nchat: <code>${escapeHtml(message.chat.id)}</code>`);
}

// /debug — dumps EVERYTHING raw
async function handleDebug(message, env, update) {
  const bot = await getBotInfo(env);
  const username = bot.username || '';

  const parts = [];
  parts.push('<b>🛠 /debug — raw dump</b>');
  parts.push(`<b>Bot:</b> @${escapeHtml(username)} (id <code>${escapeHtml(bot.id)}</code>)`);
  parts.push(`<b>Chat:</b> <code>${escapeHtml(message.chat.id)}</code> (${escapeHtml(message.chat.type)})`);
  parts.push('');
  parts.push('<b>── Full update JSON ──</b>');
  parts.push(`<pre>${escapeHtml(jsonBlock(update, 3800))}</pre>`);
  parts.push('');
  parts.push('<b>── message keys ──</b>');
  parts.push(`<code>${escapeHtml(Object.keys(message).join(', '))}</code>`);
  if (message.reply_to_message) {
    parts.push('');
    parts.push('<b>── reply_to_message keys ──</b>');
    parts.push(`<code>${escapeHtml(Object.keys(message.reply_to_message).join(', '))}</code>`);
  }

  // Telegram caps message text at 4096. Split if needed.
  const text = parts.join('\n');
  const CHUNK = 3900;
  for (let i = 0; i < text.length; i += CHUNK) {
    const slice = text.slice(i, i + CHUNK);
    await sendPlain(env, message.chat.id, message.message_id, slice);
  }
}

// ---------- Extract content (no whitelist — tries everything) ----------
function extractContent(msg) {
  if (!msg) return { html: '', kind: 'none' };
  if (typeof msg.text === 'string' && msg.text.length)       return { html: msg.text,    kind: 'text' };
  if (typeof msg.caption === 'string' && msg.caption.length) return { html: msg.caption, kind: 'caption' };

  // Any object that could carry rich content
  for (const key of ['rich_message', 'rich', 'content', 'html']) {
    const v = msg[key];
    if (!v) continue;
    if (typeof v === 'string') return { html: v, kind: `${key}(string)` };
    if (typeof v === 'object' && typeof v.html === 'string') return { html: v.html, kind: `${key}.html` };
    return { html: JSON.stringify(v), kind: `${key}(json)` };
  }
  return { html: '', kind: 'none' };
}

function stripBotMention(text, username) {
  if (!text) return '';
  if (!username) return text.trim();
  const esc = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`@${esc}\\b`, 'gi'), '').trim();
}
function isCmd(message, username, cmd) {
  const raw = (message.text || message.caption || '').trim();
  if (!raw) return false;
  const esc = username ? username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null;
  const re = esc
    ? new RegExp(`^/${cmd}(?:@${esc})?(?:\\s|$)`, 'i')
    : new RegExp(`^/${cmd}(?:\\s|$)`, 'i');
  return re.test(raw);
}
function hasRichHtml(text) {
  return !!text && /<\s*\/?\s*[a-z][^>]*>/i.test(text);
}

function resolveTarget(message, username) {
  const incoming = extractContent(message);
  const own      = stripBotMention(incoming.html, username);
  const replied  = message.reply_to_message;
  const fromReplied = extractContent(replied);

  if (replied) {
    const html = fromReplied.html && own
      ? `${fromReplied.html}\n\n${own}`
      : fromReplied.html || own;
    const reason = fromReplied.html ? 'reply'
                 : own && hasRichHtml(own) ? 'reply-own-html'
                 : own ? 'reply-own-plain'
                 : 'reply-empty';
    return { html, replyToMessageId: replied.message_id, reason, repliedKind: fromReplied.kind };
  }

  return {
    html: own,
    replyToMessageId: message.message_id,
    reason: hasRichHtml(own) ? 'has-html' : 'plain',
    repliedKind: '—',
  };
}

// ---------- Main ----------
async function handle(message, env, update) {
  const bot = await getBotInfo(env);
  const username = bot.username || '';

  if (DEBUG) console.log('=== update ===', JSON.stringify(update).slice(0, 2000));

  if (isCmd(message, username, 'ping'))  return handlePing(message, env);
  if (isCmd(message, username, 'debug')) return handleDebug(message, env, update);

  const target = resolveTarget(message, username);

  if (target.reason === 'reply-empty') {
    await sendPlain(env, message.chat.id, target.replyToMessageId,
      '⚠️ Replied-to message has no readable content from my side. ' +
      'Send /debug replying to it and I\'ll dump the raw JSON.');
    return;
  }
  if (target.reason === 'plain') return;
  if (target.reason === 'reply-own-plain') {
    await sendPlain(env, message.chat.id, target.replyToMessageId,
      '⚠️ No HTML detected. Try <code>&lt;b&gt;Hello&lt;/b&gt;</code>.');
    return;
  }
  if (!target.html || !target.html.trim()) return;

  const rich = await sendRich(env, message.chat.id, target.replyToMessageId, target.html);
  if (!rich.ok) {
    await sendPlain(env, message.chat.id, target.replyToMessageId,
      `<b>❌ sendRichMessage failed</b>\n<pre>${escapeHtml((rich.description || rich.raw || '').slice(0, 700))}</pre>`);
  }
}

// ---------- Worker ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('✅ Bot running.', { status: 200 });
    }
    if (request.method === 'POST' && url.pathname === '/webhook') {
      let update;
      try { update = await request.json(); }
      catch { return new Response('Bad JSON', { status: 400 }); }

      try {
        const msg = update.message || update.edited_message;
        if (msg) await handle(msg, env, update);
      } catch (e) {
        console.error('handler error:', e && e.stack || e);
      }
      return new Response('OK', { status: 200 });
    }
    return new Response('Not Found', { status: 404 });
  },
};
