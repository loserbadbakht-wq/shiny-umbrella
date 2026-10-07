// ============= CONFIG =============
const KV_CACHE_TTL = 30;
const OWNER_ID_FALLBACK = 302287170;

const RSS_TARGETS_KEY = 'rss:targets';
const ERRORS_KEY = 'errors:recent';

const RSS_CRON = '*/5 * * * *';
const RSS_FETCH_TIMEOUT = 12000;

const RLM = '\u200F';

// ============= ENCRYPTION =============
function encryptData(data, key) {
  const jsonStr = JSON.stringify(data);
  const encoder = new TextEncoder();
  const plaintext = encoder.encode(jsonStr);
  const keyBytes = encoder.encode(key.padEnd(32, '0').slice(0, 32));
  const encrypted = new Uint8Array(plaintext.length);
  for (let i = 0; i < plaintext.length; i++) {
    encrypted[i] = plaintext[i] ^ keyBytes[i % keyBytes.length];
  }
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < encrypted.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      encrypted.subarray(i, i + CHUNK)
    );
  }
  return btoa(binary);
}

function decryptData(encryptedStr, key) {
  const encrypted = Uint8Array.from(atob(encryptedStr), (c) =>
    c.charCodeAt(0)
  );
  const keyBytes = new TextEncoder().encode(
    key.padEnd(32, '0').slice(0, 32)
  );
  const decrypted = new Uint8Array(encrypted.length);
  for (let i = 0; i < encrypted.length; i++) {
    decrypted[i] = encrypted[i] ^ keyBytes[i % keyBytes.length];
  }
  return JSON.parse(new TextDecoder().decode(decrypted));
}

function htmlEsc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c])
  );
}

// ============= CONDITIONAL KV WRITE =============
async function writeIfChanged(env, key, data, options = {}) {
  const newRaw = encryptData(data, env.DB_ENCRYPTION_KEY);
  let oldRaw = null;
  try {
    oldRaw = await env.BOT_KV.get(key);
  } catch { /* ignore */ }
  if (oldRaw === newRaw) return false;
  await env.BOT_KV.put(key, newRaw, options);
  return true;
}

// ============= OWNER =============
function ownerId(env) {
  const v = env.OWNER_ID;
  if (v == null || v === '') return OWNER_ID_FALLBACK;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : OWNER_ID_FALLBACK;
}

// ============= ERROR REPORTING =============
async function reportError(env, where, err, extra = {}) {
  const entry = {
    t: new Date().toISOString(),
    where: where || 'unknown',
    msg: (err && (err.message || String(err))) || 'unknown error',
    stack: (err && err.stack) ? String(err.stack).slice(0, 800) : '',
    ...extra,
  };

  try {
    const raw = await env.BOT_KV.get(ERRORS_KEY, { cacheTtl: KV_CACHE_TTL });
    let list = [];
    if (raw) {
      try {
        list = decryptData(raw, env.DB_ENCRYPTION_KEY);
        if (!Array.isArray(list)) list = [];
      } catch { list = []; }
    }
    list.unshift(entry);
    list = list.slice(0, 20);
    await env.BOT_KV.put(
      ERRORS_KEY,
      encryptData(list, env.DB_ENCRYPTION_KEY)
    );
  } catch (e) {
    console.error('reportError KV write failed:', e.message);
  }

  try {
    const text =
      `🚨 *Error*\n` +
      `📍 where: \`${entry.where}\`\n` +
      `⏰ ${entry.t}\n` +
      `\n*Message*\n\`${entry.msg.replace(/`/g, '')}\`` +
      (entry.stack
        ? `\n\n*Stack (truncated)*\n\`\`\`\n${entry.stack.slice(0, 500)}\n\`\`\``
        : '');
    await sendMessage(env.BOT_TOKEN, ownerId(env), text, undefined, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
    });
  } catch (e) {
    console.error('reportError DM failed:', e.message);
  }

  console.error(`[${entry.where}]`, entry.msg);
  if (entry.stack) console.error(entry.stack);
}

// ============= TELEMETRY =============
async function logEvent(env, event) {
  try {
    const raw = await env.BOT_KV.get('telemetry', { cacheTtl: KV_CACHE_TTL });
    let log = [];
    if (raw) {
      try {
        log = decryptData(raw, env.DB_ENCRYPTION_KEY);
        if (!Array.isArray(log)) log = [];
      } catch {
        log = [];
      }
    }
    log.unshift({ t: new Date().toISOString(), ...event });
    log = log.slice(0, 30);
    await env.BOT_KV.put(
      'telemetry',
      encryptData(log, env.DB_ENCRYPTION_KEY)
    );
  } catch (e) {
    console.error('telemetry write failed:', e.message);
  }
}

// ============= RSS PARSER =============
function xmlUnescape(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripCdata(s) {
  const m = String(s).match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return (m ? m[1] : s).trim();
}

function extractTag(xml, tag) {
  const re = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
    'i'
  );
  const m = xml.match(re);
  if (!m) return '';
  return xmlUnescape(stripCdata(m[1])).trim();
}

function extractAttr(xml, tag, attr) {
  const re = new RegExp(
    `<${tag}\\b[^>]*\\s${attr}\\s*=\\s*"([^"]*)"`,
    'i'
  );
  const m = xml.match(re);
  if (!m) return '';
  return xmlUnescape(m[1]).trim();
}

