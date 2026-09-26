// src/index.js
// Rich Message bot — command-driven.
//
// Usage in any group (privacy mode ON or OFF):
//   /rich                        (reply to an HTML message)  → converts it
//   /rich <b>Hello</b>            (inline HTML)                → converts it
//   /ping    /debug    /help
//
// Commands are ALWAYS delivered to the bot, including their reply_to_message,
// so this works even when the bot has privacy mode enabled.

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
  if (!res.ok || data.ok === false) console.error(`[tg:${method}] ${res.status}:`, txt.slice(0, 800));
  else if (DEBUG) console.log(`[tg:${method}] ok`);
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
  let s; try { s = JSON.stringify(obj, null, 2); } catch { s = String(obj); }
  if (s.length > max) s = s.slice(0, max) + `\n…[+${s.length - max}]`;
  return s;
}
function hasRichHtml(t) { return !!t && /<\s*\/?\s*[a-z][^>]*>/i.test(t); }

// ---------- Command parsing ----------
// Accepts: /rich, /rich@BotUsername, /rich <args...>
// Rejects commands targeted at other bots.
function parseCommand(text, botUsername) {
  if (!text) return null;
  const m = text.match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const [, cmd, target, args] = m;
  if (target && target.toLowerCase() !== (botUsername || '').toLowerCase()) return null;
  return { cmd: cmd.toLowerCase(), args: (args || '').trim() };
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

// ---------- Send ----------
async function sendRich(env, chatId, replyToId, html, threadId) {
  const payload = {
    chat_id: chatId,
    rich_message: { html },
    reply_parameters: { message_id: replyToId, allow_sending_without_reply: true },
  };
  if (threadId != null) payload.message_thread_id = threadId;

  let r = await tg(env, 'sendRichMessage', payload);
  if (r.ok) return r;

  console.warn('sendRichMessage(reply) failed:', r.description);
  const p2 = { chat_id: chatId, rich_message: { html } };
  if (threadId != null) p2.message_thread_id = threadId;
  r = await tg(env, 'sendRichMessage', p2);
  return r;
}
async function sendPlain(env, chatId, replyToId, text, threadId) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_parameters: { message_id: replyToId, allow_sending_without_reply: true },
  };
  if (threadId != null) payload.message_thread_id = threadId;
  return tg(env, 'sendMessage', payload);
}

// ---------- Command handlers ----------
async function handleHelp(message, env) {
  await sendPlain(env, message.chat.id, message.message_id,
    '<b>🤖 Rich Message Bot</b>\n\n' +
    '<b>Commands</b>\n' +
    '<code>/rich</code> — reply to a message containing HTML, or pass HTML as the argument\n' +
    '<code>/rich &lt;b&gt;Hello&lt;/b&gt;</code> — convert inline HTML\n' +
    '<code>/ping</code> — health check\n' +
    '<code>/debug</code> — dump the raw update\n' +
    '<code>/help</code> — this message\n\n' +
    '<b>Supported HTML</b> includes <code>&lt;b&gt;</code>, <code>&lt;i&gt;</code>, <code>&lt;u&gt;</code>, ' +
    '<code>&lt;s&gt;</code>, <code>&lt;code&gt;</code>, <code>&lt;a href&gt;</code>, ' +
    '<code>&lt;tg-slideshow&gt;</code>, <code>&lt;tg-collage&gt;</code>, <code>&lt;tg-map&gt;</code>, ' +
    '<code>&lt;tg-button&gt;</code>, <code>&lt;tg-button-row&gt;</code>, <code>&lt;details&gt;</code>, ' +
    '<code>&lt;aside&gt;</code>, <code>&lt;tg-emoji&gt;</code>, and more.',
    message.message_thread_id);
}

async function handlePing(message, env) {
  await sendPlain(env, message.chat.id, message.message_id,
    `🏓 pong\nchat: <code>${escapeHtml(message.chat.id)}</code>\nthread: <code>${escapeHtml(message.message_thread_id ?? '—')}</code>`,
    message.message_thread_id);
}

