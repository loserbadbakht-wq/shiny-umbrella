import tagsConfig from './tags_config.json';

const { ORIENTATION, COPYRIGHT_TAGS, CHARACTER_TAGS } = tagsConfig;

const GELBOORU_API = 'https://gelbooru.com/index.php';
const BLOCKED_TAGS = ["guro", "snuff", "scat", "bestiality", "rape",
    "loli", "shota", "incest", "mind_break", "netorare",
    "mahou_shoujo_madoka_magica",];

// ============= ENCRYPTION HELPERS =============
let ENCRYPTION_KEY = 'default-key-please-change-me';

function initEncryptionKey(env) {
  if (env && env.DB_ENCRYPTION_KEY) {
    ENCRYPTION_KEY = env.DB_ENCRYPTION_KEY;
  }
}

function encryptData(data) {
  const jsonStr = JSON.stringify(data);
  const encoder = new TextEncoder();
  const plaintext = encoder.encode(jsonStr);
  const keyBytes = encoder.encode(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32));

  const encrypted = new Uint8Array(plaintext.length);
  for (let i = 0; i < plaintext.length; i++) {
    encrypted[i] = plaintext[i] ^ keyBytes[i % keyBytes.length];
  }
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < encrypted.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, encrypted.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function decryptData(encryptedStr) {
  const binary = atob(encryptedStr);
  const encrypted = Uint8Array.from(binary, c => c.charCodeAt(0));
  const keyBytes = new TextEncoder().encode(
    ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32)
  );

  const decrypted = new Uint8Array(encrypted.length);
  for (let i = 0; i < encrypted.length; i++) {
    decrypted[i] = encrypted[i] ^ keyBytes[i % keyBytes.length];
  }
  return JSON.parse(new TextDecoder().decode(decrypted));
}

// ============= KV STORAGE HELPERS (encrypted) =============
async function kvGetEncrypted(kv, key, fallback = null) {
  try {
    const raw = await kv.get(key);
    if (raw == null) return fallback;
    try {
      return decryptData(raw);
    } catch (e) {
      console.error(`[ERROR] Failed to decrypt KV key "${key}":`, e);
      return fallback;
    }
  } catch (e) {
    console.error(`[ERROR] Failed to read KV key "${key}":`, e);
    return fallback;
  }
}

async function kvPutEncrypted(kv, key, value) {
  await kv.put(key, encryptData(value));
}

async function getChatId(kv)      { return await kvGetEncrypted(kv, 'chat_id', null); }
async function saveChatId(kv, id) { await kvPutEncrypted(kv, 'chat_id', id); }
async function getLastId(kv) {
  const v = await kvGetEncrypted(kv, 'last_id', 0);
  return typeof v === 'number' ? v : parseInt(v, 10) || 0;
}
async function saveLastId(kv, id) { await kvPutEncrypted(kv, 'last_id', id); }

async function getSavedWorkerUrl(kv) { return (await kvGetEncrypted(kv, 'worker_url', '')) || ''; }
async function saveWorkerUrl(kv, url) { await kvPutEncrypted(kv, 'worker_url', url); }

