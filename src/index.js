// ============= IMPORTS =============
import tagsConfig from './tags_config.json';

const {
  ORIENTATION,
  COPYRIGHT_TAGS,
  CHARACTER_TAGS,
  BLOCKED_TAGS,
} = tagsConfig;

// ============= CONFIG (shared) =============
const KV_CACHE_TTL = 30;
const OWNER_ID_FALLBACK = 302287170;

// ============= ALLOWED CHATS =============
const ALLOWED_CHAT_IDS = new Set([
  -1004481485615,
  -1004119297598,
  302287170,
]);

// ============= CONFIG (Gelbooru) =============
const GELBOORU_API = 'https://gelbooru.com/index.php';
const GELBOORU_FETCH_LIMIT = 5;

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

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function linesToRichHtml(lines) {
  return (lines || [])
    .map((l) => (l === '' ? '<p>&nbsp;</p>' : `<p>${htmlEsc(l)}</p>`))
    .join('\n');
}

function normalizeMediaUrl(url) {
  const s = String(url || '').trim();
  const m = s.match(/^(https?:\/\/[^/]+)(.*)$/i);
  if (!m) return s;
  return m[1] + m[2].replace(/\/{2,}/g, '/');
}

function safeTruncateHtml(html, maxLen) {
  const s = String(html || '');
  if (s.length <= maxLen) return s;

  let cut = s.slice(0, maxLen);
  const lastGt = cut.lastIndexOf('>');
  const lastLt = cut.lastIndexOf('<');
  if (lastLt > lastGt) cut = cut.slice(0, lastLt);

  const stack = [];
  const tagRe = /<(\/?)([a-z][a-z0-9-]*)(?:\s[^>]*)?>/gi;
  let m;
  while ((m = tagRe.exec(cut)) !== null) {
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    if (closing) {
      if (stack.length && stack[stack.length - 1] === name) stack.pop();
    } else {
      stack.push(name);
    }
  }
  let suffix = '';
  while (stack.length) suffix += `</${stack.pop()}>`;
  return cut + '…' + suffix;
}

// ============= OWNER =============
function ownerId(env) {
  const v = env.OWNER_ID;
  if (v == null || v === '') return OWNER_ID_FALLBACK;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : OWNER_ID_FALLBACK;
}

// ============= ALLOWLIST CHECK =============
function isAllowedChat(chatId) {
  if (chatId == null) return false;
  const n = typeof chatId === 'number' ? chatId : parseInt(chatId, 10);
  if (!Number.isFinite(n)) return false;
  return ALLOWED_CHAT_IDS.has(n);
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
    const raw = await env.BOT_KV.get('errors:recent', { cacheTtl: KV_CACHE_TTL });
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
      'errors:recent',
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
async function logEvents(env, events) {
  if (!events || !events.length) return;
  try {
    const raw = await env.BOT_KV.get('telemetry', { cacheTtl: KV_CACHE_TTL });
    let log = [];
    if (raw) {
      try {
        log = decryptData(raw, env.DB_ENCRYPTION_KEY);
        if (!Array.isArray(log)) log = [];
      } catch { log = []; }
    }
    const now = new Date().toISOString();
    const fresh = events.slice().reverse().map((e) => ({ t: now, ...e }));
    log = fresh.concat(log).slice(0, 30);
    await env.BOT_KV.put(
      'telemetry',
      encryptData(log, env.DB_ENCRYPTION_KEY)
    );
  } catch (e) {
    console.error('logEvents failed:', e.message);
  }
}

async function logEvent(env, event) {
  await logEvents(env, [event]);
}

// ═══════════════════════════════════════════════════════════
//                     GELBOORU BOT
// ═══════════════════════════════════════════════════════════

async function kvGetEncrypted(env, key, fallback = null) {
  try {
    const raw = await env.BOT_KV.get(key);
    if (raw == null) return fallback;
    try {
      return decryptData(raw, env.DB_ENCRYPTION_KEY);
    } catch (e) {
      console.error(`[ERROR] Failed to decrypt KV key "${key}":`, e);
      return fallback;
    }
  } catch (e) {
    console.error(`[ERROR] Failed to read KV key "${key}":`, e);
    return fallback;
  }
}

async function kvPutEncrypted(env, key, value) {
  await env.BOT_KV.put(key, encryptData(value, env.DB_ENCRYPTION_KEY));
}

async function getChatId(env) {
  return await kvGetEncrypted(env, 'art:chat_id', null);
}
async function saveChatId(env, id) {
  await kvPutEncrypted(env, 'art:chat_id', id);
}

async function getLastId(env) {
  const v = await kvGetEncrypted(env, 'art:last_id', 0);
  return typeof v === 'number' ? v : parseInt(v, 10) || 0;
}
async function saveLastId(env, id) {
  await kvPutEncrypted(env, 'art:last_id', id);
}

async function getSavedWorkerUrl(env) {
  return (await kvGetEncrypted(env, 'art:worker_url', '')) || '';
}
async function saveWorkerUrl(env, url) {
  await kvPutEncrypted(env, 'art:worker_url', url);
}

function buildBlockedFilter() {
  return ' ' + BLOCKED_TAGS.map(t => `-${t}`).join(' ');
}

function reconstructHtml(text, entities) {
  if (!text) return '';
  if (!entities || !entities.length) return text;

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
    preview_url: p.preview_url || '',
    source: p.source || '',
    tags: p.tags || '',
    rating: p.rating || '',
    score: p.score || 0,
    file_url: p.file_url || '',
  }));
}

