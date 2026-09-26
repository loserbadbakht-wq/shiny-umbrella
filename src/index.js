// src/index.js
// Rich Message bot — privacy-mode friendly.
//
// Sources of HTML (in priority order, per message):
//   message.text          → normal text / caption
//   message.rich_message  → a rich message (bot or user posted with parse_mode rich)
//
// Trigger flows:
//   [user]  HTML text or rich message
//   [user]  reply to it with @botusername        → rich reply attached to the source
//   [user]  @botusername <html>                  → rich reply attached to the user's msg
//   /ping, /debug                                → plain reports only
//
// Silent on bare chatter. No visible probe from /debug.

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

// ---------- Pull HTML out of ANY message object ----------
// Telegram exposes content in different fields depending on how it was sent.
function extractContent(msg) {
  if (!msg) return { html: '', kind: 'none' };
  if (typeof msg.text === 'string' && msg.text.length)        return { html: msg.text,    kind: 'text' };
  if (typeof msg.caption === 'string' && msg.caption.length)  return { html: msg.caption, kind: 'caption' };
  if (msg.rich_message) {
    if (typeof msg.rich_message.html === 'string')            return { html: msg.rich_message.html, kind: 'rich_message.html' };
    if (typeof msg.rich_message === 'string')                 return { html: msg.rich_message,      kind: 'rich_message(string)' };
    return { html: JSON.stringify(msg.rich_message), kind: 'rich_message(json)' };
  }
  return { html: '', kind: 'none' };
}

