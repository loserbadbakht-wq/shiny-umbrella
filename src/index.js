// src/index.js
// Media URL → real media message bot (regular messages, NOT rich messages).
//
//  ▸ PV single media  → replies with a bare tg:// URL, tap-to-copy
//  ▸ PV album         → replies with one bare tg:// URL per media
//  ▸ /rich <text>     → single tg:// media: tries edit-in-place; multi: sends album
//  ▸ Channels (admin) → TWO INDEPENDENT edits:
//        (A) tg:// media edit
//        (B) text transforms — PixelMedia / 🟦 (on text or caption)
//        …but ONLY when the raw text has no HTML tags.
//  ▸ /start /ping /debug
//
//  VIDEO THUMBNAILS
//  -----------------
//    tg://video?id=<VIDEO_FILE_ID>&thumb=tg://photo?id=<PHOTO_FILE_ID>
//  The bot calls getFile on the photo, downloads the bytes, and re-uploads
//  them as multipart (the ONLY way Telegram accepts a thumbnail).
//
//  PIXELMEDIA LINK PREVIEW
//  -----------------------
//  Any sendMessage / editMessageText whose body contains the PixelMedia
//  URL is sent with link_preview_options.is_disabled = true, so t.me cards
//  never appear.

const DEBUG = true;

// ═══════════════════════════════════════════════════════════════════════
// Telegram plumbing — JSON path
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

// ═══════════════════════════════════════════════════════════════════════
// Telegram plumbing — multipart path (needed for thumbnails)
// ═══════════════════════════════════════════════════════════════════════
async function tgMultipart(env, method, fields, files) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') form.append(k, v);
    else if (typeof v === 'number') form.append(k, String(v));
    else form.append(k, JSON.stringify(v));
  }
  for (const [k, f] of Object.entries(files || {})) {
    form.append(k, f.blob, f.name || 'file.jpg');
  }
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    body: form,
  });
  const txt = await res.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = { ok: false, raw: txt }; }
  if (!res.ok || data.ok === false) console.error(`[tg-mp:${method}] ${res.status}:`, txt.slice(0, 800));
  else if (DEBUG) console.log(`[tg-mp:${method}] ok`);
  return data;
}

// Resolve a tg://photo thumbnail into { blob, name } for multipart upload.
async function fetchThumbBlob(env, thumb) {
  if (!thumb) return null;

  const m = String(thumb).match(/^tg:\/\/photo\?id=([A-Za-z0-9_-]+)/i);
  if (!m) {
    console.error('[thumb] unsupported thumb spec:', String(thumb).slice(0, 100));
    return null;
  }
  const fileId = m[1];

  const gf = await tg(env, 'getFile', { file_id: fileId });
  if (!gf.ok || !gf.result?.file_path) {
    console.error('[thumb] getFile failed:', gf.description);
    return null;
  }

  const filePath = gf.result.file_path;
  const fileSize = gf.result.file_size || 0;
  if (fileSize > 200 * 1024) {
    console.error('[thumb] too large:', fileSize, 'bytes (limit 200 KB)');
    return null;
  }

  const url = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error('[thumb] file download failed:', res.status);
      return null;
    }
    const blob = await res.blob();
    if (blob.size > 200 * 1024) {
      console.error('[thumb] downloaded blob too large:', blob.size);
      return null;
    }
    if (DEBUG) console.log('[thumb] ok:', blob.size, 'bytes, path =', filePath);
    return { blob, name: 'thumb.jpg' };
  } catch (e) {
    console.error('[thumb] download threw:', e && e.message || e);
    return null;
  }
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
const RAW_HTML_TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9-]*(\s+[^>]*)?\/?>/;
function hasRawHtmlTag(text) {
  return typeof text === 'string' && RAW_HTML_TAG_RE.test(text);
}