function parseRssItem(xml) {
  let link = extractTag(xml, 'link');
  if (!link) {
    const m = xml.match(/<link[^>]*\shref\s*=\s*"([^"]+)"/i);
    if (m) link = xmlUnescape(m[1]).trim();
  }

  let description = '';
  let descriptionIsHtml = false;

  const htmlDesc =
    extractTag(xml, 'content:encoded') ||
    extractTag(xml, 'description') ||
    extractTag(xml, 'summary') ||
    extractTag(xml, 'content');
  if (htmlDesc) {
    description = htmlDesc;
    descriptionIsHtml = true;
  } else {
    const mediaDesc = extractTag(xml, 'media:description');
    if (mediaDesc) {
      description = mediaDesc;
      descriptionIsHtml = false;
    }
  }

  let thumbnail = extractAttr(xml, 'media:thumbnail', 'url');
  if (!thumbnail) {
    thumbnail =
      extractTag(xml, 'thumbnail') ||
      extractAttr(xml, 'enclosure', 'url') ||
      extractAttr(xml, 'media:content', 'url') ||
      '';
  }

  const pubDate =
    extractTag(xml, 'pubDate') ||
    extractTag(xml, 'dc:date') ||
    extractTag(xml, 'published') ||
    extractTag(xml, 'updated') ||
    '';

  const guid =
    extractTag(xml, 'guid') ||
    extractTag(xml, 'id') ||
    extractTag(xml, 'media:title') ||
    link ||
    extractTag(xml, 'title') ||
    '';

  const title = extractTag(xml, 'title');

  return {
    title,
    link,
    description,
    descriptionIsHtml,
    pubDate,
    guid,
    thumbnail,
  };
}

function parseRssXml(xml) {
  if (!xml || typeof xml !== 'string') return null;
  const isRss = /<rss\b/i.test(xml);
  const isAtom = /<feed\b/i.test(xml);
  if (!isRss && !isAtom) return null;

  let title = '';
  if (isRss) {
    const m = xml.match(
      /<channel\b[^>]*>[\s\S]*?<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i
    );
    if (m) title = xmlUnescape(stripCdata(m[1])).trim();
  } else {
    const m = xml.match(
      /<feed\b[^>]*>[\s\S]*?<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i
    );
    if (m) title = xmlUnescape(stripCdata(m[1])).trim();
  }

  const items = [];
  const itemRe = /<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const item = parseRssItem(m[0]);
    if (item.guid || item.link || item.title) items.push(item);
  }
  const entryRe = /<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi;
  while ((m = entryRe.exec(xml)) !== null) {
    const item = parseRssItem(m[0]);
    if (item.guid || item.link || item.title) items.push(item);
  }

  return { title, items };
}

async function fetchRssOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RSS_FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept:
          'application/rss+xml, application/atom+xml, ' +
          'application/xml, text/xml, */*',
        'User-Agent':
          'Mozilla/5.0 (compatible; RssForwarderBot/1.0)',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const xml = await res.text();
    const parsed = parseRssXml(xml);
    if (!parsed) {
      return { ok: false, reason: `bad shape: ${xml.slice(0, 80)}` };
    }
    return { ok: true, data: parsed };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, reason: e.message };
  }
}

// ============= RSS TARGETS =============
async function readRssTargets(env) {
  const raw = await env.BOT_KV.get(RSS_TARGETS_KEY, {
    cacheTtl: KV_CACHE_TTL,
  });
  if (!raw) return [];
  try {
    const arr = decryptData(raw, env.DB_ENCRYPTION_KEY);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('readRssTargets decrypt failed:', e.message);
    return [];
  }
}

async function writeRssTargets(env, targets) {
  await writeIfChanged(env, RSS_TARGETS_KEY, targets);
}

// ============= HELPERS (hashing, dates, comparison) =============
function simpleHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

function formatPubDate(s) {
  if (!s) return '';
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return new Intl.DateTimeFormat('fa-IR', {
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
  } catch {
    return s;
  }
}

function normalizeForCompare(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/https?:\/\//gi, '')
    .replace(/\bwww\./gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isTitleInDescription(title, description) {
  if (!title || !description) return false;
  const t = normalizeForCompare(title);
  if (!t) return false;
  const d = normalizeForCompare(description);
  if (!d) return false;
  return d.includes(t);
}

// ============= RSS MESSAGE BUILDER =============
function buildRssItemRichMessage(item, feedTitle, hideTitle) {
  const parts = [];
  const titleDuplicated = isTitleInDescription(item.title, item.description);
  if (item.title && !hideTitle && !titleDuplicated) {
    parts.push(`<h1>${htmlEsc(item.title)}</h1>`);
  }
  if (item.thumbnail) {
    parts.push(`<img src="${htmlEsc(item.thumbnail)}" />`);
  }
  if (item.pubDate) {
    parts.push(`<p>🗓 ${htmlEsc(formatPubDate(item.pubDate))}</p>`);
  }
  if (item.link) {
    const label = feedTitle ? htmlEsc(feedTitle) : 'مشاهده مطلب';
    parts.push(`<p>🔗 <a href="${htmlEsc(item.link)}">${label}</a></p>`);
  }
  if (item.description) {
    if (item.descriptionIsHtml) {
      let html = item.description;
      if (html.length > 3000) html = html.slice(0, 3000) + '…';
      parts.push(html);
    } else {
      let text = htmlEsc(item.description)
        .replace(/\r\n/g, '\n')
        .replace(/\n+/g, ' ')
        .trim();
      if (text.length > 1200) text = text.slice(0, 1200) + '…';
      parts.push(`<p>${text}</p>`);
    }
  }
  return { html: parts.join('\n'), is_rtl: true };
}

// ============= OPML =============
function xmlEscapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildOpml(feeds) {
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n';
  out += '<opml version="2.0">\n';
  out += '  <head>\n';
  out += '    <title>RSS Subscriptions</title>\n';
  out += '  </head>\n';
  out += '  <body>\n';
  for (const f of feeds) {
    const t = xmlEscapeAttr(f.title || f.url);
    const u = xmlEscapeAttr(f.url);
    out += `    <outline type="rss" text="${t}" title="${t}" xmlUrl="${u}"/>\n`;
  }
  out += '  </body>\n';
  out += '</opml>\n';
  return out;
}

function parseOpml(xml) {
  const feeds = [];
  const re = /<outline\b[^>]*>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const tag = m[0];
    const urlMatch = tag.match(/\sxmlUrl\s*=\s*"([^"]+)"/i);
    if (!urlMatch) continue;
    const textMatch = tag.match(/\stext\s*=\s*"([^"]+)"/i);
    const titleMatch = tag.match(/\stitle\s*=\s*"([^"]+)"/i);
    feeds.push({
      url: xmlUnescape(urlMatch[1]).trim(),
      title: xmlUnescape(
        (textMatch && textMatch[1]) ||
        (titleMatch && titleMatch[1]) ||
        ''
      ).trim(),
    });
  }
  return feeds;
}