async function handleDebug(message, env, update) {
  const bot = await getBotInfo(env);
  const text = [
    '<b>🛠 /debug — raw dump</b>',
    `<b>Bot:</b> @${escapeHtml(bot.username || '?')}`,
    `<b>Chat:</b> <code>${escapeHtml(message.chat.id)}</code>`,
    `<b>thread_id:</b> <code>${escapeHtml(message.message_thread_id ?? '—')}</code>`,
    '',
    '<b>── Full update JSON ──</b>',
    `<pre>${escapeHtml(jsonBlock(update, 3600))}</pre>`,
  ].join('\n');
  const CHUNK = 3900;
  for (let i = 0; i < text.length; i += CHUNK) {
    await sendPlain(env, message.chat.id, message.message_id, text.slice(i, i + CHUNK), message.message_thread_id);
  }
}

// ---------- /rich ----------
async function handleRich(message, env, args) {
  const threadId = message.message_thread_id;

  // Source 1: inline HTML after the command
  // Source 2: the message this command is replying to
  const replied     = message.reply_to_message;
  const fromReplied = extractContent(replied);

  let html;
  let replyToId;

  if (args) {
    // /rich <html>
    html = args;
    replyToId = replied ? replied.message_id : message.message_id;
  } else if (fromReplied.html) {
    // /rich as a reply to an HTML message
    html = fromReplied.html;
    replyToId = replied.message_id;
  } else if (replied) {
    // /rich as a reply to a message with no readable content
    await sendPlain(env, message.chat.id, replied.message_id,
      `⚠️ <b>The message you replied to has no readable content.</b>\n` +
      `extracted kind: <code>${escapeHtml(fromReplied.kind)}</code>\n\n` +
      `<b>Raw reply_to_message:</b>\n<pre>${escapeHtml(jsonBlock(replied, 2500))}</pre>`,
      threadId);
    return;
  } else {
    // /rich alone
    await sendPlain(env, message.chat.id, message.message_id,
      '⚠️ <b>Nothing to convert.</b>\n\n' +
      'Either reply to a message containing HTML, or pass the HTML as an argument:\n' +
      '<code>/rich &lt;b&gt;Hello&lt;/b&gt;</code>',
      threadId);
    return;
  }

  if (!html.trim()) {
    await sendPlain(env, message.chat.id, replyToId,
      '⚠️ Empty input after parsing.',
      threadId);
    return;
  }

  if (DEBUG) console.log('rich →', JSON.stringify({ replyToId, threadId, len: html.length }));

  const rich = await sendRich(env, message.chat.id, replyToId, html, threadId);
  if (rich.ok) {
    if (DEBUG) console.log(`sendRichMessage ok msg_id=${rich.result?.message_id}`);
    return;
  }

  console.warn('sendRichMessage failed → fallback to plain:', rich.description);
  const plain = await sendPlain(env, message.chat.id, replyToId, html, threadId);
  if (!plain.ok) {
    await sendPlain(env, message.chat.id, replyToId,
      `<b>❌ All sends failed</b>\n` +
      `rich: <code>${escapeHtml((rich.description || '').slice(0, 200))}</code>\n` +
      `plain: <code>${escapeHtml((plain.description || '').slice(0, 200))}</code>`,
      threadId);
  }
}

// ---------- Main dispatch ----------
async function handle(message, env, update) {
  const bot = await getBotInfo(env);
  const username = bot.username || '';
  const text = message.text || message.caption || '';

  if (DEBUG) console.log('=== update ===', JSON.stringify(update).slice(0, 2200));

  const cmd = parseCommand(text, username);
  if (!cmd) {
    if (DEBUG) console.log('skip: not a command for this bot');
    return;
  }

  switch (cmd.cmd) {
    case 'start':
    case 'help': return handleHelp(message, env);
    case 'ping': return handlePing(message, env);
    case 'debug': return handleDebug(message, env, update);
    case 'rich': return handleRich(message, env, cmd.args);
    default:
      await sendPlain(env, message.chat.id, message.message_id,
        `❓ Unknown command <code>/${escapeHtml(cmd.cmd)}</code>. Try /help.`,
        message.message_thread_id);
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
      } catch (e) { console.error('handler error:', e && e.stack || e); }
      return new Response('OK', { status: 200 });
    }
    return new Response('Not Found', { status: 404 });
  },
};
