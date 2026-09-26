// src/index.js
// Rich Message bot.
//
//  ▸ PV media        → replies with a REGULAR message containing file_id,
//                       tg:// link, and the HTML embed, each in <code>
//                       blocks so a tap copies them.
//  ▸ Channels (admin) → auto-edits HTML posts into rich messages
//  ▸ Groups / DMs     → /rich, /ping, /debug, /help

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
// Media description
// ═══════════════════════════════════════════════════════════════════════
function describeMedia(message) {
  if (Array.isArray(message.photo) && message.photo.length) {
    const p = message.photo[message.photo.length - 1];
    return {
      emoji: '📷', type: 'Photo',
      fileId: p.file_id, uniqueId: p.file_unique_id,
      meta: [['width', p.width], ['height', p.height], ['file_size', p.file_size]],
      tgLink: `tg://photo?id=${p.file_id}`,
      embed: `<img src="tg://photo?id=${p.file_id}"/>`,
    };
  }
  if (message.video) {
    const v = message.video;
    return {
      emoji: '🎥', type: 'Video',
      fileId: v.file_id, uniqueId: v.file_unique_id,
      meta: [
        ['width', v.width], ['height', v.height], ['duration', v.duration],
        ['mime_type', v.mime_type], ['file_name', v.file_name], ['file_size', v.file_size],
      ],
      tgLink: `tg://video?id=${v.file_id}`,
      embed: `<video src="tg://video?id=${v.file_id}"/>`,
    };
  }
  if (message.animation) {
    const a = message.animation;
    return {
      emoji: '🎞', type: 'Animation',
      fileId: a.file_id, uniqueId: a.file_unique_id,
      meta: [
        ['width', a.width], ['height', a.height], ['duration', a.duration],
        ['mime_type', a.mime_type], ['file_name', a.file_name], ['file_size', a.file_size],
      ],
      tgLink: `tg://video?id=${a.file_id}`,
      embed: `<video src="tg://video?id=${a.file_id}"/>`,
    };
  }
  if (message.video_note) {
    const vn = message.video_note;
    return {
      emoji: '⭕', type: 'Video note',
      fileId: vn.file_id, uniqueId: vn.file_unique_id,
      meta: [['length', vn.length], ['duration', vn.duration], ['file_size', vn.file_size]],
      tgLink: `tg://video?id=${vn.file_id}`,
      embed: `<video src="tg://video?id=${vn.file_id}"/>`,
    };
  }
  if (message.document) {
    const d = message.document;
    const label = d.file_name || 'document';
    return {
      emoji: '📄', type: 'Document',
      fileId: d.file_id, uniqueId: d.file_unique_id,
      meta: [['file_name', d.file_name], ['mime_type', d.mime_type], ['file_size', d.file_size]],
      tgLink: `tg://document?id=${d.file_id}`,
      embed: `<a href="tg://document?id=${d.file_id}">${escapeHtml(label)}</a>`,
    };
  }
  if (message.audio) {
    const a = message.audio;
    return {
      emoji: '🎵', type: 'Audio',
      fileId: a.file_id, uniqueId: a.file_unique_id,
      meta: [
        ['duration', a.duration], ['performer', a.performer], ['title', a.title],
        ['mime_type', a.mime_type], ['file_name', a.file_name], ['file_size', a.file_size],
      ],
      tgLink: `tg://audio?id=${a.file_id}`,
      embed: `<audio src="tg://audio?id=${a.file_id}"/>`,
    };
  }
  if (message.voice) {
    const v = message.voice;
    return {
      emoji: '🎤', type: 'Voice',
      fileId: v.file_id, uniqueId: v.file_unique_id,
      meta: [['duration', v.duration], ['mime_type', v.mime_type], ['file_size', v.file_size]],
      tgLink: `tg://audio?id=${v.file_id}`,
      embed: `<audio src="tg://audio?id=${v.file_id}"/>`,
    };
  }
  if (message.sticker) {
    const s = message.sticker;
    return {
      emoji: '🏷', type: 'Sticker',
      fileId: s.file_id, uniqueId: s.file_unique_id,
      meta: [
        ['type', s.type], ['width', s.width], ['height', s.height],
        ['emoji', s.emoji], ['set_name', s.set_name],
        ['is_animated', s.is_animated], ['is_video', s.is_video], ['file_size', s.file_size],
      ],
      tgLink: `tg://sticker?id=${s.file_id}`,
      embed: `<img src="tg://sticker?id=${s.file_id}"/>`,
    };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// Senders
// ═══════════════════════════════════════════════════════════════════════
async function sendRich(env, chatId, replyToId, html, threadId) {
  const payload = {
    chat_id: chatId,
    rich_message: { html },
    reply_parameters: { message_id: replyToId, allow_sending_without_reply: true },
  };
  if (threadId != null) payload.message_thread_id = threadId;
  let r = await tg(env, 'sendRichMessage', payload);
  if (r.ok) return r;
  const p2 = { chat_id: chatId, rich_message: { html } };
  if (threadId != null) p2.message_thread_id = threadId;
  return tg(env, 'sendRichMessage', p2);
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
// PV media handler — REGULAR message, tap-to-copy code blocks
// ═══════════════════════════════════════════════════════════════════════
async function handleMediaPV(message, env) {
  if (message.chat.type !== 'private') return false;

  const m = describeMedia(message);
  if (!m) return false;

  const lines = [];
  lines.push(`${m.emoji} <b>${m.type}</b>`);
  lines.push('');
  lines.push('<b>file_id</b>');
  lines.push(`<code>${escapeHtml(m.fileId)}</code>`);
  lines.push('');
  lines.push('<b>file_unique_id</b>');
  lines.push(`<code>${escapeHtml(m.uniqueId)}</code>`);

  const meta = m.meta.filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (meta.length) {
    lines.push('');
    lines.push('<b>meta</b>');
    for (const [k, v] of meta) {
      lines.push(`${escapeHtml(k)}: <code>${escapeHtml(v)}</code>`);
    }
  }

  lines.push('');
  lines.push('<b>tg:// link</b>');
  lines.push(`<code>${escapeHtml(m.tgLink)}</code>`);
  lines.push('');
  lines.push('<b>HTML embed</b>');
  lines.push(`<code>${escapeHtml(m.embed)}</code>`);

  const text = lines.join('\n');

  // Always a regular message now — no rich send.
  const r = await sendPlain(env, message.chat.id, message.message_id, text, message.message_thread_id);
  if (!r.ok) console.error('media send failed:', r.description);
  return true;
}

// ═══════════════════════════════════════════════════════════════════════
// Group commands
// ═══════════════════════════════════════════════════════════════════════
async function handleHelp(message, env) {
  await sendPlain(env, message.chat.id, message.message_id,
    '<b>🤖 Rich Message Bot</b>\n\n' +
    '<b>Channels</b> — post HTML, bot edits it into a rich message.\n\n' +
    '<b>Groups / DMs</b>\n' +
    '<code>/rich</code> reply to HTML, or <code>/rich &lt;b&gt;Hi&lt;/b&gt;</code>\n' +
    '<code>/ping</code> <code>/debug</code> <code>/help</code>\n\n' +
    '<b>PV media</b> — send any photo/video/audio/document; the bot replies with its file_id, tg:// link, and HTML embed.',
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

  const rich = await sendRich(env, message.chat.id, replyToId, html, threadId);
  if (rich.ok) return;
  await sendPlain(env, message.chat.id, replyToId, html, threadId);
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

  const edit = await tg(env, 'editMessageText', {
    chat_id: chatId,
    message_id: msgId,
    rich_message: { html: post.text },
  });
  if (edit.ok) console.log('[channel] rich edit ok');
  else         console.error('[channel] edit failed:', edit.description);
}

// ═══════════════════════════════════════════════════════════════════════
// Group / DM dispatch
// ═══════════════════════════════════════════════════════════════════════
async function handleMessage(message, env, update) {
  const bot = await getBotInfo(env);
  const botId = bot.id;
  const username = bot.username || '';

  if (DEBUG) console.log('=== msg update ===', JSON.stringify(update).slice(0, 2200));

  // PV media → file_id report as a plain message
  if (await handleMediaPV(message, env)) return;

  // Guard: never react to replies to the bot itself
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