// ---------- Text helpers ----------
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
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- Resolve source + reply target ----------
function resolveTarget(message, username) {
  const incoming       = extractContent(message);                 // what the user typed
  const incomingStripped = stripBotMention(incoming.html, username);
  const repliedMsg     = message.reply_to_message;
  const replied        = extractContent(repliedMsg);              // the replied-to message

  if (repliedMsg) {
    // Combine replied content + (stripped) own content
    let html;
    if (replied.html && incomingStripped) html = `${replied.html}\n\n${incomingStripped}`;
    else if (replied.html)                html = replied.html;
    else                                  html = incomingStripped;

    let reason;
    if (replied.html)                                reason = 'reply';
    else if (incomingStripped && hasRichHtml(incomingStripped)) reason = 'reply-own-html';
    else if (incomingStripped)                       reason = 'reply-own-plain';
    else                                             reason = 'reply-empty';

    return {
      html,
      replyToMessageId: repliedMsg.message_id,
      reason,
      repliedKind: replied.kind,
      incomingKind: incoming.kind,
    };
  }

  return {
    html: incomingStripped,
    replyToMessageId: message.message_id,
    reason: hasRichHtml(incomingStripped) ? 'has-html' : 'plain',
    repliedKind: '—',
    incomingKind: incoming.kind,
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
  const target = resolveTarget(message, username);

  const repliedMsg = message.reply_to_message;
  const repliedContent = extractContent(repliedMsg);
  const incomingContent = extractContent(message);

  // Which keys are visible on the replied-to message (helps diagnose "no text")
  const repliedKeys = repliedMsg ? Object.keys(repliedMsg).filter(k =>
    ['text','caption','rich_message','photo','video','sticker','audio','voice','document','animation','poll','location','venue','contact','dice'].includes(k)
  ) : [];

  const lines = [
    '<b>🛠 /debug</b>',
    `<b>Bot:</b> @${escapeHtml(username)} (id <code>${escapeHtml(bot.id)}</code>)`,
    `<b>Chat:</b> <code>${escapeHtml(message.chat.id)}</code> (${escapeHtml(message.chat.type)})`,
    '',
    '<b>Incoming</b>',
    `msg_id: <code>${escapeHtml(message.message_id)}</code>`,
    `kind: <code>${escapeHtml(incomingContent.kind)}</code>`,
    `text: <pre>${escapeHtml((message.text || message.caption || '').slice(0, 200))}</pre>`,
    '',
    '<b>Replied-to message</b>',
    `id: <code>${escapeHtml(repliedMsg?.message_id ?? '—')}</code>`,
    `content kind: <code>${escapeHtml(repliedContent.kind)}</code>`,
    `content keys present: <code>${escapeHtml(repliedKeys.join(', ') || '—')}</code>`,
    `extracted html: <pre>${escapeHtml(repliedContent.html.slice(0, 300) || '—')}</pre>`,
    '',
    '<b>Resolved target</b>',
    `reply_to_message_id: <code>${escapeHtml(target.replyToMessageId)}</code>`,
    `reason: <b>${escapeHtml(target.reason)}</b>`,
    `html length: ${target.html.length}`,
    `html: <pre>${escapeHtml(target.html.slice(0, 400) || '—')}</pre>`,
    '',
    `<b>Update keys:</b> <code>${escapeHtml(Object.keys(update).join(', '))}</code>`,
    '',
    '<b>What the bot will do</b>',
    renderDecision(target),
  ];

  await sendPlain(env, message.chat.id, message.message_id, lines.join('\n'));
}

function renderDecision(target) {
  if (!target.html || !target.html.trim()) {
    return `⚠️ nothing to convert (reason: ${target.reason})`;
  }
  switch (target.reason) {
    case 'plain':           return '🔇 silent (plain chatter, no HTML)';
    case 'reply-empty':     return '⚠️ replied-to message has NO readable content — nothing to convert';
    case 'reply-own-plain': return '🔇 silent (own text after mention is plain, not HTML)';
    case 'reply-own-html':  return `✅ sendRichMessage (own HTML) → reply to ${target.replyToMessageId}`;
    case 'reply':           return `✅ sendRichMessage (from replied msg) → reply to ${target.replyToMessageId}`;
    case 'has-html':        return `✅ sendRichMessage → reply to ${target.replyToMessageId}`;
    default:                return `? unknown reason ${target.reason}`;
  }
}

// ---------- Main ----------
async function handle(message, env, update) {
  const bot = await getBotInfo(env);
  const username = bot.username || '';

  if (DEBUG) {
    console.log('incoming:', JSON.stringify({
      msg_id: message.message_id,
      chat_id: message.chat.id,
      chat_type: message.chat.type,
      text: (message.text || message.caption || '').slice(0, 120),
      has_rich: !!message.rich_message,
      reply_to_id: message.reply_to_message?.message_id,
      reply_to_text: (message.reply_to_message?.text || '').slice(0, 120),
      reply_to_has_rich: !!message.reply_to_message?.rich_message,
    }));
  }

  if (isCmd(message, username, 'ping'))  return handlePing(message, env);
  if (isCmd(message, username, 'debug')) return handleDebug(message, env, update);

  const target = resolveTarget(message, username);

  if (target.reason === 'reply-empty') {
    await sendPlain(env, message.chat.id, target.replyToMessageId,
      '⚠️ The message you replied to has no readable content (photo/sticker with no caption, or a service message).\n\n' +
      'Reply to a <b>text message</b> or a <b>rich message</b>, or put HTML in the same message after the mention:\n' +
      `<code>@${escapeHtml(username)} &lt;b&gt;Hello&lt;/b&gt;</code>`);
    return;
  }
  if (target.reason === 'plain') {
    if (DEBUG) console.log('skip: plain chatter');
    return;
  }
  if (target.reason === 'reply-own-plain') {
    await sendPlain(env, message.chat.id, target.replyToMessageId,
      '⚠️ I don\'t see HTML in your message. Include markup like <code>&lt;b&gt;Hello&lt;/b&gt;</code>, or reply to a message that contains HTML.');
    return;
  }
  if (!target.html || !target.html.trim()) {
    if (DEBUG) console.log('skip: empty html');
    return;
  }

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

      console.log('=== update ===', JSON.stringify(update).slice(0, 1200));

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