const TG_MEDIA_URL_RE = /tg:\/\/(?:photo|video|audio|document)\?id=[A-Za-z0-9_-]+/i;
function hasTgMediaUrl(text) {
  return typeof text === 'string' && TG_MEDIA_URL_RE.test(text);
}
function isTgMediaSrc(src) {
  return /^tg:\/\/(photo|video|audio|document)\?id=[A-Za-z0-9_-]+/i.test(String(src));
}

// Any mention of the PixelMedia channel URL — bare or inside <a href>.
const PIXELMEDIA_URL_RE = /t\.me\/pixelmediair/i;
function hasPixelMediaUrl(text) {
  return typeof text === 'string' && PIXELMEDIA_URL_RE.test(text);
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
// Text transforms
// ═══════════════════════════════════════════════════════════════════════
const PIXELMEDIA_LINK = '<a href="https://t.me/pixelmediair">PixelMedia</a>';
const PIXELMEDIA_WORD_RE = /\bpixelmedia\b/gi;
const PIXELMEDIA_ANY_RE  = /\bpixelmedia\b/i;

function linkifyPixelMedia(html) {
  const parts = [];
  const re = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  let pos = 0, m;
  while ((m = re.exec(html)) !== null) {
    if (m.index > pos) parts.push({ text: html.slice(pos, m.index), isLink: false });
    parts.push({ text: m[0], isLink: true });
    pos = m.index + m[0].length;
  }
  if (pos < html.length) parts.push({ text: html.slice(pos), isLink: false });

  let result = parts.map(p => {
    if (p.isLink) {
      const innerText = p.text
        .replace(/^<a\b[^>]*>/i, '')
        .replace(/<\/a\s*>$/i, '')
        .replace(/<[^>]+>/g, '');
      if (PIXELMEDIA_ANY_RE.test(innerText)) return PIXELMEDIA_LINK;
      return p.text;
    }
    return p.text.replace(PIXELMEDIA_WORD_RE, PIXELMEDIA_LINK);
  }).join('');

  const boldOnlyLink = /<(?:b|strong)>\s*(<a href="https:\/\/t\.me\/pixelmediair">PixelMedia<\/a>)\s*<\/(?:b|strong)>/gi;
  result = result.replace(boldOnlyLink, '$1');

  return result;
}

function boldFirstBlueLine(html) {
  const lines = String(html).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([ \t]*)(🟦[\s\S]*)$/);
    if (m) {
      if (/^[ \t]*<b>[\s\S]*<\/b>[ \t]*$/.test(lines[i])) break;
      lines[i] = m[1] + '<b>' + m[2] + '</b>';
      break;
    }
  }
  return lines.join('\n');
}

function applyTextTransforms(html) {
  return boldFirstBlueLine(linkifyPixelMedia(html));
}

function hasUnlinkedPixelMedia(styledHtml) {
  return linkifyPixelMedia(styledHtml) !== styledHtml;
}
function hasUnboldedBlueLine(styledHtml) {
  return boldFirstBlueLine(styledHtml) !== styledHtml;
}

// ═══════════════════════════════════════════════════════════════════════
// Entities → HTML
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
    default: return null;
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
// RTL
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
function pickBestPhoto(photos) {
  if (!Array.isArray(photos) || photos.length === 0) return null;
  let best = photos[0];
  for (const p of photos) {
    const bScore = (best.file_size || 0) || ((best.width || 0) * (best.height || 0));
    const cScore = (p.file_size   || 0) || ((p.width   || 0) * (p.height   || 0));
    if (cScore > bScore) best = p;
  }
  return best;
}

