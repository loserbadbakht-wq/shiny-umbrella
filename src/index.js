// src/index.js
// Media URL → real media message bot (regular messages, NOT rich messages).
//
//  ▸ PV single media  → replies with a bare tg:// URL, tap-to-copy
//  ▸ PV album         → replies with one bare tg:// URL per media
//  ▸ /rich <text>     → detects bare tg:// URLs, tries edit-in-place, else sends media message(s)
//  ▸ Channels (admin) → detects bare tg:// URLs, tries edit-in-place, else delete + send media message(s)
//  ▸ /start /ping /debug
//
//  ▸ Multi-media attempts are mirrored to DEBUG_CHAT_ID for troubleshooting.

const DEBUG = true;
const DEBUG_CHAT_ID = 302287170;

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
// Basic helpers
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
const TG_MEDIA_URL_RE = /tg:\/\/(?:photo|video|audio|document)\?id=[A-Za-z0-9_-]+/i;
function hasTgMediaUrl(text) {
  return typeof text === 'string' && TG_MEDIA_URL_RE.test(text);
}
function isTgMediaSrc(src) {
  return /^tg:\/\/(photo|video|audio|document)\?id=[A-Za-z0-9_-]+/i.test(String(src));
}

function parseCommand(text, botUsername) {
  if (!text) return null;
  const m = text.match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const [, cmd, target, args] = m;
  if (target && target.toLowerCase() !== (botUsername || '').toLowerCase()) return null;
  return { cmd: cmd.toLowerCase(), args: (args || '').trim() };
}