async function getLatest(apiKey, userId, limit = GELBOORU_FETCH_LIMIT) {
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

// Ratings: accept both short codes (s/q/e) and full words, always
// render in Title case ("Safe", "Questionable", "Explicit", ...).
function ratingLabel(r) {
  const v = String(r || '').toLowerCase().trim();
  if (!v) return 'Cannot guess';
  if (v === 's' || v === 'safe')             return 'Safe';
  if (v === 'q' || v === 'questionable')     return 'Questionable';
  if (v === 'e' || v === 'explicit')         return 'Explicit';
  if (v === 'sensitive')                     return 'Sensitive';
  if (v === 'g' || v === 'general')          return 'General';
  // Unknown value: Title-case it instead of uppercasing everything.
  return v.charAt(0).toUpperCase() + v.slice(1);
}

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
  const ratingStr    = ratingLabel(post.rating);
  let   tagsStr      = other.length       ? other.join(' ')       : 'None';
  if (tagsStr.length > 1000) tagsStr = tagsStr.slice(0, 1000) + '...';

  const footerParts = [];
  if (post.file_url) {
    footerParts.push(
      `<a href="${escapeAttr(post.file_url)}">original size</a>`
    );
  }
  if (post.source) {
    footerParts.push(
      `<a href="${escapeAttr(post.source)}">Source</a>`
    );
  }
  const footer = footerParts.join('\n\n');

  return {
    body:
      `<b>Copyright:</b> ${copyrightStr}\n\n` +
      `<b>Character(s):</b> ${characterStr}\n\n` +
      `<b>Orientation:</b> ${orientStr}\n\n` +
      `<b>Rating:</b> ${ratingStr}\n\n` +
      `<b>Tags:</b> ${tagsStr}`,
    footer,
  };
}