function fullTagFor(message) {
  if (Array.isArray(message.photo) && message.photo.length) {
    const p = pickBestPhoto(message.photo);
    if (p) return { tag: `tg://photo?id=${p.file_id}`, fileId: p.file_id, kind: 'photo' };
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
// Text → parts
// ═══════════════════════════════════════════════════════════════════════
function extractMediaParts(text) {
  const parts = [];
  const re = /tg:\/\/(photo|video|audio|document)\?id=([A-Za-z0-9_-]+)(?:&(?:amp;)?thumb=(tg:\/\/photo\?id=[A-Za-z0-9_-]+))?/gi;
  let pos = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > pos) {
      const t = text.slice(pos, m.index);
      if (t.trim()) parts.push({ type: 'text', html: t });
    }
    const kind   = m[1].toLowerCase();
    const fileId = m[2];
    const thumb  = m[3] || null;
    parts.push({ type: 'media', kind, src: m[0], fileId, thumb, label: null });
    pos = m.index + m[0].length;
  }
  if (pos < text.length) {
    const t = text.slice(pos);
    if (t.trim()) parts.push({ type: 'text', html: t });
  }
  return parts;
}

// ═══════════════════════════════════════════════════════════════════════
// Simplify HTML
// ═══════════════════════════════════════════════════════════════════════
const SENDMESSAGE_SUPPORTED = new Set([
  'b','strong','i','em','u','ins','s','strike','del','code','pre','a','tg-spoiler','blockquote',
]);

function simplifyHtml(html) {
  let s = String(html)
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
  return applyTextTransforms(s);
}

// ═══════════════════════════════════════════════════════════════════════
// Senders
// ═══════════════════════════════════════════════════════════════════════
async function sendPlain(env, chatId, replyToId, text, threadId) {
  const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
  // Suppress the t.me card when the message contains PixelMedia.
  if (hasPixelMediaUrl(text)) {
    payload.link_preview_options = { is_disabled: true };
  }
  if (replyToId != null) payload.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
  if (threadId != null) payload.message_thread_id = threadId;
  return tg(env, 'sendMessage', payload);
}

// ── single media ────────────────────────────────────────────────────────
async function sendSingleMedia(env, chatId, part, caption, threadId, replyToId) {
  if (!part.fileId) return null;

  if (part.kind === 'video' && part.thumb) {
    const thumbFile = await fetchThumbBlob(env, part.thumb);
    if (thumbFile) {
      const fields = {
        chat_id: chatId,
        video: part.fileId,
        thumbnail: 'attach://thumb0',
      };
      if (caption) { fields.caption = caption; fields.parse_mode = 'HTML'; }
      if (replyToId != null) fields.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
      if (threadId != null) fields.message_thread_id = threadId;
      const r = await tgMultipart(env, 'sendVideo', fields, { thumb0: thumbFile });
      if (r.ok) return r;
      console.error('[send] sendVideo multipart failed, falling back:', r.description);
    }
  }

  const payload = { chat_id: chatId };
  let method;
  switch (part.kind) {
    case 'photo':    method = 'sendPhoto';    payload.photo    = part.fileId; break;
    case 'video':    method = 'sendVideo';    payload.video    = part.fileId; break;
    case 'audio':    method = 'sendAudio';    payload.audio    = part.fileId; break;
    case 'document': method = 'sendDocument'; payload.document = part.fileId; break;
    default: return null;
  }
  if (caption) { payload.caption = caption; payload.parse_mode = 'HTML'; }
  if (replyToId != null) payload.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
  if (threadId != null) payload.message_thread_id = threadId;
  const r = await tg(env, method, payload);
  if (!r.ok) console.error('[send] single media failed:', r.description);
  return r;
}

