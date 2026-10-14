// src/index.js
// Rich Message bot.
//
//  ▸ PV single media  → replies with a tag (full file_id), tap-to-copy
//  ▸ PV album         → rich message with tap-to-copy tags + <details> previews
//  ▸ /rich <tag>       → downloads file, re-uploads via attach:// for full quality
//  ▸ Channels (admin) → auto-edits HTML posts into rich messages
//  ▸ /start            → interactive help
//  ▸ /ping /debug      → /debug fetches real dimensions from Telegram

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
// Short id
// ═══════════════════════════════════════════════════════════════════════
function shortIdFor(fileId) {
  let h = 0x811c9dc5;
  for (let i = 0; i < fileId.length; i++) {
    h ^= fileId.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return 'm' + h.toString(36);
}

// ═══════════════════════════════════════════════════════════════════════
// Prepare /rich payload
// ═══════════════════════════════════════════════════════════════════════
function prepareFileIdPayload(html) {
  const media = [];
  const seen = new Map();
  const newHtml = html.replace(
    /tg:\/\/(photo|video|audio|document)\?id=([^"'\s&<>]+)/g,
    (match, kind, rawId) => {
      const fileId = decodeURIComponent(rawId);
      if (fileId.length <= 64 && /^[A-Za-z0-9_-]+$/.test(fileId) && fileId.startsWith('m')) {
        media.push({ id: fileId, media: { type: kind, media: fileId } });
        return match;
      }
      let shortId = seen.get(fileId);
      if (!shortId) {
        shortId = shortIdFor(fileId);
        seen.set(fileId, shortId);
        media.push({ id: shortId, media: { type: kind, media: fileId } });
      }
      return `tg://${kind}?id=${shortId}`;
    }
  );
  return { html: newHtml, media, attachments: [] };
}

function prepareAttachPayload(html) {
  const media = [];
  const attachments = [];
  const seen = new Map();
  let counter = 0;

  const newHtml = html.replace(
    /tg:\/\/(photo|video|audio|document)\?id=([^"'\s&<>]+)/g,
    (match, kind, rawId) => {
      const fileId = decodeURIComponent(rawId);

      if (fileId.length <= 64 && /^[A-Za-z0-9_-]+$/.test(fileId) && fileId.startsWith('m')) {
        media.push({ id: fileId, media: { type: kind, media: fileId } });
        return match;
      }

      let shortId = seen.get(fileId);
      if (!shortId) {
        shortId = shortIdFor(fileId);
        seen.set(fileId, shortId);
        const attachName = `f${counter++}`;
        media.push({ id: shortId, media: { type: kind, media: `attach://${attachName}` } });
        attachments.push({ name: attachName, fileId, kind });
      }
      return `tg://${kind}?id=${shortId}`;
    }
  );

  return { html: newHtml, media, attachments };
}

// ═══════════════════════════════════════════════════════════════════════
// Download + upload
// ═══════════════════════════════════════════════════════════════════════
function guessMime(path) {
  const p = String(path).toLowerCase();
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.png'))                        return 'image/png';
  if (p.endsWith('.gif'))                        return 'image/gif';
  if (p.endsWith('.webp'))                       return 'image/webp';
  if (p.endsWith('.mp4'))                        return 'video/mp4';
  if (p.endsWith('.webm'))                       return 'video/webm';
  if (p.endsWith('.mov'))                        return 'video/quicktime';
  if (p.endsWith('.mp3'))                        return 'audio/mpeg';
  if (p.endsWith('.m4a'))                        return 'audio/mp4';
  if (p.endsWith('.ogg') || p.endsWith('.oga'))  return 'audio/ogg';
  return 'application/octet-stream';
}

async function downloadFile(env, fileId) {
  const gf = await tg(env, 'getFile', { file_id: fileId });
  if (!gf.ok || !gf.result?.file_path) {
    console.error(`[attach] getFile failed for ${fileId.slice(0, 20)}…:`, gf.description);
    return null;
  }
  const url = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${gf.result.file_path}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[attach] download failed: ${res.status}`);
    return null;
  }
  const buf = await res.arrayBuffer();
  return { bytes: buf, path: gf.result.file_path };
}

async function sendRichWithAttach(env, chatId, replyToId, richMessage, threadId, attachments) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (replyToId != null) {
    form.append('reply_parameters', JSON.stringify({
      message_id: replyToId,
      allow_sending_without_reply: true,
    }));
  }
  if (threadId != null) form.append('message_thread_id', String(threadId));
  form.append('rich_message', JSON.stringify(richMessage));

  for (const a of attachments) {
    const dl = await downloadFile(env, a.fileId);
    if (!dl) return { ok: false, description: `download failed for ${a.name}` };
    const mime = guessMime(dl.path);
    const blob = new Blob([dl.bytes], { type: mime });
    form.append(a.name, blob, a.name);
    if (DEBUG) console.log(`[attach] ${a.name} ← ${a.fileId.slice(0, 20)}… (${dl.bytes.byteLength} B, ${mime})`);
  }

  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendRichMessage`, {
    method: 'POST',
    body: form,
  });
  const txt = await res.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = { ok: false, raw: txt }; }
  if (!res.ok || data.ok === false) {
    console.error(`[attach] sendRichMessage multipart failed:`, txt.slice(0, 600));
  }
  return data;
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
  return tg(env, 'sendRichMessage', payload);
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
// Album batching
// ═══════════════════════════════════════════════════════════════════════
const ALBUM_MAP = new Map();

async function processAlbum(entry) {
  if (!entry || !entry.messages || entry.messages.length === 0) return;
  const { messages, chatId, threadId, env } = entry;

  const parts = [];
  const mediaArr = [];
  const usedShortIds = new Map();
  const attachments = [];
  let counter = 0;

  for (const msg of messages) {
    const info = fullTagFor(msg);
    if (!info) continue;
    const label = mediaTypeLabel(msg);

    let shortId = usedShortIds.get(info.fileId);
    if (!shortId) {
      shortId = shortIdFor(info.fileId);
      usedShortIds.set(info.fileId, shortId);
      const attachName = `f${counter++}`;
      mediaArr.push({
        id: shortId,
        media: { type: info.kind, media: `attach://${attachName}` },
      });
      attachments.push({ name: attachName, fileId: info.fileId, kind: info.kind });
    }

    parts.push(`<code>${escapeHtml(info.tag)}</code>`);
    const previewTag = info.tag.replace(/id=[^"'\s&<>]+/, `id=${shortId}`);
    parts.push(`<details><summary>پیش‌نمایش ${label}</summary>${previewTag}</details>`);
  }

  if (parts.length === 0) return;

  const html = parts.join('\n');
  const richMessage = { html };
  if (mediaArr.length) richMessage.media = mediaArr;
  if (isRTL(html)) richMessage.is_rtl = true;

  const replyToId = messages[0].message_id;
  const r = await sendRichWithAttach(env, chatId, replyToId, richMessage, threadId, attachments);
  if (!r.ok) {
    console.error('[album] attach send failed:', r.description);
    const fallbackMedia = mediaArr.map(m => {
      const a = attachments.find(x => `attach://${x.name}` === m.media.media);
      return a ? { id: m.id, media: { type: m.media.type, media: a.fileId } } : m;
    });
    const fallback = { html, media: fallbackMedia };
    if (richMessage.is_rtl) fallback.is_rtl = true;
    await sendRich(env, chatId, replyToId, fallback, threadId);
  }
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
// Media classification
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

function pickBestPhoto(photos) {
  if (!Array.isArray(photos) || photos.length === 0) return null;
  const sorted = [...photos].sort((a, b) => {
    const aPx = (a.width || 0) * (a.height || 0);
    const bPx = (b.width || 0) * (b.height || 0);
    if (bPx !== aPx) return bPx - aPx;
    return (b.file_size || 0) - (a.file_size || 0);
  });
  return sorted[0];
}

function fullTagFor(message) {
  if (Array.isArray(message.photo) && message.photo.length) {
    const best = pickBestPhoto(message.photo);
    if (best) return {
      tag: `<img src="tg://photo?id=${best.file_id}"/>`,
      fileId: best.file_id, kind: 'photo',
      meta: { width: best.width, height: best.height, file_size: best.file_size },
    };
  }
  if (message.video)      return { tag: `<video src="tg://video?id=${message.video.file_id}"/>`, fileId: message.video.file_id, kind: 'video' };
  if (message.animation)  return { tag: `<video src="tg://video?id=${message.animation.file_id}"/>`, fileId: message.animation.file_id, kind: 'video' };
  if (message.video_note) return { tag: `<video src="tg://video?id=${message.video_note.file_id}"/>`, fileId: message.video_note.file_id, kind: 'video' };
  if (message.document) {
    const d = message.document;
    return { tag: `<a href="tg://document?id=${d.file_id}">${escapeHtml(d.file_name || 'document')}</a>`, fileId: d.file_id, kind: 'document' };
  }
  if (message.audio)      return { tag: `<audio src="tg://audio?id=${message.audio.file_id}"/>`, fileId: message.audio.file_id, kind: 'audio' };
  if (message.voice)      return { tag: `<audio src="tg://audio?id=${message.voice.file_id}"/>`, fileId: message.voice.file_id, kind: 'audio' };
  if (message.sticker)    return { tag: `<img src="tg://photo?id=${message.sticker.file_id}"/>`, fileId: message.sticker.file_id, kind: 'photo' };
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// Image dimension parser (JPEG / PNG / GIF / WEBP)
// ═══════════════════════════════════════════════════════════════════════
function readImageDimensions(bytes) {
  // PNG
  if (bytes.length >= 24 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    const w = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
    const h = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
    return { width: w >>> 0, height: h >>> 0, mime: 'image/png' };
  }
  // JPEG
  if (bytes.length >= 4 && bytes[0] === 0xFF && bytes[1] === 0xD8) {
    let i = 2;
    while (i < bytes.length - 9) {
      if (bytes[i] !== 0xFF) { i++; continue; }
      const marker = bytes[i + 1];
      if ((marker >= 0xC0 && marker <= 0xC3) ||
          (marker >= 0xC5 && marker <= 0xC7) ||
          (marker >= 0xC9 && marker <= 0xCB) ||
          (marker >= 0xCD && marker <= 0xCF)) {
        const h = (bytes[i + 5] << 8) | bytes[i + 6];
        const w = (bytes[i + 7] << 8) | bytes[i + 8];
        return { width: w, height: h, mime: 'image/jpeg' };
      }
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      i += 2 + len;
    }
  }
  // GIF
  if (bytes.length >= 10 &&
      bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const w = bytes[6] | (bytes[7] << 8);
    const h = bytes[8] | (bytes[9] << 8);
    return { width: w, height: h, mime: 'image/gif' };
  }
  // WEBP
  if (bytes.length >= 30 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunk === 'VP8 ') {
      const w = (bytes[26] | (bytes[27] << 8)) & 0x3FFF;
      const h = (bytes[28] | (bytes[29] << 8)) & 0x3FFF;
      return { width: w, height: h, mime: 'image/webp' };
    }
    if (chunk === 'VP8L') {
      const b0 = bytes[21], b1 = bytes[22], b2 = bytes[23], b3 = bytes[24];
      const w = 1 + ((b0 | (b1 << 8)) & 0x3FFF);
      const h = 1 + (((b1 >> 6) | (b2 << 2) | (b3 << 10)) & 0x3FFF);
      return { width: w, height: h, mime: 'image/webp' };
    }
    if (chunk === 'VP8X') {
      const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { width: w, height: h, mime: 'image/webp' };
    }
  }
  return null;
}

// Download a file_id and report its ACTUAL dimensions and byte size.
async function inspectFile(env, fileId) {
  const gf = await tg(env, 'getFile', { file_id: fileId });
  if (!gf.ok || !gf.result?.file_path) {
    return { error: gf.description || 'getFile failed' };
  }
  const url = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${gf.result.file_path}`;
  const res = await fetch(url);
  if (!res.ok) return { error: `HTTP ${res.status}` };

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  const CAP = 65536;
  while (received < CAP) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
  }
  try { reader.cancel(); } catch {}

  const head = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { head.set(c, off); off += c.byteLength; }

  const dims = readImageDimensions(head);
  const sizeFromHeader = parseInt(res.headers.get('content-length') || '0', 10);

  return {
    file_path: gf.result.file_path,
    file_size: sizeFromHeader || gf.result.file_size || null,
    width: dims?.width,
    height: dims?.height,
    mime: dims?.mime,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// /start — help
// ═══════════════════════════════════════════════════════════════════════
function sample(code, output, lang) {
  const cls = lang ? ` class="language-${lang}"` : '';
  const codeBlock = `<pre><code${cls}>${escapeHtml(code)}</code></pre>`;
  if (!output) return codeBlock;
  return codeBlock + '\n<p><b>خروجی:</b></p>\n' + output;
}

const HELP_SECTIONS = {
  overview: {
    label: '🏠 خانه',
    body:
      '<h1>ربات تبدیل پیام به Rich Message</h1>\n' +
      '<p>برای تبدیل پیام معمولی به پیام غنی (rich message)، باید پیام رو با تگ های HTML اقدام کنید، چجوری؟</p>\n' +
      '<p>با گذاشتن متن یا المان در بین <code>&lt;tag&gt;</code> ها</p>\n' +
      '<p>که معمولا در این شکل هستن:</p>\n' +
      '<pre><code>&lt;tag&gt;متن یا المان&lt;/tag&gt;</code></pre>\n' +
      '<p>پیام رو که کامل با تگ های موردنظرتون نوشتید، با <code>/rich</code> بهش ریپلای بزنید، یا پیام رو مستقیم داخل کانالی که این ربات درش ادمین هست بفرستید، ربات به صورت خودکار پیام رو ادیت و تبدیل به پیام غنی میکنه</p>\n' +
      '<p>اگر می‌خواید بیشتر بدونید، این رو بخونید:</p>\n' +
      '<p><a href="https://blog.faradars.org/%D9%BE%D8%B1-%DA%A9%D8%A7%D8%B1%D8%A8%D8%B1%D8%AF%D8%AA%D8%B1%DB%8C%D9%86-%D8%AA%DA%AF-%D9%87%D8%A7%DB%8C-html/">پرکاربردترین تگ‌های HTML — فرادرس</a></p>',
  },
  text: { label: '📝 متن', body:
    '<h2>📝 قالب‌بندی درون‌خطی</h2>\n' +
    sample('<b>بولد</b> <i>ایتالیک</i> <u>زیرخط</u>', '<p><b>بولد</b> <i>ایتالیک</i> <u>زیرخط</u></p>') +
    sample('<s>خط‌خورده</s> <mark>هایلایت</mark>', '<p><s>خط‌خورده</s> <mark>هایلایت</mark></p>') +
    sample('<sub>زیرنویس</sub> <sup>بالانویس</sup> <tg-spoiler>اسپویلر</tg-spoiler>', '<p><sub>زیرنویس</sub> <sup>بالانویس</sup> <tg-spoiler>اسپویلر</tg-spoiler></p>') +
    sample('دستور <code>npm install</code> را اجرا کنید.', '<p>دستور <code>npm install</code> را اجرا کنید.</p>'),
  },
  blocks: { label: '🧱 بلوک‌ها', body:
    '<h2>🧱 عناصر بلوکی</h2>\n' +
    '<h3>سرتیتر</h3>\n' +
    sample('<h1>سرتیتر ۱</h1>\n<h2>سرتیتر ۲</h2>', '<h1>سرتیتر ۱</h1>\n<h2>سرتیتر ۲</h2>') +
    '<h3>پاراگراف</h3>\n' +
    sample('<p>پاراگراف اول.</p>\n<p>پاراگراف دوم.</p>', '<p>پاراگراف اول.</p>\n<p>پاراگراف دوم.</p>') +
    '<h3>نقل‌قول</h3>\n' +
    sample('<blockquote>نقل‌قول<cite>نویسنده</cite></blockquote>', '<blockquote>نقل‌قول<cite>نویسنده</cite></blockquote>') +
    sample('<aside>نقل‌قول کششی<cite>منبع</cite></aside>', '<aside>نقل‌قول کششی<cite>منبع</cite></aside>') +
    '<h3>کد</h3>\n' +
    sample('<pre><code class="language-python">print("hi")</code></pre>', '<pre><code class="language-python">print("hi")</code></pre>') +
    '<h3>جداکننده و پاورقی</h3>\n' +
    sample('<p>بخش اول</p>\n<hr/>\n<footer>پاورقی</footer>', '<p>بخش اول</p>\n<hr/>\n<footer>پاورقی</footer>'),
  },
  lists: { label: '📋 لیست و جدول', body:
    '<h2>📋 لیست‌ها</h2>\n' +
    '<h3>لیست نامرتب</h3>\n' +
    sample('<ul>\n  <li>آیتم اول</li>\n  <li>آیتم دوم</li>\n</ul>', '<ul>\n  <li>آیتم اول</li>\n  <li>آیتم دوم</li>\n</ul>') +
    '<h3>لیست مرتب با حروف</h3>\n' +
    sample('<ol type="a">\n  <li>اول</li>\n  <li>دوم</li>\n</ol>', '<ol type="a">\n  <li>اول</li>\n  <li>دوم</li>\n</ol>') +
    '<h3>لیست وظایف</h3>\n' +
    sample('<ul>\n  <li><input type="checkbox" checked>انجام شد</li>\n  <li><input type="checkbox">در انتظار</li>\n</ul>',
           '<ul>\n  <li><input type="checkbox" checked>انجام شد</li>\n  <li><input type="checkbox">در انتظار</li>\n</ul>') +
    '<h3>جدول</h3>\n' +
    sample('<table bordered striped>\n  <tr><th>نام</th><th>سن</th></tr>\n  <tr><td>علی</td><td>۳۰</td></tr>\n</table>',
           '<table bordered striped>\n  <tr><th>نام</th><th>سن</th></tr>\n  <tr><td>علی</td><td>۳۰</td></tr>\n</table>'),
  },
  details: { label: '🔽 تاشو', body:
    '<h2>🔽 بخش‌های تاشو</h2>\n' +
    '<h3>حالت بسته</h3>\n' +
    sample('<details><summary>عنوان</summary>محتوا</details>', '<details><summary>عنوان</summary>محتوا</details>') +
    '<h3>حالت باز</h3>\n' +
    sample('<details open><summary>عنوان</summary>محتوا</details>', '<details open><summary>عنوان</summary>محتوا</details>') +
    '<h3>محتوای غنی داخل تاشو</h3>\n' +
    sample('<details><summary><b>خلاصه</b></summary>\n  <ul><li>آیتم ۱</li><li>آیتم ۲</li></ul>\n</details>',
           '<details><summary><b>خلاصه</b></summary>\n  <ul><li>آیتم ۱</li><li>آیتم ۲</li></ul>\n</details>'),
  },
  media: { label: '🖼 مدیا', body:
    '<h2>🖼 تگ‌های مدیا</h2>\n' +
    '<h3>تصویر</h3>\n' + sample('<img src="https://picsum.photos/400/300"/>') +
    '<p><b>خروجی:</b></p>\n<img src="https://picsum.photos/400/300"/>\n' +
    '<h3>تصویر دوم (لوگوی تلگرام)</h3>\n' + sample('<img src="https://telegram.org/img/t_logo.png"/>') +
    '<p><b>خروجی:</b></p>\n<img src="https://telegram.org/img/t_logo.png"/>\n' +
    '<h3>ویدیو</h3>\n' + sample('<video src="https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4"/>') +
    '<p><b>خروجی:</b></p>\n<video src="https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4"/>\n' +
    '<h3>صدا</h3>\n' + sample('<audio src="https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"/>') +
    '<p><b>خروجی:</b></p>\n<audio src="https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"/>\n' +
    '<h3>📎 فایل تلگرامی خودتان</h3>\n' +
    '<p>فایل (عکس، ویدیو، سند و…) را در <b>چت خصوصی با ربات</b> بفرستید. ربات بلافاصله تگ آن را به‌صورت یک بلوک کد قابل کپی می‌دهد:</p>\n' +
    sample('<img src="tg://photo?id=AgACAgQAAxkBAAM…"/>') +
    '<p>انواع پشتیبانی‌شده: عکس، ویدیو، گیف، ویدیوی گرد، سند، فایل صوتی، پیام صوتی، استیکر.</p>\n' +
    '<aside>با /rich، فایل مجدداً آپلود می‌شود تا کیفیت اصلی حفظ شود.<cite>کیفیت</cite></aside>\n' +
    '<aside>اگر چند فایل را با هم (به‌صورت آلبوم) بفرستید، ربات یک پیام غنی با پیش‌نمایش هرکدام می‌سازد.<cite>آلبوم</cite></aside>\n' +
    '<h3>کلاژ</h3>\n' +
    sample('<tg-collage>\n  <img src="https://picsum.photos/id/1015/500/400"/>\n  <img src="https://picsum.photos/id/1016/500/400"/>\n  <figcaption>مناظر طبیعی<cite>Picsum</cite></figcaption>\n</tg-collage>') +
    '<p><b>خروجی:</b></p>\n<tg-collage>\n  <img src="https://picsum.photos/id/1015/500/400"/>\n  <img src="https://picsum.photos/id/1016/500/400"/>\n  <figcaption>مناظر طبیعی<cite>Picsum</cite></figcaption>\n</tg-collage>\n' +
    '<h3>اسلایدشو</h3>\n' +
    sample('<tg-slideshow>\n  <img src="https://picsum.photos/id/1025/500/400"/>\n  <img src="https://picsum.photos/id/1035/500/400"/>\n  <img src="https://picsum.photos/id/1040/500/400"/>\n  <figcaption>سه اسلاید</figcaption>\n</tg-slideshow>') +
    '<p><b>خروجی:</b></p>\n<tg-slideshow>\n  <img src="https://picsum.photos/id/1025/500/400"/>\n  <img src="https://picsum.photos/id/1035/500/400"/>\n  <img src="https://picsum.photos/id/1040/500/400"/>\n  <figcaption>سه اسلاید</figcaption>\n</tg-slideshow>\n' +
    '<h3>نقشه</h3>\n' + sample('<tg-map lat="35.6892" long="51.3890" zoom="12"/>') +
    '<p><b>خروجی:</b></p>\n<tg-map lat="35.6892" long="51.3890" zoom="12"/>',
  },
};

const HELP_ORDER = ['overview', 'text', 'blocks', 'lists', 'details', 'media'];

function buildHelpPage(sectionKey) {
  const key = HELP_SECTIONS[sectionKey] ? sectionKey : 'overview';
  const section = HELP_SECTIONS[key];
  const row1Keys = HELP_ORDER.slice(0, 3);
  const row2Keys = HELP_ORDER.slice(3);
  function btnRow(keys) {
    const buttons = keys.map(k => {
      const s = HELP_SECTIONS[k];
      const style = k === key ? ' style="primary"' : '';
      return `<tg-button type="callback_data"${style} data="start:${k}">${escapeHtml(s.label)}</tg-button>`;
    });
    return `<tg-button-row align="center">${buttons.join('')}</tg-button-row>`;
  }
  const html = `${section.body}\n\n${btnRow(row1Keys)}\n${btnRow(row2Keys)}`;
  const msg = { html };
  if (isRTL(html)) msg.is_rtl = true;
  return msg;
}

async function handleStart(message, env) {
  const rich = buildHelpPage('overview');
  const r = await sendRich(env, message.chat.id, message.message_id, rich, message.message_thread_id);
  if (!r.ok) {
    await sendPlain(env, message.chat.id, message.message_id,
      `<b>❌ sendRichMessage failed</b>\n<pre>${escapeHtml((r.description || '').slice(0, 400))}</pre>`,
      message.message_thread_id);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Callback query
// ═══════════════════════════════════════════════════════════════════════
async function handleCallbackQuery(cq, env) {
  const data = cq.data || '';
  const m = data.match(/^start:([a-z_]+)$/);
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  if (!m) return;
  const rich = buildHelpPage(m[1]);
  const edit = await tg(env, 'editMessageText', {
    chat_id: cq.message.chat.id,
    message_id: cq.message.message_id,
    rich_message: rich,
  });
  if (!edit.ok) console.error('[callback] edit failed:', edit.description);
}

// ═══════════════════════════════════════════════════════════════════════
// PV media
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
  const parts = [];
  parts.push('<b>🛠 /debug — raw dump</b>');
  parts.push(`<b>Bot:</b> @${escapeHtml(bot.username || '?')}`);
  parts.push(`<b>Chat:</b> <code>${escapeHtml(message.chat.id)}</code>`);
  parts.push('');
  parts.push('<b>── Full update JSON ──</b>');
  parts.push(`<pre>${escapeHtml(jsonBlock(update, 2200))}</pre>`);

  const replied = message.reply_to_message;

  const inspected = [];
  if (replied) inspected.push({ label: 'reply target', msg: replied });
  if (replied?.reply_to_message) {
    inspected.push({ label: 'reply target’s reply target', msg: replied.reply_to_message });
  }

  for (const { label, msg } of inspected) {
    const analysis = [];

    if (Array.isArray(msg.photo) && msg.photo.length) {
      analysis.push(`<b>── Photo quality analysis (${label}) ──</b>`);
      const best = pickBestPhoto(msg.photo);
      analysis.push(`Reported ${msg.photo.length} sizes. Verifying with real downloads…`);

      for (const p of msg.photo) {
        const isBest = p.file_id === best.file_id;
        const marker = isBest ? ' ✅ <b>PICKED</b>' : '';
        const rep = `${p.width}×${p.height} / ${p.file_size ?? '?'} B`;
        const real = await inspectFile(env, p.file_id);
        let realStr;
        if (real.error) {
          realStr = `⚠️ ${real.error}`;
        } else {
          const dims = (real.width && real.height) ? `${real.width}×${real.height}` : 'unknown dims';
          const size = real.file_size ? `${(real.file_size / 1024).toFixed(1)} KB` : '?';
          const mime = real.mime ? `, ${real.mime}` : '';
          realStr = `${dims} / ${size}${mime}`;
        }
        analysis.push(
          `• <code>…${p.file_id.slice(-8)}</code>${marker}\n` +
          `  reported: <code>${rep}</code>\n` +
          `  actual:   <code>${realStr}</code>`
        );
      }

      analysis.push('');
      analysis.push('<b>What /rich will use:</b>');
      analysis.push(`<code>…${best.file_id.slice(-8)}</code> — ${best.width}×${best.height}`);
    }

    if (msg.video || msg.animation || msg.video_note) {
      const v = msg.video || msg.animation || msg.video_note;
      analysis.push(`<b>── Video (${label}) ──</b>`);
      const real = await inspectFile(env, v.file_id);
      const sizeStr = real.file_size ? `${(real.file_size / 1024).toFixed(1)} KB` : '?';
      analysis.push(`• <code>…${v.file_id.slice(-8)}</code>`);
      analysis.push(`  reported: <code>${v.width ?? '?'}×${v.height ?? '?'} / ${v.file_size ?? '?'} B</code>`);
      analysis.push(`  actual:   <code>${real.error ? real.error : sizeStr}</code>`);
    }

    if (msg.document) {
      const d = msg.document;
      analysis.push(`<b>── Document (${label}) ──</b>`);
      const real = await inspectFile(env, d.file_id);
      const sizeStr = real.file_size ? `${(real.file_size / 1024).toFixed(1)} KB` : '?';
      analysis.push(`• <code>…${d.file_id.slice(-8)}</code>`);
      analysis.push(`  name: <code>${escapeHtml(d.file_name || '?')}</code>`);
      analysis.push(`  reported: <code>${d.file_size ?? '?'} B</code>`);
      analysis.push(`  actual:   <code>${real.error ? real.error : sizeStr}</code>`);
    }

    const rich = msg.rich_message;
    if (rich) {
      analysis.push(`<b>── Rich message (${label}) ──</b>`);
      if (typeof rich === 'object' && Array.isArray(rich.media) && rich.media.length) {
        analysis.push(`<b>${rich.media.length}</b> media entries:`);
        for (const m of rich.media) {
          const src = m?.media?.media ?? '?';
          analysis.push(`• type=<code>${escapeHtml(m?.media?.type ?? '?')}</code>, id=<code>${escapeHtml(m.id)}</code>`);
          analysis.push(`  source: <code>${escapeHtml(String(src).slice(0, 80))}</code>`);
        }
      } else {
        analysis.push('media array: <i>not echoed back by Telegram (expected)</i>');
      }
      if (typeof rich === 'object' && typeof rich.html === 'string') {
        analysis.push('');
        analysis.push('<b>HTML:</b>');
        analysis.push(`<pre>${escapeHtml(rich.html.slice(0, 700))}</pre>`);

        const refs = [...rich.html.matchAll(/tg:\/\/(photo|video|audio|document)\?id=([^"'\s&<>]+)/g)];
        if (refs.length) {
          analysis.push('<b>Media refs in HTML:</b>');
          for (const [, kind, rawId] of refs) {
            analysis.push(`• kind=<code>${escapeHtml(kind)}</code>, id=<code>${escapeHtml(rawId)}</code>`);
          }
        }
      }
    }

    if (analysis.length) {
      parts.push('');
      parts.push(...analysis);
    }
  }

  const text = parts.join('\n');
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

  const attachPayload = prepareAttachPayload(html);

  const attachMessage = { html: attachPayload.html };
  if (attachPayload.media.length) attachMessage.media = attachPayload.media;
  if (isRTL(attachPayload.html)) attachMessage.is_rtl = true;

  if (attachPayload.attachments.length > 0) {
    if (DEBUG) console.log(`[rich] uploading ${attachPayload.attachments.length} file(s)`);
    const r = await sendRichWithAttach(env, message.chat.id, replyToId, attachMessage, threadId, attachPayload.attachments);
    if (r.ok) return;
    console.warn('[rich] attach upload failed, falling back to file_id:', r.description);
  }

  const filePayload = prepareFileIdPayload(html);
  const fileMessage = { html: filePayload.html };
  if (filePayload.media.length) fileMessage.media = filePayload.media;
  if (isRTL(filePayload.html)) fileMessage.is_rtl = true;

  const rich = await sendRich(env, message.chat.id, replyToId, fileMessage, threadId);
  if (rich.ok) return;

  await sendPlain(env, message.chat.id, replyToId,
    `❌ <b>sendRichMessage failed</b>\n` +
    `description: <code>${escapeHtml((rich.description || 'none').slice(0, 400))}</code>`,
    threadId);
}

// ═══════════════════════════════════════════════════════════════════════
// Channel auto-convert
// ═══════════════════════════════════════════════════════════════════════
async function handleChannelPost(post, env, isEdit) {
  const chatId = post.chat.id;
  const msgId  = post.message_id;
  if (post.rich_message)      return;
  if (post.from?.is_bot)      return;
  if (!post.text)             return;
  if (!hasHtmlTag(post.text)) return;

  const { html: shortHtml, media } = prepareFileIdPayload(post.text);
  const richMessage = { html: shortHtml };
  if (media.length) richMessage.media = media;
  if (isRTL(shortHtml)) richMessage.is_rtl = true;

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

  const text = message.text || message.caption || '';
  const cmd = parseCommand(text, username);

  const SAFE_CMDS = new Set(['start', 'ping', 'debug']);
  if (cmd && SAFE_CMDS.has(cmd.cmd)) {
    switch (cmd.cmd) {
      case 'start': return handleStart(message, env);
      case 'ping':  return handlePing(message, env);
      case 'debug': return handleDebug(message, env, update);
    }
  }

  if (message.reply_to_message?.from?.id === botId) return;

  if (!cmd) return;

  switch (cmd.cmd) {
    case 'rich': return handleRich(message, env, cmd.args, botId);
    default:
      await sendPlain(env, message.chat.id, message.message_id,
        `❓ Unknown command <code>/${escapeHtml(cmd.cmd)}</code>. Try /start.`,
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
        if (update.callback_query)           await handleCallbackQuery(update.callback_query, env);
        else if (update.channel_post)        await handleChannelPost(update.channel_post, env, false);
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
