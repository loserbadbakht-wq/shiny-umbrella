// src/index.js
// Rich Message bot — privacy-mode friendly.
//
// Trigger flows:
//   [user]  HTML text message
//   [user]  reply to it with @botusername        → rich reply attached to the HTML
//   [user]  @botusername <html>                  → rich reply attached to the user's msg
//   /ping, /debug                                → plain reports only
//
// Silent on bare chatter. Never sends a rich probe from /debug.

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
function wasMentioned(message, username) {
  if (!username) return false;
  const esc = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const t = message.text || message.caption || '';
  return new RegExp(`@${esc}\\b`, 'i').test(t);
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- Resolve source + reply target ----------
function resolveTarget(message, username) {
  const incoming = message.text || message.caption || '';
  const replied  = message.reply_to_message;

  if (replied) {
    const repliedText = (replied.text || replied.caption || '').trim();
    const extra       = stripBotMention(incoming, username);

    const html = repliedText && extra
      ? `${repliedText}\n\n${extra}`
      : repliedText || extra;

    let reason;
    if (repliedText)              reason = 'reply';           // source has text
    else if (extra && hasRichHtml(extra)) reason = 'reply-own-html'; // user typed HTML after mention
    else if (extra)               reason = 'reply-own-plain'; // user typed plain after mention
    else                          reason = 'reply-empty';     // only "@bot"

    return { html, replyToMessageId: replied.message_id, reason };
  }

  const cleaned = stripBotMention(incoming, username);
  return {
    html: cleaned,
    replyToMessageId: message.message_id,
    reason: hasRichHtml(cleaned) ? 'has-html' : 'plain',
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

  // NO visible probe. The debug report itself is the output.
  const incomingText   = message.text || message.caption || '';
  const repliedMsg     = message.reply_to_message;
  const repliedTextRaw = repliedMsg ? (repliedMsg.text || repliedMsg.caption || '') : '';
  const repliedHasText = repliedTextRaw.trim().length > 0;

  const lines = [
    '<b>🛠 /debug</b>',
    `<b>Bot:</b> @${escapeHtml(username)} (id <code>${escapeHtml(bot.id)}</code>)`,
    `<b>Chat:</b> <code>${escapeHtml(message.chat.id)}</code> (${escapeHtml(message.chat.type)})`,
    '',
    '<b>Incoming</b>',
    `msg_id: <code>${escapeHtml(message.message_id)}</code>`,
    `text: <pre>${escapeHtml(incomingText.slice(0, 200))}</pre>`,
    `reply_to.id: <code>${escapeHtml(repliedMsg?.message_id ?? '—')}</code>`,
    `reply_to has text: ${repliedHasText}`,
    `reply_to.text: <pre>${escapeHtml(repliedTextRaw.slice(0, 200) || '—')}</pre>`,
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
    case 'plain':
      return '🔇 silent (plain chatter, no HTML)';
    case 'reply-empty':
      return '⚠️ replied-to message has no readable text — nothing to convert';
    case 'reply-own-plain':
      return '🔇 silent (own text after mention is plain, not HTML)';
    case 'reply-own-html':
      return `✅ sendRichMessage (own HTML) → reply to ${target.replyToMessageId}`;
    case 'reply':
      return `✅ sendRichMessage (from replied msg) → reply to ${target.replyToMessageId}`;
    case 'has-html':
      return `✅ sendRichMessage → reply to ${target.replyToMessageId}`;
    default:
      return `? unknown reason ${target.reason}`;
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
      reply_to_id: message.reply_to_message?.message_id,
      reply_to_text: (message.reply_to_message?.text || '').slice(0, 120),
    }));
  }

  if (isCmd(message, username, 'ping'))  return handlePing(message, env);
  if (isCmd(message, username, 'debug')) return handleDebug(message, env, update);

  const target = resolveTarget(message, username);

  // ── reply-empty: reply to a message that has no text ─────────────
  if (target.reason === 'reply-empty') {
    await sendPlain(env, message.chat.id, target.replyToMessageId,
      '⚠️ The message you replied to has no text I can read (photo/sticker/rich message with no caption).\n\n' +
      'Reply to a <b>text message</b> containing HTML, or put the HTML in the same message after the mention:\n' +
      '<code>@' + escapeHtml(username) + ' &lt;b&gt;Hello&lt;/b&gt;</code>');
    return;
  }

  // ── plain chatter: silent ────────────────────────────────────────
  if (target.reason === 'plain') {
    if (DEBUG) console.log('skip: plain chatter, no HTML');
    return;
  }

  // ── own text after mention is plain, no HTML to convert ──────────
  if (target.reason === 'reply-own-plain') {
    await sendPlain(env, message.chat.id, target.replyToMessageId,
      '⚠️ I don\'t see HTML in your message. Include markup like <code>&lt;b&gt;Hello&lt;/b&gt;</code> or reply to a message that contains HTML.');
    return;
  }

  // ── actually convert ─────────────────────────────────────────────
  if (!target.html || !target.html.trim()) {
    if (DEBUG) console.log('skip: empty html after resolution');
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