// ============= RSS SETTINGS =============
function parseRssCallback(data) {
  if (!data || typeof data !== 'string' || !data.startsWith('rss:')) return null;
  const parts = data.split(':');
  if (parts[1] !== 'toggle') return null;
  const ref = parts.slice(2).join(':');
  if (!ref) return null;
  return { action: 'toggle', ref };
}

function rssSettingsMessage(mine, ref) {
  if (ref === 'all') {
    const total = mine.length;
    const hidden = mine.filter((t) => !!t.hideTitle).length;
    let stateStr;
    if (hidden === 0) stateStr = 'همه روشن (ON)';
    else if (hidden === total) stateStr = 'همه خاموش (OFF)';
    else stateStr = `مخلوط — ${hidden} از ${total} خاموش`;

    const willHide = hidden < total;
    const buttonText = willHide
      ? '🔕 Turn Feed Title off'
      : '🔔 Turn Feed Title on';

    return {
      text:
        `${RLM}📡 تنظیمات RSS — همه فیدها\n` +
        `${RLM}تعداد: ${total}\n` +
        `${RLM}نمایش تیتر آیتم‌ها: ${stateStr}\n\n` +
        `${RLM}با زدن دکمه، برای همه فیدهای این چت تغییر می‌کنه.`,
      button: { text: buttonText, callback_data: 'rss:toggle:all' },
    };
  }

  const t = mine.find((x) => simpleHash(x.url) === ref);
  if (!t) return null;
  const hide = !!t.hideTitle;
  const stateStr = hide ? 'خاموش (OFF)' : 'روشن (ON)';
  const buttonText = hide
    ? '🔔 Turn Feed Title on'
    : '🔕 Turn Feed Title off';

  return {
    text:
      `${RLM}📡 تنظیمات RSS\n` +
      `${RLM}«${t.title || 'RSS'}»\n` +
      `${RLM}${t.url}\n\n` +
      `${RLM}نمایش تیتر آیتم‌ها: ${stateStr}`,
    button: { text: buttonText, callback_data: `rss:toggle:${ref}` },
  };
}

function rssSettingsKeyboard(settings) {
  return {
    inline_keyboard: [
      [
        {
          text: settings.button.text,
          callback_data: settings.button.callback_data,
        },
      ],
    ],
  };
}

async function handleRssSettingsCallback(cq, parsed, env) {
  const chatId = cq.message.chat.id;
  const threadId = cq.message.message_thread_id ?? null;
  const messageId = cq.message.message_id;

  const targets = await readRssTargets(env);
  const mine = targets.filter(
    (t) => t.chatId === chatId && (t.threadId ?? null) === threadId
  );

  if (!mine.length) {
    try {
      await editMessageText(
        env.BOT_TOKEN,
        chatId,
        messageId,
        '📭 دیگه هیچ RSS ای در اینجا نیست.',
        { reply_markup: { inline_keyboard: [] } }
      );
    } catch { /* ignore */ }
    return;
  }

  let changed = 0;
  if (parsed.ref === 'all') {
    const allHidden = mine.every((t) => !!t.hideTitle);
    const newHide = !allHidden;
    for (const t of targets) {
      if (t.chatId === chatId && (t.threadId ?? null) === threadId) {
        t.hideTitle = newHide;
        changed++;
      }
    }
  } else {
    const t = targets.find(
      (x) =>
        x.chatId === chatId &&
        (x.threadId ?? null) === threadId &&
        simpleHash(x.url) === parsed.ref
    );
    if (!t) {
      try {
        await editMessageText(
          env.BOT_TOKEN,
          chatId,
          messageId,
          '⚠️ این فید دیگه وجود نداره.',
          { reply_markup: { inline_keyboard: [] } }
        );
      } catch { /* ignore */ }
      return;
    }
    t.hideTitle = !t.hideTitle;
    changed = 1;
  }

  await writeRssTargets(env, targets);

  const newMine = targets.filter(
    (t) => t.chatId === chatId && (t.threadId ?? null) === threadId
  );
  const settings = rssSettingsMessage(newMine, parsed.ref);
  if (!settings) return;

  try {
    await editMessageText(
      env.BOT_TOKEN,
      chatId,
      messageId,
      settings.text,
      { reply_markup: rssSettingsKeyboard(settings) }
    );
  } catch (e) {
    if (!/not modified/i.test(String(e.message || ''))) {
      console.error('rss settings edit failed:', e.message);
    }
  }

  await logEvent(env, {
    ev: 'rss_settings_toggle',
    ref: parsed.ref,
    changed,
  });
}