// ── album ───────────────────────────────────────────────────────────────
async function sendAlbum(env, chatId, mediaParts, caption, threadId, replyToId) {
  const chunks = [];
  for (let i = 0; i < mediaParts.length; i += 10) chunks.push(mediaParts.slice(i, i + 10));
  let isFirstChunk = true;
  let firstResult = null;
  for (const chunk of chunks) {
    const media = [];
    const files = {};
    let thumbIdx = 0;

    for (let idx = 0; idx < chunk.length; idx++) {
      const part = chunk[idx];
      if (!part.fileId) continue;
      const entry = { type: part.kind, media: part.fileId };

      if (part.kind === 'video' && part.thumb) {
        const thumbFile = await fetchThumbBlob(env, part.thumb);
        if (thumbFile) {
          const name = `thumb_${thumbIdx++}`;
          entry.thumbnail = `attach://${name}`;
          files[name] = thumbFile;
        }
      }
      if (isFirstChunk && idx === 0 && caption) {
        entry.caption = caption;
        entry.parse_mode = 'HTML';
      }
      media.push(entry);
    }
    if (!media.length) { isFirstChunk = false; continue; }

    let r;
    if (Object.keys(files).length > 0) {
      const fields = { chat_id: chatId, media };
      if (isFirstChunk && replyToId != null) fields.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
      if (threadId != null) fields.message_thread_id = threadId;
      r = await tgMultipart(env, 'sendMediaGroup', fields, files);
    } else {
      const payload = { chat_id: chatId, media };
      if (isFirstChunk && replyToId != null) payload.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
      if (threadId != null) payload.message_thread_id = threadId;
      r = await tg(env, 'sendMediaGroup', payload);
    }
    if (r && !r.ok) console.error('[send] sendMediaGroup failed:', r.description);
    if (isFirstChunk) firstResult = r;
    isFirstChunk = false;
  }
  return firstResult;
}

// ═══════════════════════════════════════════════════════════════════════
// In-place edit — single tg:// media
// ═══════════════════════════════════════════════════════════════════════
async function tryEditTextToMedia(env, chatId, msgId, mediaPart, caption) {
  if (Array.isArray(mediaPart)) {
    if (mediaPart.length !== 1) return false;
    mediaPart = mediaPart[0];
  }
  if (!isTgMediaSrc(mediaPart.src)) return false;
  if (!mediaPart.fileId) return false;

  if (mediaPart.kind === 'video' && mediaPart.thumb) {
    const thumbFile = await fetchThumbBlob(env, mediaPart.thumb);
    if (thumbFile) {
      const media = { type: 'video', media: mediaPart.fileId, thumbnail: 'attach://thumb0' };
      if (caption) { media.caption = caption; media.parse_mode = 'HTML'; }
      const fields = { chat_id: chatId, message_id: msgId, media };
      const r = await tgMultipart(env, 'editMessageMedia', fields, { thumb0: thumbFile });
      if (r.ok) return true;
      console.error('[edit] editMessageMedia (multipart) refused:', r.description);
    }
  }

  const media = { type: mediaPart.kind, media: mediaPart.fileId };
  if (caption) { media.caption = caption; media.parse_mode = 'HTML'; }
  const r = await tg(env, 'editMessageMedia', { chat_id: chatId, message_id: msgId, media });
  if (r.ok) return true;
  console.error('[edit] editMessageMedia refused:', r.description);
  return false;
}

