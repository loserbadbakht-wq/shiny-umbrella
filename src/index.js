// src/index.js
// Rich Message bot. Handles BOTH reply conventions for sendRichMessage:
//   1) reply_parameters: { message_id }
//   2) reply_to_message_id + allow_sending_without_reply
// The API returns ok:true even when it silently ignores the reply field,
// so we verify by inspecting the returned message.

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

// ---------- Resolve target ----------
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

// ---------- sendRichMessage with reply-convention fallbacks ----------
// Telegram's sendRichMessage has been observed to ignore `reply_parameters`
// and only honor `reply_to_message_id`. We try both and verify by inspecting
// the returned message's `reply_to_message`.
async function sendRichReply(env, chatId, replyToId, html) {
  const attempts = [
    {
      label: 'reply_parameters',
      payload: {
        chat_id: chatId,
        rich_message: { html },
        reply_parameters: { message_id: replyToId, allow_sending_without_reply: true },
      },
    },
    {
      label: 'reply_to_message_id',
      payload: {
        chat_id: chatId,
        rich_message: { html },
        reply_to_message_id: replyToId,
        allow_sending_without_reply: true,
      },
    },
    {
      label: 'no-reply',
      payload: {
        chat_id: chatId,
        rich_message: { html },
      },
    },
  ];

  const log = [];
  for (const a of attempts) {
    const r = await tg(env, 'sendRichMessage', a.payload);
    const attached = r?.result?.reply_to_message?.message_id;
    log.push({
      attempt: a.label,
      ok: !!r?.ok,
      err: r?.description,
      replied_to: attached ?? null,
    });
    if (r?.ok) {
      return { result: r, attached, usedLabel: a.label, log };
    }
  }
  return { result: { ok: false, description: 'all attempts failed' }, attached: null, log };
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

  const probe = await sendRichReply(
    env, message.chat.id, target.replyToMessageId,
    target.html || '<b>debug probe</b>'
  );

  const lines = [
    '<b>🛠 /debug</b>',
    `<b>Bot:</b> @${escapeHtml(username)}`,
    `<b>Chat:</b> <code>${escapeHtml(message.chat.id)}</code> (${escapeHtml(message.chat.type)})`,
    '',
    '<b>Incoming</b>',
    `msg_id: <code>${escapeHtml(message.message_id)}</code>`,
    `reply_to.id: <code>${escapeHtml(message.reply_to_message?.message_id ?? '—')}</code>`,
    `reply_to.text: <pre>${escapeHtml((message.reply_to_message?.text || message.reply_to_message?.caption || '—').slice(0, 160))}</pre>`,
    '',
    '<b>Resolved target</b>',
    `reply_to_message_id: <code>${escapeHtml(target.replyToMessageId)}</code>`,
    `reason: ${escapeHtml(target.reason)}`,
    '',
    '<b>sendRichMessage attempts</b>',
    `<pre>${escapeHtml(JSON.stringify(probe.log, null, 2))}</pre>`,
    `<b>Used attempt:</b> <code>${escapeHtml(probe.usedLabel || '—')}</code>`,
    `<b>Attached to msg:</b> <code>${escapeHtml(probe.attached ?? 'null — NOT A REPLY')}</code>`,
    '',
    '<b>Update keys</b>',
    `<code>${escapeHtml(Object.keys(update).join(', '))}</code>`,
  ];

  await sendPlain(env, message.chat.id, message.message_id, lines.join('\n'));
}

// ---------- Main ----------
async function handle(message, env, update) {
  const bot = await getBotInfo(env);
  const username = bot.username || '';

  if (DEBUG) console.log('incoming:', JSON.stringify({
    msg_id: message.message_id,
    chat_id: message.chat.id,
    chat_type: message.chat.type,
    reply_to_id: message.reply_to_message?.message_id,
    text: (message.text || message.caption || '').slice(0, 120),
  }));

  if (isCmd(message, username, 'ping'))  return handlePing(message, env);
  if (isCmd(message, username, 'debug')) return handleDebug(message, env, update);

  const target = resolveTarget(message, username);
  if (!target.html) return;
  if (target.reason === 'plain') {
    if (DEBUG) console.log('skip: plain chatter, no HTML');
    return;
  }

  const { result, attached, usedLabel } = await sendRichReply(
    env, message.chat.id, target.replyToMessageId, target.html
  );

  if (!result.ok) {
    await sendPlain(env, message.chat.id, target.replyToMessageId,
      `<b>❌ sendRichMessage failed</b>\n<pre>${escapeHtml((result.description || result.raw || '').slice(0, 700))}</pre>`);
    return;
  }

  if (DEBUG) {
    console.log(`sendRichMessage: used=${usedLabel} attached=${attached} expected=${target.replyToMessageId}`);
  }

  // If even `reply_to_message_id` didn't attach, fall back to a normal
  // sendMessage reply containing the same rich HTML so the user at least
  // sees the content attached to the source message.
  if (attached !== target.replyToMessageId) {
    console.warn('sendRichMessage did not attach the reply; falling back to sendMessage.');
    await sendPlain(env, message.chat.id, target.replyToMessageId, target.html);
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