// ============= CALLBACK HANDLER =============
async function handleCallbackQuery(update, env) {
  const cq = update.callback_query;
  if (!cq) return;
  try {
    await answerCallbackQuery(env.BOT_TOKEN, cq.id);
  } catch { /* ignore */ }

  const parsed = parseRssCallback(cq.data);
  if (!parsed) return;

  try {
    await handleRssSettingsCallback(cq, parsed, env);
  } catch (e) {
    await reportError(env, 'handleRssSettingsCallback', e, { data: cq.data });
  }
}

// ============= COMMAND PARSER =============
function parseCommand(text) {
  if (!text || typeof text !== 'string' || !text.startsWith('/')) return null;
  const first = text.trim().split(/\s+/)[0];
  return first.split('@')[0].toLowerCase();
}

// ============= WORKER =============
export default {
  async fetch(request, env) {
    try {
      if (request.method === 'GET') {
        return new Response('OK', { status: 200 });
      }
      if (request.method !== 'POST') {
        return new Response('OK', { status: 200 });
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response('OK', { status: 200 });
      }

      if (update.callback_query) {
        try {
          await handleCallbackQuery(update, env);
        } catch (err) {
          await reportError(env, 'fetch.callback', err);
        }
        return new Response('OK', { status: 200 });
      }

      const msg = update.message || update.channel_post;
      try {
        await handleUpdate(update, env);
      } catch (err) {
        await reportError(env, 'handleUpdate', err, {
          cmd: msg?.text ? parseCommand(msg.text) : null,
        });
        if (msg?.chat?.id) {
          try {
            await sendMessage(
              env.BOT_TOKEN,
              msg.chat.id,
              `❌ خطای داخلی: ${err.message}`,
              topicOf(msg)
            );
          } catch { /* ignore */ }
        }
      }
      return new Response('OK', { status: 200 });
    } catch (outer) {
      await reportError(env, 'fetch.outer', outer);
      return new Response('OK', { status: 200 });
    }
  },

  async scheduled(event, env) {
    console.log(`Cron fired: ${event.cron}`);
    if (!env.BOT_TOKEN || !env.DB_ENCRYPTION_KEY || !env.BOT_KV) {
      console.error('Missing env bindings');
      return;
    }
    if (event.cron !== RSS_CRON) {
      console.log(`Unknown cron fired: ${event.cron}`);
      return;
    }

    try {
      const targets = await readRssTargets(env);
      if (!targets.length) return;

      const urlCache = new Map();
      let changed = false;

      for (const t of targets) {
        let r = urlCache.get(t.url);
        if (!r) {
          r = await fetchRssOnce(t.url);
          urlCache.set(t.url, r);
        }
        if (!r.ok) {
          console.error(`RSS fetch fail [${t.url}]: ${r.reason}`);
          continue;
        }

        const items = r.data.items;
        if (!items.length) continue;

        const newItems = [];
        let foundBoundary = false;
        for (const item of items) {
          if (item.guid && item.guid === t.lastGuid) {
            foundBoundary = true;
            break;
          }
          newItems.push(item);
        }

        const toSend = foundBoundary
          ? newItems.slice(0, 10)
          : newItems.slice(0, 3);

        toSend.reverse();

        let sentAny = false;
        for (const item of toSend) {
          try {
            await sendRichMessage(
              env.BOT_TOKEN,
              t.chatId,
              buildRssItemRichMessage(
                item,
                t.title || r.data.title,
                !!t.hideTitle
              ),
              t.threadId ?? undefined
            );
            sentAny = true;
          } catch (e) {
            console.error('RSS sendRichMessage failed:', e.message);
            await logEvent(env, {
              ev: 'rss_send_error',
              msg: e.message,
              url: t.url.slice(0, 80),
            });
          }
        }

        const newestGuid = items[0]?.guid;
        if (newestGuid && newestGuid !== t.lastGuid) {
          t.lastGuid = newestGuid;
          if (r.data.title) t.title = r.data.title;
          changed = true;
        }
        if (sentAny) {
          await logEvent(env, {
            ev: 'rss_sent',
            url: t.url.slice(0, 80),
            count: toSend.length,
          });
        }
      }

      if (changed) {
        await writeRssTargets(env, targets);
      }
    } catch (e) {
      await reportError(env, 'scheduled.rss', e);
    }
  },
};

