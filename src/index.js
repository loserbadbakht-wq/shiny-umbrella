// src/index.js
// Robust stateless bot — always replies, always logs, falls back if rich isn't supported.

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
    console.error(`Telegram ${method} ${res.status}:`, txt);
  }
  return data;
}

let BOT_INFO = null;
async function getBotInfo(env) {
  if (BOT_INFO) return BOT_INFO;
  const r = await tg(env, 'getMe', {});
  BOT_INFO = r?.result || {};
  return BOT_INFO;
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
  const re = esc ? new RegExp(`^/${cmd}(@${esc})?\\b`, 'i') : new RegExp(`^/${cmd}\\b`, 'i');
  return re.test(raw);
}

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

// Try rich first, fall back to plain HTML message. Always replies to the SOURCE.
async function sendReply(env, chatId, replyToMessageId, html) {
  // 1) Try Rich Message
  const rich = await tg(env, 'sendRichMessage', {
    chat_id: chatId,
    rich_message: { html },
    reply_parameters: { message_id: replyToMessageId },
  });
  if (rich.ok) return { via: 'sendRichMessage', message_id: rich.result?.message_id };

  // 2) Fall back to plain sendMessage with HTML parse mode
  console.warn('sendRichMessage failed, falling back to sendMessage:', JSON.stringify(rich).slice(0, 300));
  const plain = await tg(env, 'sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    reply_parameters: { message_id: replyToMessageId },
  });
  return { via: 'sendMessage(fallback)', message_id: plain.result?.message_id, fallback: rich };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function handlePing(message, env) {
  await tg(env, 'sendMessage', {
    chat_id: message.chat.id,
    text: `🏓 pong\nchat_id: <code>${message.chat.id}</code>`,
    parse_mode: 'HTML',
    reply_parameters: { message_id: message.message_id },
  });
}

async function handleDebug(message, env, update) {
  const bot = await getBotInfo(env);
  const username = bot.username || '';
  const target = resolveTarget(message, username);

  const richTest = await tg(env, 'sendRichMessage', {
    chat_id: message.chat.id,
    rich_message: { html: target.html || '<b>debug</b>' },
    reply_parameters: { message_id: target.replyToMessageId },
  });

  const lines = [
    '<b>🛠 /debug</b>',
    `<b>Bot:</b> <code>@${escapeHtml(username)}</code> (id <code>${escapeHtml(bot.id)}</code>)`,
    `<b>Chat:</b> <code>${escapeHtml(message.chat.id)}</code> (${escapeHtml(message.chat.type)})`,
    `<b>Message id:</b> <code>${escapeHtml(message.message_id)}</code>`,
    `<b>Replied to:</b> <code>${escapeHtml(message.reply_to_message?.message_id ?? '—')}</code>`,
    `<b>Reply target:</b> <code>${escapeHtml(target.replyToMessageId)}</code>`,
    `<b>HTML length:</b> ${target.html.length}`,
    `<b>Update keys:</b> <code>${escapeHtml(Object.keys(update).join(', '))}</code>`,
    '',
    `<b>sendRichMessage probe:</b>`,
    richTest.ok
      ? `✅ ok — reply id <code>${escapeHtml(richTest.result?.message_id)}</code>`
      : `❌ failed — <code>${escapeHtml((richTest.description || richTest.raw || 'unknown').slice(0, 400))}</code>`,
  ];

  // /debug always uses plain sendMessage so you SEE output even if rich is broken
  await tg(env, 'sendMessage', {
    chat_id: message.chat.id,
    text: lines.join('\n'),
    parse_mode: 'HTML',
    reply_parameters: { message_id: message.message_id },
  });
}

async function handle(message, env, update) {
  const bot = await getBotInfo(env);
  const username = bot.username || '';

  if (isCmd(message, username, 'ping')) return handlePing(message, env);
  if (isCmd(message, username, 'debug')) return handleDebug(message, env, update);

  const target = resolveTarget(message, username);
  if (!target.html) return;

  await sendReply(env, message.chat.id, target.replyToMessageId, target.html);
}

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

      console.log('UPDATE keys:', Object.keys(update).join(', '));

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
