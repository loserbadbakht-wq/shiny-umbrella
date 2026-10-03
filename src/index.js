// src/index.js
// Rich Message bot.
//
//  ▸ PV single media  → replies with a tag (full file_id)
//  ▸ PV album         → rich message with tags + <details> previews
//  ▸ /rich <tag>       → shortens ids, builds media array, sends rich message
//  ▸ Channels (admin) → auto-edits HTML posts into rich messages
//  ▸ /start            → interactive help
//  ▸ /ping /debug

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
// Short id + media array
// ═══════════════════════════════════════════════════════════════════════
function shortIdFor(fileId) {
  let h = 0x811c9dc5;
  for (let i = 0; i < fileId.length; i++) {
    h ^= fileId.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return 'm' + h.toString(36);
}

function shortenAndBuildMedia(html) {
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
  return { html: newHtml, media };
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

// Returns { tag, fileId, kind } where tag uses the FULL file_id.
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
const ALBUM_MAP = new Map(); // media_group_id -> entry

async function processAlbum(entry) {
  if (!entry || !entry.messages || entry.messages.length === 0) return;
  const { messages, chatId, threadId, env } = entry;

  const parts = [];
  const mediaArr = [];
  const usedShortIds = new Map(); // fullFileId -> shortId

  for (const msg of messages) {
    const info = fullTagFor(msg);
    if (!info) continue;
    const label = mediaTypeLabel(msg);

    let shortId = usedShortIds.get(info.fileId);
    if (!shortId) {
      shortId = shortIdFor(info.fileId);
      usedShortIds.set(info.fileId, shortId);
      mediaArr.push({
        id: shortId,
        media: { type: info.kind, media: info.fileId },
      });
    }

    // 1) code block with the FULL-id tag (copyable)
    parts.push(`<pre><code>${escapeHtml(info.tag)}</code></pre>`);

    // 2) preview using the SHORT id (renderable)
    const previewTag = info.tag.replace(/id=[^"'\s&<>]+/, `id=${shortId}`);
    parts.push(
      `<details><summary>پیش‌نمایش ${label}</summary>${previewTag}</details>`
    );
  }

  if (parts.length === 0) return;

  const html = parts.join('\n');
  const richMessage = { html };
  if (mediaArr.length) richMessage.media = mediaArr;
  if (isRTL(html)) richMessage.is_rtl = true;

  if (DEBUG) console.log('[album] sending', mediaArr.length, 'items');

  const replyToId = messages[0].message_id;
  const r = await sendRich(env, chatId, replyToId, richMessage, threadId);
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
      // Wait a moment so all album parts arrive and get appended
      await new Promise(r => setTimeout(r, 700));
      const collected = ALBUM_MAP.get(groupId);
      ALBUM_MAP.delete(groupId);
      try {
        await processAlbum(collected);
      } catch (e) {
        console.error('[album] processing failed:', e && e.stack || e);
      }
    })());
  }
}

