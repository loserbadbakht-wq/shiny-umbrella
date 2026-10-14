// src/index.js
// Media URL → real media message bot (regular messages, NOT rich messages).
//
//  ▸ PV single media  → replies with a bare tg:// URL, tap-to-copy
//  ▸ PV album         → replies with one bare tg:// URL per media
//  ▸ /rich <text>     → single tg:// media: tries edit-in-place; multi: sends album
//  ▸ Channels (admin) → INDEPENDENT edits:
//        (A) tg:// media edit
//        (B) text transforms — PixelMedia / 🟦 (on text, caption, or rich_message)
//      BUT: any message whose text/caption contains literal HTML tags is left
//      completely alone (no edits at all). Rich messages are not skipped.
//  ▸ /pixel           → re-linkifies every recorded post (incl. rich); deletes itself
//  ▸ /start /ping /debug

const DEBUG = true;

const MAX_EDITS_PER_RUN = 100;   // cap per /pixel invocation
const EDIT_DELAY_MS     = 30;    // ~33 edits/sec, safe for Telegram
const DO_LIST_LIMIT     = 5000;  // hard cap on records pulled from DO

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
function hasAnyPixelMedia(styledHtml) {
  return PIXELMEDIA_ANY_RE.test(styledHtml.replace(/<[^>]+>/g, ' '));
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
  if (msg.rich_message && typeof msg.rich_message === 'object') {
    const html = typeof msg.rich_message.html === 'string' ? msg.rich_message.html : '';
    return { html, kind: 'rich' };
  }
  for (const key of ['rich', 'content', 'html']) {
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
// Text → parts
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
// In-place edit — single tg:// media
// ═══════════════════════════════════════════════════════════════════════
async function tryEditTextToMedia(env, chatId, msgId, mediaPart, caption) {
  if (Array.isArray(mediaPart)) {
    if (mediaPart.length !== 1) return false;
    mediaPart = mediaPart[0];
  }
  if (!isTgMediaSrc(mediaPart.src)) return false;
  const fileId = resolveFileId(mediaPart.src);
  if (!fileId) return false;

  const media = { type: mediaPart.kind, media: fileId };
  if (caption) { media.caption = caption; media.parse_mode = 'HTML'; }

  const r = await tg(env, 'editMessageMedia', {
    chat_id: chatId,
    message_id: msgId,
    media,
  });
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
// DURABLE OBJECT
// ═══════════════════════════════════════════════════════════════════════
export class PixelMediaStore {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  async record(msgId, record) { await this.ctx.storage.put(`msg:${msgId}`, record); }
  async forget(msgId)          { await this.ctx.storage.delete(`msg:${msgId}`); }
  async listAll(limit = DO_LIST_LIMIT) {
    const map = await this.ctx.storage.list({ prefix: 'msg:', limit });
    const out = [];
    for (const [key, value] of map) out.push({ key, ...value });
    return out;
  }
  async clearAll() { await this.ctx.storage.deleteAll(); }
}

function pixelmediaStub(env, chatId) {
  if (!env.PIXELMEDIA_DO) return null;
  return env.PIXELMEDIA_DO.get(env.PIXELMEDIA_DO.idFromName(String(chatId)));
}

async function doRecord(env, chatId, msgId, record) {
  const stub = pixelmediaStub(env, chatId);
  if (!stub) return;
  try {
    await stub.record(msgId, { ...record, chat_id: chatId, message_id: msgId, ts: Date.now() });
  } catch (e) { console.error('[do] record failed:', e && e.message || e); }
}

async function doForget(env, chatId, msgId) {
  const stub = pixelmediaStub(env, chatId);
  if (!stub) return;
  try { await stub.forget(msgId); }
  catch (e) { console.error('[do] forget failed:', e && e.message || e); }
}

async function doListAll(env, chatId) {
  const stub = pixelmediaStub(env, chatId);
  if (!stub) return [];
  try { return await stub.listAll(DO_LIST_LIMIT); }
  catch (e) { console.error('[do] list failed:', e && e.message || e); return []; }
}

// ═══════════════════════════════════════════════════════════════════════
// /pixel command — bulk re-linkify, scales to big channels
// ═══════════════════════════════════════════════════════════════════════
async function handlePixelCommand(message, env) {
  const chatId = message.chat.id;
  const msgId  = message.message_id;

  // Delete the command message first so it disappears immediately.
  const del = await tg(env, 'deleteMessage', { chat_id: chatId, message_id: msgId });
  if (!del.ok) console.error('[/pixel] delete failed:', del.description);

  const records = await doListAll(env, chatId);
  const total = records.length;

  let edited = 0, skipped = 0, failed = 0, processed = 0;
  let hitLimit = false;

  for (const rec of records) {
    if (processed >= MAX_EDITS_PER_RUN) { hitLimit = true; break; }
    processed++;

    const original = rec.kind === 'rich'
      ? String(rec.rich_html || (rec.rich_message && rec.rich_message.html) || '')
      : getStyledHtml(rec.text, rec.entities);
    if (!original) { skipped++; continue; }

    // Only PixelMedia linkify for the bulk command — tg:// and 🟦 untouched.
    const newHtml = linkifyPixelMedia(original);
    if (newHtml === original) { skipped++; continue; }

    let r;
    if (rec.kind === 'caption') {
      if (newHtml.length > 1024) { skipped++; continue; }
      r = await tg(env, 'editMessageCaption', {
        chat_id: rec.chat_id, message_id: rec.message_id,
        caption: newHtml, parse_mode: 'HTML',
      });
    } else if (rec.kind === 'rich') {
      const newRich = { ...(rec.rich_message || {}), html: newHtml };
      r = await tg(env, 'editMessageText', {
        chat_id: rec.chat_id, message_id: rec.message_id,
        rich_message: newRich,
      });
    } else {
      if (newHtml.length > 4096) { skipped++; continue; }
      r = await tg(env, 'editMessageText', {
        chat_id: rec.chat_id, message_id: rec.message_id,
        text: newHtml, parse_mode: 'HTML',
      });
    }

    // Rate limit: honour retry_after
    if (r && r.error_code === 429 && r.parameters?.retry_after) {
      const waitSec = Math.min(Number(r.parameters.retry_after) || 1, 30);
      if (DEBUG) console.log(`[/pixel] 429 — sleeping ${waitSec}s`);
      await sleep(waitSec * 1000);
      failed++;
      continue;
    }

    if (r && r.ok) edited++;
    else {
      failed++;
      const d = String((r && r.description) || '');
      if (/not found|can't be edited|MESSAGE_ID_INVALID/i.test(d)) {
        await doForget(env, rec.chat_id, rec.message_id);
      }
    }

    await sleep(EDIT_DELAY_MS);
  }

  if (DEBUG) {
    console.log(`[/pixel] chat=${chatId} total=${total} processed=${processed} edited=${edited} skipped=${skipped} failed=${failed} hitLimit=${hitLimit}`);
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
    '<b>📝 تبدیل به مدیای واقعی:</b>\n' +
    'یک <code>tg://…id=…</code> را در کانال/چت بفرستید یا روی پیام ریپلای کنید و <code>/rich</code> بزنید.\n\n' +
    '<b>📢 کانال:</b>\n' +
    '• پست با یک <code>tg://…id=…</code> → ادیت درجا به مدیا.\n' +
    '• <code>pixelmedia</code> یا خط 🟦 در متن، کپشن یا پیام غنی → ادیت می‌شود.\n' +
    '• اگر پیام حاوی تگ‌های HTML باشد (<code>&lt;b&gt;…&lt;/b&gt;</code> و…) هیچ ادیتی انجام نمی‌شود.\n\n' +
    '<b>🧹 /pixel:</b>\n' +
    'همه پست‌های ثبت‌شده را دوباره بررسی می‌کند و PixelMedia را لینک می‌کند (tg:// و 🟦 دست‌نخورده). خودِ پیام دستور حذف می‌شود.\n' +
    'برای کانال‌های بزرگ، هر بار حداکثر ' + MAX_EDITS_PER_RUN + ' پیام پردازش می‌شود.';
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
// Rich message transform
// ═══════════════════════════════════════════════════════════════════════
async function transformRichMessage(env, chatId, msgId, rich, contextLabel) {
  const originalHtml = typeof rich.html === 'string' ? rich.html : '';
  if (!originalHtml) return { changed: false };

  const newHtml = applyTextTransforms(originalHtml);
  if (newHtml === originalHtml) return { changed: false };

  const newRich = { ...rich, html: newHtml };
  const r = await tg(env, 'editMessageText', {
    chat_id: chatId,
    message_id: msgId,
    rich_message: newRich,
  });
  if (r.ok) {
    if (DEBUG) console.log(`[rich:${contextLabel}] transforms applied ✅`);
    return { changed: true, ok: true };
  }
  console.error(`[rich:${contextLabel}] edit failed:`, r.description);
  return { changed: true, ok: false, description: r.description };
}

// ═══════════════════════════════════════════════════════════════════════
// Channel auto-convert
// ═══════════════════════════════════════════════════════════════════════
async function handleChannelPost(post, env, _isEdit) {
  const chatId = post.chat.id;
  const msgId  = post.message_id;

  if (post.from?.is_bot) return;

  // ── (0) Rich message ──
  if (post.rich_message && typeof post.rich_message === 'object') {
    const rm = post.rich_message;

    // /pixel as rich message
    if (typeof rm.html === 'string') {
      const cmd = parseCommand(rm.html, (await getBotInfo(env)).username);
      if (cmd && cmd.cmd === 'pixel') {
        await handlePixelCommand(post, env);
        return;
      }
    }

    const originalHtml = typeof rm.html === 'string' ? rm.html : '';
    if (!originalHtml) return;

    if (hasAnyPixelMedia(originalHtml)) {
      await doRecord(env, chatId, msgId, {
        kind: 'rich',
        rich_message: rm,
        rich_html: originalHtml,
      });
    }

    await transformRichMessage(env, chatId, msgId, rm, 'channel');
    return;
  }

  // ── (1) Text / caption ──
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

  // Command detection runs BEFORE the HTML-tag skip, so /pixel works even
  // if it happens to contain a tag (unlikely).
  if (kind === 'text') {
    const cmd = parseCommand(rawText, (await getBotInfo(env)).username);
    if (cmd && cmd.cmd === 'pixel') {
      await handlePixelCommand(post, env);
      return;
    }
  }

  if (!rawText && !nativeMedia) return;

  // ── Rule: any literal HTML tag in the text/caption → leave it alone ──
  if (kind && hasHtmlTag(rawText)) {
    if (DEBUG) console.log('[channel] HTML tags in text/caption — skip all edits');
    return;
  }

  const styled = getStyledHtml(rawText, ents);
  const hasTg   = hasTgMediaUrl(rawText);
  const needsLink = hasUnlinkedPixelMedia(styled);
  const needsBold = hasUnboldedBlueLine(styled);
  const needsTextTransform = needsLink || needsBold;

  if (DEBUG) {
    console.log(`[channel] native=${nativeMedia} hasTg=${hasTg} link=${needsLink} bold=${needsBold}`);
  }

  if (kind && hasAnyPixelMedia(styled)) {
    await doRecord(env, chatId, msgId, { kind, text: rawText, entities: ents });
  }

  // Native media → caption edit
  if (nativeMedia) {
    if (!needsTextTransform) return;
    const newCaption = simplifyHtml(styled);
    if (!newCaption || newCaption === styled) return;
    if (newCaption.length > 1024) {
      if (DEBUG) console.log('[channel] caption too long — skip');
      return;
    }
    const r = await tg(env, 'editMessageCaption', {
      chat_id: chatId, message_id: msgId,
      caption: newCaption, parse_mode: 'HTML',
    });
    if (r.ok) { if (DEBUG) console.log('[channel] (native) caption transform ✅'); }
    else console.error('[channel] (native) editMessageCaption failed:', r.description);
    return;
  }

  // Text-only with tg:// media
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

  // Text-transform edit
  if (!needsTextTransform) return;
  if (mediaEdited) return;

  const newHtml = simplifyHtml(styled);
  if (!newHtml || newHtml === styled) return;

  const r = await tg(env, 'editMessageText', {
    chat_id: chatId, message_id: msgId,
    text: newHtml, parse_mode: 'HTML',
  });
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

  // Rich message in PV / group
  if (message.rich_message && typeof message.rich_message === 'object') {
    const rm = message.rich_message;
    if (typeof rm.html === 'string') {
      const cmd = parseCommand(rm.html, username);
      if (cmd && cmd.cmd === 'pixel') {
        await handlePixelCommand(message, env);
        return;
      }
    }
    const originalHtml = typeof rm.html === 'string' ? rm.html : '';
    if (originalHtml) {
      if (hasAnyPixelMedia(originalHtml)) {
        await doRecord(env, message.chat.id, message.message_id, {
          kind: 'rich', rich_message: rm, rich_html: originalHtml,
        });
      }
      await transformRichMessage(env, message.chat.id, message.message_id, rm, 'pv');
    }
    return;
  }

  const text = message.text || message.caption || '';
  const cmd = parseCommand(text, username);
  if (!cmd) return;

  // Rule: literal HTML tags in the text/caption → leave it alone.
  // (Commands are checked first, so /pixel still works.)
  if (hasHtmlTag(text)) {
    if (DEBUG) console.log('[msg] HTML tags in text/caption — skip all edits');
    return;
  }

  switch (cmd.cmd) {
    case 'start':  return handleStart(message, env);
    case 'ping':   return handlePing(message, env);
    case 'debug':  return handleDebug(message, env, update);
    case 'rich':   return handleRich(message, env, cmd.args, botId);
    case 'pixel':  return handlePixelCommand(message, env);
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
