// src/index.js
// Telegram Rich Message bot — privacy-mode friendly.
//
// Trigger flows:
//   [user]  HTML message
//   [user]  reply to it with @botusername     → bot posts rich reply to the HTML message
//
//   [user]  @botusername <html>               → bot posts rich reply to the user's own msg
//
//   /ping, /debug                             → plain HTML replies (always visible)
//
// Silent on plain chatter. No echo. Reports exact sendRichMessage errors.

const DEBUG = true;

// ---------- Telegram helper ----------
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

// ---------- Bot identity ----------
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

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- Pick HTML source + which message to reply to ----------
// Rules:
//   • If the incoming message is a reply → the bot ALWAYS replies to the
//     replied-to message (not the mention).
//   • If the replied-to message has text, that becomes the HTML body.
//   • If the mention carries extra text after it, append it too.
//   • If the replied-to message has no text (photo/sticker/rich msg),
//     the bot uses whatever the user typed after the mention. If that's
//     also empty, it reports "can't read source".
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
    if (repliedText) reason = 'reply';
    else if (extra)  reason = 'reply-own-html';
    else             reason = 'reply-empty';

    return {
      html,
      replyToMessageId: replied.message_id,   // ← always the source
      reason,
    };
  }

  const cleaned = stripBotMention(incoming, username);
  return {
    html: cleaned,
    replyToMessageId: message.message_id,
    reason: hasRichHtml(cleaned) ? 'has-html' : 'plain',
  };
}

// ---------- Send helpers ----------
async function sendRich(env, chatId, replyToId, html) {
  return tg(env, 'sendRichMessage', {
    chat_id: chatId,
    rich_message: { html },
    reply_parameters: { message_id: replyToId, allow_sending_without_reply: true },
  });
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
    `🏓 pong\nchat: <code>${escapeHtml(message.chat.id)}</code> (${escapeHtml(message.chat.type)})`);
}

async function handleDebug(message, env, update) {
  const bot = await getBotInfo(env);
  const username = bot.username || '';
  const target = resolveTarget(message, username);

  // Only probe with non-empty HTML so we don't send an empty rich message.
  const probeHtml = target.html && target.html.trim()
    ? target.html
    : '<b>debug probe</b>';

  const probe = await sendRich(env, message.chat.id, target.replyToMessageId, probeHtml);
  const attached = probe?.result?.reply_to_message?.message_id ?? null;

  const probeLine = probe.ok
    ? `✅ ok — reply msg_id <code>${escapeHtml(probe.result?.message_id)}</code>, attached to <code>${escapeHtml(attached ?? 'null')}</code>`
    : `❌ <code>${escapeHtml((probe.description || probe.raw || 'unknown').slice(0, 500))}</code>`;

  const lines = [
    '<b>🛠 /debug</b>',
    `<b>Bot:</b> @${escapeHtml(username)} (id <code>${escapeHtml(bot.id)}</code>)`,
    `<b>Chat:</b> <code>${escapeHtml(message.chat.id)}</code> (${escapeHtml(message.chat.type)})`,
    '',
    '<b>Incoming</b>',
    `msg_id: <code>${escapeHtml(message.message_id)}</code>`,
    `text: <pre>${escapeHtml((message.text || message.caption || '').slice(0, 200))}</pre>`,
    `reply_to.id: <code>${escapeHtml(message.reply_to_message?.message_id ?? '—')}</code>`,
    `reply_to.text: <pre>${escapeHtml((message.reply_to_message?.text || message.reply_to_message?.caption || '—').slice(0, 200))}</pre>`,
    '',
    '<b>Resolved target</b>',
    `reply_to_message_id: <code>${escapeHtml(target.replyToMessageId)}</code>`,
    `reason: ${escapeHtml(target.reason)}`,
    `html length: ${target.html.length}`,
    `html: <pre>${escapeHtml(target.html.slice(0, 400))}</pre>`,
    '',
    `<b>Update keys:</b> <code>${escapeHtml(Object.keys(update).join(', '))}</code>`,
    '',
    '<b>sendRichMessage probe:</b>',
    probeLine,
  ];

  await sendPlain(env, message.chat.id, message.message_id, lines.join('\n'));
}

// ---------- Main dispatcher ----------
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

  if (!target.html || !target.html.trim()) {
    if (DEBUG) console.log('skip: empty html');
    if (target.reason === 'reply-empty') {
      await sendPlain(env, message.chat.id, target.replyToMessageId,
        '⚠️ I can\'t read the message you replied to (no text/caption exposed). Reply to a <b>text message</b> that contains HTML.');
    }
    return;
  }

  if (target.reason === 'plain') {
    if (DEBUG) console.log('skip: plain chatter, no HTML markup');
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
