// src/index.js
// Rich Message bot.
//
//  ▸ PV media         → replies with a tag (full file_id)
//  ▸ /rich <tag>       → shortens ids, builds media array, sends rich message
//  ▸ Channels (admin) → auto-edits HTML posts into rich messages
//  ▸ /send             → interactive help with switchable sections + code samples
//  ▸ /ping /debug /help

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
// Media → tag
// ═══════════════════════════════════════════════════════════════════════
function mediaTag(message) {
  if (Array.isArray(message.photo) && message.photo.length) {
    const p = message.photo[message.photo.length - 1];
    return `<img src="tg://photo?id=${p.file_id}"/>`;
  }
  if (message.video) return `<video src="tg://video?id=${message.video.file_id}"/>`;
  if (message.animation) return `<video src="tg://video?id=${message.animation.file_id}"/>`;
  if (message.video_note) return `<video src="tg://video?id=${message.video_note.file_id}"/>`;
  if (message.document) {
    const d = message.document;
    const label = d.file_name || 'document';
    return `<a href="tg://document?id=${d.file_id}">${escapeHtml(label)}</a>`;
  }
  if (message.audio) return `<audio src="tg://audio?id=${message.audio.file_id}"/>`;
  if (message.voice) return `<audio src="tg://audio?id=${message.voice.file_id}"/>`;
  if (message.sticker) return `<img src="tg://photo?id=${message.sticker.file_id}"/>`;
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
// /send — interactive help with code samples
// ═══════════════════════════════════════════════════════════════════════
// Small helper for building a code sample inside the help page.
function sample(code, lang) {
  const cls = lang ? ` class="language-${lang}"` : '';
  return `<pre><code${cls}>${escapeHtml(code)}</code></pre>`;
}

const HELP_SECTIONS = {
  overview: {
    label: '🏠 خانه',
    body:
      '<h1>🤖 ربات پیام غنی</h1>\n' +
      '<p>HTML و تگ‌های تلگرامی را به <b>پیام غنی</b> تبدیل می‌کنم.</p>\n' +
      '<p>هر بخش را با دکمه‌های زیر ببینید. بخش‌ها جدا هستند تا پیام بزرگ نشود.</p>\n' +
      '<aside>نمونه‌ها به‌صورت بلوک کد نمایش داده می‌شوند تا مستقیم کپی کنید.<cite>راهنما</cite></aside>',
  },

  text: {
    label: '📝 متن',
    body:
      '<h2>📝 قالب‌بندی درون‌خطی</h2>\n' +
      '<p><b>بولد</b> · <i>ایتالیک</i> · <u>زیرخط</u> · <s>خط‌خورده</s> · <code>کد</code> · <mark>هایلایت</mark> · <sub>زیرنویس</sub> · <sup>بالانویس</sup> · <tg-spoiler>اسپویلر</tg-spoiler></p>\n' +
      '<p><b>کد منبع:</b></p>\n' +
      sample(
        '<b>بولد</b> <i>ایتالیک</i> <u>زیرخط</u>\n' +
        '<s>خط‌خورده</s> <mark>هایلایت</mark>\n' +
        '<sub>زیرنویس</sub> <sup>بالانویس</sup>\n' +
        '<tg-spoiler>اسپویلر</tg-spoiler>'
      ),
  },

  blocks: {
    label: '🧱 بلوک‌ها',
    body:
      '<h2>🧱 عناصر بلوکی</h2>\n' +
      '<h3>سرتیتر</h3>\n' +
      sample('<h1>سرتیتر ۱</h1>\n<h2>سرتیتر ۲</h2>\n<h3>سرتیتر ۳</h3>') +
      '<h3>پاراگراف و نقل‌قول</h3>\n' +
      sample(
        '<p>یک پاراگراف متن.</p>\n' +
        '<blockquote>نقل‌قول<cite>نویسنده</cite></blockquote>\n' +
        '<aside>نقل‌قول کششی</aside>'
      ) +
      '<h3>کد و پاورقی</h3>\n' +
      sample(
        '<pre><code class="language-python">print("hi")</code></pre>\n' +
        '<hr/>\n' +
        '<footer>پاورقی</footer>'
      ),
  },

  lists: {
    label: '📋 لیست و جدول',
    body:
      '<h2>📋 لیست‌ها</h2>\n' +
      '<h3>لیست نامرتب و مرتب</h3>\n' +
      sample(
        '<ul>\n  <li>آیتم الف</li>\n  <li>آیتم ب</li>\n</ul>\n\n' +
        '<ol type="a" start="3">\n  <li>c</li>\n  <li>d</li>\n</ol>'
      ) +
      '<h3>لیست وظایف</h3>\n' +
      sample(
        '<ul>\n' +
        '  <li><input type="checkbox" checked>انجام شد</li>\n' +
        '  <li><input type="checkbox">در انتظار</li>\n' +
        '</ul>'
      ) +
      '<h3>جدول</h3>\n' +
      sample(
        '<table bordered striped>\n' +
        '  <tr><th>نام</th><th>سن</th></tr>\n' +
        '  <tr><td>علی</td><td>۳۰</td></tr>\n' +
        '</table>'
      ),
  },

  details: {
    label: '🔽 تاشو',
    body:
      '<h2>🔽 بخش‌های تاشو</h2>\n' +
      '<h3>حالت بسته (پیش‌فرض)</h3>\n' +
      sample('<details><summary>عنوان</summary>محتوای پنهان</details>') +
      '<h3>حالت باز (پیش‌فرض)</h3>\n' +
      sample('<details open><summary>عنوان</summary>محتوای نمایان</details>') +
      '<h3>نمونه‌ی زنده</h3>\n' +
      '<details><summary>برای باز کردن کلیک کنید</summary>حالا این متن را می‌بینید.</details>\n' +
      '<details open><summary>از ابتدا باز</summary>این یکی از اول باز است.</details>',
  },

  media: {
    label: '🖼 مدیا',
    body:
      '<h2>🖼 تگ‌های مدیا</h2>\n' +
      '<h3>استاندارد (نیاز به URL عمومی)</h3>\n' +
      sample(
        '<img src="https://example.com/photo.jpg"/>\n' +
        '<video src="https://example.com/clip.mp4"/>\n' +
        '<audio src="https://example.com/song.mp3"/>'
      ) +
      '<h3>ترکیبی</h3>\n' +
      sample(
        '<tg-collage>\n' +
        '  <img src="https://example.com/a.jpg"/>\n' +
        '  <img src="https://example.com/b.jpg"/>\n' +
        '  <figcaption>عنوان<cite>منبع</cite></figcaption>\n' +
        '</tg-collage>\n\n' +
        '<tg-slideshow>\n' +
        '  <img src="https://example.com/1.jpg"/>\n' +
        '  <video src="https://example.com/2.mp4"/>\n' +
        '  <figcaption>اسلایدشو</figcaption>\n' +
        '</tg-slideshow>'
      ) +
      '<h3>نقشه</h3>\n' +
      sample('<tg-map lat="35.6892" long="51.3890" zoom="12"/>') +
      '<aside>فایل تلگرامی خودتان را در چت خصوصی بفرستید تا تگ آن را بگیرید.<cite>نکته</cite></aside>',
  },

  usage: {
    label: '⚙️ استفاده',
    body:
      '<h2>⚙️ نحوه استفاده</h2>\n' +
      '<h3>۱. فایل تلگرامی → تگ</h3>\n' +
      '<p>عکس یا ویدیو را به ربات در چت خصوصی بفرستید. تگ می‌گیرید:</p>\n' +
      sample('<img src="tg://photo?id=AgACAgQAAxkBAAM…"/>') +
      '<h3>۲. تگ → پیام غنی</h3>\n' +
      '<p>تگ را با <code>/rich</code> بفرستید:</p>\n' +
      sample('/rich <img src="tg://photo?id=AgACAgQAAxkBAAM…"/>') +
      '<h3>۳. کانال (اختیاری)</h3>\n' +
      '<p>اگر ربات در کانال ادمین باشد، فقط تگ را به‌عنوان پست بنویسید:</p>\n' +
      sample('<h2>عنوان</h2>\n<img src="tg://photo?id=AgACAgQAAxkBAAM…"/>\n<footer>پاورقی</footer>') +
      '<h3>دستورات</h3>\n' +
      '<table bordered striped>\n' +
      '  <tr><td><code>/send</code></td><td>این راهنما</td></tr>\n' +
      '  <tr><td><code>/rich</code></td><td>تبدیل HTML</td></tr>\n' +
      '  <tr><td><code>/ping</code></td><td>بررسی اتصال</td></tr>\n' +
      '  <tr><td><code>/debug</code></td><td>نمایش JSON خام</td></tr>\n' +
      '  <tr><td><code>/help</code></td><td>راهنمای کوتاه</td></tr>\n' +
      '</table>',
  },
};

const HELP_ORDER = ['overview', 'text', 'blocks', 'lists', 'details', 'media', 'usage'];

function buildHelpPage(sectionKey) {
  const key = HELP_SECTIONS[sectionKey] ? sectionKey : 'overview';
  const section = HELP_SECTIONS[key];

  const row1Keys = HELP_ORDER.slice(0, 4);
  const row2Keys = HELP_ORDER.slice(4);

  function btnRow(keys) {
    const buttons = keys.map(k => {
      const s = HELP_SECTIONS[k];
      const style = k === key ? ' style="primary"' : '';
      return `<tg-button type="callback_data"${style} data="send:${k}">${escapeHtml(s.label)}</tg-button>`;
    });
    return `<tg-button-row align="center">${buttons.join('')}</tg-button-row>`;
  }

  const html = `${section.body}\n\n${btnRow(row1Keys)}\n${btnRow(row2Keys)}`;
  return { html };
}

async function handleSend(message, env) {
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
  const m = data.match(/^send:([a-z_]+)$/);

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
    '<code>/send</code> — راهنمای تعاملی\n' +
    '<code>/rich</code> — تبدیل HTML\n' +
    '<code>/ping</code> · <code>/debug</code> · <code>/help</code>',
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

  const { html: shortHtml, media } = shortenAndBuildMedia(html);
  const richMessage = media.length ? { html: shortHtml, media } : { html };

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
  const richMessage = media.length ? { html: shortHtml, media } : { html: post.text };

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

  if (await handleMediaPV(message, env)) return;

  if (message.reply_to_message?.from?.id === botId) return;

  const text = message.text || message.caption || '';
  const cmd = parseCommand(text, username);
  if (!cmd) return;

  switch (cmd.cmd) {
    case 'start':
    case 'help': return handleHelp(message, env);
    case 'send': return handleSend(message, env);
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
        if (update.callback_query)           await handleCallbackQuery(update.callback_query, env);
        else if (update.channel_post)        await handleChannelPost(update.channel_post, env, false);
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
