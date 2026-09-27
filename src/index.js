// src/index.js
// Rich Message bot — no cache, no Map.
//
//  ▸ PV media         → replies with a tag using the raw file_id
//  ▸ /rich with tag    → parses tag, builds media array, sends rich
//  ▸ Channels (admin) → auto-edits HTML posts into rich messages
//
// The tag carries everything needed. No id↔file_id mapping anywhere.

const DEBUG = true;

// ═══════════════════════════════════════════════════════════════════════
// Telegram plumbing
// ═══════════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function jsonBlock(obj, max = 3000) {
  let s; try { s = JSON.stringify(obj, null, 2); } catch { s = String(obj); }
  if (s.length > max) s = s.slice(0, max) + `\n…[+${s.length - max}]`;
  return s;
}
const HTML_TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?\/?>/;
function hasHtmlTag(text) {
  return typeof text === 'string' && HTML_TAG_RE.test(text);
}
function parseCommand(text, botUsername) {
  if (!text) return null;
  const m = text.match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const [, cmd, target, args] = m;
  if (target && target.toLowerCase() !== (botUsername || '').toLowerCase()) return null;
  return { cmd: cmd.toLowerCase(), args: (args || '').trim() };
}
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

// ═══════════════════════════════════════════════════════════════════════
// Parse tg:// links → media array (id IS the file_id)
// ═══════════════════════════════════════════════════════════════════════
function buildMediaArray(html) {
  const media = [];
  const seen = new Set();

  // Grab `tg://<kind>?id=<value>` — value is the file_id (URL-encoded)
  const re = /tg:\/\/(photo|video|audio|document)\?id=([^"'\s&<>]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const kind = m[1];
    const fileId = decodeURIComponent(m[2]);
    if (seen.has(fileId)) continue;
    seen.add(fileId);

    media.push({
      id: fileId,                                     // used in the tg:// tag
      media: { type: kind, media: fileId },           // same value = the file
    });
  }
  return media;
}

// ═══════════════════════════════════════════════════════════════════════
// Media → tag (file_id is the id — no mapping layer)
// ═══════════════════════════════════════════════════════════════════════
function mediaTag(message) {
  if (Array.isArray(message.photo) && message.photo.length) {
    const p = message.photo[message.photo.length - 1];
    return `<img src="tg://photo?id=${encodeURIComponent(p.file_id)}"/>`;
  }
  if (message.video) {
    return `<video src="tg://video?id=${encodeURIComponent(message.video.file_id)}"/>`;
  }
  if (message.animation) {
    return `<video src="tg://video?id=${encodeURIComponent(message.animation.file_id)}"/>`;
  }
  if (message.video_note) {
    return `<video src="tg://video?id=${encodeURIComponent(message.video_note.file_id)}"/>`;
  }
  if (message.document) {
    const d = message.document;
    const label = d.file_name || 'document';
    return `<a href="tg://document?id=${encodeURIComponent(d.file_id)}">${escapeHtml(label)}</a>`;
  }
  if (message.audio) {
    return `<audio src="tg://audio?id=${encodeURIComponent(message.audio.file_id)}"/>`;
  }
  if (message.voice) {
    return `<audio src="tg://audio?id=${encodeURIComponent(message.voice.file_id)}"/>`;
  }
  if (message.sticker) {
    return `<img src="tg://photo?id=${encodeURIComponent(message.sticker.file_id)}"/>`;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// Senders
// ═══════════════════════════════════════════════════════════════════════
async function sendRich(env, chatId, replyToId, richMessage, threadId) {
  const payload = {
    chat_id: chatId,
    rich_message: richMessage,
    reply_parameters: { message_id: replyToId, allow_sending_without_reply: true },
  };
  if (threadId != null) payload.message_thread_id = threadId;

  console.log('[sendRich] request:', JSON.stringify(payload).slice(0, 1200));
  const r = await tg(env, 'sendRichMessage', payload);
  console.log('[sendRich] response:', JSON.stringify(r).slice(0, 800));
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

// ═══════════════════════════════════════════════════════════════════════
// PV media handler
// ═══════════════════════════════════════════════════════════════════════
async function handleMediaPV(message, env) {
  if (message.chat.type !== 'private') return false;

  const tag = mediaTag(message);
  if (!tag) return false;

  const text = `<code>${escapeHtml(tag)}</code>`;
  const r = await sendPlain(env, message.chat.id, message.message_id, text, message.message_thread_id);
  if (!r.ok) console.error('media send failed:', r.description);
  return true;
}

// ═══════════════════════════════════════════════════════════════════════
// Commands
// ═══════════════════════════════════════════════════════════════════════
async function handleHelp(message, env) {
  await sendPlain(env, message.chat.id, message.message_id,
    '<b>🤖 Rich Message Bot</b>\n\n' +
    '<b>PV media</b> — send a photo/video/audio/document; the bot replies with a self-contained tag.\n' +
    'Convert it with <code>/rich &lt;tag&gt;</code>, no lookup needed.\n\n' +
    '<b>Groups / DMs</b>\n' +
    '<code>/rich</code> reply to HTML, or <code>/rich &lt;b&gt;Hi&lt;/b&gt;</code>\n' +
    '<code>/ping</code> <code>/debug</code> <code>/help</code>',
    message.message_thread_id);
}
async function handlePing(message, env) {
  await sendPlain(env, message.chat.id, message.message_id,
    `🏓 pong\nchat: <code>${escapeHtml(message.chat.id)}</code>`,
    message.message_thread_id);
}
async function handleDebug(message, env, update) {
  const bot = await getBotInfo(env);
  const text = [
    '<b>🛠 /debug — raw dump</b>',
    `<b>Bot:</b> @${escapeHtml(bot.username || '?')}`,
    `<b>Chat:</b> <code>${escapeHtml(message.chat.id)}</code>`,
    '',
    '<b>── Full update JSON ──</b>',
    `<pre>${escapeHtml(jsonBlock(update, 3600))}</pre>`,
  ].join('\n');
  const CHUNK = 3900;
  for (let i = 0; i < text.length; i += CHUNK) {
    await sendPlain(env, message.chat.id, message.message_id, text.slice(i, i + CHUNK), message.message_thread_id);
  }
}

async function handleRich(message, env, args, botId) {
  const threadId = message.message_thread_id;
  const replied = message.reply_to_message;
  if (replied?.from?.id === botId) return;

  const fromReplied = extractContent(replied);
  let html, replyToId;
  if (args) {
    html = args;
    replyToId = replied ? replied.message_id : message.message_id;
  } else if (fromReplied.html) {
    html = fromReplied.html;
    replyToId = replied.message_id;
  } else if (replied) {
    await sendPlain(env, message.chat.id, replied.message_id,
      `⚠️ Replied-to message has no readable content (kind: <code>${escapeHtml(fromReplied.kind)}</code>).`,
      threadId);
    return;
  } else {
    await sendPlain(env, message.chat.id, message.message_id,
      '⚠️ Nothing to convert. Reply to HTML, or use <code>/rich &lt;b&gt;Hi&lt;/b&gt;</code>.',
      threadId);
    return;
  }
  if (!html.trim()) return;

  const richMessage = { html };
  const media = buildMediaArray(html);
  if (media.length) richMessage.media = media;

  console.log('[handleRich] richMessage:', JSON.stringify(richMessage).slice(0, 1200));

  const rich = await sendRich(env, message.chat.id, replyToId, richMessage, threadId);
  if (rich.ok) {
    console.log('[handleRich] success');
    return;
  }

  // Rich failed — show exactly why
  const errText =
    `❌ <b>sendRichMessage failed</b>\n` +
    `description: <code>${escapeHtml((rich.description || 'none').slice(0, 400))}</code>\n` +
    `error_code: <code>${escapeHtml(rich.error_code ?? '—')}</code>\n\n` +
    `<b>Payload sent:</b>\n<pre>${escapeHtml(jsonBlock(richMessage, 900))}</pre>`;

  await sendPlain(env, message.chat.id, replyToId, errText, threadId);
}

// ═══════════════════════════════════════════════════════════════════════
// Channel auto-convert
// ═══════════════════════════════════════════════════════════════════════
async function handleChannelPost(post, env, isEdit) {
  const chatId = post.chat.id;
  const msgId  = post.message_id;

  console.log(`[channel] ${isEdit ? 'EDIT' : 'POST'} chat=${chatId} msg=${msgId} ` +
    `is_bot=${!!post.from?.is_bot} has_text=${!!post.text} has_rich=${!!post.rich_message}`);

  if (post.rich_message)      { console.log('[channel] skip: already rich'); return; }
  if (post.from?.is_bot)      { console.log('[channel] skip: authored by bot'); return; }
  if (!post.text)             { console.log('[channel] skip: no text'); return; }
  if (!hasHtmlTag(post.text)) { console.log('[channel] skip: no HTML tag'); return; }

  const richMessage = { html: post.text };
  const media = buildMediaArray(post.text);
  if (media.length) richMessage.media = media;

  const edit = await tg(env, 'editMessageText', {
    chat_id: chatId,
    message_id: msgId,
    rich_message: richMessage,
  });
  if (edit.ok) console.log('[channel] rich edit ok');
  else         console.error('[channel] edit failed:', edit.description);
}

// ═══════════════════════════════════════════════════════════════════════
// Dispatch
// ═══════════════════════════════════════════════════════════════════════
async function handleMessage(message, env, update) {
  const bot = await getBotInfo(env);
  const botId = bot.id;
  const username = bot.username || '';

  if (DEBUG) console.log('=== msg update ===', JSON.stringify(update).slice(0, 2200));

  if (await handleMediaPV(message, env)) return;

  if (message.reply_to_message?.from?.id === botId) return;

  const text = message.text || message.caption || '';
  const cmd = parseCommand(text, username);
  if (!cmd) return;

  switch (cmd.cmd) {
    case 'start':
    case 'help': return handleHelp(message, env);
    case 'ping': return handlePing(message, env);
    case 'debug': return handleDebug(message, env, update);
    case 'rich': return handleRich(message, env, cmd.args, botId);
    default:
      await sendPlain(env, message.chat.id, message.message_id,
        `❓ Unknown command <code>/${escapeHtml(cmd.cmd)}</code>. Try /help.`,
        message.message_thread_id);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Worker
// ═══════════════════════════════════════════════════════════════════════
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
        if (update.channel_post)             await handleChannelPost(update.channel_post, env, false);
        else if (update.edited_channel_post) await handleChannelPost(update.edited_channel_post, env, true);
        else if (update.message || update.edited_message)
          await handleMessage(update.message || update.edited_message, env, update);
      } catch (e) {
        console.error('handler error:', e && e.stack || e);
      }
      return new Response('OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  },
};