// ═══════════════════════════════════════════════════════════════════════
// Debug forwarder
// ═══════════════════════════════════════════════════════════════════════
async function sendDebugReport(env, title, lines) {
  const header = `<b>🛠 ${escapeHtml(title)}</b>\n`;
  const body = lines.map(escapeHtml).join('\n');
  const full = header + body;
  const CHUNK = 3900;
  for (let i = 0; i < full.length; i += CHUNK) {
    const part = full.slice(i, i + CHUNK);
    const r = await tg(env, 'sendMessage', {
      chat_id: DEBUG_CHAT_ID,
      text: part,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    if (!r.ok) console.error('[debug-report] send failed:', r.description);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Entities → HTML  (preserves links & styling)
// ═══════════════════════════════════════════════════════════════════════
function entityToTags(ent) {
  switch (ent.type) {
    case 'bold':        return ['<b>', '</b>'];
    case 'italic':      return ['<i>', '</i>'];
    case 'underline':   return ['<u>', '</u>'];
    case 'strikethrough': return ['<s>', '</s>'];
    case 'spoiler':     return ['<tg-spoiler>', '</tg-spoiler>'];
    case 'code':        return ['<code>', '</code>'];
    case 'pre': {
      const lang = ent.language;
      if (lang) return [`<pre><code class="language-${escapeHtml(lang)}">`, '</code></pre>'];
      return ['<pre>', '</pre>'];
    }
    case 'text_link':
      return [`<a href="${escapeHtml(ent.url || '')}">`, '</a>'];
    case 'text_mention':
      return ent.user?.id
        ? [`<a href="tg://user?id=${ent.user.id}">`, '</a>']
        : null;
    case 'blockquote':            return ['<blockquote>', '</blockquote>'];
    case 'expandable_blockquote': return ['<blockquote expandable>', '</blockquote>'];
    default:
      return null;
  }
}

function entitiesToHtml(text, entities) {
  if (!entities || !entities.length) return escapeHtml(text);

  const opens = new Map();
  const closes = new Map();
  const sorted = [...entities]
    .filter(e => entityToTags(e))
    .sort((a, b) => a.offset - b.offset || b.length - a.length);

  for (const ent of sorted) {
    const tags = entityToTags(ent);
    if (!tags) continue;
    const start = ent.offset;
    const end = ent.offset + ent.length;
    if (start < 0 || end > text.length || start >= end) continue;
    if (!opens.has(start)) opens.set(start, []);
    opens.get(start).push(tags[0]);
    if (!closes.has(end)) closes.set(end, []);
    closes.get(end).unshift(tags[1]);
  }

  let result = '';
  const len = text.length;
  for (let i = 0; i <= len; i++) {
    const c = closes.get(i); if (c) result += c.join('');
    const o = opens.get(i);  if (o) result += o.join('');
    if (i < len) result += escapeHtml(text[i]);
  }
  return result;
}

function getStyledHtml(text, entities) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw) return '';
  if (hasHtmlTag(raw)) return raw;
  if (!entities || !entities.length) return escapeHtml(raw);
  return entitiesToHtml(raw, entities);
}

function extractContent(msg) {
  if (!msg) return { html: '', kind: 'none' };
  if (typeof msg.text === 'string' && msg.text.length) {
    return { html: getStyledHtml(msg.text, msg.entities), kind: 'text' };
  }
  if (typeof msg.caption === 'string' && msg.caption.length) {
    return { html: getStyledHtml(msg.caption, msg.caption_entities), kind: 'caption' };
  }
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
  const text = String(html).replace(/<[^>]+>/g, ' ').replace(/&#\d+;/g, ' ').replace(/&[a-z]+;/gi, ' ');
  let rtl = 0, ltr = 0;
  for (const ch of text) {
    if (RTL_CHAR_RE.test(ch)) rtl++;
    else if (LTR_CHAR_RE.test(ch)) ltr++;
  }
  return rtl > ltr;
}

// ═══════════════════════════════════════════════════════════════════════
// PV: media → bare tg:// URL
// ═══════════════════════════════════════════════════════════════════════
function fullTagFor(message) {
  if (Array.isArray(message.photo) && message.photo.length) {
    const p = message.photo[message.photo.length - 1];
    return { tag: `tg://photo?id=${p.file_id}`, fileId: p.file_id, kind: 'photo' };
  }
  if (message.video)      return { tag: `tg://video?id=${message.video.file_id}`, fileId: message.video.file_id, kind: 'video' };
  if (message.animation)  return { tag: `tg://video?id=${message.animation.file_id}`, fileId: message.animation.file_id, kind: 'video' };
  if (message.video_note) return { tag: `tg://video?id=${message.video_note.file_id}`, fileId: message.video_note.file_id, kind: 'video' };
  if (message.document)   return { tag: `tg://document?id=${message.document.file_id}`, fileId: message.document.file_id, kind: 'document' };
  if (message.audio)      return { tag: `tg://audio?id=${message.audio.file_id}`, fileId: message.audio.file_id, kind: 'audio' };
  if (message.voice)      return { tag: `tg://audio?id=${message.voice.file_id}`, fileId: message.voice.file_id, kind: 'audio' };
  if (message.sticker)    return { tag: `tg://photo?id=${message.sticker.file_id}`, fileId: message.sticker.file_id, kind: 'photo' };
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// Text → parts (text + media). Matches ONLY bare tg://…id=… URLs.
// ═══════════════════════════════════════════════════════════════════════
function extractMediaParts(text) {
  const parts = [];
  const re = /tg:\/\/(photo|video|audio|document)\?id=[A-Za-z0-9_-]+/gi;
  let pos = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > pos) {
      const t = text.slice(pos, m.index);
      if (t.trim()) parts.push({ type: 'text', html: t });
    }
    parts.push({ type: 'media', kind: m[1].toLowerCase(), src: m[0], label: null });
    pos = m.index + m[0].length;
  }
  if (pos < text.length) {
    const t = text.slice(pos);
    if (t.trim()) parts.push({ type: 'text', html: t });
  }
  return parts;
}

// ═══════════════════════════════════════════════════════════════════════
// Simplify HTML for captions / messages
// ═══════════════════════════════════════════════════════════════════════
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

function resolveFileId(src) {
  const m = String(src).match(/^tg:\/\/(photo|video|audio|document)\?id=([^&"'\s<>]+)/i);
  return m ? decodeURIComponent(m[2]) : null;
}

// ═══════════════════════════════════════════════════════════════════════
// Senders
// ═══════════════════════════════════════════════════════════════════════
async function sendPlain(env, chatId, replyToId, text, threadId) {
  const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (replyToId != null) payload.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
  if (threadId != null) payload.message_thread_id = threadId;
  return tg(env, 'sendMessage', payload);
}

function buildSingleMediaPayload(chatId, part, caption, threadId, replyToId) {
  const fileId = resolveFileId(part.src);
  if (!fileId) return null;
  const payload = { chat_id: chatId };
  let method;
  switch (part.kind) {
    case 'photo':    method = 'sendPhoto';    payload.photo    = fileId; break;
    case 'video':    method = 'sendVideo';    payload.video    = fileId; break;
    case 'audio':    method = 'sendAudio';    payload.audio    = fileId; break;
    case 'document': method = 'sendDocument'; payload.document = fileId; break;
    default: return null;
  }
  if (caption) { payload.caption = caption; payload.parse_mode = 'HTML'; }
  if (replyToId != null) payload.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
  if (threadId != null) payload.message_thread_id = threadId;
  return { method, payload };
}

async function sendSingleMedia(env, chatId, part, caption, threadId, replyToId) {
  const p = buildSingleMediaPayload(chatId, part, caption, threadId, replyToId);
  if (!p) return null;
  const r = await tg(env, p.method, p.payload);
  if (!r.ok) console.error('[send] single media failed:', r.description);
  return r;
}

async function sendAlbum(env, chatId, mediaParts, caption, threadId, replyToId) {
  const chunks = [];
  for (let i = 0; i < mediaParts.length; i += 10) chunks.push(mediaParts.slice(i, i + 10));
  let isFirstChunk = true;
  let firstResult = null;
  for (const chunk of chunks) {
    const media = [];
    for (let idx = 0; idx < chunk.length; idx++) {
      const part = chunk[idx];
      const fileId = resolveFileId(part.src);
      if (!fileId) continue;
      const entry = { type: part.kind, media: fileId };
      if (isFirstChunk && idx === 0 && caption) {
        entry.caption = caption;
        entry.parse_mode = 'HTML';
      }
      media.push(entry);
    }
    if (!media.length) { isFirstChunk = false; continue; }
    const payload = { chat_id: chatId, media };
    if (isFirstChunk && replyToId != null) payload.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
    if (threadId != null) payload.message_thread_id = threadId;
    const r = await tg(env, 'sendMediaGroup', payload);
    if (!r.ok) console.error('[send] sendMediaGroup failed:', r.description);
    if (isFirstChunk) firstResult = r;
    isFirstChunk = false;
  }
  return firstResult;
}

// ═══════════════════════════════════════════════════════════════════════
// In-place edit — probes multiple API shapes for multi-media.
// When mediaParts.length > 1, the full transcript (payloads + responses)
// is forwarded to DEBUG_CHAT_ID.
// ═══════════════════════════════════════════════════════════════════════
function buildFlatInputMedia(part, caption, withCaption) {
  const fileId = resolveFileId(part.src);
  if (!fileId) return null;
  const entry = { type: part.kind, media: fileId };
  if (withCaption && caption) { entry.caption = caption; entry.parse_mode = 'HTML'; }
  return entry;
}

function buildRichInputMedia(part, idx, caption, withCaption) {
  const fileId = resolveFileId(part.src);
  if (!fileId) return null;
  const inner = { type: part.kind, media: fileId };
  if (withCaption && caption) { inner.caption = caption; inner.parse_mode = 'HTML'; }
  return { id: 'm' + idx, media: inner };
}

async function tryEditTextToMedia(env, chatId, msgId, mediaParts, caption, contextLabel) {
  if (!Array.isArray(mediaParts)) mediaParts = [mediaParts];
  if (!mediaParts.length) return false;
  for (const p of mediaParts) if (!isTgMediaSrc(p.src)) return false;

  // ── Single media: known to work ──
  if (mediaParts.length === 1) {
    const entry = buildFlatInputMedia(mediaParts[0], caption, true);
    if (!entry) return false;
    const r = await tg(env, 'editMessageMedia', { chat_id: chatId, message_id: msgId, media: entry });
    if (r.ok) return true;
    console.error('[edit/single] refused:', r.description);
    return false;
  }

  // ── Multi media: build both styles ──
  const flatArr = mediaParts.map((p, i) => buildFlatInputMedia(p, caption, i === 0)).filter(Boolean);
  const richArr = mediaParts.map((p, i) => buildRichInputMedia(p, i, caption, i === 0)).filter(Boolean);
  if (!flatArr.length || !richArr.length) return false;

  const shapes = [
    { name: 'emm/media:flat',        method: 'editMessageMedia',        payload: { chat_id: chatId, message_id: msgId, media: flatArr } },
    { name: 'emm/medias:flat',       method: 'editMessageMedia',        payload: { chat_id: chatId, message_id: msgId, medias: flatArr } },
    { name: 'emm/media:mg_obj',      method: 'editMessageMedia',        payload: { chat_id: chatId, message_id: msgId, media: { type: 'media_group', media: flatArr } } },
    { name: 'emm/media_group:flat',  method: 'editMessageMedia',        payload: { chat_id: chatId, message_id: msgId, media_group: flatArr } },
    { name: 'emm/media:rich',        method: 'editMessageMedia',        payload: { chat_id: chatId, message_id: msgId, media: richArr } },
    { name: 'emm/media:rich_mg',     method: 'editMessageMedia',        payload: { chat_id: chatId, message_id: msgId, media: { type: 'media_group', media: richArr } } },
    { name: 'emt/media:flat',        method: 'editMessageText',         payload: { chat_id: chatId, message_id: msgId, media: flatArr } },
    { name: 'emt/media:rich',        method: 'editMessageText',         payload: { chat_id: chatId, message_id: msgId, media: richArr } },
    { name: 'emt/media:rich_capt',   method: 'editMessageText',         payload: { chat_id: chatId, message_id: msgId, caption: caption || '', parse_mode: 'HTML', media: richArr } },
    { name: 'emc/media:flat',        method: 'editMessageCaption',      payload: { chat_id: chatId, message_id: msgId, caption: caption || '', parse_mode: 'HTML', media: flatArr } },
    { name: 'emr/media:flat',        method: 'editMessageReplyMarkup',  payload: { chat_id: chatId, message_id: msgId, media: flatArr } },
  ];

  // Collect transcript for debug forwarding
  const transcript = [];
  transcript.push(`── Multi-media attempt ──`);
  transcript.push(`context : ${contextLabel || 'unknown'}`);
  transcript.push(`chat_id : ${chatId}`);
  transcript.push(`msg_id  : ${msgId}`);
  transcript.push(`count   : ${mediaParts.length}`);
  transcript.push(`caption : ${caption ? caption.slice(0, 200) : '(none)'}`);
  transcript.push(`parts   :`);
  for (let i = 0; i < mediaParts.length; i++) {
    transcript.push(`  [${i}] kind=${mediaParts[i].kind} src=${mediaParts[i].src.slice(0, 80)}`);
  }
  transcript.push('');

  let winner = null;
  for (const shape of shapes) {
    if (DEBUG) console.log(`[edit/multi] trying ${shape.name}`);
    const r = await tg(env, shape.method, shape.payload);
    const payloadStr = JSON.stringify(shape.payload);
    const respStr = JSON.stringify(r);

    transcript.push(`▶ ${shape.name}`);
    transcript.push(`  method  : ${shape.method}`);
    transcript.push(`  payload : ${payloadStr.length > 900 ? payloadStr.slice(0, 900) + '…' : payloadStr}`);
    transcript.push(`  resp    : ${respStr.length > 900 ? respStr.slice(0, 900) + '…' : respStr}`);
    transcript.push('');

    if (r.ok) {
      console.log(`[edit/multi] SUCCESS via ${shape.name} ✅`);
      winner = shape.name;
      transcript.push(`✅ SUCCESS via ${shape.name}`);
      break;
    }
    console.error(`[edit/multi] ${shape.name} refused:`, r.description);
  }

  if (!winner) {
    transcript.push('❌ All shapes refused — falling back to delete + sendMediaGroup');
    console.error('[edit/multi] all shapes refused — falling back to delete+resend');
  }

  // Forward the transcript to DEBUG_CHAT_ID
  try {
    await sendDebugReport(env, 'Multi-media edit debug', transcript);
  } catch (e) {
    console.error('[debug-report] failed:', e && e.stack || e);
  }

  return !!winner;
}

// ═══════════════════════════════════════════════════════════════════════
// PV album batching → one bare tg:// URL per media
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
    entry = { messages: [], chatId: message.chat.id, threadId: message.message_thread_id, env, scheduled: false };
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
// /start /ping /debug
// ═══════════════════════════════════════════════════════════════════════
async function handleStart(message, env) {
  const text =
    '<b>🤖 Media URL → Media bot</b>\n\n' +
    '<b>🔒 در چت خصوصی:</b>\n' +
    'هر مدیای تلگرامی بفرستید — ربات لینک <code>tg://…id=…</code> قابل کپی جواب می‌دهد.\n' +
    'آلبوم → همه لینک‌ها یک‌جا.\n\n' +
    '<b>📝 تبدیل به مدیای واقعی (یک پیام):</b>\n' +
    'یک یا چند <code>tg://…id=…</code> را در کانال/چت بفرستید یا روی پیام ریپلای کنید و <code>/rich</code> بزنید.\n' +
    'در صورت پشتیبانی، پیام درجا به مدیا (یا آلبوم) ادیت می‌شود.\n' +
    'فرمت‌بندی متن (بولد، لینک و…) حفظ می‌شود.\n\n' +
    '<b>📢 کانال:</b> پست‌های دارای <code>tg://…id=…</code> به‌صورت خودکار به پیام مدیا تبدیل می‌شوند.';
  await sendPlain(env, message.chat.id, message.message_id, text, message.message_thread_id);
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

// ═══════════════════════════════════════════════════════════════════════
// /rich
// ═══════════════════════════════════════════════════════════════════════
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
      '⚠️ چیزی برای تبدیل نیست. روی یک پیام ریپلای کنید، یا از <code>/rich tg://photo?id=…</code> استفاده کنید.',
      threadId);
    return;
  }
  if (!html.trim()) return;

  const parts = extractMediaParts(html);
  const mediaParts = parts.filter(p => p.type === 'media');

  if (mediaParts.length === 0) {
    const text = simplifyHtml(parts.map(p => p.html).join('\n\n'));
    if (!text) return;
    await sendPlain(env, message.chat.id, replyToId, text, threadId);
    return;
  }

  const textParts = parts.filter(p => p.type === 'text');
  let combinedText = simplifyHtml(textParts.map(p => p.html).join('\n\n'));
  const captionTooLong = combinedText.length > 1024;
  const caption = captionTooLong ? null : (combinedText || null);

  if (replied && !captionTooLong) {
    const allTg = mediaParts.every(p => isTgMediaSrc(p.src));
    if (allTg) {
      const ok = await tryEditTextToMedia(
        env, message.chat.id, replied.message_id, mediaParts, caption,
        `/rich reply (chat=${message.chat.id})`
      );
      if (ok) {
        if (DEBUG) console.log('[/rich] edited replied text → media in place ✅ (' + mediaParts.length + ')');
        return;
      }
    }
  }

  if (captionTooLong && combinedText) {
    await sendPlain(env, message.chat.id, replyToId, combinedText, threadId);
  }
  if (mediaParts.length === 1) {
    await sendSingleMedia(env, message.chat.id, mediaParts[0], caption, threadId, replyToId);
  } else {
    await sendAlbum(env, message.chat.id, mediaParts, caption, threadId, replyToId);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PV single media → bare tg:// URL
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
// Channel auto-convert
// ═══════════════════════════════════════════════════════════════════════
async function handleChannelPost(post, env, _isEdit) {
  const chatId = post.chat.id;
  const msgId  = post.message_id;

  if (post.from?.is_bot) return;
  if (!post.text) return;
  if (!hasTgMediaUrl(post.text)) return;

  const styled = getStyledHtml(post.text, post.entities);
  const parts = extractMediaParts(styled);
  const mediaParts = parts.filter(p => p.type === 'media');
  if (mediaParts.length === 0) return;

  const textParts = parts.filter(p => p.type === 'text');
  let combinedText = simplifyHtml(textParts.map(p => p.html).join('\n\n'));
  const captionTooLong = combinedText.length > 1024;
  const caption = captionTooLong ? null : (combinedText || null);

  if (!captionTooLong) {
    const allTg = mediaParts.every(p => isTgMediaSrc(p.src));
    if (allTg) {
      const ok = await tryEditTextToMedia(
        env, chatId, msgId, mediaParts, caption,
        `channel post (chat=${chatId})`
      );
      if (ok) {
        if (DEBUG) console.log('[channel] edited text → media in place ✅ (' + mediaParts.length + ')');
        return;
      }
    }
  }

  // Fallback: delete original, send fresh media message(s).
  const del = await tg(env, 'deleteMessage', { chat_id: chatId, message_id: msgId });
  if (!del.ok) console.error('[channel] delete failed:', del.description);

  if (captionTooLong && combinedText) {
    const r = await tg(env, 'sendMessage', { chat_id: chatId, text: combinedText, parse_mode: 'HTML' });
    if (!r.ok) console.error('[channel] text failed:', r.description);
  }

  if (mediaParts.length === 1) {
    await sendSingleMedia(env, chatId, mediaParts[0], caption, null, null);
  } else {
    await sendAlbum(env, chatId, mediaParts, caption, null, null);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Dispatch
// ═══════════════════════════════════════════════════════════════════════
async function handleMessage(message, env, update, ctx) {
  const bot = await getBotInfo(env);
  const botId = bot.id;
  const username = bot.username || '';

  if (message.chat.type === 'private' && message.media_group_id) {
    if (DEBUG) console.log('[album] queued msg', message.message_id, 'group', message.media_group_id);
    scheduleAlbumProcessing(message, env, ctx);
    return;
  }

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
        if (update.channel_post)             await handleChannelPost(update.channel_post, env, false);
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