// ═══════════════════════════════════════════════════════════════════════
// PV album batching
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
    'یک <code>tg://…id=…</code> را در کانال/چت بفرستید یا روی پیام ریپلای کنید و <code>/rich</code> بزنید.\n\n' +
    '<b>🖼 تصویر بندانگشتی برای ویدیو:</b>\n' +
    'به انتهای لینک ویدیو <code>&amp;thumb=</code> و بعد یک <code>tg://photo?id=…</code> اضافه کنید:\n' +
    '<code>tg://video?id=VIDEO_ID&amp;thumb=tg://photo?id=PHOTO_ID</code>\n\n' +
    '<b>📢 کانال:</b>\n' +
    '• پست متنی با یک <code>tg://…id=…</code> → ادیت درجا به مدیا.\n' +
    '• هر پست (متنی یا با مدیا) شامل <code>pixelmedia</code> یا خط 🟦 → متن/کپشن ادیت می‌شود.\n' +
    '• اگر متن پیام شامل تگ HTML باشد، هیچ ادیتی انجام نمی‌شود.\n\n' +
    '<b>🚫 پیش‌نمایش لینک:</b>\n' +
    'برای PixelMedia هیچ پیش‌نمایشی نمایش داده نمی‌شود.';
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

  if (replied && mediaParts.length === 1 && !captionTooLong && isTgMediaSrc(mediaParts[0].src)) {
    const ok = await tryEditTextToMedia(env, message.chat.id, replied.message_id, mediaParts[0], caption);
    if (ok) {
      if (DEBUG) console.log('[/rich] edited replied text → media in place ✅');
      return;
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
// PV single media
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

  let rawText = '';
  let ents = [];
  let kind = null;
  if (typeof post.text === 'string' && post.text.length) {
    rawText = post.text;
    ents = post.entities || [];
    kind = 'text';
  } else if (typeof post.caption === 'string' && post.caption.length) {
    rawText = post.caption;
    ents = post.caption_entities || [];
    kind = 'caption';
  }

  const nativeMedia = !!(
    post.photo || post.video || post.animation || post.document ||
    post.audio || post.voice || post.sticker || post.video_note
  );

  if (rawText && hasRawHtmlTag(rawText)) {
    if (DEBUG) console.log('[channel] raw HTML tags present — skipping all edits');
    return;
  }

  if (!rawText && !nativeMedia) return;

  const styled = getStyledHtml(rawText, ents);
  const hasTg   = hasTgMediaUrl(rawText);
  const needsLink = hasUnlinkedPixelMedia(styled);
  const needsBold = hasUnboldedBlueLine(styled);
  const needsTextTransform = needsLink || needsBold;

  if (DEBUG) {
    console.log(`[channel] native=${nativeMedia} hasTg=${hasTg} link=${needsLink} bold=${needsBold}`);
  }

  if (nativeMedia) {
    if (!needsTextTransform) return;
    const newCaption = simplifyHtml(styled);
    if (!newCaption || newCaption === styled) return;
    if (newCaption.length > 1024) {
      if (DEBUG) console.log('[channel] caption too long — skip');
      return;
    }
    const r = await tg(env, 'editMessageCaption', {
      chat_id: chatId,
      message_id: msgId,
      caption: newCaption,
      parse_mode: 'HTML',
    });
    if (r.ok) { if (DEBUG) console.log('[channel] (native) caption transform ✅'); }
    else console.error('[channel] (native) editMessageCaption failed:', r.description);
    return;
  }

  let mediaEdited = false;
  if (hasTg) {
    const parts = extractMediaParts(styled);
    const mediaParts = parts.filter(p => p.type === 'media');
    if (mediaParts.length === 1 && isTgMediaSrc(mediaParts[0].src)) {
      const textParts = parts.filter(p => p.type === 'text');
      const combinedText = simplifyHtml(textParts.map(p => p.html).join('\n\n'));
      const captionTooLong = combinedText.length > 1024;
      const caption = captionTooLong ? null : (combinedText || null);
      mediaEdited = await tryEditTextToMedia(env, chatId, msgId, mediaParts[0], caption);
      if (DEBUG) console.log('[channel] (A) tg:// media edit ' + (mediaEdited ? '✅' : '❌ refused'));
    } else if (mediaParts.length > 1) {
      if (DEBUG) console.log('[channel] (A) multi tg:// — skipped');
    }
  }

  if (!needsTextTransform) return;
  if (mediaEdited) return;

  const newHtml = simplifyHtml(styled);
  if (!newHtml || newHtml === styled) return;

  const editPayload = {
    chat_id: chatId,
    message_id: msgId,
    text: newHtml,
    parse_mode: 'HTML',
  };
  // Suppress the t.me card when the new body contains PixelMedia.
  if (hasPixelMediaUrl(newHtml)) {
    editPayload.link_preview_options = { is_disabled: true };
  }
  const r = await tg(env, 'editMessageText', editPayload);
  if (r.ok) { if (DEBUG) console.log('[channel] (B) text transform ✅ (link=' + needsLink + ', bold=' + needsBold + ')'); }
  else console.error('[channel] (B) editMessageText failed:', r.description);
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