// ═══════════════════════════════════════════════════════════════════════
// /start — interactive help
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
      '<p>پیام رو که کامل با تگ های موردنظرتون نوشتید، با <code>/rich</code> بهش ریپلای بزنید، یا پیام رو مستقیم داخل کانالی که این ربات درش ادمین هست بفرستید، ربات به صورت خودکار پیام رو ادیت و تبدیل به پیام غنی میکنه</p>',
  },
  text: {
    label: '📝 متن',
    body:
      '<h2>📝 قالب‌بندی درون‌خطی</h2>\n' +
      sample('<b>بولد</b> <i>ایتالیک</i> <u>زیرخط</u>', '<p><b>بولد</b> <i>ایتالیک</i> <u>زیرخط</u></p>') +
      sample('<s>خط‌خورده</s> <mark>هایلایت</mark>', '<p><s>خط‌خورده</s> <mark>هایلایت</mark></p>') +
      sample('<sub>زیرنویس</sub> <sup>بالانویس</sup> <tg-spoiler>اسپویلر</tg-spoiler>', '<p><sub>زیرنویس</sub> <sup>بالانویس</sup> <tg-spoiler>اسپویلر</tg-spoiler></p>') +
      sample('دستور <code>npm install</code> را اجرا کنید.', '<p>دستور <code>npm install</code> را اجرا کنید.</p>'),
  },
  blocks: {
    label: '🧱 بلوک‌ها',
    body:
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
  lists: {
    label: '📋 لیست و جدول',
    body:
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
  details: {
    label: '🔽 تاشو',
    body:
      '<h2>🔽 بخش‌های تاشو</h2>\n' +
      '<h3>حالت بسته</h3>\n' +
      sample('<details><summary>عنوان</summary>محتوا</details>', '<details><summary>عنوان</summary>محتوا</details>') +
      '<h3>حالت باز</h3>\n' +
      sample('<details open><summary>عنوان</summary>محتوا</details>', '<details open><summary>عنوان</summary>محتوا</details>') +
      '<h3>محتوای غنی داخل تاشو</h3>\n' +
      sample('<details><summary><b>خلاصه</b></summary>\n  <ul><li>آیتم ۱</li><li>آیتم ۲</li></ul>\n</details>',
             '<details><summary><b>خلاصه</b></summary>\n  <ul><li>آیتم ۱</li><li>آیتم ۲</li></ul>\n</details>'),
  },
  media: {
    label: '🖼 مدیا',
    body:
      '<h2>🖼 تگ‌های مدیا</h2>\n' +
      '<h3>تصویر</h3>\n' +
      sample('<img src="https://picsum.photos/400/300"/>') +
      '<p><b>خروجی:</b></p>\n' +
      '<img src="https://picsum.photos/400/300"/>\n' +
      '<h3>تصویر دوم (لوگوی تلگرام)</h3>\n' +
      sample('<img src="https://telegram.org/img/t_logo.png"/>') +
      '<p><b>خروجی:</b></p>\n' +
      '<img src="https://telegram.org/img/t_logo.png"/>\n' +
      '<h3>ویدیو</h3>\n' +
      sample('<video src="https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4"/>') +
      '<p><b>خروجی:</b></p>\n' +
      '<video src="https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4"/>\n' +
      '<h3>صدا</h3>\n' +
      sample('<audio src="https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"/>') +
      '<p><b>خروجی:</b></p>\n' +
      '<audio src="https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"/>\n' +
      '<h3>📎 فایل تلگرامی خودتان</h3>\n' +
      '<p>فایل (عکس، ویدیو، سند و…) را در <b>چت خصوصی با ربات</b> بفرستید. ربات بلافاصله تگ آن را به‌صورت یک بلوک کد قابل کپی می‌دهد:</p>\n' +
      sample('<img src="tg://photo?id=AgACAgQAAxkBAAM…"/>') +
      '<p>انواع پشتیبانی‌شده: عکس، ویدیو، گیف، ویدیوی گرد، سند، فایل صوتی، پیام صوتی، استیکر.</p>\n' +
      '<aside>می‌توانید چند تگ را با هم ترکیب کنید تا کلاژ یا اسلایدشو بسازید.<cite>نکته</cite></aside>\n' +
      '<aside>اگر چند فایل را با هم (به‌صورت آلبوم) بفرستید، ربات یک پیام غنی با پیش‌نمایش هرکدام می‌سازد.<cite>آلبوم</cite></aside>\n' +
      '<h3>کلاژ</h3>\n' +
      sample('<tg-collage>\n  <img src="https://picsum.photos/id/1015/500/400"/>\n  <img src="https://picsum.photos/id/1016/500/400"/>\n  <figcaption>مناظر طبیعی<cite>Picsum</cite></figcaption>\n</tg-collage>') +
      '<p><b>خروجی:</b></p>\n' +
      '<tg-collage>\n  <img src="https://picsum.photos/id/1015/500/400"/>\n  <img src="https://picsum.photos/id/1016/500/400"/>\n  <figcaption>مناظر طبیعی<cite>Picsum</cite></figcaption>\n</tg-collage>\n' +
      '<h3>اسلایدشو</h3>\n' +
      sample('<tg-slideshow>\n  <img src="https://picsum.photos/id/1025/500/400"/>\n  <img src="https://picsum.photos/id/1035/500/400"/>\n  <img src="https://picsum.photos/id/1040/500/400"/>\n  <figcaption>سه اسلاید</figcaption>\n</tg-slideshow>') +
      '<p><b>خروجی:</b></p>\n' +
      '<tg-slideshow>\n  <img src="https://picsum.photos/id/1025/500/400"/>\n  <img src="https://picsum.photos/id/1035/500/400"/>\n  <img src="https://picsum.photos/id/1040/500/400"/>\n  <figcaption>سه اسلاید</figcaption>\n</tg-slideshow>\n' +
      '<h3>نقشه</h3>\n' +
      sample('<tg-map lat="35.6892" long="51.3890" zoom="12"/>') +
      '<p><b>خروجی:</b></p>\n' +
      '<tg-map lat="35.6892" long="51.3890" zoom="12"/>',
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
// PV media handler (single media)
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

  const { html: shortHtml, media } = shortenAndBuildMedia(html);
  const richMessage = { html: shortHtml };
  if (media.length) richMessage.media = media;
  if (isRTL(shortHtml)) richMessage.is_rtl = true;

  const rich = await sendRich(env, message.chat.id, replyToId, richMessage, threadId);
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

  const { html: shortHtml, media } = shortenAndBuildMedia(post.text);
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

  // Album (multiple media) in private chat → batch & send one rich reply
  if (message.chat.type === 'private' && message.media_group_id) {
    if (DEBUG) console.log('[album] queued msg', message.message_id, 'group', message.media_group_id);
    scheduleAlbumProcessing(message, env, ctx);
    return;
  }

  // Single PV media → tag reply
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