// ============= UPDATE HANDLER =============
async function handleUpdate(update, env) {
  const msg = update.message || update.channel_post;
  if (!msg || !msg.text) return;
  const cmd = parseCommand(msg.text);
  if (!cmd) return;
  if (!env.BOT_TOKEN) return;

  const threadId = topicOf(msg) ?? null;
  const where = !threadId
    ? msg.chat.type === 'private'
      ? 'چت خصوصی'
      : msg.chat.type === 'channel'
        ? 'کانال'
        : 'چت'
    : 'تاپیک';

  switch (cmd) {
    case '/start': {
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        '<b>دستورات ربات RSS:</b>\n' +
          '/rss &lt;url&gt; — اشتراک فید جدید\n' +
          '/rssunsub &lt;url&gt; — حذف اشتراک\n' +
          '/rsslist — لیست اشتراک‌های این چت\n' +
          '/rsssettings &lt;url&gt; | all — تنظیمات نمایش تیتر\n' +
          '/rsstest &lt;url&gt; — تست دستی یک فید\n' +
          '/rssexport — خروجی OPML\n' +
          '/rssimport — ورودی OPML (روی فایل ریپلای کن)\n' +
          '/id — نمایش Chat ID و Topic ID\n' +
          '/ping — تست',
        threadId ?? undefined,
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      await logEvent(env, { ev: 'start_help' });
      return;
    }

    case '/ping': {
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `🏓 pong — ${new Date().toISOString()}`,
        threadId ?? undefined
      );
      return;
    }

    case '/id': {
      const lines = [];
      lines.push(`${RLM}🆔 شناسه‌ها`);
      lines.push('');
      lines.push(`${RLM}Chat ID: <code>${msg.chat.id}</code>`);
      lines.push(`${RLM}Chat type: <code>${msg.chat.type}</code>`);

      if (msg.chat.title) {
        lines.push(`${RLM}Title: <code>${htmlEsc(msg.chat.title)}</code>`);
      }
      if (msg.chat.username) {
        lines.push(
          `${RLM}Username: <code>@${htmlEsc(msg.chat.username)}</code>`
        );
      }

      if (msg.chat.type === 'supergroup' || msg.chat.type === 'channel') {
        lines.push(
          `${RLM}Chat (full): <code>${String(msg.chat.id).replace(
            /^-100/,
            ''
          )}</code>  ← بدون -100`
        );
      }

      lines.push('');
      lines.push(`${RLM}🧵 Topic / Thread`);
      if (threadId) {
        lines.push(`${RLM}Thread ID: <code>${threadId}</code>`);
      } else {
        lines.push(`${RLM}Thread ID: — (بدون تاپیک)`);
      }

      if (msg.from) {
        lines.push('');
        lines.push(`${RLM}👤 Sender`);
        lines.push(`${RLM}User ID: <code>${msg.from.id}</code>`);
        if (msg.from.username) {
          lines.push(
            `${RLM}Username: <code>@${htmlEsc(msg.from.username)}</code>`
          );
        }
        const name = [msg.from.first_name, msg.from.last_name]
          .filter(Boolean)
          .join(' ');
        if (name) {
          lines.push(`${RLM}Name: <code>${htmlEsc(name)}</code>`);
        }
      }

      if (msg.is_topic_message) {
        lines.push('');
        lines.push(
          `${RLM}ℹ️ این پیام داخل یک تاپیک ارسال شده.`
        );
      }

      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        lines.join('\n'),
        threadId ?? undefined,
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        }
      );

      await logEvent(env, {
        ev: 'id_cmd',
        chatId: msg.chat.id,
        threadId,
      });
      return;
    }

    case '/rss': {
      const url = msg.text.replace(/^\/rss(@\w+)?\s*/i, '').trim();
      if (!url) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          'ℹ️ استفاده:\n' +
            '`/rss <url>`\n\n' +
            'نام فید از تایتل خود RSS گرفته میشه.\n' +
            'برای حذف: `/rssunsub <url>`\n' +
            'برای تنظیمات نمایش تیتر: `/rsssettings <url>` یا `/rsssettings all`\n' +
            'برای خروجی OPML: `/rssexport`\n' +
            'برای ورودی OPML: روی فایل `.opml` ریپلای کن و `/rssimport` بزن.',
          threadId ?? undefined,
          { parse_mode: 'Markdown' }
        );
        return;
      }
      if (!/^https?:\/\//i.test(url)) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ URL باید با http یا https شروع بشه.',
          threadId ?? undefined
        );
        return;
      }
      const r = await fetchRssOnce(url);
      if (!r.ok) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          `⚠️ خطا در دریافت RSS: ${r.reason}`,
          threadId ?? undefined
        );
        return;
      }
      const title = r.data.title || 'RSS Feed';
      const lastGuid = r.data.items[0]?.guid || '';

      const targets = await readRssTargets(env);
      const existing = targets.find(
        (t) =>
          t.chatId === msg.chat.id &&
          (t.threadId ?? null) === threadId &&
          t.url === url
      );

      if (existing) {
        existing.title = title;
        existing.lastGuid = lastGuid;
        await writeRssTargets(env, targets);
        await logEvent(env, {
          ev: 'rss_sub_update',
          url: url.slice(0, 80),
          title: title.slice(0, 80),
        });
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          `${RLM}♻️ اشتراک «${title}» به‌روزرسانی شد.`,
          threadId ?? undefined
        );
        return;
      }

      targets.push({
        chatId: msg.chat.id,
        threadId,
        url,
        title,
        lastGuid,
        hideTitle: false,
      });
      await writeRssTargets(env, targets);
      await logEvent(env, {
        ev: 'rss_sub',
        url: url.slice(0, 80),
        title: title.slice(0, 80),
        total: targets.length,
      });
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `${RLM}✅ اشتراک «${title}» فعال شد. از این به بعد هر وقت آیتم جدیدی در این فید بیاد، در این ${where} ارسال میشه.`,
        threadId ?? undefined
      );
      return;
    }

    case '/rssunsub': {
      const url = msg.text.replace(/^\/rssunsub(@\w+)?\s*/i, '').trim();
      if (!url) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          'ℹ️ `/rssunsub <url>`',
          threadId ?? undefined,
          { parse_mode: 'Markdown' }
        );
        return;
      }
      const targets = await readRssTargets(env);
      const idx = targets.findIndex(
        (t) =>
          t.chatId === msg.chat.id &&
          (t.threadId ?? null) === threadId &&
          t.url === url
      );
      if (idx === -1) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ اشتراکی با این URL در اینجا پیدا نشد.',
          threadId ?? undefined
        );
        return;
      }
      const removed = targets.splice(idx, 1)[0];
      await writeRssTargets(env, targets);
      await logEvent(env, {
        ev: 'rss_unsub',
        url: removed.url.slice(0, 80),
        title: (removed.title || '').slice(0, 80),
      });
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `✅ اشتراک «${removed.title || removed.url}» حذف شد.`,
        threadId ?? undefined
      );
      return;
    }

    case '/rsslist': {
      const targets = await readRssTargets(env);
      const mine = targets.filter(
        (t) =>
          t.chatId === msg.chat.id &&
          (t.threadId ?? null) === threadId
      );

      if (!mine.length) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          `📭 هیچ RSS ای در این ${where} وجود نداره.\n` +
            'برای اضافه کردن: `/rss <url>`',
          threadId ?? undefined,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const s = [];
      s.push(`${RLM}📡 RSS در این ${where} (${mine.length})`);
      s.push('');

      mine.forEach((t, i) => {
        const titleState = t.hideTitle ? '🔕' : '🔔';
        s.push(`${RLM}${i + 1}. ${titleState} «${t.title || 'RSS'}»`);
        s.push(`${RLM}   ${t.url}`);
      });

      s.push('');
      s.push(`${RLM}🔔 = تیتر آیتم‌ها نمایش داده میشه`);
      s.push(`${RLM}🔕 = تیتر آیتم‌ها مخفی میشه`);
      s.push(`${RLM}برای تغییر: /rsssettings <url> یا /rsssettings all`);
      s.push(`${RLM}برای حذف: /rssunsub <url>`);

      let text = s.join('\n');
      if (text.length > 4000) {
        text = text.slice(0, 3950) + '\n…';
      }

      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        text,
        threadId ?? undefined,
        { link_preview_options: { is_disabled: true } }
      );

      await logEvent(env, { ev: 'rss_list', count: mine.length });
      return;
    }

    case '/rsssettings': {
      const arg = msg.text.replace(/^\/rsssettings(@\w+)?\s*/i, '').trim();

      if (!arg) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          'ℹ️ استفاده:\n' +
            '`/rsssettings all` — تنظیم همه فیدهای این ' + where + '\n' +
            '`/rsssettings <url>` — تنظیم یک فید خاص\n\n' +
            'با این تنظیم می‌تونی مشخص کنی تیتر خود آیتم‌ها (item title) توی پیام‌ها نمایش داده بشه یا نه.',
          threadId ?? undefined,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const targets = await readRssTargets(env);
      const mine = targets.filter(
        (t) =>
          t.chatId === msg.chat.id &&
          (t.threadId ?? null) === threadId
      );

      if (!mine.length) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          `📭 هیچ RSS ای در این ${where} وجود نداره. اول با /rss اضافه کن.`,
          threadId ?? undefined
        );
        return;
      }

      let ref;
      if (arg.toLowerCase() === 'all') {
        ref = 'all';
      } else {
        if (!/^https?:\/\//i.test(arg)) {
          await sendMessage(
            env.BOT_TOKEN,
            msg.chat.id,
            '⚠️ URL باید با http یا https شروع بشه، یا کلمه `all`.',
            threadId ?? undefined,
            { parse_mode: 'Markdown' }
          );
          return;
        }
        const match = mine.find((t) => t.url === arg);
        if (!match) {
          await sendMessage(
            env.BOT_TOKEN,
            msg.chat.id,
            '⚠️ اشتراکی با این URL در اینجا پیدا نشد. از /rsslist استفاده کن.',
            threadId ?? undefined
          );
          return;
        }
        ref = simpleHash(match.url);
      }

      const settings = rssSettingsMessage(mine, ref);
      if (!settings) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ خطا در ساخت تنظیمات. دوباره تلاش کن.',
          threadId ?? undefined
        );
        return;
      }

      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        settings.text,
        threadId ?? undefined,
        { reply_markup: rssSettingsKeyboard(settings) }
      );

      await logEvent(env, { ev: 'rss_settings_open', ref });
      return;
    }

    case '/rsstest': {
      const url = msg.text.replace(/^\/rsstest(@\w+)?\s*/i, '').trim();
      if (!url) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          'ℹ️ `/rsstest <url>`\n\n' +
            'آخرین آیتم فید رو همین الان برای تست ارسال می‌کنه.',
          threadId ?? undefined,
          { parse_mode: 'Markdown' }
        );
        return;
      }
      if (!/^https?:\/\//i.test(url)) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ URL باید با http یا https شروع بشه.',
          threadId ?? undefined
        );
        return;
      }
      const r = await fetchRssOnce(url);
      if (!r.ok) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          `⚠️ خطا در دریافت RSS: ${r.reason}`,
          threadId ?? undefined
        );
        return;
      }
      const first = r.data.items[0];
      if (!first) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ این فید آیتمی نداره.',
          threadId ?? undefined
        );
        return;
      }
      try {
        await sendRichMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          buildRssItemRichMessage(first, r.data.title, false),
          threadId ?? undefined
        );
      } catch (e) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          `⚠️ خطا در ارسال: ${e.message}`,
          threadId ?? undefined
        );
        return;
      }
      await logEvent(env, { ev: 'rss_test', url: url.slice(0, 80) });
      return;
    }

    case '/rssexport': {
      const targets = await readRssTargets(env);
      const mine = targets.filter(
        (t) =>
          t.chatId === msg.chat.id &&
          (t.threadId ?? null) === threadId
      );
      if (!mine.length) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '📭 اشتراکی در این ' + where + ' وجود نداره.',
          threadId ?? undefined
        );
        return;
      }
      const opml = buildOpml(mine);
      try {
        await sendDocument(
          env.BOT_TOKEN,
          msg.chat.id,
          'subscriptions.opml',
          opml,
          'text/x-opml',
          threadId ?? undefined
        );
      } catch (e) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          `❌ خطا در ارسال فایل OPML: ${e.message}`,
          threadId ?? undefined
        );
        await reportError(env, 'rssexport', e);
        return;
      }
      await logEvent(env, { ev: 'rss_export', count: mine.length });
      return;
    }

    case '/rssimport': {
      const reply = msg.reply_to_message;
      if (!reply || !reply.document) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          'ℹ️ روی یک فایل OPML ریپلای کن و `/rssimport` بزن.',
          threadId ?? undefined,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      let opml;
      try {
        opml = await getFileText(env.BOT_TOKEN, reply.document.file_id);
      } catch (e) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          `❌ خطا در دریافت فایل: ${e.message}`,
          threadId ?? undefined
        );
        await reportError(env, 'rssimport_fetch', e);
        return;
      }

      const feeds = parseOpml(opml);
      if (!feeds.length) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ هیچ فید معتبری در OPML پیدا نشد.',
          threadId ?? undefined
        );
        return;
      }

      const capped = feeds.slice(0, 50);

      const targets = await readRssTargets(env);
      let added = 0;
      let updated = 0;
      let failed = 0;

      for (const feed of capped) {
        const r = await fetchRssOnce(feed.url);
        if (!r.ok) {
          failed++;
          continue;
        }
        const title = r.data.title || feed.title || feed.url;
        const lastGuid = r.data.items[0]?.guid || '';

        const existing = targets.find(
          (t) =>
            t.chatId === msg.chat.id &&
            (t.threadId ?? null) === threadId &&
            t.url === feed.url
        );
        if (existing) {
          existing.title = title;
          existing.lastGuid = lastGuid;
          updated++;
        } else {
          targets.push({
            chatId: msg.chat.id,
            threadId,
            url: feed.url,
            title,
            lastGuid,
            hideTitle: false,
          });
          added++;
        }
      }

      await writeRssTargets(env, targets);
      await logEvent(env, {
        ev: 'rss_import',
        added,
        updated,
        failed,
        total: capped.length,
      });

      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `${RLM}📥 ایمپورت انجام شد.\n` +
          `${RLM}✅ ${added} اشتراک جدید، ♻️ ${updated} به‌روزرسانی، ❌ ${failed} ناموفق` +
          (feeds.length > capped.length
            ? `\n${RLM}(فقط ${capped.length} فید اول پردازش شد)`
            : ''),
        threadId ?? undefined
      );
      return;
    }

    case '/errors': {
      if (msg.from?.id !== ownerId(env)) return;
      const parts = msg.text.trim().split(/\s+/);
      let n = 10;
      if (parts[1]) {
        const parsed = parseInt(parts[1], 10);
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 20) n = parsed;
      }
      const raw = await env.BOT_KV.get(ERRORS_KEY, { cacheTtl: KV_CACHE_TTL });
      let list = [];
      if (raw) {
        try {
          list = decryptData(raw, env.DB_ENCRYPTION_KEY);
          if (!Array.isArray(list)) list = [];
        } catch { list = []; }
      }
      if (!list.length) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '✅ هیچ خطایی ثبت نشده.',
          threadId ?? undefined
        );
        return;
      }
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `📋 *${list.length} error(s) recorded. Showing last ${Math.min(n, list.length)}:*`,
        threadId ?? undefined,
        { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
      );
      for (const e of list.slice(0, n)) {
        const text =
          `📍 *${e.where}*\n` +
          `⏰ ${e.t}\n` +
          `\n*Message:*\n\`${String(e.msg).replace(/`/g, '')}\`` +
          (e.stack
            ? `\n\n*Stack:*\n\`\`\`\n${e.stack.slice(0, 900)}\n\`\`\``
            : '');
        try {
          await sendMessage(env.BOT_TOKEN, msg.chat.id, text, threadId ?? undefined, {
            parse_mode: 'Markdown',
            link_preview_options: { is_disabled: true },
          });
        } catch (err) {
          await sendMessage(
            env.BOT_TOKEN,
            msg.chat.id,
            `${e.where} — ${e.msg}\n${e.stack || ''}`,
            threadId ?? undefined
          );
        }
      }
      return;
    }

    case '/clearerrors': {
      if (msg.from?.id !== ownerId(env)) return;
      await env.BOT_KV.delete(ERRORS_KEY);
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        '🗑 Error log cleared.',
        threadId ?? undefined
      );
      return;
    }

    case '/debug': {
      const send = (text) =>
        sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          text,
          threadId ?? undefined,
          { link_preview_options: { is_disabled: true } }
        );

      try {
        const s = [];
        s.push('🔍 Debug 1/3 — Basic');
        s.push('');
        s.push('📍 Chat');
        s.push(`  type: ${msg.chat.type}`);
        s.push(`  thread: ${threadId ?? '—'}`);
        s.push('');
        s.push('⚙️ Env');
        s.push(`  BOT_TOKEN: ${env.BOT_TOKEN ? '✅' : '❌'}`);
        s.push(`  DB_ENCRYPTION_KEY: ${env.DB_ENCRYPTION_KEY ? '✅' : '❌'}`);
        s.push(`  BOT_KV: ${env.BOT_KV ? '✅' : '❌'}`);
        s.push(`  OWNER_ID: ${ownerId(env)}`);
        await send(s.join('\n'));
      } catch (e) {
        await send(`🔍 Debug 1/3 — Basic ⚠️ ${e.message}`);
      }

      try {
        const s = [];
        s.push('🔍 Debug 2/3 — Subscriptions');
        s.push('');
        try {
          const rts = await readRssTargets(env);
          s.push(`📡 RSS total (${rts.length})`);
          const rcap = rts.slice(0, 10);
          rcap.forEach((t, i) => {
            const flag = t.hideTitle ? '🔕' : '🔔';
            s.push(`  ${i + 1}. ${flag} «${t.title || 'RSS'}»`);
            s.push(`     chat=${t.chatId} thread=${t.threadId ?? '—'}`);
            s.push(`     ${t.url.slice(0, 70)}`);
          });
          if (rts.length > 10) s.push(`  … +${rts.length - 10} more`);
        } catch (e) {
          s.push(`📡 RSS ⚠️ ${e.message}`);
        }
        await send(s.join('\n'));
      } catch (e) {
        await send(`🔍 Debug 2/3 — Subscriptions ⚠️ ${e.message}`);
      }

      try {
        const s = [];
        s.push('🔍 Debug 3/3 — Bot & Webhook');
        s.push('');
        s.push('🤖 Bot');
        try {
          const me = await telegram(env.BOT_TOKEN, 'getMe');
          s.push(`  @${me.result.username}`);
        } catch (e) {
          s.push(`  ⚠️ ${e.message}`);
        }
        s.push('');
        s.push('🪝 Webhook');
        try {
          const info = await telegram(env.BOT_TOKEN, 'getWebhookInfo');
          const r = info.result || {};
          s.push(`  url: ${r.url ? '✅ set' : '❌'}`);
          s.push(`  pending: ${r.pending_update_count ?? 0}`);
          if (r.last_error_message) {
            s.push(`  ⚠️ ${r.last_error_message}`);
          } else {
            s.push('  last_error: none ✅');
          }
        } catch (e) {
          s.push(`  ⚠️ ${e.message}`);
        }
        s.push('');
        s.push('🚨 Errors');
        try {
          const rawErr = await env.BOT_KV.get(ERRORS_KEY, {
            cacheTtl: KV_CACHE_TTL,
          });
          let errCount = 0;
          if (rawErr) {
            try {
              const list = decryptData(rawErr, env.DB_ENCRYPTION_KEY);
              errCount = Array.isArray(list) ? list.length : 0;
            } catch { errCount = 0; }
          }
          s.push(`  recorded: ${errCount}`);
          if (errCount > 0) s.push('  use /errors to view');
        } catch (e) {
          s.push(`  ⚠️ ${e.message}`);
        }
        await send(s.join('\n'));
      } catch (e) {
        await send(`🔍 Debug 3/3 — Bot & Webhook ⚠️ ${e.message}`);
      }
      return;
    }

    default:
      return;
  }
}

