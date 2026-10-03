// src/index.js
// Media URL → real media message bot (regular messages, NOT rich messages).
//
//  ▸ PV single media  → replies with a tg:// tag (full file_id), tap-to-copy
//  ▸ PV album         → replies with one tg:// tag per media
//  ▸ /rich <html>     → converts <img>/<video>/<audio>/<a> tags to real media messages
//  ▸ Channels (admin) → auto-converts HTML posts: strips media tags, sends media as replies
//  ▸ /start /ping /debug

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
function stripHtml(s) { return String(s).replace(/<[^>]+>/g, ''); }

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
// RTL detection
// ═══════════════════════════════════════════════════════════════════════
const RTL_CHAR_RE = /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0780-\u07BF\u07C0-\u07FF\u0800-\u083F\u0840-\u085F\u0860-\u086F\u0870-\u089F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LTR_CHAR_RE = /[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]/;
function isRTL(html) {
  const text = String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ');
  let rtl = 0, ltr = 0;
  for (const ch of text) {
    if (RTL_CHAR_RE.test(ch)) rtl++;
    else if (LTR_CHAR_RE.test(ch)) ltr++;
  }
  return rtl > ltr;
}

// ═══════════════════════════════════════════════════════════════════════
// Media classification (PV → tg:// URL)
// ═══════════════════════════════════════════════════════════════════════
function mediaTypeLabel(message) {
  if (Array.isArray(message.photo) && message.photo.length) return 'تصویر';
  if (message.video)        return 'ویدئو';
  if (message.animation)    return 'گیف';
  if (message.video_note)   return 'ویدئوی گرد';
  if (message.document)     return 'سند';
  if (message.audio)        return 'صوت';
  if (message.voice)        return 'پیام صوتی';
  if (message.sticker)      return 'استیکر';
  return 'مدیا';
}

function fullTagFor(message) {
  if (Array.isArray(message.photo) && message.photo.length) {
    const p = message.photo[message.photo.length - 1];
    return { tag: `<img src="tg://photo?id=${p.file_id}"/>`, fileId: p.file_id, kind: 'photo' };
  }
  if (message.video)      return { tag: `<video src="tg://video?id=${message.video.file_id}"/>`, fileId: message.video.file_id, kind: 'video' };
  if (message.animation)  return { tag: `<video src="tg://video?id=${message.animation.file_id}"/>`, fileId: message.animation.file_id, kind: 'video' };
  if (message.video_note) return { tag: `<video src="tg://video?id=${message.video_note.file_id}"/>`, fileId: message.video_note.file_id, kind: 'video' };
  if (message.document) {
    const d = message.document;
    const label = d.file_name || 'document';
    return { tag: `<a href="tg://document?id=${d.file_id}">${escapeHtml(label)}</a>`, fileId: d.file_id, kind: 'document' };
  }
  if (message.audio)      return { tag: `<audio src="tg://audio?id=${message.audio.file_id}"/>`, fileId: message.audio.file_id, kind: 'audio' };
  if (message.voice)      return { tag: `<audio src="tg://audio?id=${message.voice.file_id}"/>`, fileId: message.voice.file_id, kind: 'audio' };
  if (message.sticker)    return { tag: `<img src="tg://photo?id=${message.sticker.file_id}"/>`, fileId: message.sticker.file_id, kind: 'photo' };
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// HTML → parts (text + media). Media URLs become real media messages.
// ═══════════════════════════════════════════════════════════════════════
function attrVal(attrs, name) {
  const re = new RegExp('\\b' + name + '\\s*=\\s*["\']([^"\']*)["\']', 'i');
  const m = String(attrs).match(re);
  return m ? m[1] : null;
}

/**
 * Parse HTML and split into ordered parts:
 *   { type: 'text', html }
 *   { type: 'media', kind: 'photo'|'video'|'audio'|'document', src, label? }
 *
 * Recognized media sources:
 *   <img src="URL|tg://photo?id=..."/>
 *   <video src="URL|tg://video?id=..."></video>
 *   <audio src="URL|tg://audio?id=..."></audio>
 *   <a href="tg://document?id=...">label</a>
 */
function extractMediaParts(html) {
  const parts = [];
  let pos = 0;
  const re = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)\/?>(?:([\s\S]*?)<\/\1>)?/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [full, tagName, attrs, inner] = m;
    const lower = tagName.toLowerCase();

    let src = null;
    let kind = null;
    let label = null;

    if (lower === 'img') {
      src = attrVal(attrs, 'src');
      if (src) kind = 'photo';
    } else if (lower === 'video') {
      src = attrVal(attrs, 'src');
      if (src) kind = 'video';
    } else if (lower === 'audio') {
      src = attrVal(attrs, 'src');
      if (src) kind = 'audio';
    } else if (lower === 'a') {
      const href = attrVal(attrs, 'href');
      if (href) {
        const sm = href.match(/^tg:\/\/(photo|video|audio|document)\?/i);
        if (sm) {
          src = href;
          kind = sm[1].toLowerCase();
          label = inner ? stripHtml(inner).trim() : null;
        }
      }
    }

    if (kind && src) {
      if (m.index > pos) {
        const t = html.slice(pos, m.index);
        if (t.trim()) parts.push({ type: 'text', html: t });
      }
      parts.push({ type: 'media', kind, src, label });
      pos = m.index + full.length;
    }
  }
  if (pos < html.length) {
    const t = html.slice(pos);
    if (t.trim()) parts.push({ type: 'text', html: t });
  }
  return parts;
}

