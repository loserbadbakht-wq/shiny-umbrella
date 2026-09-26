// src/index.js
// Rich Message bot — bulletproof diagnostics.
// Never stays silent when addressed. Always sends something.

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
  if (!res.ok || data.ok === false) {
    console.error(`[tg:${method}] HTTP ${res.status} →`, txt.slice(0, 800));
  } else if (DEBUG) {
    console.log(`[tg:${method}] ok`);
  }
  return data;
}

let BOT_INFO = null;
async function getBotInfo(env) {
  if (BOT_INFO) return BOT_INFO;
  BOT_INFO = (await tg(env, 'getMe', {}))?.result || {};
  return BOT_INFO;
}

// ---------- Helpers ----------
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function jsonBlock(obj, max = 3000) {
  let s;
  try { s = JSON.stringify(obj, null, 2); } catch { s = String(obj); }
  if (s.length > max) s = s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
  return s;
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
function wasMentioned(text, username) {
  if (!text || !username) return false;
  const esc = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`@${esc}\\b`, 'i').test(text);
}

// ---------- Extract content from any message ----------
function extractContent(msg) {
  if (!msg) return { html: '', kind: 'none' };
  if (typeof msg.text === 'string' && msg.text.length)       return { html: msg.text,    kind: 'text' };
  if (typeof msg.caption === 'string' && msg.caption.length) return { html: msg.caption, kind: 'caption' };
  for (const key of ['rich_message', 'rich', 'content', 'html']) {
    const v = msg[key];
    if (!v) continue;
    if (typeof v === 'string') return { html: v, kind: `${key}(string)` };
    if (typeof v === 'object' && typeof v.html === 'string') return { html: v.html, kind: `${key}.html` };
    return { html: JSON.stringify(v), kind: `${key}(json)` };
  }
  return { html: '', kind: 'none' };
}

// ---------- Resolve target ----------
function resolveTarget(message, username) {
  const incoming    = extractContent(message);
  const own         = stripBotMention(incoming.html, username);
  const replied     = message.reply_to_message;
  const fromReplied = extractContent(replied);

  if (replied) {
    const html = fromReplied.html && own
      ? `${fromReplied.html}\n\n${own}`
      : fromReplied.html || own;

    let reason;
    if (fromReplied.html)             reason = 'reply';
    else if (own && hasRichHtml(own)) reason = 'reply-own-html';
    else if (own)                     reason = 'reply-own-plain';
    else                              reason = 'reply-empty';

    return { html, replyToMessageId: replied.message_id, reason, repliedKind: fromReplied.kind };
  }

  if (!own && wasMentioned(incoming.html, username)) {
    return { html: '', replyToMessageId: message.message_id, reason: 'mentioned-empty', repliedKind: '—' };
  }
  if (!own) {
    return { html: '', replyToMessageId: message.message_id, reason: 'plain', repliedKind: '—' };
  }
  return {
    html: own,
    replyToMessageId: message.message_id,
    reason: hasRichHtml(own) ? 'has-html' : 'plain',
    repliedKind: '—',
  };
}

// ---------- Send ----------
async function sendRich(env, chatId, replyToId, html) {
  const withReply = await tg(env, 'sendRichMessage', {
    chat_id: chatId,
    rich_message: { html },
    reply_parameters: { message_id: replyToId, allow_sending_without_reply: true },
  });
  if (withReply.ok) return withReply;

  console.warn('sendRichMessage with reply failed:', withReply.description);
  const without = await tg(env, 'sendRichMessage', {
    chat_id: chatId,
    rich_message: { html },
  });
  return without;
}
async function sendPlain(env, chatId, replyToId, text) {
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

async function handleDebug(message, env, update) {
  const bot = await getBotInfo(env);
  const username = bot.username || '';
  const parts = [];
  parts.push('<b>🛠 /debug — raw dump</b>');
  parts.push(`<b>Bot:</b> @${escapeHtml(username)}`);
  parts.push(`<b>Chat:</b> <code>${escapeHtml(message.chat.id)}</code>`);
  parts.push('');
  parts.push('<b>── Full update JSON ──</b>');
  parts.push(`<pre>${escapeHtml(jsonBlock(update, 3800))}</pre>`);

  const text = parts.join('\n');
  const CHUNK = 3900;
  for (let i = 0; i < text.length; i += CHUNK) {
    await sendPlain(env, message.chat.id, message.message_id, text.slice(i, i + CHUNK));
  }
}

// ---------- Main ----------
async function handle(message, env, update) {
  const bot = await getBotInfo(env);
  const username = bot.username || '';

  console.log('=== update ===', JSON.stringify(update).slice(0, 2500));

  if (isCmd(message, username, 'ping'))  return handlePing(message, env);
  if (isCmd(message, username, 'debug')) return handleDebug(message, env, update);

  const target = resolveTarget(message, username);
  console.log('=== resolved ===', JSON.stringify({
    reason: target.reason,
    htmlLen: target.html.length,
    replyTo: target.replyToMessageId,
    repliedKind: target.repliedKind,
    hasReplyTo: !!message.reply_to_message,
  }));

  // ── Addressed but replied-to message has no readable content ──
  if (target.reason === 'reply-empty') {
    const raw = message.reply_to_message
      ? jsonBlock(message.reply_to_message, 2500)
      : 'absent';
    await sendPlain(env, message.chat.id, target.replyToMessageId,
      `⚠️ <b>Replied-to message has no readable content.</b>\n` +
      `kind: <code>${escapeHtml(target.repliedKind)}</code>\n\n` +
      `<b>Raw reply_to_message object:</b>\n<pre>${escapeHtml(raw)}</pre>`);
    return;
  }

  // ── Mentioned alone, no reply, no HTML ──
  if (target.reason === 'mentioned-empty') {
    await sendPlain(env, message.chat.id, message.message_id,
      `⚠️ <b>Mentioned, but no HTML and no reply target.</b>\n` +
      `Try: <code>@${escapeHtml(username)} &lt;b&gt;Hello&lt;/b&gt;</code>`);
    return;
  }

  // ── Replied with plain text after mention ──
  if (target.reason === 'reply-own-plain') {
    await sendPlain(env, message.chat.id, target.replyToMessageId,
      `⚠️ <b>No HTML in your reply.</b>\n` +
      `Try: <code>&lt;b&gt;Hello&lt;/b&gt;</code>`);
    return;
  }

  // ── Not addressed — silent ──
  if (target.reason === 'plain') return;
  if (!target.html.trim()) return;

  // ── Convert ──
  const rich = await sendRich(env, message.chat.id, target.replyToMessageId, target.html);
  if (rich.ok) {
    if (DEBUG) {
      const attached = rich?.result?.reply_to_message?.message_id ?? null;
      console.log(`sendRichMessage: attached=${attached} expected=${target.replyToMessageId}`);
    }
    return;
  }

  // Rich failed → plain fallback
  const plain = await sendPlain(env, message.chat.id, target.replyToMessageId, target.html);
  if (!plain.ok) {
    await sendPlain(env, message.chat.id, target.replyToMessageId,
      `<b>❌ All send attempts failed</b>\n` +
      `rich: <code>${escapeHtml((rich.description || '').slice(0, 200))}</code>\n` +
      `plain: <code>${escapeHtml((plain.description || '').slice(0, 200))}</code>`);
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