async function tg(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

const PROXY_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36';

const REFERER_BY_HOST = [
  { test: /(^|\.)gelbooru\.com$/i, referer: 'https://gelbooru.com/' },
  { test: /(^|\.)donmai\.us$/i,    referer: 'https://danbooru.donmai.us/' },
  { test: /(^|\.)youtube\.com$/i,  referer: 'https://www.youtube.com/' },
  { test: /(^|\.)ytimg\.com$/i,    referer: 'https://www.youtube.com/' },
];

function refererForHost(hostname) {
  for (const rule of REFERER_BY_HOST) {
    if (rule.test.test(hostname)) return rule.referer;
  }
  return `https://${hostname}/`;
}

function guessContentType(url, upstreamCt) {
  const ct = (upstreamCt || '').toLowerCase().trim();
  if (ct && ct !== 'application/octet-stream' && ct !== 'binary/octet-stream') {
    return upstreamCt;
  }
  let ext = '';
  try {
    ext = new URL(url).pathname.split('.').pop()?.toLowerCase() || '';
  } catch {}
  return ({
    jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  })[ext] || 'application/octet-stream';
}

async function handleProxy(request, targetUrlStr) {
  let targetUrl;
  try {
    targetUrl = new URL(normalizeMediaUrl(targetUrlStr));
  } catch (e) {
    console.log('❌ Proxy: bad target URL:', targetUrlStr);
    return new Response('Invalid target URL: ' + targetUrlStr, { status: 400 });
  }

  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    return new Response('Invalid protocol', { status: 400 });
  }

  const ref = refererForHost(targetUrl.hostname);

  const headers = new Headers();
  headers.set('User-Agent', PROXY_UA);
  headers.set(
    'Accept',
    'image/avif,image/webp,image/apng,image/svg+xml,image/*,video/*,*/*;q=0.8'
  );
  headers.set('Accept-Language', 'en-US,en;q=0.9');
  headers.set('Referer', ref);
  headers.set('Origin', ref.replace(/\/$/, ''));

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

  console.log(
    `🎯 Proxy ${targetUrl.href} (ref=${ref}) → ${upstream.status} ` +
    `${upstream.headers.get('content-type')}`
  );

  if (!upstream.ok) {
    return new Response(`Upstream returned ${upstream.status}`, {
      status: upstream.status,
      headers: { 'content-type': 'text/plain' },
    });
  }

  const upstreamCt = (upstream.headers.get('content-type') || '').toLowerCase();
  if (upstreamCt.startsWith('text/html') || upstreamCt.includes('application/xhtml')) {
    const preview = await upstream.text().then(t => t.slice(0, 120)).catch(() => '');
    console.log('❌ Proxy: upstream returned HTML:', preview);
    return new Response(
      `Upstream returned HTML (likely hotlink block). Preview: ${preview}`,
      { status: 502, headers: { 'content-type': 'text/plain' } }
    );
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
  responseHeaders.set('x-proxied-by', 'gelbooru-worker');

  return new Response(upstream.body, {
    status: 200,
    statusText: 'OK',
    headers: responseHeaders,
  });
}

function buildProxyUrl(workerUrl, targetUrl) {
  const base = workerUrl.replace(/\/+$/, '');
  return `${base}/${targetUrl}`;
}

async function resolveWorkerUrl(env) {
  const fromEnv = (env.WORKER_URL || '').trim().replace(/\/+$/, '');
  if (fromEnv) return fromEnv;
  const fromKv = (await getSavedWorkerUrl(env) || '').trim().replace(/\/+$/, '');
  return fromKv;
}

function classifyMediaKind(url) {
  const clean = String(url || '')
    .toLowerCase()
    .split('?')[0]
    .split('#')[0];
  if (/\.(mp4|webm|mov|m4v|avi|mkv)$/.test(clean)) return 'video';
  if (/\.gif$/.test(clean)) return 'animation';
  return 'photo';
}

function buildMediaCandidates(post) {
  const list = [];
  const seen = new Set();
  const push = (url, kind) => {
    const clean = normalizeMediaUrl(url);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    list.push({ url: clean, kind: kind || classifyMediaKind(clean) });
  };

  push(post.sample_url);
  push(post.file_url);
  push(post.preview_url, 'photo');

  return list;
}

const LIKE_KEYBOARD = {
  inline_keyboard: [
    [{ text: '❤️', callback_data: 'like' }],
  ],
};

async function trySendMedia(env, chatId, threadId, candidates, body, footer) {
  const workerUrl = await resolveWorkerUrl(env);
  if (!workerUrl) {
    return { ok: false, reason: 'no worker url' };
  }

  const tid = threadId ? { message_thread_id: threadId } : {};

  const footerText = footer ? `\n\n${footer}` : '';
  const bodyBudget = Math.max(200, 1000 - footerText.length - 20);
  const trimmedBody = safeTruncateHtml(body || '', bodyBudget);
  const cap = trimmedBody + footerText;

  const failures = [];

  for (const cand of candidates) {
    if (!cand || !cand.url) continue;
    const kind = cand.kind || classifyMediaKind(cand.url);
    const primaryMethod =
      kind === 'video' ? 'sendVideo'
      : kind === 'animation' ? 'sendAnimation'
      : 'sendPhoto';
    const primaryField =
      kind === 'video' ? 'video'
      : kind === 'animation' ? 'animation'
      : 'photo';

    const proxyUrl = buildProxyUrl(workerUrl, cand.url);

    let res = await tg(env.BOT_TOKEN, primaryMethod, {
      chat_id: chatId,
      ...tid,
      [primaryField]: proxyUrl,
      caption: cap,
      parse_mode: 'HTML',
      reply_markup: LIKE_KEYBOARD,
    });
    if (res.ok) {
      return { ok: true, method: `${primaryMethod}_proxy`, url: cand.url };
    }
    failures.push(`${primaryMethod}_proxy: ${res.description || 'failed'}`);

    if (primaryMethod !== 'sendDocument') {
      res = await tg(env.BOT_TOKEN, 'sendDocument', {
        chat_id: chatId,
        ...tid,
        document: proxyUrl,
        caption: cap,
        parse_mode: 'HTML',
        reply_markup: LIKE_KEYBOARD,
      });
      if (res.ok) {
        return { ok: true, method: 'sendDocument_proxy', url: cand.url };
      }
      failures.push(`sendDocument_proxy: ${res.description || 'failed'}`);
    }
  }

  return { ok: false, reason: failures.join(' | ') || 'no candidates' };
}

async function sendPost(env, chatId, post) {
  const { body, footer } = buildDescription(post);
  const candidates = buildMediaCandidates(post);

  if (candidates.length) {
    const result = await trySendMedia(
      env, chatId, null, candidates, body, footer
    );
    if (result.ok) {
      return true;
    }

    await reportError(env, 'art_send', new Error(result.reason), {
      postId: post.id,
      sample: !!post.sample_url,
      preview: !!post.preview_url,
      file: !!post.file_url,
    });
  } else {
    await reportError(env, 'art_no_media',
      new Error('post has no media URLs at all'),
      { postId: post.id }
    );
  }

  const fullText = `${body}${footer ? `\n\n${footer}` : ''}`;

  const r = await tg(env.BOT_TOKEN, 'sendMessage', {
    chat_id: chatId,
    text: safeTruncateHtml(fullText, 4000),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: LIKE_KEYBOARD,
  });
  return !!r.ok;
}

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

async function handleGelbooruLike(env, cq) {
  const msg = cq.message;
  if (!msg) {
    await tg(env.BOT_TOKEN, 'answerCallbackQuery', { callback_query_id: cq.id });
    return;
  }

  const from = cq.from || {};
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Someone';
  const likeLine = `${htmlEsc(name)} liked this art!`;
  const LIKE_SUFFIX = ' liked this art!';

  const plainCaption = msg.caption || msg.text || '';
  const entities = msg.caption_entities || msg.entities || [];
  const htmlCaption = reconstructHtml(plainCaption, entities);

  if (htmlCaption.includes(likeLine)) {
    await tg(env.BOT_TOKEN, 'answerCallbackQuery', {
      callback_query_id: cq.id,
      text: 'You already liked this!',
      show_alert: false,
    });
    return;
  }

  await tg(env.BOT_TOKEN, 'answerCallbackQuery', {
    callback_query_id: cq.id,
  });

  let newCaption = htmlCaption ? `${htmlCaption}\n\n${likeLine}` : likeLine;

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

async function handleGelbooruSubscribe(env, msg) {
  const chatId = msg.chat.id;
  const threadId = topicOf(msg) ?? null;

  await saveChatId(env, chatId);

  await tg(env.BOT_TOKEN, 'sendMessage', {
    chat_id: chatId,
    ...(threadId ? { message_thread_id: threadId } : {}),
    text:
      '✅ Subscribed! You will receive new Gelbooru (yuri / yaoi) posts on every check.\n\n' +
      'Send /test to get the latest post right now.',
  });

  await logEvent(env, { ev: 'art_sub', chatId, threadId });
}

async function handleGelbooruTest(env, msg) {
  const chatId = msg.chat.id;
  const threadId = topicOf(msg) ?? null;

  if (!threadId) {
    await sendLatestPost(env, chatId);
    return;
  }

  try {
    const posts = await getLatest(env.KEY, env.ID, 1);
    if (!posts.length) {
      await tg(env.BOT_TOKEN, 'sendMessage', {
        chat_id: chatId,
        message_thread_id: threadId,
        text: '⚠️ No posts found right now.',
      });
      return;
    }
    const post = posts[0];
    const { body, footer } = buildDescription(post);
    const candidates = buildMediaCandidates(post);

    if (candidates.length) {
      const result = await trySendMedia(
        env, chatId, threadId, candidates, body, footer
      );
      if (result.ok) {
        return;
      }

      await reportError(env, 'art_test_send', new Error(result.reason), {
        postId: post.id,
        sample: !!post.sample_url,
        preview: !!post.preview_url,
        file: !!post.file_url,
      });
    }

    const fullText = `${body}${footer ? `\n\n${footer}` : ''}`;

    await tg(env.BOT_TOKEN, 'sendMessage', {
      chat_id: chatId,
      message_thread_id: threadId,
      text: safeTruncateHtml(fullText, 4000),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: LIKE_KEYBOARD,
    });
  } catch (e) {
    console.error('gelbooru /test failed:', e);
    await tg(env.BOT_TOKEN, 'sendMessage', {
      chat_id: chatId,
      ...(threadId ? { message_thread_id: threadId } : {}),
      text: '❌ Failed to fetch the latest post.',
    });
  }
}

async function handleGelbooruCron(env, events) {
  if (!events) events = [];
  const summary = {
    chatId: null,
    lastId: 0,
    newCount: 0,
    sent: 0,
    error: null,
  };
  try {
    if (!env.KEY || !env.ID) {
      summary.error = 'Missing KEY or ID';
      console.log('❌ Missing KEY or ID env vars (Gelbooru).');
      return summary;
    }

    const chatId = await getChatId(env);
    summary.chatId = chatId;
    if (!chatId) {
      summary.error = 'No chat_id in KV';
      console.log('⚠️ No Gelbooru chat_id in KV. Send /art to the bot first.');
      return summary;
    }

    const posts  = await getLatest(env.KEY, env.ID, GELBOORU_FETCH_LIMIT);
    const lastId = await getLastId(env);
    summary.lastId = lastId;

    const newPosts = posts
      .filter(p => p.id > lastId)
      .sort((a, b) => a.id - b.id);
    summary.newCount = newPosts.length;
    console.log(`🔄 ${newPosts.length} new Gelbooru posts (last_id=${lastId})`);

    let lastSentId = lastId;
    for (const post of newPosts) {
      try {
        await sendPost(env, chatId, post);
        summary.sent++;
        lastSentId = post.id;
      } catch (e) {
        console.error(`❌ Failed to send post ${post.id}:`, e);
        events.push({
          ev: 'gelbooru_send_error',
          postId: post.id,
          msg: e.message,
        });
        break;
      }
    }

    if (lastSentId !== lastId) {
      await saveLastId(env, lastSentId);
    }
  } catch (e) {
    summary.error = e.message;
  }
  return summary;
}

async function handleGelbooruDebug(env) {
  const info = {
    savedWorkerUrl: await getSavedWorkerUrl(env),
    envWorkerUrl:   env.WORKER_URL || null,
    kvChatId:       await getChatId(env),
    kvLastId:       await getLastId(env),
    hasKey:         !!env.KEY,
    hasId:          !!env.ID,
    hasArttagDO:    !!env.ARTTAG_SESSION,
  };
  return new Response(JSON.stringify(info, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function parseCommand(text) {
  if (!text || typeof text !== 'string' || !text.startsWith('/')) return null;
  const first = text.trim().split(/\s+/)[0];
  return first.split('@')[0].toLowerCase();
}

// ═══════════════════════════════════════════════════════════
//                  /arttag command helpers
// ═══════════════════════════════════════════════════════════
function parseArttagArgs(text) {
  const rest = String(text || '')
    .replace(/^\/arttag(@\S+)?\s*/i, '')
    .trim();
  if (!rest) return null;

  let working = rest;
  let noFilter = false;

  const nf = working.match(/\s+no_filter\s*$/i);
  if (nf) {
    noFilter = true;
    working = working.slice(0, nf.index).trim();
  }
  if (!working) return null;

  let tags = [];

  if (working.startsWith('[')) {
    try {
      const arr = JSON.parse(working);
      if (Array.isArray(arr)) {
        tags = arr.map((t) => String(t).trim()).filter(Boolean);
      }
    } catch {}
  }

  if (!tags.length) {
    const q = working.match(/^"([^"]*)"/);
    if (q) tags = q[1].split(',').map((t) => t.trim()).filter(Boolean);
  }

  if (!tags.length) {
    tags = working
      .split(',')
      .map((t) => t.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }

  if (!tags.length) return null;
  return { tags, noFilter };
}

async function fetchAllPostsForTags(tags, noFilter, apiKey, userId) {
  if (!apiKey || !userId) throw new Error('Missing Gelbooru KEY/ID');
  if (!Array.isArray(tags) || !tags.length) return [];

  // AND semantics (like Gelbooru default): "tag1 tag2" requires both.
  const filter = noFilter ? '' : buildBlockedFilter();
  const tagsQuery = tags.map((t) => t.trim()).filter(Boolean).join(' ') + filter;

  const all = [];
  const seen = new Set();
  const LIMIT = 100;
  const MAX_PAGES = 15;

  for (let pid = 0; pid < MAX_PAGES; pid++) {
    const params = new URLSearchParams({
      page: 'dapi', s: 'post', q: 'index', json: '1',
      limit: String(LIMIT), pid: String(pid),
      tags: tagsQuery,
      api_key: apiKey, user_id: userId,
    });

    let data;
    try {
      const res = await fetch(`${GELBOORU_API}?${params}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) break;
      data = await res.json();
    } catch (e) {
      console.error(`arttag fetch pid=${pid} failed:`, e);
      break;
    }

    const posts = (data.post || []).map((p) => ({
      id: parseInt(p.id || 0, 10),
      sample_url:  p.sample_url  || '',
      preview_url: p.preview_url || '',
      source:      p.source      || '',
      tags:        p.tags        || '',
      rating:      p.rating      || '',
      score:       p.score       || 0,
      file_url:    p.file_url    || '',
    }));

    if (!posts.length) break;
    for (const p of posts) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      all.push(p);
    }
    if (posts.length < LIMIT) break;
  }

  if (!noFilter) {
    const blocked = new Set(BLOCKED_TAGS);
    return all.filter((p) => {
      const pt = p.tags.split(/\s+/).filter(Boolean);
      return !pt.some((t) => blocked.has(t));
    });
  }

  all.sort((a, b) => b.id - a.id);
  return all;
}

function arttagStub(env, chatId) {
  if (!env.ARTTAG_SESSION) return null;
  const id = env.ARTTAG_SESSION.idFromName(`chat:${chatId}`);
  return env.ARTTAG_SESSION.get(id);
}

async function handleArttagCommand(env, msg) {
  const chatId = msg.chat.id;
  const threadId = topicOf(msg) ?? null;
  const parsed = parseArttagArgs(msg.text);

  if (!parsed) {
    await sendMessage(
      env.BOT_TOKEN, chatId,
      '⚠️ Usage:\n' +
        '`/arttag "tag_name"`\n' +
        '`/arttag "tag1, tag2, tag3"`\n' +
        '`/arttag ["tag1","tag2","tag3"]`\n' +
        'Append `no_filter` to bypass the block list:\n' +
        '`/arttag "tag_name" no_filter`',
      threadId ?? undefined,
      { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
    );
    return;
  }

  const stub = arttagStub(env, chatId);
  if (!stub) {
    await sendMessage(
      env.BOT_TOKEN, chatId,
      '❌ ARTTAG_SESSION binding missing on this Worker.',
      threadId ?? undefined
    );
    return;
  }

  await sendMessage(
    env.BOT_TOKEN, chatId,
    `⏳ Starting /arttag...\n` +
      `Tags: <code>${parsed.tags.map(htmlEsc).join(', ')}</code>\n` +
      `Filter: <b>${parsed.noFilter ? 'OFF' : 'ON'}</b>`,
    threadId ?? undefined,
    { parse_mode: 'HTML' }
  );

  try {
    const res = await stub.fetch('https://do/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chatId, threadId,
        tags: parsed.tags,
        noFilter: parsed.noFilter,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      await sendMessage(
        env.BOT_TOKEN, chatId,
        `❌ Failed to start /arttag: ${data.error || 'unknown'}`,
        threadId ?? undefined
      );
    }
  } catch (e) {
    await reportError(env, 'arttag_start', e, { tags: parsed.tags });
  }

  await logEvent(env, {
    ev: 'arttag_start', chatId, threadId,
    tags: parsed.tags, noFilter: parsed.noFilter,
  });
}

async function handleArttagStop(env, msg) {
  const chatId = msg.chat.id;
  const threadId = topicOf(msg) ?? null;
  const stub = arttagStub(env, chatId);
  if (!stub) {
    await sendMessage(env.BOT_TOKEN, chatId,
      '❌ ARTTAG_SESSION binding missing.', threadId ?? undefined);
    return;
  }
  await stub.fetch('https://do/stop', { method: 'POST' });
  await sendMessage(env.BOT_TOKEN, chatId,
    '🛑 /arttag session stopped.', threadId ?? undefined);
}

async function handleArttagStatus(env, msg) {
  const chatId = msg.chat.id;
  const threadId = topicOf(msg) ?? null;
  const stub = arttagStub(env, chatId);
  if (!stub) {
    await sendMessage(env.BOT_TOKEN, chatId,
      '❌ ARTTAG_SESSION binding missing.', threadId ?? undefined);
    return;
  }
  const res = await stub.fetch('https://do/status');
  const d = await res.json().catch(() => ({}));

  const lines = [];
  lines.push('📊 /arttag status');
  lines.push('');
  lines.push(`Status:    <b>${htmlEsc(d.status || 'idle')}</b>`);
  lines.push(`Tags:      ${htmlEsc((d.tags || []).join(', ') || '—')}`);
  lines.push(`Filter:    <b>${d.noFilter ? 'OFF' : 'ON'}</b>`);
  lines.push(`Sent:      ${d.sent ?? 0} / ${d.total ?? 0}`);
  lines.push(`Remaining: ${d.remaining ?? 0}`);
  if (d.historyCount != null) lines.push(`History:   ${d.historyCount} item(s) remembered`);
  if (d.startedAt) lines.push(`Started:   ${htmlEsc(d.startedAt)}`);

  await sendMessage(env.BOT_TOKEN, chatId, lines.join('\n'),
    threadId ?? undefined, { parse_mode: 'HTML' });
}

async function handleArttagReset(env, msg) {
  const chatId = msg.chat.id;
  const threadId = topicOf(msg) ?? null;
  const stub = arttagStub(env, chatId);
  if (!stub) {
    await sendMessage(env.BOT_TOKEN, chatId,
      '❌ ARTTAG_SESSION binding missing.', threadId ?? undefined);
    return;
  }
  await stub.fetch('https://do/reset', { method: 'POST' });
  await sendMessage(env.BOT_TOKEN, chatId,
    '🧹 /arttag sent-history cleared. Next run will send everything again.',
    threadId ?? undefined);
}

async function handleUpdate(update, env) {
  const msg = update.message || update.channel_post;
  if (!msg || !msg.text) return;
  const cmd = parseCommand(msg.text);
  if (!cmd) return;
  if (!env.BOT_TOKEN) return;

  const threadId = topicOf(msg) ?? null;

  switch (cmd) {
    case '/start': {
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        '<b>Gelbooru Bot — دستورات:</b>\n' +
          '/art — اشتراک پست‌های Gelbooru (yuri / yaoi)\n' +
          '/test — ارسال جدیدترین پست همین الان\n' +
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
      lines.push('🆔 شناسه‌ها');
      lines.push('');
      lines.push(`Chat ID: <code>${msg.chat.id}</code>`);
      lines.push(`Chat type: <code>${msg.chat.type}</code>`);

      if (msg.chat.title) {
        lines.push(`Title: <code>${htmlEsc(msg.chat.title)}</code>`);
      }
      if (msg.chat.username) {
        lines.push(`Username: <code>@${htmlEsc(msg.chat.username)}</code>`);
      }

      if (msg.chat.type === 'supergroup' || msg.chat.type === 'channel') {
        lines.push(
          `Chat (full): <code>${String(msg.chat.id).replace(
            /^-100/,
            ''
          )}</code>  ← بدون -100`
        );
      }

      lines.push('');
      lines.push('🧵 Topic / Thread');
      if (threadId) {
        lines.push(`Thread ID: <code>${threadId}</code>`);
      } else {
        lines.push('Thread ID: — (بدون تاپیک)');
      }

      if (msg.from) {
        lines.push('');
        lines.push('👤 Sender');
        lines.push(`User ID: <code>${msg.from.id}</code>`);
        if (msg.from.username) {
          lines.push(`Username: <code>@${htmlEsc(msg.from.username)}</code>`);
        }
        const name = [msg.from.first_name, msg.from.last_name]
          .filter(Boolean)
          .join(' ');
        if (name) {
          lines.push(`Name: <code>${htmlEsc(name)}</code>`);
        }
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

    case '/errors': {
      if (msg.from?.id !== ownerId(env)) return;
      const parts = msg.text.trim().split(/\s+/);
      let n = 10;
      if (parts[1]) {
        const parsed = parseInt(parts[1], 10);
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 20) n = parsed;
      }
      const raw = await env.BOT_KV.get('errors:recent', { cacheTtl: KV_CACHE_TTL });
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
      await env.BOT_KV.delete('errors:recent');
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        '🗑 Error log cleared.',
        threadId ?? undefined
      );
      return;
    }

    case '/debug': {
      const send = (lines) =>
        sendRichMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          { html: linesToRichHtml(lines), is_rtl: false },
          threadId ?? undefined
        );

      try {
        const s = [];
        s.push('🔍 Debug 1/2 — Basic');
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
        s.push(`  KEY (Gelbooru): ${env.KEY ? '✅' : '❌'}`);
        s.push(`  ID (Gelbooru): ${env.ID ? '✅' : '❌'}`);
        s.push(`  ARTTAG_SESSION: ${env.ARTTAG_SESSION ? '✅' : '❌'}`);
        await send(s);
      } catch (e) {
        await send([`🔍 Debug 1/2 — Basic ⚠️ ${e.message}`]);
      }

      try {
        const s = [];
        s.push('🔍 Debug 2/2 — Gelbooru & Bot');
        s.push('');
        try {
          const gChatId = await getChatId(env);
          const gLastId = await getLastId(env);
          s.push(`🎨 Gelbooru`);
          s.push(`  chat_id: ${gChatId ?? '—'}`);
          s.push(`  last_id: ${gLastId}`);
          s.push(`  worker_url: ${(await getSavedWorkerUrl(env)) || '—'}`);
        } catch (e) {
          s.push(`🎨 Gelbooru ⚠️ ${e.message}`);
        }
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
        await send(s);
      } catch (e) {
        await send([`🔍 Debug 2/2 ⚠️ ${e.message}`]);
      }
      return;
    }

    default:
      return;
  }
}

// ═══════════════════════════════════════════════════════════
//              DO: /arttag per-chat send session
// ═══════════════════════════════════════════════════════════
function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export class ArtTagSessionDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v TEXT
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS queue (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL UNIQUE,
        data    TEXT NOT NULL,
        sent    INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_queue_sent_id ON queue(sent, id);
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sent_history (
        post_id INTEGER PRIMARY KEY,
        sent_at TEXT NOT NULL
      );
    `);
  }

  async meta(k) {
    const rows = this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray();
    return rows.length ? rows[0].v : null;
  }

  async setMeta(k, v) {
    this.sql.exec(
      `INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      k, String(v)
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\/+/, '');
    try {
      if (action === 'start')  return await this.handleStart(request);
      if (action === 'stop')   return await this.handleStop();
      if (action === 'status') return await this.handleStatus();
      if (action === 'reset')  return await this.handleReset();
      return jsonRes({ ok: false, error: 'unknown action' }, 404);
    } catch (e) {
      console.error('ArtTagSessionDO.fetch error:', e);
      return jsonRes({ ok: false, error: e.message }, 500);
    }
  }

  async handleStart(request) {
    const body = await request.json();
    const { chatId, threadId, tags, noFilter } = body;

    this.sql.exec(`DELETE FROM meta`);
    this.sql.exec(`DELETE FROM queue`);

    await this.setMeta('chatId',    chatId);
    await this.setMeta('threadId',  threadId || '');
    await this.setMeta('tags',      JSON.stringify(tags || []));
    await this.setMeta('noFilter',  noFilter ? '1' : '0');
    await this.setMeta('status',    'starting');
    await this.setMeta('startedAt', new Date().toISOString());
    await this.setMeta('sentCount', '0');
    await this.setMeta('totalCount','0');
    await this.setMeta('skippedCount', '0');

    await this.state.storage.setAlarm(Date.now() + 1000);

    return jsonRes({ ok: true, status: 'starting' });
  }

  async handleStop() {
    try { await this.state.storage.deleteAlarm(); } catch {}
    await this.setMeta('status', 'stopped');
    return jsonRes({ ok: true });
  }

  async handleReset() {
    this.sql.exec(`DELETE FROM sent_history`);
    return jsonRes({ ok: true });
  }

  async handleStatus() {
    const total = parseInt((await this.meta('totalCount')) || '0', 10);
    const sent  = parseInt((await this.meta('sentCount'))  || '0', 10);
    const remRows = this.sql
      .exec(`SELECT COUNT(*) AS c FROM queue WHERE sent = 0`)
      .toArray();
    const remaining = remRows.length ? remRows[0].c : 0;
    const histRows = this.sql
      .exec(`SELECT COUNT(*) AS c FROM sent_history`)
      .toArray();
    const historyCount = histRows.length ? histRows[0].c : 0;
    let tags = [];
    try { tags = JSON.parse((await this.meta('tags')) || '[]'); } catch {}

    return jsonRes({
      ok: true,
      status:    (await this.meta('status')) || 'idle',
      tags,
      noFilter:  (await this.meta('noFilter')) === '1',
      total, sent, remaining,
      historyCount,
      startedAt: await this.meta('startedAt'),
    });
  }

  async loadPosts(tags, noFilter) {
    try {
      const posts = await fetchAllPostsForTags(
        tags, noFilter, this.env.KEY, this.env.ID
      );

      const history = new Set(
        this.sql.exec(`SELECT post_id FROM sent_history`).toArray()
          .map((r) => r.post_id)
      );
      const fresh = posts.filter((p) => !history.has(p.id));

      for (const p of fresh) {
        try {
          this.sql.exec(
            `INSERT OR IGNORE INTO queue (post_id, data, sent) VALUES (?, ?, 0)`,
            p.id, JSON.stringify(p)
          );
        } catch (e) {
          console.error('queue insert failed:', e);
        }
      }

      await this.setMeta('totalCount', String(fresh.length));
      await this.setMeta('skippedCount', String(posts.length - fresh.length));
      await this.setMeta('status', fresh.length ? 'running' : 'empty');
      return fresh.length;
    } catch (e) {
      console.error('loadPosts failed:', e);
      await this.setMeta('status', 'error');
      await this.setMeta('lastError', e.message || String(e));
      return -1;
    }
  }

  async alarm() {
    try {
      const status = await this.meta('status');
      if (status === 'stopped' || status === 'done' || status === 'empty') {
        return;
      }

      // ---------- phase 1: load ----------
      if (status === 'starting' || status === 'loading' || status === 'error') {
        const tags = JSON.parse((await this.meta('tags')) || '[]');
        const noFilter = (await this.meta('noFilter')) === '1';
        await this.setMeta('status', 'loading');

        const loaded = await this.loadPosts(tags, noFilter);
        if (loaded < 0) {
          await this.state.storage.setAlarm(Date.now() + 60 * 1000);
          return;
        }

        const chatId   = parseInt(await this.meta('chatId'), 10);
        const threadId = parseInt((await this.meta('threadId')) || '0', 10) || null;

        const skipped = parseInt((await this.meta('skippedCount')) || '0', 10);
        const skippedLine = skipped
          ? `\n⏭ Skipped <b>${skipped}</b> already-sent item(s).`
          : '';

        if (loaded === 0) {
          await tg(this.env.BOT_TOKEN, 'sendMessage', {
            chat_id: chatId,
            ...(threadId ? { message_thread_id: threadId } : {}),
            text: `⚠️ /arttag: no new posts matched these tags.${skippedLine}`,
            parse_mode: 'HTML',
          });
          return;
        }

        await tg(this.env.BOT_TOKEN, 'sendMessage', {
          chat_id: chatId,
          ...(threadId ? { message_thread_id: threadId } : {}),
          text:
            `✅ /arttag loaded <b>${loaded}</b> new item(s).${skippedLine}\n` +
            `Sending 1 item per minute until done.\n` +
            `Use /arttagstop to stop early.`,
          parse_mode: 'HTML',
        }).catch((e) => console.error('load notify failed:', e));
      }

      // ---------- phase 2: send next ----------
      const row = this.sql.exec(
        `SELECT id, post_id, data FROM queue WHERE sent = 0 ORDER BY id ASC LIMIT 1`
      ).toArray()[0];

      if (!row) {
        await this.finishSession('done');
        return;
      }

      const post     = JSON.parse(row.data);
      const chatId   = parseInt(await this.meta('chatId'), 10);
      const threadId = parseInt((await this.meta('threadId')) || '0', 10) || null;

      try {
        const { body, footer } = buildDescription(post);
        const candidates = buildMediaCandidates(post);
        let ok = false;

        if (candidates.length) {
          const r = await trySendMedia(
            this.env, chatId, threadId, candidates, body, footer
          );
          ok = r.ok;
        }
        if (!ok) {
          const fullText = `${body}${footer ? `\n\n${footer}` : ''}`;
          const r = await tg(this.env.BOT_TOKEN, 'sendMessage', {
            chat_id: chatId,
            ...(threadId ? { message_thread_id: threadId } : {}),
            text: safeTruncateHtml(fullText, 4000),
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: LIKE_KEYBOARD,
          });
          ok = !!r.ok;
        }
      } catch (e) {
        console.error(`arttag send failed for ${post.id}:`, e);
      }

      this.sql.exec(`UPDATE queue SET sent = 1 WHERE id = ?`, row.id);

      try {
        this.sql.exec(
          `INSERT OR IGNORE INTO sent_history (post_id, sent_at) VALUES (?, ?)`,
          post.id, new Date().toISOString()
        );
      } catch (e) {
        console.error('sent_history insert failed:', e);
      }

      const sent = parseInt((await this.meta('sentCount')) || '0', 10) + 1;
      await this.setMeta('sentCount', String(sent));

      const remRows = this.sql
        .exec(`SELECT COUNT(*) AS c FROM queue WHERE sent = 0`)
        .toArray();
      const remaining = remRows.length ? remRows[0].c : 0;

      if (remaining > 0) {
        await this.state.storage.setAlarm(Date.now() + 60 * 1000);
      } else {
        await this.finishSession('done');
      }
    } catch (e) {
      console.error('arttag alarm error:', e);
      try {
        await this.state.storage.setAlarm(Date.now() + 60 * 1000);
      } catch {}
    }
  }

  async finishSession(finalStatus) {
    try { await this.state.storage.deleteAlarm(); } catch {}
    await this.setMeta('status', finalStatus);
    const chatId   = parseInt(await this.meta('chatId'), 10);
    const threadId = parseInt((await this.meta('threadId')) || '0', 10) || null;
    const sent     = parseInt((await this.meta('sentCount'))  || '0', 10);
    const total    = parseInt((await this.meta('totalCount')) || '0', 10);
    if (!chatId) return;
    await tg(this.env.BOT_TOKEN, 'sendMessage', {
      chat_id: chatId,
      ...(threadId ? { message_thread_id: threadId } : {}),
      text: `🏁 /arttag finished. Sent ${sent}/${total}.`,
    }).catch((e) => console.error('finish notify failed:', e));
  }
}

// ═══════════════════════════════════════════════════════════
//                         WORKER
// ═══════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (
        url.pathname.startsWith('/http://') ||
        url.pathname.startsWith('/https://')
      ) {
        const target = url.pathname.slice(1) + (url.search || '');
        return handleProxy(request, target);
      }

      if (url.pathname === '/debug' && request.method === 'GET') {
        return handleGelbooruDebug(env);
      }

      if (request.method === 'GET') {
        return new Response('OK', { status: 200 });
      }
      if (request.method !== 'POST') {
        return new Response('OK', { status: 200 });
      }

      try {
        const origin = url.origin;
        const saved = await getSavedWorkerUrl(env);
        if (origin && origin !== saved) {
          await saveWorkerUrl(env, origin);
          console.log(`📍 Saved worker URL: ${origin}`);
        }
      } catch { /* ignore */ }

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response('OK', { status: 200 });
      }

      const gateChatId =
        update.callback_query?.message?.chat?.id ??
        update.message?.chat?.id ??
        update.channel_post?.chat?.id ??
        update.edited_message?.chat?.id ??
        update.edited_channel_post?.chat?.id ??
        null;
      if (!isAllowedChat(gateChatId)) {
        console.log(`🚫 Ignored update from disallowed chat: ${gateChatId}`);
        return new Response('OK', { status: 200 });
      }

      if (update.callback_query) {
        const data = update.callback_query.data || '';
        try {
          if (data === 'like') {
            await handleGelbooruLike(env, update.callback_query);
          } else {
            await answerCallbackQuery(env.BOT_TOKEN, update.callback_query.id);
          }
        } catch (err) {
          await reportError(env, 'fetch.callback', err, { data });
        }
        return new Response('OK', { status: 200 });
      }

      const msg = update.message || update.channel_post;
      if (!msg) return new Response('OK', { status: 200 });

      const cmd = msg.text ? parseCommand(msg.text) : null;

      if (cmd === '/art') {
        try {
          await handleGelbooruSubscribe(env, msg);
        } catch (err) {
          await reportError(env, 'art', err);
        }
        return new Response('OK', { status: 200 });
      }
      if (cmd === '/test') {
        try {
          await handleGelbooruTest(env, msg);
        } catch (err) {
          await reportError(env, 'test', err);
        }
        return new Response('OK', { status: 200 });
      }
      if (cmd === '/arttag') {
        try { await handleArttagCommand(env, msg); }
        catch (err) { await reportError(env, 'arttag', err); }
        return new Response('OK', { status: 200 });
      }
      if (cmd === '/arttagstop') {
        try { await handleArttagStop(env, msg); }
        catch (err) { await reportError(env, 'arttagstop', err); }
        return new Response('OK', { status: 200 });
      }
      if (cmd === '/arttagstatus') {
        try { await handleArttagStatus(env, msg); }
        catch (err) { await reportError(env, 'arttagstatus', err); }
        return new Response('OK', { status: 200 });
      }
      if (cmd === '/arttagreset') {
        try { await handleArttagReset(env, msg); }
        catch (err) { await reportError(env, 'arttagreset', err); }
        return new Response('OK', { status: 200 });
      }

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

  async scheduled(event, env, ctx) {
    console.log(`⏰ Cron fired: ${event.cron} at ${new Date().toISOString()}`);

    if (!env.BOT_TOKEN || !env.DB_ENCRYPTION_KEY || !env.BOT_KV) {
      console.error('Missing env bindings');
      return;
    }

    ctx.waitUntil((async () => {
      const events = [];
      let gelSummary = null;
      try {
        gelSummary = await handleGelbooruCron(env, events);
      } catch (e) {
        console.error('handleGelbooruCron threw:', e);
        gelSummary = { error: e.message };
      }

      await logEvents(env, events);
      console.log('✅ Gelbooru cron done:', JSON.stringify(gelSummary));
    })());
  },
};

// ═══════════════════════════════════════════════════════════
//                    LOW-LEVEL HELPERS
// ═══════════════════════════════════════════════════════════
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