// ============= HELPERS =============
function topicOf(msg) {
  return msg.is_topic_message && msg.message_thread_id
    ? msg.message_thread_id
    : undefined;
}

async function sendMessage(token, chatId, text, threadId, extra = {}) {
  const body = { chat_id: chatId, text, ...extra };
  if (threadId) body.message_thread_id = threadId;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(
      `sendMessage ${res.status}: ${data.description || JSON.stringify(data)}`
    );
  }
  return data;
}

async function sendRichMessage(token, chatId, richMessage, threadId, extra = {}) {
  const body = { chat_id: chatId, rich_message: richMessage, ...extra };
  if (threadId) body.message_thread_id = threadId;
  const res = await fetch(
    `https://api.telegram.org/bot${token}/sendRichMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(
      `sendRichMessage ${res.status}: ${data.description || JSON.stringify(data)}`
    );
  }
  return data;
}

async function sendDocument(token, chatId, filename, content, mimeType, threadId, extra = {}) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (threadId) form.append('message_thread_id', String(threadId));
  form.append(
    'document',
    new Blob([content], { type: mimeType || 'application/octet-stream' }),
    filename
  );
  for (const [k, v] of Object.entries(extra)) {
    form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const res = await fetch(
    `https://api.telegram.org/bot${token}/sendDocument`,
    { method: 'POST', body: form }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(
      `sendDocument ${res.status}: ${data.description || JSON.stringify(data)}`
    );
  }
  return data;
}

async function getFileText(token, fileId) {
  const infoRes = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`
  );
  const info = await infoRes.json();
  if (!info.ok) throw new Error(info.description || 'getFile failed');
  const filePath = info.result.file_path;
  const fileRes = await fetch(
    `https://api.telegram.org/file/bot${token}/${filePath}`
  );
  if (!fileRes.ok) throw new Error(`file download HTTP ${fileRes.status}`);
  return await fileRes.text();
}

async function editMessageText(token, chatId, messageId, text, extra = {}) {
  const res = await fetch(
    `https://api.telegram.org/bot${token}/editMessageText`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        ...extra,
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(
      `editMessageText ${res.status}: ${data.description || JSON.stringify(data)}`
    );
  }
  return data;
}

async function answerCallbackQuery(token, callbackQueryId, extra = {}) {
  const res = await fetch(
    `https://api.telegram.org/bot${token}/answerCallbackQuery`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, ...extra }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(
      `answerCallbackQuery ${res.status}: ${data.description || JSON.stringify(data)}`
    );
  }
  return data;
}

async function telegram(token, method, params = {}) {
  const res = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    Object.keys(params).length
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        }
      : undefined
  );
  return res.json();
    }