// ---------- helpers ----------
function buildBlockedFilter() {
  return ' ' + BLOCKED_TAGS.map(t => `-${t}`).join(' ');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Rebuild HTML from plain caption + Telegram's caption_entities array.
function reconstructHtml(text, entities) {
  if (!text) return '';
  if (!entities || !entities.length) return text;

  // Process from the end so earlier offsets stay valid.
  const sorted = [...entities].sort((a, b) => b.offset - a.offset);
  let result = text;

  for (const ent of sorted) {
    const start = ent.offset;
    const end = ent.offset + ent.length;
    if (start < 0 || end > result.length) continue;

    const inner = result.slice(start, end);
    let wrapped;
    switch (ent.type) {
      case 'bold':          wrapped = `<b>${inner}</b>`; break;
      case 'italic':        wrapped = `<i>${inner}</i>`; break;
      case 'underline':     wrapped = `<u>${inner}</u>`; break;
      case 'strikethrough': wrapped = `<s>${inner}</s>`; break;
      case 'spoiler':       wrapped = `<tg-spoiler>${inner}</tg-spoiler>`; break;
      case 'code':          wrapped = `<code>${inner}</code>`; break;
      case 'pre':           wrapped = `<pre>${inner}</pre>`; break;
      case 'blockquote':    wrapped = `<blockquote>${inner}</blockquote>`; break;
      case 'text_link':     wrapped = `<a href="${escapeAttr(ent.url || '')}">${inner}</a>`; break;
      case 'text_mention':  wrapped = `<a href="tg://user?id=${ent.user?.id}">${inner}</a>`; break;
      case 'url':           wrapped = `<a href="${escapeAttr(inner)}">${inner}</a>`; break;
      default:              wrapped = inner;
    }
    result = result.slice(0, start) + wrapped + result.slice(end);
  }

  return result;
}

// ---------- Gelbooru ----------
async function fetchPosts(tag, limit, apiKey, userId) {
  const params = new URLSearchParams({
    page: 'dapi', s: 'post', q: 'index', json: '1',
    limit: String(limit), pid: '0',
    tags: `${tag}${buildBlockedFilter()}`,
    api_key: apiKey, user_id: userId,
  });

  const res = await fetch(`${GELBOORU_API}?${params}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  if (!res.ok) {
    console.log(`⚠️ API error: ${res.status}`);
    return [];
  }

  const data = await res.json();
  return (data.post || []).map(p => ({
    id: parseInt(p.id || 0, 10),
    sample_url: p.sample_url || '',
    source: p.source || '',
    tags: p.tags || '',
    rating: p.rating || '',
    score: p.score || 0,
    file_url: p.file_url || '',
  }));
}

async function getLatest(apiKey, userId, limit = 50) {
  const [yuri, yaoi] = await Promise.all([
    fetchPosts('yuri', limit, apiKey, userId),
    fetchPosts('yaoi', limit, apiKey, userId),
  ]);

  const map = new Map();
  for (const p of [...yuri, ...yaoi]) map.set(p.id, p);

  return Array.from(map.values())
    .sort((a, b) => b.id - a.id)
    .slice(0, limit);
}

// ---------- Build the message body ----------
function buildDescription(post) {
  const allTags = post.tags.split(/\s+/).filter(Boolean);

  const copyright   = allTags.filter(t => COPYRIGHT_TAGS.includes(t));
  const character   = allTags.filter(t => CHARACTER_TAGS.includes(t));
  const orientation = allTags.filter(t => ORIENTATION.includes(t));
  const other       = allTags.filter(t =>
    !COPYRIGHT_TAGS.includes(t) &&
    !CHARACTER_TAGS.includes(t) &&
    !ORIENTATION.includes(t)
  );

  const copyrightStr = copyright.length   ? copyright.join(' ')   : 'Cannot guess';
  const characterStr = character.length   ? character.join(' ')   : 'Cannot guess';
  const orientStr    = orientation.length ? orientation.join(' ') : 'Cannot guess';
  let   tagsStr      = other.length       ? other.join(' ')       : 'None';
  if (tagsStr.length > 1000) tagsStr = tagsStr.slice(0, 1000) + '...';

  const sourceLine = post.source
    ? `\n\n<a href="${escapeAttr(post.source)}">Source</a>`
    : '';

  return {
    title: allTags.slice(0, 3).join(' ') || `Image ${post.id}`,
    text:
      `<b>Copyright:</b> ${copyrightStr}\n\n` +
      `<b>Character(s):</b> ${characterStr}\n\n` +
      `<b>Orientation:</b> ${orientStr}\n\n` +
      `<b>Tags:</b> ${tagsStr}\n\n` +
      `<a href="${escapeAttr(post.file_url)}">original size</a>` +
      sourceLine,
  };
}

// ---------- Telegram ----------
async function tg(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ============================================================
// STREAMING PROXY
// URL shape:  https://<worker>/https://img4.gelbooru.com//samples/...
// ============================================================
const PROXY_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36';

function guessContentType(url, upstreamCt) {
  if (upstreamCt && /^image\//i.test(upstreamCt)) return upstreamCt;
  let ext = '';
  try {
    ext = new URL(url).pathname.split('.').pop()?.toLowerCase() || '';
  } catch {}
  return ({
    jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml',
  })[ext] || 'image/jpeg';
}

async function handleProxy(request, targetUrlStr) {
  let targetUrl;
  try {
    targetUrl = new URL(targetUrlStr);
  } catch (e) {
    console.log('❌ Proxy: bad target URL:', targetUrlStr);
    return new Response('Invalid target URL: ' + targetUrlStr, { status: 400 });
  }

  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    return new Response('Invalid protocol', { status: 400 });
  }

  const headers = new Headers();
  headers.set('User-Agent', PROXY_UA);
  headers.set(
    'Accept',
    'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
  );
  headers.set('Accept-Language', 'en-US,en;q=0.9');
  headers.set('Referer', `${targetUrl.origin}/`);

  const range = request.headers.get('Range');
  if (range) headers.set('Range', range);

  let upstream;
  try {
    upstream = await fetch(targetUrl.href, {
      method: 'GET',
      headers,
      redirect: 'follow',
    });
  } catch (e) {
    console.error('❌ Proxy fetch error:', e);
    return new Response(`Proxy fetch failed: ${e.message}`, { status: 502 });
  }

  console.log(`🎯 Proxy ${targetUrl.href} → ${upstream.status} ${upstream.headers.get('content-type')}`);

  if (!upstream.ok) {
    return new Response(`Upstream returned ${upstream.status}`, {
      status: upstream.status,
      headers: { 'content-type': 'text/plain' },
    });
  }

  const responseHeaders = new Headers();
  responseHeaders.set(
    'content-type',
    guessContentType(targetUrl.href, upstream.headers.get('content-type'))
  );
  for (const h of ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = upstream.headers.get(h);
    if (v) responseHeaders.set(h, v);
  }
  responseHeaders.set('access-control-allow-origin', '*');
  responseHeaders.set('cache-control', 'public, max-age=86400');
  responseHeaders.set('x-proxied-by', 'shiny-art-worker');

  return new Response(upstream.body, {
    status: 200,
    statusText: 'OK',
    headers: responseHeaders,
  });
}

// ---------- Build the plain proxy URL Telegram will fetch ----------
function buildProxyUrl(workerUrl, targetUrl) {
  const base = workerUrl.replace(/\/+$/, '');
  return `${base}/${targetUrl}`;
}

// ---------- Resolve the Worker's own public URL ----------
async function resolveWorkerUrl(env) {
  const fromEnv = (env.WORKER_URL || '').trim().replace(/\/+$/, '');
  if (fromEnv) return fromEnv;
  const fromKv = (await getSavedWorkerUrl(env.GELBOORU_KV) || '').trim().replace(/\/+$/, '');
  return fromKv;
}

// ---------- Inline keyboard with ❤️ button ----------
const LIKE_KEYBOARD = {
  inline_keyboard: [
    [{ text: '❤️', callback_data: 'like' }],
  ],
};

// ---------- Send a post ----------
async function sendPost(env, chatId, post) {
  const { text, title } = buildDescription(post);

  if (post.sample_url) {
    const workerUrl = await resolveWorkerUrl(env);

    if (!workerUrl) {
      console.log('⚠️ No worker URL yet — send /start once so we can save it.');
    } else {
      const proxyUrl = buildProxyUrl(workerUrl, post.sample_url);
      console.log(`📤 sendPhoto: ${proxyUrl}`);

      const r = await tg(env.BOT_TOKEN, 'sendPhoto', {
        chat_id: chatId,
        photo: proxyUrl,
        caption: text.slice(0, 1024),
        parse_mode: 'HTML',
        reply_markup: LIKE_KEYBOARD,
      });

      if (r.ok) {
        if (text.length > 1024) {
          await tg(env.BOT_TOKEN, 'sendMessage', {
            chat_id: chatId,
            text: `<b>${title}</b>\n\n${text}`,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          });
        }
        return true;
      }
      console.log('❌ sendPhoto failed:', r.description, '| url:', proxyUrl);
    }
  }

  // Text-only fallback
  const r = await tg(env.BOT_TOKEN, 'sendMessage', {
    chat_id: chatId,
    text: `<b>${title}</b>\n\n${text}`,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: LIKE_KEYBOARD,
  });
  return !!r.ok;
}

// ---------- Latest-post sender (used by /test) ----------
async function sendLatestPost(env, chatId) {
  const posts = await getLatest(env.KEY, env.ID, 1);
  if (!posts.length) {
    await tg(env.BOT_TOKEN, 'sendMessage', {
      chat_id: chatId,
      text: '⚠️ No posts found right now.',
    });
    return;
  }
  await sendPost(env, chatId, posts[0]);
}

// ---------- Handle ❤️ button press → edit the post caption ----------
async function handleCallbackQuery(env, cq) {
  // Always acknowledge the callback so Telegram stops the loading spinner.
  await tg(env.BOT_TOKEN, 'answerCallbackQuery', {
    callback_query_id: cq.id,
  });

  if (cq.data !== 'like') return;

  const msg = cq.message;
  if (!msg) return;

  const from = cq.from || {};
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Someone';
  const likeLine = `${escapeHtml(name)} liked this art!`;
  const LIKE_SUFFIX = ' liked this art!';

  // ⚠️  Telegram returns the caption as PLAIN TEXT + a separate entities array.
  //     We must rebuild the HTML before appending, or all formatting/links die.
  const plainCaption = msg.caption || msg.text || '';
  const entities = msg.caption_entities || msg.entities || [];
  const htmlCaption = reconstructHtml(plainCaption, entities);

  let newCaption = htmlCaption ? `${htmlCaption}\n\n${likeLine}` : likeLine;

  // Telegram caption limit is 1024 chars; drop the oldest like-lines if needed.
  const MAX = 1024;
  if (newCaption.length > MAX) {
    const lines = newCaption.split('\n\n');
    const header = [];
    const likes = [];
    for (const l of lines) {
      if (l.endsWith(LIKE_SUFFIX)) likes.push(l);
      else header.push(l);
    }
    let rebuilt = header.join('\n\n');
    for (let i = likes.length - 1; i >= 0; i--) {
      const candidate = `${rebuilt}\n\n${likes[i]}`;
      if (candidate.length > MAX) break;
      rebuilt = candidate;
    }
    newCaption = rebuilt;
  }

  const editPayload = {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    reply_markup: LIKE_KEYBOARD,
  };

  if (msg.caption !== undefined || msg.photo) {
    editPayload.caption = newCaption;
    editPayload.parse_mode = 'HTML';
    await tg(env.BOT_TOKEN, 'editMessageCaption', editPayload);
  } else {
    editPayload.text = newCaption;
    editPayload.parse_mode = 'HTML';
    editPayload.disable_web_page_preview = true;
    await tg(env.BOT_TOKEN, 'editMessageText', editPayload);
  }
}

// ---------- Handlers ----------
async function handleCron(env) {
  initEncryptionKey(env);

  if (!env.KEY || !env.ID) {
    console.log('❌ Missing KEY or ID env vars.');
    return;
  }

  const chatId = await getChatId(env.GELBOORU_KV);
  if (!chatId) {
    console.log('⚠️ No chat_id in KV. Send /start to the bot first.');
    return;
  }

  const posts  = await getLatest(env.KEY, env.ID, 50);
  const lastId = await getLastId(env.GELBOORU_KV);

  const newPosts = posts.filter(p => p.id > lastId).sort((a, b) => a.id - b.id);
  console.log(`🔄 ${newPosts.length} new posts (last_id=${lastId})`);

  for (const post of newPosts) {
    try {
      await sendPost(env, chatId, post);
      await saveLastId(env.GELBOORU_KV, post.id);
    } catch (e) {
      console.error(`❌ Failed to send post ${post.id}:`, e);
    }
  }
}

async function handleWebhook(request, env) {
  initEncryptionKey(env);

  // Auto-capture this Worker's public origin on any incoming request.
  try {
    const origin = new URL(request.url).origin;
    const saved = await getSavedWorkerUrl(env.GELBOORU_KV);
    if (origin && origin !== saved) {
      await saveWorkerUrl(env.GELBOORU_KV, origin);
      console.log(`📍 Saved worker URL: ${origin}`);
    }
  } catch {}

  try {
    const update = await request.json();

    // ---- ❤️ inline button press ----
    if (update.callback_query) {
      await handleCallbackQuery(env, update.callback_query);
      return new Response('ok');
    }

    // ---- Regular messages ----
    const msg = update.message || update.edited_message;

    if (msg?.text) {
      const chatId = msg.chat.id;
      const text = msg.text.trim();

      if (text.startsWith('/start')) {
        await saveChatId(env.GELBOORU_KV, chatId);
        await tg(env.BOT_TOKEN, 'sendMessage', {
          chat_id: chatId,
          text:
            '✅ Subscribed! You will receive new Gelbooru (yuri / yaoi) posts every 10 minutes.\n\n' +
            'Send /test to get the latest post right now.',
        });
        return new Response('ok');
      }

      if (text.startsWith('/test')) {
        try {
          await sendLatestPost(env, chatId);
        } catch (e) {
          console.error('sendLatestPost failed:', e);
          await tg(env.BOT_TOKEN, 'sendMessage', {
            chat_id: chatId,
            text: '❌ Failed to fetch the latest post.',
          });
        }
        return new Response('ok');
      }
    }
  } catch (e) {
    console.error('Webhook error:', e);
  }
  return new Response('ok');
}

// ---------- Diagnostics ----------
async function handleDebug(env) {
  const info = {
    savedWorkerUrl: await getSavedWorkerUrl(env.GELBOORU_KV),
    envWorkerUrl:   env.WORKER_URL || null,
    kvChatId:       await getChatId(env.GELBOORU_KV),
    kvLastId:       await getLastId(env.GELBOORU_KV),
  };
  return new Response(JSON.stringify(info, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(handleCron(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/debug') {
      initEncryptionKey(env);
      return handleDebug(env);
    }

    // Proxy route: /https://img4.gelbooru.com//samples/...
    if (
      url.pathname.startsWith('/http://') ||
      url.pathname.startsWith('/https://')
    ) {
      const target = url.pathname.slice(1) + (url.search || '');
      return handleProxy(request, target);
    }

    return handleWebhook(request, env);
  },
};
