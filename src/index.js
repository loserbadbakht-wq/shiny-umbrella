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

// ---------- Download image bytes inside the Worker ----------
async function downloadImage(url) {
  if (!url) return null;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://gelbooru.com/',
      'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    console.log(`⚠️ Image download failed (${res.status}): ${url}`);
    return null;
  }
  return {
    buf: await res.arrayBuffer(),
    contentType: res.headers.get('content-type') || 'image/jpeg',
  };
}

// ---------- Multipart upload to Telegram ----------
async function tgSendPhotoUpload(token, chatId, fileBuf, contentType, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('parse_mode', 'HTML');
  form.append('caption', caption.slice(0, 1024));
  form.append('photo', new Blob([fileBuf], { type: contentType }), 'image.jpg');

  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'POST',
    body: form,
  });
  return res.json();
}

async function sendPost(token, chatId, post) {
  const { text, title } = buildDescription(post);
  const img = await downloadImage(post.sample_url);

  if (img) {
    const r = await tgSendPhotoUpload(token, chatId, img.buf, img.contentType, text);
    if (r.ok) {
      if (text.length > 1024) {
        await tg(token, 'sendMessage', {
          chat_id: chatId,
          text: `<b>${title}</b>\n\n${text}`,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
      }
      return true;
    }
    console.log('sendPhoto(upload) failed:', r.description);
  }

  const r = await tg(token, 'sendMessage', {
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
  await sendPost(env.BOT_TOKEN, chatId, posts[0]);
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
      await sendPost(env.BOT_TOKEN, chatId, post);
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
    return handleWebhook(request, env);
  },
};