// Keep only tags that Telegram sendMessage with parse_mode=HTML understands.
// Block-level tags get turned into newlines / bullets.
const SENDMESSAGE_SUPPORTED = new Set([
  'b','strong','i','em','u','ins','s','strike','del','code','pre','a','tg-spoiler','blockquote',
]);
function simplifyHtml(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n──────────\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|ul|ol|table|details|summary|figure|figcaption|aside|footer|header|main|section|article|nav|tbody|thead|caption)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<tr\b[^>]*>/gi, '\n')
    .replace(/<t[dh]\b[^>]*>/gi, ' | ')
    .replace(/<(p|div|h[1-6]|ul|ol|table|details|summary|figure|figcaption|aside|footer|header|main|section|article|nav|tbody|thead|caption)\b[^>]*>/gi, '')
    .replace(/<cite\b[^>]*>/gi, '— ')
    .replace(/<\/cite\s*>/gi, '')
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?\/?>/g, (match, tag) => {
      const lower = tag.toLowerCase();
      return SENDMESSAGE_SUPPORTED.has(lower) ? match : '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Extract a Telegram file_id from a tg:// URL, or return null.
function resolveFileId(src) {
  const m = String(src).match(/^tg:\/\/(photo|video|audio|document)\?id=([^&"'\s<>]+)/i);
  return m ? decodeURIComponent(m[2]) : null;
}

// ═══════════════════════════════════════════════════════════════════════
// Senders
// ═══════════════════════════════════════════════════════════════════════
async function sendPlain(env, chatId, replyToId, text, threadId) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  };
  if (replyToId != null) payload.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
  if (threadId != null) payload.message_thread_id = threadId;
  return tg(env, 'sendMessage', payload);
}

/**
 * Send one media part as a real Telegram media message.
 * src can be a public https URL or a tg:// URL (whose file_id will be used).
 */
async function sendMediaPart(env, chatId, part, threadId, replyToId) {
  const fileId = resolveFileId(part.src);
  const ref = fileId || part.src;

  const payload = { chat_id: chatId };
  if (replyToId != null) payload.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
  if (threadId != null) payload.message_thread_id = threadId;

  let method;
  switch (part.kind) {
    case 'photo':    method = 'sendPhoto';    payload.photo    = ref; break;
    case 'video':    method = 'sendVideo';    payload.video    = ref; break;
    case 'audio':    method = 'sendAudio';    payload.audio    = ref; break;
    case 'document': method = 'sendDocument'; payload.document = ref; break;
    default: return null;
  }
  if (part.label) {
    payload.caption = part.label;
    payload.parse_mode = 'HTML';
  }
  return tg(env, method, payload);
}

/**
 * Send all parts in order. Only the first message carries reply_parameters,
 * so multi-part replies don't create a pile of "replying to..." bubbles.
 */
async function sendParts(env, chatId, parts, threadId, replyToId) {
  let first = true;
  for (const part of parts) {
    const rt = first ? replyToId : null;
    if (part.type === 'text') {
      const text = simplifyHtml(part.html);
      if (!text) { continue; }
      const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
      if (rt != null) payload.reply_parameters = { message_id: rt, allow_sending_without_reply: true };
      if (threadId != null) payload.message_thread_id = threadId;
      const r = await tg(env, 'sendMessage', payload);
      if (!r.ok) console.error('[parts] sendMessage failed:', r.description);
    } else if (part.type === 'media') {
      const r = await sendMediaPart(env, chatId, part, threadId, rt);
      if (r && !r.ok) console.error('[parts] media failed:', r.description);
    }
    first = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Album batching (PV only) — send one tg:// tag per line
// ═══════════════════════════════════════════════════════════════════════
const ALBUM_MAP = new Map();

async function processAlbum(entry) {
  if (!entry || !entry.messages || entry.messages.length === 0) return;
  const { messages, chatId, threadId, env } = entry;

  const lines = [];
  for (const msg of messages) {
    const info = fullTagFor(msg);
    if (!info) continue;
    lines.push(`<code>${escapeHtml(info.tag)}</code>`);
  }
  if (lines.length === 0) return;

  const text = lines.join('\n');
  const r = await sendPlain(env, chatId, messages[0].message_id, text, threadId);
  if (!r.ok) console.error('[album] send failed:', r.description);
}

function scheduleAlbumProcessing(message, env, ctx) {
  const groupId = message.media_group_id;
  let entry = ALBUM_MAP.get(groupId);
  if (!entry) {
    entry = {
      messages: [],
      chatId: message.chat.id,
      threadId: message.message_thread_id,
      env,
      scheduled: false,
    };
    ALBUM_MAP.set(groupId, entry);
  }
  entry.messages.push(message);

  if (!entry.scheduled) {
    entry.scheduled = true;
    ctx.waitUntil((async () => {
      await new Promise(r => setTimeout(r, 700));
      const collected = ALBUM_MAP.get(groupId);
      ALBUM_MAP.delete(groupId);
      try { await processAlbum(collected); }
      catch (e) { console.error('[album] processing failed:', e && e.stack || e); }
    })());
  }
}

// ═══════════════════════════════════════════════════════════════════════
// /start
// ═══════════════════════════════════════════════════════════════════════
async function handleStart(message, env) {
  const text =
    '<b>🤖 Media URL → Media bot</b>\n\n' +
    '<b>🔒 در چت خصوصی:</b>\n' +
    'هر مدیای تلگرامی (عکس، ویدیو، گیف، سند، صوت، استیکر) بفرستید — ربات همان لحظه لینک <code>tg://</code> آن را به‌صورت قابل کپی جواب می‌دهد.\n' +
    'اگر چند فایل را به‌صورت آلبوم بفرستید، همه لینک‌ها یک‌جا ارسال می‌شوند.\n\n' +
    '<b>📝 تبدیل HTML به مدیای واقعی:</b>\n' +
    'روی یک پیام HTML ریپلای کنید و <code>/rich</code> بزنید، یا از <code>/rich &lt;html&gt;</code> استفاده کنید.\n' +
    'تگ‌های پشتیبانی‌شده:\n' +
    '  • <code>&lt;img src="URL"/&gt;</code>\n' +
    '  • <code>&lt;video src="URL"/&gt;</code>\n' +
    '  • <code>&lt;audio src="URL"/&gt;</code>\n' +
    '  • <code>&lt;a href="URL"&gt;نام&lt;/a&gt;</code> (برای سند)\n' +
    'همچنین لینک‌های <code>tg://...</code> که از خود ربات گرفته‌اید هم به مدیای واقعی تبدیل می‌شوند.\n\n' +
    '<b>📢 کانال:</b>\n' +
    'ربات را در کانال ادمین کنید؛ پست‌های HTML به‌صورت خودکار به مدیا تبدیل می‌شوند.\n\n' +
    '<b>دستورات:</b> /start /ping /debug /rich';

  const r = await sendPlain(env, message.chat.id, message.message_id, text, message.message_thread_id);
  if (!r.ok) console.error('/start failed:', r.description);
}

// ═══════════════════════════════════════════════════════════════════════
// PV single media → tg:// tag
// ═══════════════════════════════════════════════════════════════════════
async function handleMediaPV(message, env) {
  if (message.chat.type !== 'private') return false;
  const info = fullTagFor(message);
  if (!info) return false;

  const text = `<code>${escapeHtml(info.tag)}</code>`;
  const r = await sendPlain(env, message.chat.id, message.message_id, text, message.message_thread_id);
  if (!r.ok) console.error('media send failed:', r.description);
  return true;
}

// ═══════════════════════════════════════════════════════════════════════
// Commands
// ═══════════════════════════════════════════════════════════════════════
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
      `⚠️ پیام ریپلای‌شده محتوای خواندنی ندارد (kind: <code>${escapeHtml(fromReplied.kind)}</code>).`,
      threadId);
    return;
  } else {
    await sendPlain(env, message.chat.id, message.message_id,
      '⚠️ چیزی برای تبدیل نیست. روی یک پیام HTML ریپلای کنید، یا از <code>/rich &lt;b&gt;Hi&lt;/b&gt;</code> استفاده کنید.',
      threadId);
    return;
  }
  if (!html.trim()) return;

  const parts = extractMediaParts(html);
  const hasMedia = parts.some(p => p.type === 'media');

  if (!hasMedia) {
    // Just a plain formatted text message.
    const text = simplifyHtml(html);
    if (!text) return;
    await sendPlain(env, message.chat.id, replyToId, text, threadId);
    return;
  }

  await sendParts(env, message.chat.id, parts, threadId, replyToId);
}

// ═══════════════════════════════════════════════════════════════════════
// Channel auto-convert
// ═══════════════════════════════════════════════════════════════════════
async function handleChannelPost(post, env, isEdit) {
  const chatId = post.chat.id;
  const msgId  = post.message_id;

  if (post.from?.is_bot)      return;
  if (!post.text)             return;
  if (!hasHtmlTag(post.text)) return;

  const parts = extractMediaParts(post.text);
  const mediaParts = parts.filter(p => p.type === 'media');
  if (mediaParts.length === 0) return;

  const textOnly = parts.filter(p => p.type === 'text').map(p => p.html).join('');
  const textHtml = simplifyHtml(textOnly);

  if (textHtml) {
    // Edit the post so it keeps the text, then reply with the media.
    const edit = await tg(env, 'editMessageText', {
      chat_id: chatId,
      message_id: msgId,
      text: textHtml,
      parse_mode: 'HTML',
    });
    if (!edit.ok) console.error('[channel] edit failed:', edit.description);

    for (const part of mediaParts) {
      const r = await sendMediaPart(env, chatId, part, undefined, msgId);
      if (r && !r.ok) console.error('[channel] media failed:', r.description);
    }
  } else {
    // Nothing left after stripping media tags → delete the post, send media.
    const del = await tg(env, 'deleteMessage', { chat_id: chatId, message_id: msgId });
    if (!del.ok) console.error('[channel] delete failed:', del.description);

    for (const part of mediaParts) {
      const r = await sendMediaPart(env, chatId, part, undefined, undefined);
      if (r && !r.ok) console.error('[channel] media failed:', r.description);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Dispatch
// ═══════════════════════════════════════════════════════════════════════
async function handleMessage(message, env, update, ctx) {
  const bot = await getBotInfo(env);
  const botId = bot.id;
  const username = bot.username || '';

  // Album (multiple media) in PV → reply with all tg:// tags
  if (message.chat.type === 'private' && message.media_group_id) {
    if (DEBUG) console.log('[album] queued msg', message.message_id, 'group', message.media_group_id);
    scheduleAlbumProcessing(message, env, ctx);
    return;
  }

  // Single PV media → tg:// tag
  if (await handleMediaPV(message, env)) return;

  if (message.reply_to_message?.from?.id === botId) return;

  const text = message.text || message.caption || '';
  const cmd = parseCommand(text, username);
  if (!cmd) return;

  switch (cmd.cmd) {
    case 'start': return handleStart(message, env);
    case 'ping':  return handlePing(message, env);
    case 'debug': return handleDebug(message, env, update);
    case 'rich':  return handleRich(message, env, cmd.args, botId);
    default:
      await sendPlain(env, message.chat.id, message.message_id,
        `❓ دستور ناشناخته <code>/${escapeHtml(cmd.cmd)}</code>. /start را امتحان کنید.`,
        message.message_thread_id);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Worker
// ═══════════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('✅ Bot running.', { status: 200 });
    }

    if (request.method === 'POST' && url.pathname === '/webhook') {
      let update;
      try { update = await request.json(); }
      catch { return new Response('Bad JSON', { status: 400 }); }

      try {
        if (update.channel_post)        await handleChannelPost(update.channel_post, env, false);
        else if (update.edited_channel_post) await handleChannelPost(update.edited_channel_post, env, true);
        else if (update.message || update.edited_message)
          await handleMessage(update.message || update.edited_message, env, update, ctx);
      } catch (e) {
        console.error('handler error:', e && e.stack || e);
      }
      return new Response('OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  },
};
