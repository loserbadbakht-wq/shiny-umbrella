import tagsConfig from './tags_config.json';

const { ORIENTATION, COPYRIGHT_TAGS, CHARACTER_TAGS } = tagsConfig;

const GELBOORU_API = 'https://gelbooru.com/index.php';
const BLOCKED_TAGS = ['mahou_shoujo_madoka_magica'];

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

// ---------- helpers ----------
function buildBlockedFilter() {
  return ' ' + BLOCKED_TAGS.map(t => `-${t}`).join(' ');
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

  return {
    title: allTags.slice(0, 3).join(' ') || `Image ${post.id}`,
    text:
      `<b>Copyright:</b> ${copyrightStr}\n\n` +
      `<b>Character(s):</b> ${characterStr}\n\n` +
      `<b>Orientation:</b> ${orientStr}\n\n` +
      `<b>Tags:</b> ${tagsStr}\n\n` +
      `<a href="${post.file_url}">original size</a>`,
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
// STREAMING PROXY  →  used so Telegram can fetch hotlink-
// protected images through us instead of downloading+uploading
// ============================================================
const PROXY_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36';

async function handleProxy(request, targetUrlStr) {
  let targetUrl;
  try {
    targetUrl = new URL(targetUrlStr);
  } catch {
    return new Response('Invalid target URL', { status: 400 });
  }

  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    return new Response('Invalid protocol', { status: 400 });
  }

  const headers = new Headers();
  headers.set('User-Agent', PROXY_UA);
  headers.set('Accept', 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8');
  headers.set('Accept-Language', 'en-US,en;q=0.9');
  headers.set('Sec-Fetch-Dest', 'image');
  headers.set('Sec-Fetch-Mode', 'no-cors');
  headers.set('Sec-Fetch-Site', 'same-origin');
  // The magic header that defeats Gelbooru's hotlink protection
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
    return new Response(`Proxy fetch failed: ${e.message}`, { status: 502 });
  }

  const responseHeaders = new Headers();
  for (const h of [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'last-modified',
    'etag',
  ]) {
    const v = upstream.headers.get(h);
    if (v) responseHeaders.set(h, v);
  }
  responseHeaders.set('access-control-allow-origin', '*');
  responseHeaders.set('cache-control', 'public, max-age=86400');
  responseHeaders.set('x-proxied-by', 'shiny-art-worker');

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

// ---------- Build a proxy URL for a given image ----------
function buildProxyUrl(env, targetUrl) {
  const base = (env.WORKER_URL || '').replace(/\/+$/, '');
  return `${base}/proxy/${encodeURIComponent(targetUrl)}`;
}

// ---------- Send a post to Telegram ----------
async function sendPost(env, chatId, post) {
  const { text, title } = buildDescription(post);

  // Primary path: give Telegram a proxy URL; it fetches the image itself.
  if (post.sample_url && env.WORKER_URL) {
    const proxyUrl = buildProxyUrl(env, post.sample_url);

    const r = await tg(env.BOT_TOKEN, 'sendPhoto', {
      chat_id: chatId,
      photo: proxyUrl,
      caption: text.slice(0, 1024),
      parse_mode: 'HTML',
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
    console.log('sendPhoto(proxy) failed:', r.description);
  }

  // Fallback: text-only message.
  const r = await tg(env.BOT_TOKEN, 'sendMessage', {
    chat_id: chatId,
    text: `<b>${title}</b>\n\n${text}`,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
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

// ---------- Handlers ----------
async function handleCron(env) {
  initEncryptionKey(env);

  if (!env.KEY || !env.ID) {
    console.log('❌ Missing KEY or ID env vars.');
    return;
  }
  if (!env.WORKER_URL) {
    console.log('❌ Missing WORKER_URL env var.');
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

  try {
    const update = await request.json();
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

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(handleCron(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);

    // /proxy/<encoded-target-url>
    if (url.pathname.startsWith('/proxy/')) {
      let target;
      try {
        target = decodeURIComponent(url.pathname.slice('/proxy/'.length));
      } catch {
        return new Response('Bad proxy path', { status: 400 });
      }
      return handleProxy(request, target + url.search);
    }

    return handleWebhook(request, env);
  },
};
