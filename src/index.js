// src/index.js
// Rich-message bot. Converts HTML → Rich Message.
// Silent on plain chatter. Reports exact errors instead of silently echoing.

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
  BOT_INFO = (await tg(env, 'getMe', {}))?.result || {};
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

// Does the text look like a rich-HTML post rather than plain chatter?
// We only auto-convert messages that actually contain markup.
function hasRichHtml(text) {
  if (!text) return false;
  return /<\/?(?:tg-[a-z0-9-]+|[a-z]+(?:\s+[a-z-]+=|\s*>))/i.test(text) ||
         /<[a-z]+[^>]*>/i.test(text);
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

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Send a short plain diagnostic to the chat (never rich, always visible)
async function reportError(env, chatId, replyToId, title, detail) {
  const text =
    `<b>${escapeHtml(title)}</b>\n` +
    `<pre>${escapeHtml(String(detail).slice(0, 900))}</pre>`;
  await tg(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_parameters: { message_id: replyToId },
  });
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

  const probe = await tg(env, 'sendRichMessage', {
    chat_id: message.chat.id,
    rich_message: { html: target.html || '<b>debug</b>' },
    reply_parameters: { message_id: target.replyToMessageId },
  });

  const probeLine = probe.ok
    ? `✅ ok — reply id <code>${escapeHtml(probe.result?.message_id)}</code>`
    : `❌ <code>${escapeHtml((probe.description || probe.raw || 'unknown').slice(0, 500))}</code>`;

  const lines = [
    '<b>🛠 /debug</b>',
    `<b>Bot:</b> <code>@${escapeHtml(username)}</code>`,
    `<b>Chat id:</b> <code>${escapeHtml(message.chat.id)}</code> (${escapeHtml(message.chat.type)})`,
    `<b>Msg id:</b> <code>${escapeHtml(message.message_id)}</code>`,
    `<b>Replied to:</b> <code>${escapeHtml(message.reply_to_message?.message_id ?? '—')}</code>`,
    `<b>Reply target:</b> <code>${escapeHtml(target.replyToMessageId)}</code>`,
    `<b>Reason:</b> ${escapeHtml(target.reason)}`,
    `<b>Has rich HTML:</b> ${hasRichHtml(target.html)}`,
    `<b>HTML length:</b> ${target.html.length}`,
    `<b>Update keys:</b> <code>${escapeHtml(Object.keys(update).join(', '))}</code>`,
    '',
    '<b>sendRichMessage probe:</b>',
    probeLine,
    '',
    '<b>Resolved HTML (first 500 chars):</b>',
    `<pre>${escapeHtml(target.html.slice(0, 500))}</pre>`,
  ];

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

  if (isCmd(message, username, 'ping'))  return handlePing(message, env);
  if (isCmd(message, username, 'debug')) return handleDebug(message, env, update);

  const target = resolveTarget(message, username);
  if (!target.html) return;

  // ── The key filter ────────────────────────────────────────────────
  // Reply to a message → always convert the replied HTML.
  // Standalone message → only convert if it actually contains markup.
  // Plain chatter → stay silent. No echo.
  if (target.reason === 'plain') return;

  const rich = await tg(env, 'sendRichMessage', {
    chat_id: message.chat.id,
    rich_message: { html: target.html },
    reply_parameters: { message_id: target.replyToMessageId },
  });

  if (!rich.ok) {
    // Do NOT silently echo. Show the exact failure so it's debuggable.
    await reportError(
      env,
      message.chat.id,
      target.replyToMessageId,
      '❌ sendRichMessage failed',
      rich.description || rich.raw || JSON.stringify(rich).slice(0, 800)
    );
  }
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
