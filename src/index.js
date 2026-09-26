// src/index.js
// Telegram Rich Message bot — privacy-mode friendly.
//
// In groups with privacy mode ON, the bot only receives:
//   • /commands
//   • messages that contain @botusername
//   • replies to the bot's own messages
//
// Trigger flow:
//   [user]  HTML message
//   [user]  reply to it with @botusername
//   [bot]   Rich Message reply, attached to the HTML message
//
// Plain chatter (no mention, no HTML) → bot stays silent. No echo.

const DEBUG = true;

// ---------- Telegram helper ----------
async function tg(env, method, payload) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
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

// Any `<tag>` — matches both rich-only (`<tg-map/>`) and standard (`<b>`) markup
function hasRichHtml(text) {
  if (!text) return false;
  return /<\s*\/?\s*[a-z][^>]*>/i.test(text);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- Pick HTML source + which message to reply to ----------
function resolveTarget(message, username) {
  const incoming = message.text || message.caption || '';
  const replied  = message.reply_to_message;

  if (replied) {
    const repliedText = replied.text || replied.caption || '';
    if (repliedText.trim()) {
      const extra = stripBotMention(incoming, username);
      return {
        html: extra ? `${repliedText}\n\n${extra}` : repliedText,
        replyToMessageId: replied.message_id,
        reason: 'reply',
      };
    }
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
    reply_parameters: { message_id: replyToId },
  });
}

function sendPlain(env, chatId, replyToId, text) {
  return tg(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_parameters: { message_id: replyToId },
  });
}

// ---------- Commands ----------
async function handlePing(message, env) {
  await sendPlain(env, message.chat.id, message.message_id,
    `🏓 pong\nchat_id: <code>${escapeHtml(message.chat.id)}</code>\ntype: <code>${escapeHtml(message.chat.type)}</code>`);
}

async function handleDebug(message, env, update) {
  const bot = await getBotInfo(env);
  const username = bot.username || '';
  const target = resolveTarget(message, username);

  const probeHtml = target.html || '<b>debug probe</b>';
  const probe = await sendRich(env, message.chat.id, target.replyToMessageId, probeHtml);

  const probeLine = probe.ok
    ? `✅ ok — reply msg_id <code>${escapeHtml(probe.result?.message_id)}</code>`
    : `❌ <code>${escapeHtml((probe.description || probe.raw || 'unknown').slice(0, 500))}</code>`;

  const lines = [
    '<b>🛠 /debug</b>',
    `<b>Bot:</b> @${escapeHtml(username)} (id <code>${escapeHtml(bot.id)}</code>)`,
    `<b>Chat:</b> <code>${escapeHtml(message.chat.id)}</code> (${escapeHtml(message.chat.type)})`,
    '',
    '<b>Incoming</b>',
    `id: <code>${escapeHtml(message.message_id)}</code>`,
    `text: <pre>${escapeHtml((message.text || message.caption || '').slice(0, 200))}</pre>`,
    `has reply_to_message: ${!!message.reply_to_message}`,
    `reply_to.id: <code>${escapeHtml(message.reply_to_message?.message_id ?? '—')}</code>`,
    `reply_to.text: <pre>${escapeHtml((message.reply_to_message?.text || message.reply_to_message?.caption || '—').slice(0, 200))}</pre>`,
    '',
    '<b>Resolved</b>',
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

  if (!target.html) {
    if (DEBUG) console.log('skip: empty html');
    return;
  }
  if (target.reason === 'plain') {
    if (DEBUG) console.log('skip: no HTML markup, plain chatter');
    return;
  }

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
