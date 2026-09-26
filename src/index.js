// src/index.js
// Rich Message bot — privacy-mode friendly.
//
// Sources of HTML (in priority order, per message):
//   message.text          → normal text / caption
//   message.rich_message  → a rich message
//
// Trigger flows:
//   [user]  HTML text or rich message
//   [user]  reply to it with @botusername    → rich reply attached to the source
//   [user]  @botusername <html>              → rich reply attached to the user's msg
//   /ping, /debug                            → plain reports only
//
// The bot NEVER stays silent when addressed. If it can't convert, it tells you why.

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
    console.error(`[tg:${method}] HTTP ${res.status} →`, txt.slice(0, 600));
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
function jsonBlock(obj, max = 3800) {
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

// ---------- Extract content from any message object ----------
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

// ---------- Resolve source + reply target ----------
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
    if (fromReplied.html)                        reason = 'reply';
    else if (own && hasRichHtml(own))            reason = 'reply-own-html';
    else if (own)                                reason = 'reply-own-plain';
    else                                         reason = 'reply-empty';

    return { html, replyToMessageId: replied.message_id, reason, repliedKind: fromReplied.kind };
  }

  // No reply target
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
    `🏓 pong\nchat: <code>${escapeHtml(message.chat.id)}</code> (${escapeHtml(message.chat.type)})`);
}

async function handleDebug(message, env, update) {
  const bot = await getBotInfo(env);
  const username = bot.username || '';

  const parts = [];
  parts.push('<b>🛠 /debug — raw dump</b>');
  parts.push(`<b>Bot:</b> @${escapeHtml(username)} (id <code>${escapeHtml(bot.id)}</code>)`);
  parts.push(`<b>Chat:</b> <code>${escapeHtml(message.chat.id)}</code> (${escapeHtml(message.chat.type)})`);
  parts.push('');
  parts.push('<b>── Full update JSON ──</b>');
  parts.push(`<pre>${escapeHtml(jsonBlock(update, 3500))}</pre>`);
  parts.push('');
  parts.push('<b>── message keys ──</b>');
  parts.push(`<code>${escapeHtml(Object.keys(message).join(', '))}</code>`);
  if (message.reply_to_message) {
    parts.push('');
    parts.push('<b>── reply_to_message keys ──</b>');
    parts.push(`<code>${escapeHtml(Object.keys(message.reply_to_message).join(', '))}</code>`);
  } else {
    parts.push('');
    parts.push('<b>── reply_to_message ──</b>');
    parts.push('<i>absent</i>');
  }

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

  if (DEBUG) {
    console.log('=== update ===', JSON.stringify(update).slice(0, 2000));
  }

  if (isCmd(message, username, 'ping'))  return handlePing(message, env);
  if (isCmd(message, username, 'debug')) return handleDebug(message, env, update);

  const target = resolveTarget(message, username);

  // 1) Replied to a message with no readable content
  if (target.reason === 'reply-empty') {
    await sendPlain(env, message.chat.id, target.replyToMessageId,
      '⚠️ <b>Replied-to message has no readable content.</b>\n' +
      'I got a reply target but it carried no <code>text</code>, <code>caption</code>, or <code>rich_message</code>.\n\n' +
      'Send <code>/debug</code> replying to the same message and I\'ll dump the raw JSON.');
    return;
  }

  // 2) Addressed with nothing to convert
  if (target.reason === 'mentioned-empty') {
    await sendPlain(env, message.chat.id, target.replyToMessageId,
      '⚠️ <b>You mentioned me but I see no HTML and no reply target.</b>\n' +
      'Telegram delivered the message with no <code>reply_to_message</code> field.\n\n' +
      'Try either:\n' +
      `• <code>@${escapeHtml(username)} &lt;b&gt;Hello&lt;/b&gt;</code>\n` +
      '• or long-press a text message → Reply → type <code>@' + escapeHtml(username) + '</code>');
    return;
  }

  // 3) Not addressed and no HTML — silent
  if (target.reason === 'plain') {
    if (DEBUG) console.log('skip: not addressed, no HTML');
    return;
  }

  // 4) Replied with plain text after mention
  if (target.reason === 'reply-own-plain') {
    await sendPlain(env, message.chat.id, target.replyToMessageId,
      '⚠️ No HTML detected. Try <code>&lt;b&gt;Hello&lt;/b&gt;</code>.');
    return;
  }

  // 5) Empty after all resolution — silent
  if (!target.html || !target.html.trim()) {
    if (DEBUG) console.log('skip: empty html');
    return;
  }

  // 6) Convert
  const rich = await sendRich(env, message.chat.id, target.replyToMessageId, target.html);
  if (!rich.ok) {
    await sendPlain(env, message.chat.id, target.replyToMessageId,
      `<b>❌ sendRichMessage failed</b>\n<pre>${escapeHtml((rich.description || rich.raw || '').slice(0, 700))}</pre>`);
    return;
  }
  if (DEBUG) {
    const attached = rich?.result?.reply_to_message?.message_id ?? null;
    console.log(`sendRichMessage: attached=${attached} expected=${target.replyToMessageId}`);
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
