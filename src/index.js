// ============= CONFIG =============
const MSG_LINE_1 = 'روز شمار سرور آقا سگه، روز';
const MSG_LINE_2 =
  'امروز هم سرور ماینکرفت اونی-چان نیومد ૮₍ ˃ ⤙ ˂ ₎ა';

const CRON_MIDNIGHT = '30 20 * * *';
const HOURLY_CRON   = '30 * * * *';
const SERVER_CRON   = '*/5 * * * *';

const KV_CACHE_TTL = 30;
const OWNER_ID = 302287170;

const DIRECT_LINK = 'https://t.me/AqhaSageServerRoozShomarBot/game';

const BUTTON_IMAGE =
  'https://cdn.donmai.us/original/46/ea/__original_drawn_by_soya_torga__46eaa11d83f35adb94e2edf6b9e7f29a.jpg';

const BTN_PAGE_SIZE = 20;
const RLM = '\u200F';

const HOUR_KEY = 'hour:targets';
const UNAME_INDEX_KEY = 'uname:index';
const ERRORS_KEY = 'errors:recent';

// Server monitor — new API
const SERVER_API =
  'https://minecraft-serverhub.com/api/ping?host=deepvalley-ZLKV.aternos.me';
const SERVER_TARGETS_KEY = 'server:targets';
const SERVER_LAST_KEY = 'server:lastStatus';
const SERVER_MSG_ONLINE  = `${RLM}سرور ماینکرفت آقا سگه اونی-چان <b>آنلاین🟢</b> شد! ₍^. .^₎⟆`;
const SERVER_MSG_OFFLINE = `${RLM}سرور ماینکرفت آقا سگه اونی-چان <b>آفلاین🔴</b> شد`;
const STATUS_MSG_ONLINE  = `${RLM}سرور ماینکرفت آقا سگه اونی-چان <b>آنلاین🟢</b> هست! ₍^. .^₎⟆`;
const STATUS_MSG_OFFLINE = `${RLM}سرور ماینکرفت آقا سگه اونی-چان <b>آفلاین🔴</b> هست`;
const STATUS_MSG_UNKNOWN = `${RLM}❓ وضعیت سرور ماینکرفت آقا سگه اونی-چان در دسترس نیست (API پاسخگو نیست)`;

// Dollar monitor — via Google Translate proxy (API blocks CF IPs)
const DOLLAR_ENDPOINTS = [
  {
    name: 'translate',
    url:
      'https://api-priceto-day.translate.goog/v1/latest/irr/usd' +
      '?_x_tr_sl=auto&_x_tr_tl=en&_x_tr_hl=en',
  },
];
const DOLLAR_TARGETS_KEY = 'dollar:targets';
const DOLLAR_LAST_KEY = 'dollar:lastPrice';

// Cold-start retry tuning
const SERVER_RETRIES = 3;
const SERVER_RETRY_DELAY = 1500;
const SERVER_TIMEOUT = 8000;

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
  } catch {
    /* ignore — fall through and write */
  }
  if (oldRaw === newRaw) return false;
  await env.BOT_KV.put(key, newRaw, options);
  return true;
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
    await sendMessage(env.BOT_TOKEN, OWNER_ID, text, undefined, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
    });
  } catch (e) {
    console.error('reportError DM failed:', e.message);
  }

  console.error(`[${entry.where}]`, entry.msg);
  if (entry.stack) console.error(entry.stack);
}

// ============= SERVER MONITOR =============
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchServerOnce() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVER_TIMEOUT);

  try {
    const res = await fetch(SERVER_API, {
      headers: {
        'User-Agent':
          'RoozShomarBot/1.0 (+https://t.me/AqhaSageServerRoozShomarBot)',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function classifyServerData(data) {
  if (!data) return null;

  if (typeof data.version === 'string' && /offline/i.test(data.version)) {
    return false;
  }

  let motdText = '';
  if (typeof data.motd === 'string') {
    motdText = data.motd;
  } else if (Array.isArray(data?.motd?.clean)) {
    motdText = data.motd.clean.join(' ');
  }
  if (motdText.toLowerCase().includes('this server is offline')) {
    return false;
  }

  const hasVersion = typeof data.version === 'string';
  const hasMotd =
    typeof data.motd === 'string' || Array.isArray(data?.motd?.clean);
  if (hasVersion || hasMotd) {
    return true;
  }

  return null;
}

async function checkServerStatus() {
  for (let attempt = 1; attempt <= SERVER_RETRIES; attempt++) {
    const data = await fetchServerOnce();
    const result = classifyServerData(data);

    if (result !== null) return result;

    if (attempt < SERVER_RETRIES) {
      await sleep(SERVER_RETRY_DELAY * attempt);
    }
  }

  return null;
}

async function readServerTargets(env) {
  const raw = await env.BOT_KV.get(SERVER_TARGETS_KEY, {
    cacheTtl: KV_CACHE_TTL,
  });
  if (!raw) return [];
  try {
    const arr = decryptData(raw, env.DB_ENCRYPTION_KEY);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('readServerTargets decrypt failed:', e.message);
    return [];
  }
}

async function writeServerTargets(env, targets) {
  await writeIfChanged(env, SERVER_TARGETS_KEY, targets);
}

async function readServerLast(env) {
  const raw = await env.BOT_KV.get(SERVER_LAST_KEY, {
    cacheTtl: KV_CACHE_TTL,
  });
  if (!raw) return null;
  try {
    const obj = decryptData(raw, env.DB_ENCRYPTION_KEY);
    if (obj && typeof obj.online === 'boolean') return obj;
    return null;
  } catch {
    return null;
  }
}

async function writeServerLast(env, online) {
  await env.BOT_KV.put(
    SERVER_LAST_KEY,
    encryptData({ online, at: Date.now() }, env.DB_ENCRYPTION_KEY)
  );
}

// ============= DOLLAR MONITOR =============
function parseDollarText(text) {
  // Direct JSON
  try {
    const data = JSON.parse(text);
    if (data && data.success && typeof data.price === 'number') {
      return {
        price: data.price,
        high: typeof data.high === 'number' ? data.high : null,
        low: typeof data.low === 'number' ? data.low : null,
        time: data.time || null,
      };
    }
  } catch { /* not JSON, try regex */ }

  // Extract embedded JSON (translate.goog wraps it in HTML)
  const match = text.match(/"success"\s*:\s*true[^}]*"price"\s*:\s*\d+[^}]*\}/);
  if (match) {
    try {
      const data = JSON.parse('{' + match[0]);
      if (data.success && typeof data.price === 'number') {
        return {
          price: data.price,
          high: typeof data.high === 'number' ? data.high : null,
          low: typeof data.low === 'number' ? data.low : null,
          time: data.time || null,
        };
      }
    } catch { /* ignore */ }
  }
  return null;
}

async function fetchDollarOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (compatible; RoozShomarBot/1.0)',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    const text = await res.text();
    const parsed = parseDollarText(text);
    if (!parsed) {
      return { ok: false, reason: `bad shape: ${text.slice(0, 60)}` };
    }
    return { ok: true, data: parsed };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, reason: e.message };
  }
}

async function fetchDollarData() {
  for (const ep of DOLLAR_ENDPOINTS) {
    const r = await fetchDollarOnce(ep.url);
    if (r.ok) {
      console.log(`Dollar ok via ${ep.name}: ${r.data.price}`);
      return r.data;
    }
    console.error(`Dollar fail [${ep.name}]: ${r.reason}`);
  }
  return null;
}

// Formats Rial → Toman with thousands separator (e.g. 2687000 → "268,700")
function tomanFormat(rialPrice) {
  const toman = Math.floor(rialPrice / 10);
  return String(toman).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Renders a mono-spaced table of the current dollar prices.
// Uses <pre> so columns line up; wrapped in <blockquote> for a card look.
function dollarTable(data) {
  const price = tomanFormat(data.price);
  const high = data.high != null ? tomanFormat(data.high) : '—';
  const low = data.low != null ? tomanFormat(data.low) : '—';

  const rows = [
    ['قیمت فعلی', price],
    ['بیشترین', high],
    ['کمترین', low],
  ];

  // Width calculation — count each Persian label as its JS .length.
  // Monospace fonts render Persian at ~1 column per code unit, so this
  // lines up in practice across iOS/Android/Web/Desktop clients.
  const leftW = Math.max(...rows.map((r) => r[0].length));
  const rightW = Math.max(...rows.map((r) => r[1].length));

  const padEnd = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
  const padStart = (s, n) => ' '.repeat(Math.max(0, n - s.length)) + s;

  const sep = (l, m, r) =>
    l + '─'.repeat(leftW + 2) + m + '─'.repeat(rightW + 2) + r;

  const lines = [];
  lines.push(sep('┌', '┬', '┐'));
  rows.forEach((row, i) => {
    if (i > 0) lines.push(sep('├', '┼', '┤'));
    lines.push(
      '│ ' + padEnd(row[0], leftW) + ' │ ' + padStart(row[1], rightW) + ' │'
    );
  });
  lines.push(sep('└', '┴', '┘'));

  return lines.join('\n');
}

// Full /statusdollar message (blockquote header + table + footer)
function dollarStatusMessage(data) {
  const table = dollarTable(data);
  return (
    `<blockquote>💵 <b>قیمت دلار</b></blockquote>\n` +
    `<pre>${table}</pre>\n` +
    `<i>تومان — هر ۱۰ ریال = ۱ تومان</i>`
  );
}

async function readDollarTargets(env) {
  const raw = await env.BOT_KV.get(DOLLAR_TARGETS_KEY, {
    cacheTtl: KV_CACHE_TTL,
  });
  if (!raw) return [];
  try {
    const arr = decryptData(raw, env.DB_ENCRYPTION_KEY);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('readDollarTargets decrypt failed:', e.message);
    return [];
  }
}

async function writeDollarTargets(env, targets) {
  await writeIfChanged(env, DOLLAR_TARGETS_KEY, targets);
}

async function readDollarLast(env) {
  const raw = await env.BOT_KV.get(DOLLAR_LAST_KEY, {
    cacheTtl: KV_CACHE_TTL,
  });
  if (!raw) return null;
  try {
    const obj = decryptData(raw, env.DB_ENCRYPTION_KEY);
    if (obj && typeof obj.price === 'number') return obj;
    return null;
  } catch {
    return null;
  }
}

async function writeDollarLast(env, price) {
  await env.BOT_KV.put(
    DOLLAR_LAST_KEY,
    encryptData({ price, at: Date.now() }, env.DB_ENCRYPTION_KEY)
  );
}

// ============= DURABLE OBJECT: BUTTON COUNTER =============
export class ButtonCounter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.cached = { total: 0, users: [] };
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get('state');
      if (stored) this.cached = stored;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'GET') {
      return new Response(JSON.stringify(this.cached), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    if (url.pathname === '/seed') {
      let seed = {};
      try {
        seed = await request.json();
      } catch { /* ignore */ }

      if (
        seed &&
        typeof seed.total === 'number' &&
        Array.isArray(seed.users)
      ) {
        if (!this.cached.users.length && !this.cached.total) {
          this.cached = seed;
          await this.state.storage.put('state', this.cached);
        }
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let body = {};
    try {
      body = await request.json();
    } catch { /* ignore */ }

    const userId = body.userId;
    const name = body.name || 'User';
    const username = body.username || null;

    if (userId == null) {
      return new Response(JSON.stringify({ error: 'no userId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    this.cached.total = (this.cached.total || 0) + 1;

    const entry = this.cached.users.find((u) => u.id === userId);
    if (entry) {
      entry.count += 1;
      entry.name = name;
      if (username) entry.username = username;
    } else {
      this.cached.users.push({ id: userId, name, username, count: 1 });
    }

    this.cached.users.sort((a, b) => b.count - a.count);
    if (this.cached.users.length > 100) this.cached.users.length = 100;

    await this.state.storage.put('state', this.cached);

    return new Response(JSON.stringify(this.cached), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ============= DURABLE OBJECT: GAME COUNTER =============
export class GameCounter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.cached = { total: 0, users: [] };
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get('state');
      if (stored) this.cached = stored;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/state') {
      return new Response(JSON.stringify(this.cached), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.method === 'POST' && url.pathname === '/tap') {
      let body = {};
      try {
        body = await request.json();
      } catch { /* ignore */ }

      const userId = body.userId;
      const name = body.name || 'User';
      const username = body.username || null;

      if (userId == null) {
        return new Response(JSON.stringify({ error: 'no userId' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      let n = parseInt(body.n, 10);
      if (!Number.isFinite(n) || n < 1) n = 1;
      if (n > 200) n = 200;

      this.cached.total = (this.cached.total || 0) + n;

      const entry = this.cached.users.find((u) => u.id === userId);
      if (entry) {
        entry.count += n;
        entry.name = name;
        if (username) entry.username = username;
      } else {
        this.cached.users.push({ id: userId, name, username, count: n });
      }

      this.cached.users.sort((a, b) => b.count - a.count);
      if (this.cached.users.length > 1000) this.cached.users.length = 1000;

      await this.state.storage.put('state', this.cached);

      return new Response(JSON.stringify(this.cached), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.method === 'POST' && url.pathname === '/seed') {
      let seed = {};
      try {
        seed = await request.json();
      } catch { /* ignore */ }

      if (
        seed &&
        typeof seed.total === 'number' &&
        Array.isArray(seed.users)
      ) {
        if (!this.cached.users.length && !this.cached.total) {
          this.cached = seed;
          await this.state.storage.put('state', this.cached);
        }
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }
}

// ============= COMMAND PARSER =============
function parseCommand(text) {
  if (!text || typeof text !== 'string' || !text.startsWith('/')) return null;
  const first = text.trim().split(/\s+/)[0];
  return first.split('@')[0].toLowerCase();
}

// ============= INIT DATA VALIDATION =============
async function validateInitData(initData, botToken) {
  if (!initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheckString = Array.from(params.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const encoder = new TextEncoder();
    const secretKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode('WebAppData'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const secret = await crypto.subtle.sign(
      'HMAC',
      secretKey,
      encoder.encode(botToken)
    );
    const hmacKey = await crypto.subtle.importKey(
      'raw',
      secret,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign(
      'HMAC',
      hmacKey,
      encoder.encode(dataCheckString)
    );
    const hexSig = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    if (hexSig !== hash) return null;

    const userJson = params.get('user');
    if (!userJson) return null;
    return JSON.parse(userJson);
  } catch {
    return null;
  }
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

// ============= TARGETS HELPERS =============
async function readTargets(env) {
  const raw = await env.BOT_KV.get('targets', { cacheTtl: KV_CACHE_TTL });
  if (!raw) {
    const legacy = await env.BOT_KV.get('target', { cacheTtl: KV_CACHE_TTL });
    if (legacy) {
      try {
        const one = decryptData(legacy, env.DB_ENCRYPTION_KEY);
        const migrated = [
          {
            chatId: one.chatId,
            threadId: one.threadId ?? null,
            counter: one.counter || 0,
          },
        ];
        await writeTargets(env, migrated);
        await env.BOT_KV.delete('target');
        return migrated;
      } catch {
        return [];
      }
    }
    return [];
  }
  try {
    const arr = decryptData(raw, env.DB_ENCRYPTION_KEY);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('readTargets decrypt failed:', e.message);
    return [];
  }
}

async function writeTargets(env, targets) {
  await writeIfChanged(env, 'targets', targets);
}

function sameTarget(a, chatId, threadId) {
  return a.chatId === chatId && (a.threadId ?? null) === (threadId ?? null);
}

// ============= HOURLY HELPERS =============
async function readHourTargets(env) {
  const raw = await env.BOT_KV.get(HOUR_KEY, { cacheTtl: KV_CACHE_TTL });
  if (!raw) return [];
  try {
    const arr = decryptData(raw, env.DB_ENCRYPTION_KEY);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('readHourTargets decrypt failed:', e.message);
    return [];
  }
}

async function writeHourTargets(env, targets) {
  await writeIfChanged(env, HOUR_KEY, targets);
}

// ============= USERNAME INDEX =============
async function readUnameIndex(env) {
  try {
    const raw = await env.BOT_KV.get(UNAME_INDEX_KEY, {
      cacheTtl: KV_CACHE_TTL,
    });
    if (!raw) return {};
    const obj = decryptData(raw, env.DB_ENCRYPTION_KEY);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

async function writeUnameIndex(env, index) {
  try {
    await writeIfChanged(env, UNAME_INDEX_KEY, index);
  } catch (e) {
    console.error('writeUnameIndex failed:', e.message);
  }
}

async function indexUser(env, user) {
  try {
    if (!user || !user.id) return;
    const uname = user.username ? user.username.toLowerCase() : null;
    if (!uname) return;

    const index = await readUnameIndex(env);
    const existing = index[uname];
    if (
      existing &&
      existing.id === user.id &&
      existing.firstName === (user.first_name || '') &&
      existing.lastName === (user.last_name || '') &&
      existing.username === user.username
    ) {
      return; // nothing to update
    }
    index[uname] = {
      id: user.id,
      firstName: user.first_name || '',
      lastName: user.last_name || '',
      username: user.username,
    };
    await writeUnameIndex(env, index);
  } catch (e) {
    console.error('indexUser failed:', e.message);
  }
}

async function lookupUsername(env, username) {
  try {
    const uname = username.replace(/^@/, '').toLowerCase();
    const index = await readUnameIndex(env);
    return index[uname] || null;
  } catch {
    return null;
  }
}

// ─── displayLink ───
function displayLink(entry) {
  if (entry.displayName) {
    return htmlEsc(entry.displayName);
  }

  const name = [entry.firstName, entry.lastName].filter(Boolean).join(' ');
  const uname = entry.username
    ? String(entry.username).replace(/^@/, '')
    : '';
  const uid = entry.userId != null ? String(entry.userId) : '';

  if (uname) {
    const text = name || `@${uname}`;
    return `<a href="https://t.me/${htmlEsc(uname)}">${htmlEsc(text)}</a>`;
  }
  if (uid) {
    const text = name || 'User';
    return `<a href="tg://user?id=${htmlEsc(uid)}">${htmlEsc(text)}</a>`;
  }
  if (name) {
    return htmlEsc(name);
  }
  return 'User';
}

function hourlyMessage(t) {
  const link = displayLink(t);
  const line1 = `${RLM}ساعت شمار بازگشت ${link}، ساعت ${t.counter}`;

  const isLocked = !!t.userId || !!t.username;
  if (isLocked) {
    const line2 = `${RLM}اگه برگشتی بزن رو /hourend تا ساعت شمار متوقف شه، چون فقط خودت می‌تونی متوقفش کنی D:`;
    return `${line1}\n${line2}`;
  }
  return line1;
}

function dailyMessage(t) {
  if (t.subject) {
    let msg = `روز شمار ${t.subject}\nروز ${t.counter}`;
    if (t.description) msg += `\n${t.description}`;
    return msg;
  }
  return `${MSG_LINE_1} ${t.counter}\n${MSG_LINE_2}`;
}

// ============= GAME HELPERS =============
const USER_PREFIX = 'game:user:';
const LORD_PREFIX = 'lord:';
const INDEX_KEY = 'game:index';

async function readUser(env, id) {
  const raw = await env.BOT_KV.get(USER_PREFIX + id, {
    cacheTtl: KV_CACHE_TTL,
  });
  if (!raw) return null;
  try {
    const u = decryptData(raw, env.DB_ENCRYPTION_KEY);
    if (u && typeof u.count === 'number') return u;
    return null;
  } catch (e) {
    console.error(`readUser(${id}) decrypt failed:`, e.message);
    return null;
  }
}

async function writeUser(env, id, data) {
  await env.BOT_KV.put(
    USER_PREFIX + id,
    encryptData(data, env.DB_ENCRYPTION_KEY)
  );
}

async function readIndex(env) {
  const raw = await env.BOT_KV.get(INDEX_KEY, { cacheTtl: KV_CACHE_TTL });
  if (!raw) return [];
  try {
    const arr = decryptData(raw, env.DB_ENCRYPTION_KEY);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function writeIndex(env, ids) {
  await writeIfChanged(env, INDEX_KEY, ids);
}

async function addToIndex(env, id) {
  const ids = await readIndex(env);
  const s = String(id);
  if (!ids.includes(s)) {
    ids.push(s);
    await writeIndex(env, ids);
  }
}

async function readLord(env, username) {
  if (!username) return null;
  const raw = await env.BOT_KV.get(
    LORD_PREFIX + username.toLowerCase(),
    { cacheTtl: KV_CACHE_TTL }
  );
  if (!raw) return null;
  try {
    const l = decryptData(raw, env.DB_ENCRYPTION_KEY);
    return l && l.text ? l.text : null;
  } catch {
    return null;
  }
}

async function writeLord(env, username, text) {
  await env.BOT_KV.put(
    LORD_PREFIX + username.toLowerCase(),
    encryptData({ text }, env.DB_ENCRYPTION_KEY)
  );
}

async function deleteLord(env, username) {
  await env.BOT_KV.delete(LORD_PREFIX + username.toLowerCase());
}

async function listUsers(env) {
  const idSet = new Set();
  for (const id of await readIndex(env)) idSet.add(String(id));

  let cursor;
  do {
    const res = await env.BOT_KV.list({ prefix: USER_PREFIX, cursor });
    for (const k of res.keys) {
      idSet.add(k.name.slice(USER_PREFIX.length));
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);

  const users = [];
  for (const id of idSet) {
    const u = await readUser(env, id);
    if (!u) continue;
    const numericId = /^\d+$/.test(id) ? parseInt(id, 10) : id;
    const lord = u.username ? await readLord(env, u.username) : null;
    users.push({
      id: numericId,
      name: u.name || 'User',
      username: u.username || null,
      lord: lord || null,
      count: u.count,
    });
  }

  users.sort((a, b) => b.count - a.count);
  return users;
}

async function migrateOldGame(env) {
  const raw = await env.BOT_KV.get('game', { cacheTtl: KV_CACHE_TTL });
  if (!raw) return;
  try {
    const g = decryptData(raw, env.DB_ENCRYPTION_KEY);
    if (g && Array.isArray(g.users)) {
      const ids = await readIndex(env);
      for (const u of g.users) {
        if (u && u.id != null && typeof u.count === 'number') {
          const existing = await readUser(env, u.id);
          if (!existing) {
            await writeUser(env, u.id, {
              name: u.name || 'User',
              username: null,
              count: u.count,
            });
          }
          if (!ids.includes(String(u.id))) ids.push(String(u.id));
        }
      }
      await writeIndex(env, ids);
    }
  } catch {
    /* ignore */
  }
  await env.BOT_KV.delete('game');
}

// ─── Game DO helpers ───
async function getGameStub(env) {
  const id = env.GAME_COUNTER.idFromName('global');
  return env.GAME_COUNTER.get(id);
}

async function ensureGameSeeded(env) {
  try {
    await migrateOldGame(env);

    const stub = await getGameStub(env);
    const res = await stub.fetch('https://do/state', { method: 'GET' });
    const state = await res.json();

    if (state.total > 0 || (Array.isArray(state.users) && state.users.length > 0)) {
      return; // already has data
    }

    const kvUsers = await listUsers(env);
    if (!kvUsers.length) return;

    const kvTotal = kvUsers.reduce((s, u) => s + u.count, 0);
    const seedUsers = kvUsers.map((u) => ({
      id: u.id,
      name: u.name,
      username: u.username,
      count: u.count,
    }));

    await stub.fetch('https://do/seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ total: kvTotal, users: seedUsers }),
    });
  } catch (e) {
    console.error('ensureGameSeeded failed:', e.message);
  }
}

async function buildGameState(env, state, myUserId) {
  const users = Array.isArray(state?.users) ? state.users : [];
  const total = typeof state?.total === 'number' ? state.total : 0;

  const top = users.slice(0, 50);
  if (myUserId != null && !top.some((u) => u.id === myUserId)) {
    const me = users.find((u) => u.id === myUserId);
    if (me) top.push(me);
  }

  const enriched = [];
  for (const u of top) {
    const lord = u.username ? await readLord(env, u.username) : null;
    enriched.push({
      id: u.id,
      name: u.name,
      username: u.username || null,
      lord: lord || null,
      count: u.count,
    });
  }

  return { total, users: enriched };
}

// ============= BUTTON COUNTER =============
const BTN_STATE_KEY = 'btn:state';

async function readBtnState(env) {
  const raw = await env.BOT_KV.get(BTN_STATE_KEY);
  if (raw) {
    try {
      const s = decryptData(raw, env.DB_ENCRYPTION_KEY);
      if (s && typeof s.total === 'number' && Array.isArray(s.users)) {
        return s;
      }
    } catch (e) {
      console.error('btn:state decrypt failed:', e.message);
    }
  }
  return await migrateBtnState(env);
}

async function writeBtnState(env, state) {
  await writeIfChanged(env, BTN_STATE_KEY, state);
}

async function migrateBtnState(env) {
  const users = [];
  let total = 0;

  const rawTotal = await env.BOT_KV.get('btn:total');
  if (rawTotal) {
    try {
      const d = decryptData(rawTotal, env.DB_ENCRYPTION_KEY);
      if (typeof d.v === 'number') total = d.v;
    } catch { /* ignore */ }
  }

  let cursor;
  do {
    const res = await env.BOT_KV.list({ prefix: 'btn:user:', cursor });
    for (const k of res.keys) {
      const idStr = k.name.slice('btn:user:'.length);
      const raw = await env.BOT_KV.get(k.name);
      if (!raw) continue;
      try {
        const u = decryptData(raw, env.DB_ENCRYPTION_KEY);
        if (u && typeof u.count === 'number') {
          users.push({
            id: /^\d+$/.test(idStr) ? parseInt(idStr, 10) : idStr,
            name: u.name || 'User',
            username: u.username || null,
            count: u.count,
          });
        }
      } catch { /* skip */ }
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);

  users.sort((a, b) => b.count - a.count);
  if (!users.length && !total) return { total: 0, users: [] };

  const migrated = { total, users };
  try {
    await writeBtnState(env, migrated);
  } catch { /* ignore */ }
  return migrated;
}

async function getBtnState(env) {
  try {
    const id = env.BTN_COUNTER.idFromName('global');
    const stub = env.BTN_COUNTER.get(id);
    const res = await stub.fetch('https://do/state', { method: 'GET' });
    return await res.json();
  } catch (e) {
    console.error('DO read failed, falling back to KV:', e.message);
    return await readBtnState(env);
  }
}

function buttonCaption(total, users) {
  const lines = [];
  lines.push(`${RLM}انگشت های کل: ${total}`);
  lines.push('');

  if (!users.length) {
    lines.push(`${RLM}هنوز کسی انگشت نزده`);
  } else {
    for (const u of users) {
      const safeName = htmlEsc(u.name);
      const namePart = u.lord
        ? `<a href="tg://user?id=${u.id}">${safeName}</a> «${htmlEsc(
            u.lord
          )}»`
        : safeName;
      lines.push(`${RLM}انگشت های ${namePart}: ${u.count}`);
    }
  }

  lines.push('');
  lines.push(`${RLM}اونی-چان انگشتم نکن!`);

  return capToLimit(lines);
}

function buttonCaptionPlain(total, users) {
  const lines = [];
  lines.push(`${RLM}انگشت های کل: ${total}`);
  lines.push('');

  if (!users.length) {
    lines.push(`${RLM}هنوز کسی انگشت نزده`);
  } else {
    for (const u of users) {
      const namePart = u.lord ? `${u.name} «${u.lord}»` : u.name;
      lines.push(`${RLM}انگشت های ${namePart}: ${u.count}`);
    }
  }

  lines.push('');
  lines.push(`${RLM}اونی-چان انگشتم نکن!`);

  return capToLimit(lines);
}

function capToLimit(lines) {
  let caption = lines.join('\n');
  if (caption.length <= 1024) return caption;

  const trimmed = [...lines];
  while (trimmed.length > 3 && trimmed.join('\n').length > 1024) {
    trimmed.splice(trimmed.length - 2, 1);
  }
  caption = trimmed.join('\n');
  if (caption.length > 1024) {
    const header = lines[0];
    const footer = lines[lines.length - 1];
    return `${header}\n\n${footer}`;
  }
  return caption;
}

function buttonKeyboard(page, totalUsers) {
  const totalPages = Math.max(1, Math.ceil(totalUsers / BTN_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);

  const nav = [];
  if (safePage > 0) {
    nav.push({ text: '◀', callback_data: `btn:page:${safePage - 1}` });
  }
  nav.push({
    text: `${safePage + 1}/${totalPages}`,
    callback_data: 'btn:noop',
  });
  if (safePage < totalPages - 1) {
    nav.push({ text: '▶', callback_data: `btn:page:${safePage + 1}` });
  }

  return {
    inline_keyboard: [
      [{ text: '/start', callback_data: `btn:click:${safePage}` }],
      nav,
    ],
  };
}

function parseButtonCallback(data) {
  if (!data || typeof data !== 'string' || !data.startsWith('btn:')) return null;
  const parts = data.split(':');
  const action = parts[1];
  if (action === 'click') {
    const page = parts[2] ? Math.max(0, parseInt(parts[2], 10) || 0) : 0;
    return { action: 'click', page };
  }
  if (action === 'page') {
    const page = Math.max(0, parseInt(parts[2], 10) || 0);
    return { action: 'page', page };
  }
  if (action === 'noop') {
    return { action: 'noop', page: 0 };
  }
  return null;
}

// ============= ANONYMIZATION =============
function makeAnonymizer(targets, currentChatId, currentThreadId) {
  const nameOf = new Map();
  targets.forEach((t, i) => {
    const key = `${t.chatId}:${t.threadId ?? 'main'}`;
    nameOf.set(key, `chat ${i + 1}`);
  });
  const currentKey = `${currentChatId}:${currentThreadId ?? 'main'}`;
  return function label(chatId, threadId) {
    const key = `${chatId}:${threadId ?? 'main'}`;
    if (key === currentKey) return 'you';
    return nameOf.get(key) || 'unknown';
  };
}

// ============= GAME HTML =============
const GAME_HTML = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover">
<title>بازی</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body {
  margin: 0; padding: 0;
  background: #000;
  color: #e6edf3;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  min-height: 100vh;
  user-select: none;
  -webkit-user-select: none;
}
.wrap {
  max-width: 480px;
  margin: 0 auto;
  padding: 24px 16px 40px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
}
.total { text-align: center; margin-top: 8px; }
.total .label { font-size: 12px; color: #8b949e; letter-spacing: 3px; text-transform: uppercase; margin-bottom: 8px; }
.total .value {
  font-size: 64px;
  font-weight: 800;
  line-height: 1;
  background: linear-gradient(135deg, #58a6ff, #a371f7);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  font-variant-numeric: tabular-nums;
}
@keyframes spin-border {
  0%   { filter: hue-rotate(0deg); }
  100% { filter: hue-rotate(360deg); }
}
#tap {
  width: 210px;
  height: 210px;
  border-radius: 50%;
  color: #e6edf3;
  font-size: 40px;
  font-weight: 800;
  font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
  letter-spacing: 1px;
  cursor: pointer;
  transition: transform 0.08s ease, box-shadow 0.2s ease;
  margin: 8px 0;
  position: relative;
  border: 4px solid transparent;
  background-image:
    linear-gradient(#000, #000),
    linear-gradient(135deg, #2ea043, #58a6ff, #a371f7, #2ea043);
  background-origin: border-box;
  background-clip: padding-box, border-box;
  box-shadow:
    0 0 40px rgba(46, 160, 67, 0.35),
    0 0 80px rgba(88, 166, 255, 0.18),
    inset 0 0 30px rgba(46, 160, 67, 0.12);
  animation: spin-border 6s linear infinite;
  direction: ltr;
  unicode-bidi: isolate;
}
#tap:active {
  transform: scale(0.94);
  box-shadow:
    0 0 60px rgba(46, 160, 67, 0.7),
    0 0 120px rgba(88, 166, 255, 0.35),
    inset 0 0 40px rgba(46, 160, 67, 0.25);
}
.mine { font-size: 16px; color: #8b949e; }
.mine span { color: #58a6ff; font-weight: 700; font-size: 22px; }
.board {
  width: 100%;
  background: #0a0a0a;
  border: 1px solid #1c1c1c;
  border-radius: 14px;
  padding: 16px;
}
.board h2 {
  font-size: 13px;
  color: #8b949e;
  margin: 0 0 12px;
  letter-spacing: 1px;
  font-weight: 600;
}
.row {
  display: flex;
  align-items: center;
  padding: 10px 6px;
  border-radius: 8px;
  border-bottom: 1px solid #151515;
}
.row:last-child { border-bottom: none; }
.row.me { background: rgba(88, 166, 255, 0.08); }
.rank { width: 30px; text-align: center; font-weight: 700; color: #8b949e; font-size: 15px; }
.rank.r1 { color: #ffd700; }
.rank.r2 { color: #c0c0c0; }
.rank.r3 { color: #cd7f32; }
.name { flex: 1; margin: 0 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; }
.count { font-weight: 700; color: #2ea043; font-variant-numeric: tabular-nums; }
.empty { text-align: center; color: #8b949e; padding: 24px 0; font-size: 14px; }

@keyframes goldshine {
  0%   { background-position: 200% center; }
  100% { background-position: -200% center; }
}
.lord {
  display: inline-block;
  margin-inline-start: 6px;
  font-weight: 800;
  font-size: 12px;
  letter-spacing: 0.5px;
  padding: 1px 6px;
  border-radius: 6px;
  background: linear-gradient(
    90deg,
    #b8860b 0%,
    #ffd700 20%,
    #fff8b0 40%,
    #ffd700 60%,
    #b8860b 80%,
    #ffd700 100%
  );
  background-size: 200% auto;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: goldshine 3s linear infinite;
  filter: drop-shadow(0 0 4px rgba(255, 215, 0, 0.55));
}
</style>
</head>
<body>
<div class="wrap">
  <div class="total">
    <div class="label">مجموع کل</div>
    <div class="value" id="total">0</div>
  </div>
  <button id="tap" dir="ltr">/start</button>
  <div class="mine">امتیاز تو: <span id="mine">0</span></div>
  <div class="board">
    <h2>🏆 برترینها</h2>
    <div id="list"></div>
  </div>
</div>
<script>
var tg = window.Telegram && window.Telegram.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  if (tg.setHeaderColor) tg.setHeaderColor('#000000');
  if (tg.setBackgroundColor) tg.setBackgroundColor('#000000');
}
var myId = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) ? tg.initDataUnsafe.user.id : null;
var initData = (tg && tg.initData) ? tg.initData : '';

var serverState = { total: 0, users: [] };
var pending = 0;
var timer = null;
var flushing = false;

function api(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ initData: initData }, body || {}))
  }).then(function(r) {
    if (!r.ok) throw new Error('api');
    return r.json();
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, function(c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

function render() {
  document.getElementById('total').textContent = serverState.total + pending;

  var myServerCount = 0;
  var myServerLord = null;
  var list = serverState.users.map(function(u) {
    if (u.id === myId) { myServerCount = u.count; myServerLord = u.lord; }
    return {
      id: u.id,
      name: u.name,
      lord: u.lord,
      count: u.id === myId ? u.count + pending : u.count,
      isMe: u.id === myId
    };
  });
  if (pending > 0 && myId && !list.some(function(u) { return u.id === myId; })) {
    var meName = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user)
      ? (tg.initDataUnsafe.user.first_name || 'You')
      : 'You';
    list.push({ id: myId, name: meName, lord: myServerLord, count: pending, isMe: true });
  }
  list.sort(function(a, b) { return b.count - a.count; });

  document.getElementById('mine').textContent = myServerCount + pending;

  var el = document.getElementById('list');
  if (!list.length) {
    el.innerHTML = '<div class="empty">هنوز کسی بازی نکرده</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < Math.min(list.length, 20); i++) {
    var u = list[i];
    var cls = i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : '';
    var lordBadge = u.lord ? '<span class="lord">' + esc(u.lord) + '</span>' : '';
    html += '<div class="row' + (u.isMe ? ' me' : '') + '">' +
      '<div class="rank ' + cls + '">' + (i + 1) + '</div>' +
      '<div class="name">' + esc(u.name) + lordBadge + '</div>' +
      '<div class="count">' + u.count + '</div>' +
    '</div>';
  }
  el.innerHTML = html;
}

function onTap() {
  pending++;
  if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
  render();
  if (!timer && !flushing) timer = setTimeout(flush, 1000);
}

function flush() {
  timer = null;
  if (pending === 0) return;
  var n = pending;
  flushing = true;
  api('/api/tap', { count: n }).then(function(res) {
    flushing = false;
    pending -= n;
    serverState = res;
    render();
    if (pending > 0 && !timer) timer = setTimeout(flush, 1000);
  }).catch(function() {
    flushing = false;
    if (!timer) timer = setTimeout(flush, 2000);
  });
}

document.getElementById('tap').addEventListener('click', onTap);

api('/api/state').then(function(res) {
  serverState = res;
  render();
}).catch(function() {});

setInterval(function() {
  if (pending === 0 && !timer && !flushing) {
    api('/api/state').then(function(res) {
      serverState = res;
      render();
    }).catch(function() {});
  }
}, 5000);
</script>
</body>
</html>`;

// ============= API HANDLERS =============
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleState(request, env) {
  try {
    let body = {};
    try {
      body = await request.json();
    } catch { /* ignore */ }

    const user = await validateInitData(body.initData, env.BOT_TOKEN);
    if (!user) return jsonResponse({ error: 'unauthorized' }, 401);

    await ensureGameSeeded(env);

    const stub = await getGameStub(env);
    const res = await stub.fetch('https://do/state', { method: 'GET' });
    const state = await res.json();

    const enriched = await buildGameState(env, state, user.id);
    return jsonResponse(enriched);
  } catch (e) {
    await reportError(env, 'handleState', e);
    return jsonResponse({ error: 'server error' }, 500);
  }
}

async function handleTap(request, env) {
  try {
    let body = {};
    try {
      body = await request.json();
    } catch { /* ignore */ }

    const user = await validateInitData(body.initData, env.BOT_TOKEN);
    if (!user) return jsonResponse({ error: 'unauthorized' }, 401);

    await ensureGameSeeded(env);

    let n = parseInt(body.count, 10);
    if (!Number.isFinite(n) || n < 1) n = 1;
    if (n > 200) n = 200;

    const displayName =
      [user.first_name, user.last_name].filter(Boolean).join(' ') ||
      user.username ||
      'User';

    const stub = await getGameStub(env);
    const res = await stub.fetch('https://do/tap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: user.id,
        name: displayName,
        username: user.username || null,
        n,
      }),
    });
    const state = await res.json();

    const enriched = await buildGameState(env, state, user.id);
    return jsonResponse(enriched);
  } catch (e) {
    await reportError(env, 'handleTap', e);
    return jsonResponse({ error: 'server error' }, 500);
  }
}

// ============= CALLBACK QUERY HANDLER =============
async function handleCallbackQuery(update, env) {
  const cq = update.callback_query;
  if (!cq) return;

  try {
    await answerCallbackQuery(env.BOT_TOKEN, cq.id);
  } catch { /* ignore */ }

  try {
    await indexUser(env, cq.from);
  } catch { /* ignore */ }

  const parsed = parseButtonCallback(cq.data);
  if (!parsed) return;

  if (parsed.action === 'noop') return;

  const userId = cq.from?.id;
  if (!userId) return;

  const name = cq.from.first_name || cq.from.username || 'User';
  const username = cq.from.username || null;

  try {
    const id = env.BTN_COUNTER.idFromName('global');
    const stub = env.BTN_COUNTER.get(id);

    let state;
    if (parsed.action === 'click') {
      const res = await stub.fetch('https://do/tap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, name, username }),
      });
      state = await res.json();
    } else {
      const res = await stub.fetch('https://do/state', { method: 'GET' });
      state = await res.json();
    }

    const totalUsers = state.users.length;
    const totalPages = Math.max(1, Math.ceil(totalUsers / BTN_PAGE_SIZE));
    const page = Math.min(Math.max(0, parsed.page), totalPages - 1);
    const slice = state.users.slice(
      page * BTN_PAGE_SIZE,
      (page + 1) * BTN_PAGE_SIZE
    );

    const enriched = [];
    for (const u of slice) {
      const lord = u.username ? await readLord(env, u.username) : null;
      enriched.push({
        id: u.id,
        name: u.name,
        username: u.username || null,
        lord: lord || null,
        count: u.count,
      });
    }

    const htmlCaption = buttonCaption(state.total, enriched);
    const plainCaption = buttonCaptionPlain(state.total, enriched);
    const keyboard = buttonKeyboard(page, totalUsers);

    let editStatus = 'ok';
    try {
      await editMessageCaption(
        env.BOT_TOKEN,
        cq.message.chat.id,
        cq.message.message_id,
        htmlCaption,
        { parse_mode: 'HTML', reply_markup: keyboard }
      );
    } catch (e) {
      const m = String(e.message || '');
      if (/not modified/i.test(m)) {
        editStatus = 'noop';
      } else {
        try {
          await editMessageCaption(
            env.BOT_TOKEN,
            cq.message.chat.id,
            cq.message.message_id,
            plainCaption,
            { reply_markup: keyboard }
          );
          editStatus = 'plain';
        } catch (e2) {
          editStatus = 'fail: ' + String(e2.message || '').slice(0, 120);
        }
      }
    }

    await logEvent(env, {
      ev: 'btn_click',
      action: parsed.action,
      page,
      total: state.total,
      edit: editStatus,
    });
  } catch (e) {
    await reportError(env, 'handleCallbackQuery', e, {
      data: cq.data,
      userId,
    });
  }
}

// ============= WORKER =============
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === 'GET' && (path === '/app' || path === '/app/')) {
        return new Response(GAME_HTML, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      if (request.method === 'POST' && path === '/api/state') {
        return handleState(request, env);
      }
      if (request.method === 'POST' && path === '/api/tap') {
        return handleTap(request, env);
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
        if (msg?.from && msg.from.username) {
          await indexUser(env, msg.from);
        }
      } catch (e) {
        console.error('indexUser failed:', e.message);
      }

      try {
        await handleUpdate(update, env, url.origin);
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

    // ─── Server status check ───
    if (event.cron === SERVER_CRON) {
      // ── Server availability ──
      try {
        const online = await checkServerStatus();

        if (online === null) {
          // API failure / unknown → skip silently, keep last state
        } else {
          const last = await readServerLast(env);

          if (!last) {
            await writeServerLast(env, online);
            await logEvent(env, {
              ev: 'server_baseline',
              online,
            });
          } else if (last.online !== online) {
            const targets = await readServerTargets(env);
            const text = online ? SERVER_MSG_ONLINE : SERVER_MSG_OFFLINE;

            let sent = 0;
            let failed = 0;
            for (const t of targets) {
              try {
                await sendMessage(env.BOT_TOKEN, t.chatId, text, t.threadId ?? undefined, {
                  parse_mode: 'HTML',
                  link_preview_options: { is_disabled: true },
                });
                sent++;
              } catch (err) {
                failed++;
                await logEvent(env, {
                  ev: 'server_notify_error',
                  msg: err.message,
                });
              }
            }

            await writeServerLast(env, online);
            await logEvent(env, {
              ev: 'server_change',
              online,
              sent,
              failed,
            });
          }
        }
      } catch (e) {
        await reportError(env, 'scheduled.server', e);
      }

      // ── Dollar price ──
      try {
        const data = await fetchDollarData();

        if (data === null) {
          // API failure → skip silently
        } else {
          const price = data.price;
          const last = await readDollarLast(env);
          const isMultipleOf10 = price % 10 === 0;

          if (!last) {
            await writeDollarLast(env, price);
            await logEvent(env, {
              ev: 'dollar_baseline',
              price,
            });
          } else if (isMultipleOf10 && price !== last.price) {
            const targets = await readDollarTargets(env);
            const toman = tomanFormat(price);
            const text = `${RLM}💵 قیمت دلار به ${toman} تومان رسید`;

            let sent = 0;
            let failed = 0;
            for (const t of targets) {
              try {
                await sendMessage(env.BOT_TOKEN, t.chatId, text, t.threadId ?? undefined, {
                  link_preview_options: { is_disabled: true },
                });
                sent++;
              } catch (err) {
                failed++;
                await logEvent(env, {
                  ev: 'dollar_notify_error',
                  msg: err.message,
                });
              }
            }

            await writeDollarLast(env, price);
            await logEvent(env, {
              ev: 'dollar_change',
              price,
              sent,
              failed,
            });
          } else if (!isMultipleOf10) {
            await writeDollarLast(env, price);
          }
        }
      } catch (e) {
        await reportError(env, 'scheduled.dollar', e);
      }

      return;
    }

    if (event.cron === HOURLY_CRON) {
      try {
        const targets = await readHourTargets(env);
        if (!targets.length) {
          return;
        }

        let sent = 0;
        let failed = 0;

        for (const t of targets) {
          const threadId = t.threadId ?? undefined;
          try {
            t.counter = (t.counter || 0) + 1;
            const text = hourlyMessage(t);
            await sendMessage(env.BOT_TOKEN, t.chatId, text, threadId, {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
            });
            sent++;
          } catch (err) {
            failed++;
            await logEvent(env, { ev: 'hour_send_error', msg: err.message });
          }
        }

        try {
          await writeHourTargets(env, targets);
        } catch (e) {
          console.error('hour persist failed:', e.message);
        }

        await logEvent(env, { ev: 'hour_done', sent, failed });
      } catch (e) {
        await reportError(env, 'scheduled.hourly', e);
      }
      return;
    }

    if (event.cron === CRON_MIDNIGHT) {
      try {
        const targets = await readTargets(env);
        if (!targets.length) {
          return;
        }

        let sent = 0;
        let failed = 0;

        for (const t of targets) {
          const threadId = t.threadId ?? undefined;
          try {
            const counter = (t.counter || 0) + 1;
            const text = dailyMessage({ ...t, counter });
            await sendMessage(env.BOT_TOKEN, t.chatId, text, threadId, {
              link_preview_options: { is_disabled: true },
            });
            t.counter = counter;
            sent++;
          } catch (err) {
            failed++;
            await logEvent(env, { ev: 'send_error', msg: err.message });
          }
        }

        try {
          await writeTargets(env, targets);
        } catch (e) {
          console.error('Failed to persist counters:', e.message);
        }

        await logEvent(env, { ev: 'cron_done', sent, failed });
      } catch (e) {
        await reportError(env, 'scheduled.midnight', e);
      }
      return;
    }

    console.log(`Unknown cron fired: ${event.cron}`);
  },
};

// ============= UPDATE HANDLER =============
async function handleUpdate(update, env, origin) {
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
    // ─── /server ───
    case '/server': {
      const targets = await readServerTargets(env);
      const existing = targets.find((t) =>
        sameTarget(t, msg.chat.id, threadId)
      );

      if (!existing) {
        targets.push({ chatId: msg.chat.id, threadId });
        await writeServerTargets(env, targets);
      }

      await logEvent(env, {
        ev: 'server_sub',
        already: !!existing,
        total: targets.length,
      });

      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `${RLM}🖥 از این به بعد وضعیت سرور ماینکرفت در این ${where} اطلاع داده میشه.`,
        threadId ?? undefined
      );
      return;
    }

    // ─── /status ───
    case '/status': {
      try {
        const online = await checkServerStatus();
        let text;
        if (online === null) {
          text = STATUS_MSG_UNKNOWN;
        } else {
          text = online ? STATUS_MSG_ONLINE : STATUS_MSG_OFFLINE;
        }
        await sendMessage(env.BOT_TOKEN, msg.chat.id, text, threadId ?? undefined, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
        await logEvent(env, { ev: 'status_check', online });
      } catch (e) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          `❌ خطا در گرفتن وضعیت سرور: ${e.message}`,
          threadId ?? undefined
        );
        await reportError(env, 'status_check', e);
      }
      return;
    }

    // ─── /serverdollar ───
    case '/serverdollar': {
      const targets = await readDollarTargets(env);
      const existing = targets.find((t) =>
        sameTarget(t, msg.chat.id, threadId)
      );

      if (!existing) {
        targets.push({ chatId: msg.chat.id, threadId });
        await writeDollarTargets(env, targets);
      }

      await logEvent(env, {
        ev: 'dollar_sub',
        already: !!existing,
        total: targets.length,
      });

      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `${RLM}💵 از این به بعد هر وقت قیمت دلار به مضربی از ۱۰ رسید در این ${where} اطلاع داده میشه.`,
        threadId ?? undefined
      );
      return;
    }

    // ─── /statusdollar ───
    case '/statusdollar': {
      try {
        const data = await fetchDollarData();
        if (data === null) {
          await sendMessage(
            env.BOT_TOKEN,
            msg.chat.id,
            `${RLM}❓ قیمت دلار در دسترس نیست (API پاسخگو نیست)`,
            threadId ?? undefined
          );
        } else {
          await sendMessage(
            env.BOT_TOKEN,
            msg.chat.id,
            dollarStatusMessage(data),
            threadId ?? undefined,
            {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
            }
          );
        }
        await logEvent(env, { ev: 'status_dollar' });
      } catch (e) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          `❌ خطا در گرفتن قیمت دلار: ${e.message}`,
          threadId ?? undefined
        );
        await reportError(env, 'status_dollar', e);
      }
      return;
    }

    // ─── /debugdollar (owner) ───
    case '/debugdollar': {
      if (msg.from?.id !== OWNER_ID) return;
      const lines = ['🔍 *Dollar endpoints:*', ''];
      for (const ep of DOLLAR_ENDPOINTS) {
        const r = await fetchDollarOnce(ep.url);
        if (r.ok) {
          lines.push(`✅ \`${ep.name}\` → ${r.data.price}`);
        } else {
          lines.push(`❌ \`${ep.name}\` → ${r.reason}`);
        }
      }
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        lines.join('\n'),
        threadId ?? undefined,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // ─── /hourstart ───
    case '/hourstart': {
      const parts = msg.text.trim().split(/\s+/);

      if (parts.length < 2) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          'ℹ️ استفاده:\n' +
            '`/hourstart @username` — لینکدار\n' +
            '`/hourstart هر متن دلخواهی` — متن ساده\n\n' +
            'هر ساعت دقیقه ۰۰ به وقت ایران پیام ارسال میشود.',
          threadId ?? undefined
        );
        return;
      }

      const rawInput = parts.slice(1).join(' ').trim();
      if (!rawInput) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ متن ورودی خالی است.',
          threadId ?? undefined
        );
        return;
      }

      let entry;

      if (rawInput.startsWith('@')) {
        const asUsername = rawInput.slice(1);
        if (!/^[a-z0-9_]{3,32}$/i.test(asUsername)) {
          await sendMessage(
            env.BOT_TOKEN,
            msg.chat.id,
            '⚠️ یوزرنیم معتبر نیست.',
            threadId ?? undefined
          );
          return;
        }

        const found = await lookupUsername(env, asUsername);
        entry = found
          ? {
              userId: found.id,
              firstName: found.firstName || '',
              lastName: found.lastName || '',
              username: found.username || asUsername,
              displayName: null,
            }
          : {
              userId: null,
              firstName: '',
              lastName: '',
              username: asUsername,
              displayName: null,
            };
      } else {
        entry = {
          userId: null,
          firstName: '',
          lastName: '',
          username: '',
          displayName: rawInput,
        };
      }

      const targets = await readHourTargets(env);
      const idx = targets.findIndex((t) =>
        sameTarget(t, msg.chat.id, threadId)
      );

      if (idx >= 0) {
        targets[idx].userId = entry.userId;
        targets[idx].firstName = entry.firstName;
        targets[idx].lastName = entry.lastName;
        targets[idx].username = entry.username;
        targets[idx].displayName = entry.displayName;
      } else {
        targets.push({
          chatId: msg.chat.id,
          threadId,
          ...entry,
          counter: 0,
        });
      }

      await writeHourTargets(env, targets);
      await logEvent(env, {
        ev: 'hourstart',
        input: rawInput.slice(0, 40),
        linked: !!entry.username || !!entry.userId,
        total: targets.length,
      });

      const link = displayLink(entry);
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `${RLM}⏰ ساعت شمار در این ${where} برای ${link} فعال شد.\n` +
          `${RLM}پیام هر ساعت دقیقه ۰۰ به وقت ایران ارسال میشود.`,
        threadId ?? undefined,
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      return;
    }

    // ─── /hourend [force] ───
    case '/hourend': {
      const parts = msg.text.trim().split(/\s+/);
      const isForce = (parts[1] || '').toLowerCase() === 'force';

      const targets = await readHourTargets(env);
      const idx = targets.findIndex((t) =>
        sameTarget(t, msg.chat.id, threadId)
      );

      if (idx === -1) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ ساعت شمار از اینجا فعال نشده.',
          threadId ?? undefined
        );
        return;
      }

      const target = targets[idx];
      const senderId = msg.from?.id;
      const senderUsername =
        msg.from?.username ? msg.from.username.toLowerCase() : null;

      const isPlainText =
        !target.userId && !target.username && !!target.displayName;

      const usernameMatch =
        !!target.username &&
        !!senderUsername &&
        target.username.toLowerCase() === senderUsername;

      if (isForce) {
        if (senderId !== OWNER_ID) {
          const targetLink = displayLink(target);

          await sendMessage(
            env.BOT_TOKEN,
            msg.chat.id,
            `${RLM}تو ${targetLink} نیستی، فقط اون می‌تونه وقتی برگشت متوقف کنه ساعت شمار رو`,
            threadId ?? undefined,
            { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
          );
          await logEvent(env, {
            ev: 'hourend_denied',
            senderId,
            targetUserId: target.userId,
            force: true,
          });
          return;
        }

        targets.splice(idx, 1);
        await writeHourTargets(env, targets);
        await logEvent(env, {
          ev: 'hourend',
          remaining: targets.length,
          force: true,
        });

        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          'ساعت شمار متوقف شد، خوش‌برگشتی',
          threadId ?? undefined
        );
        return;
      }

      const allowed =
        isPlainText ||
        (target.userId != null && target.userId === senderId) ||
        usernameMatch;

      if (!allowed) {
        const targetLink = displayLink(target);

        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          `${RLM}تو ${targetLink} نیستی، فقط اون می‌تونه وقتی برگشت متوقف کنه ساعت شمار رو`,
          threadId ?? undefined,
          { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
        );

        await logEvent(env, {
          ev: 'hourend_denied',
          senderId,
          targetUserId: target.userId,
        });
        return;
      }

      targets.splice(idx, 1);
      await writeHourTargets(env, targets);
      await logEvent(env, {
        ev: 'hourend',
        remaining: targets.length,
        byTarget: !isPlainText,
        byUsername: !isPlainText && target.userId == null && usernameMatch,
      });

      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        'ساعت شمار متوقف شد، خوش‌برگشتی',
        threadId ?? undefined
      );
      return;
    }

    // ─── /errors (owner) ───
    case '/errors': {
      if (msg.from?.id !== OWNER_ID) return;

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

    // ─── /clearerrors (owner) ───
    case '/clearerrors': {
      if (msg.from?.id !== OWNER_ID) return;
      await env.BOT_KV.delete(ERRORS_KEY);
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        '🗑 Error log cleared.',
        threadId ?? undefined
      );
      return;
    }

    // ─── /test ───
    case '/test': {
      let sentAny = false;
      let foundDaily = false;
      let foundHourly = false;

      const dailyTargets = await readTargets(env);
      const dt = dailyTargets.find((x) =>
        sameTarget(x, msg.chat.id, threadId)
      );
      if (dt) {
        foundDaily = true;
        sentAny = true;
        const testCounter = (dt.counter || 0) + 1;
        const testText = dailyMessage({ ...dt, counter: testCounter });
        await sendMessage(
          env.BOT_TOKEN,
          dt.chatId,
          `🧪 (test daily)\n${testText}`,
          dt.threadId ?? undefined,
          { link_preview_options: { is_disabled: true } }
        );
      }

      const hourTargets = await readHourTargets(env);
      const ht = hourTargets.find((x) =>
        sameTarget(x, msg.chat.id, threadId)
      );
      if (ht) {
        foundHourly = true;
        sentAny = true;
        const testTarget = { ...ht, counter: (ht.counter || 0) + 1 };
        const testMsg = `🧪 (test hourly)\n${hourlyMessage(testTarget)}`;
        await sendMessage(
          env.BOT_TOKEN,
          ht.chatId,
          testMsg,
          ht.threadId ?? undefined,
          { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
        );
      }

      // Server test
      let foundServer = false;
      const serverTargets = await readServerTargets(env);
      const st = serverTargets.find((x) =>
        sameTarget(x, msg.chat.id, threadId)
      );
      if (st) {
        foundServer = true;
        sentAny = true;
        try {
          const online = await checkServerStatus();
          let text;
          if (online === null) {
            text = STATUS_MSG_UNKNOWN;
          } else {
            text = online ? SERVER_MSG_ONLINE : SERVER_MSG_OFFLINE;
          }
          await sendMessage(
            env.BOT_TOKEN,
            st.chatId,
            `🧪 (test server)\n${text}`,
            st.threadId ?? undefined,
            { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
          );
        } catch (e) {
          await sendMessage(
            env.BOT_TOKEN,
            st.chatId,
            `🧪 (test server) ❌ ${e.message}`,
            st.threadId ?? undefined
          );
        }
      }

      // Dollar test
      let foundDollar = false;
      const dollarTargets = await readDollarTargets(env);
      const dolt = dollarTargets.find((x) =>
        sameTarget(x, msg.chat.id, threadId)
      );
      if (dolt) {
        foundDollar = true;
        sentAny = true;
        try {
          const data = await fetchDollarData();
          if (data === null) {
            await sendMessage(
              env.BOT_TOKEN,
              dolt.chatId,
              `🧪 (test dollar) ❌ قیمت دلار در دسترس نیست`,
              dolt.threadId ?? undefined
            );
          } else {
            const header =
              `<blockquote>🧪 <b>تست — قیمت دلار</b></blockquote>\n`;
            const body = dollarStatusMessage(data);
            await sendMessage(
              env.BOT_TOKEN,
              dolt.chatId,
              header + body,
              dolt.threadId ?? undefined,
              {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
              }
            );
          }
        } catch (e) {
          await sendMessage(
            env.BOT_TOKEN,
            dolt.chatId,
            `🧪 (test dollar) ❌ ${e.message}`,
            dolt.threadId ?? undefined
          );
        }
      }

      if (!sentAny) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ هیچ روز شمار یا ساعت شماری فعال نیست.\n' +
            'برای روز شمار: `/roozshomar`\n' +
            'برای ساعت شمار: `/hourstart @username`\n' +
            'برای سرور: `/server`\n' +
            'برای دلار: `/serverdollar`',
          threadId ?? undefined
        );
      }

      await logEvent(env, {
        ev: 'test_sent',
        daily: foundDaily,
        hourly: foundHourly,
        server: foundServer,
        dollar: foundDollar,
      });
      return;
    }

    // ─── /button (paginated) ───
    case '/button': {
      const state = await getBtnState(env);
      const totalUsers = state.users.length;
      const page = 0;
      const slice = state.users.slice(0, BTN_PAGE_SIZE);

      const enriched = [];
      for (const u of slice) {
        const lord = u.username ? await readLord(env, u.username) : null;
        enriched.push({
          id: u.id,
          name: u.name,
          username: u.username || null,
          lord: lord || null,
          count: u.count,
        });
      }

      await sendPhoto(
        env.BOT_TOKEN,
        msg.chat.id,
        BUTTON_IMAGE,
        buttonCaption(state.total || 0, enriched),
        threadId ?? undefined,
        {
          parse_mode: 'HTML',
          reply_markup: buttonKeyboard(page, totalUsers),
        }
      );

      await logEvent(env, {
        ev: 'button_msg',
        total: state.total || 0,
        players: totalUsers,
      });
      return;
    }

    // ─── /migratedo (button counter) ───
    case '/migratedo': {
      if (msg.from?.id !== OWNER_ID) return;
      const state = await readBtnState(env);
      const id = env.BTN_COUNTER.idFromName('global');
      const stub = env.BTN_COUNTER.get(id);
      await stub.fetch('https://do/seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `✅ ButtonCounter DO seeded with total=${state.total}, users=${state.users.length}.`,
        threadId ?? undefined
      );
      return;
    }

    // ─── /migratedogame (game counter) ───
    case '/migratedogame': {
      if (msg.from?.id !== OWNER_ID) return;

      const kvUsers = await listUsers(env);
      if (!kvUsers.length) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '📭 KV has no game taps to migrate.',
          threadId ?? undefined
        );
        return;
      }

      const kvTotal = kvUsers.reduce((s, u) => s + u.count, 0);
      const seedUsers = kvUsers.map((u) => ({
        id: u.id,
        name: u.name,
        username: u.username,
        count: u.count,
      }));

      const stub = await getGameStub(env);
      await stub.fetch('https://do/seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ total: kvTotal, users: seedUsers }),
      });

      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `✅ GameCounter DO seeded with total=${kvTotal}, users=${kvUsers.length}.`,
        threadId ?? undefined
      );
      return;
    }

    // ─── /buttonlord ───
    case '/buttonlord': {
      if (msg.from?.id !== OWNER_ID) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⛔ فقط owner می‌تواند لقب بدهد.',
          threadId ?? undefined
        );
        return;
      }

      const parts = msg.text.trim().split(/\s+/);
      if (parts.length < 2) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          'ℹ️ `/buttonlord @username متن لقب` — ارتقا\n' +
            '`/buttonlord @username` — حذف',
          threadId ?? undefined
        );
        return;
      }

      const username = parts[1].replace(/^@/, '').toLowerCase();
      if (!/^[a-z0-9_]{3,32}$/.test(username)) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ یوزرنیم معتبر نیست.',
          threadId ?? undefined
        );
        return;
      }

      const lordText = parts.slice(2).join(' ').trim();

      if (!lordText) {
        await deleteLord(env, username);
        await logEvent(env, { ev: 'buttonlord_remove', username });
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          `✅ لقب @${username} حذف شد.`,
          threadId ?? undefined
        );
        return;
      }

      await writeLord(env, username, lordText);
      await logEvent(env, { ev: 'buttonlord_set', username });
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `✅ @${username} به «${lordText}» ارتقا یافت.`,
        threadId ?? undefined
      );
      return;
    }

    // ─── /editcounter ───
    case '/editcounter': {
      if (msg.from?.id !== OWNER_ID) return;

      const reply = msg.reply_to_message;
      if (!reply || !reply.from?.is_bot) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          'ℹ️ روی یک پیام ربات ریپلای کن.',
          threadId ?? undefined
        );
        return;
      }

      const replyText = reply.text || '';
      const isDefault = replyText.includes(MSG_LINE_1);
      const isCustom =
        !isDefault &&
        /^روز شمار /.test(replyText) &&
        /\nروز \d+/.test(replyText);

      if (!isDefault && !isCustom) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ پیام روز شمار نیست.',
          threadId ?? undefined
        );
        return;
      }

      const parts = msg.text.trim().split(/\s+/);
      const newCounter = parseInt(parts[1], 10);
      if (!Number.isFinite(newCounter) || newCounter < 0) return;

      let newText;
      if (isDefault) {
        newText = replyText.replace(
          /(روز شمار سرور آقا سگه، روز )\d+/,
          `$1${newCounter}`
        );
      } else {
        newText = replyText.replace(/(\nروز )\d+/, `\nروز ${newCounter}`);
      }
      if (newText === replyText) return;

      try {
        await editMessageText(
          env.BOT_TOKEN,
          msg.chat.id,
          reply.message_id,
          newText
        );
      } catch (e) {
        console.error('editcounter failed:', e.message);
        return;
      }

      const targets = await readTargets(env);
      const t = targets.find((x) => sameTarget(x, msg.chat.id, threadId));
      if (t) {
        t.counter = newCounter;
        await writeTargets(env, targets);
      }
      await logEvent(env, { ev: 'editcounter', to: newCounter });
      return;
    }

    // ─── /lord ───
    case '/lord': {
      if (msg.from?.id !== OWNER_ID) return;
      const parts = msg.text.trim().split(/\s+/);
      if (parts.length < 3) return;
      const username = parts[1].replace(/^@/, '').toLowerCase();
      if (!/^[a-z0-9_]{3,32}$/.test(username)) return;
      const lordText = parts.slice(2).join(' ').trim();
      if (!lordText) return;
      await writeLord(env, username, lordText);
      await logEvent(env, { ev: 'lord_set', username });
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `✅ لقب «${lordText}» برای @${username} تنظیم شد.`,
        threadId ?? undefined
      );
      return;
    }

    // ─── /removelord ───
    case '/removelord': {
      if (msg.from?.id !== OWNER_ID) return;
      const parts = msg.text.trim().split(/\s+/);
      if (parts.length < 2) return;
      const username = parts[1].replace(/^@/, '').toLowerCase();
      if (!/^[a-z0-9_]{3,32}$/.test(username)) return;
      await deleteLord(env, username);
      await logEvent(env, { ev: 'lord_remove', username });
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `✅ لقب @${username} حذف شد.`,
        threadId ?? undefined
      );
      return;
    }

    // ─── /players (owner) ───
    case '/players': {
      if (msg.from?.id !== OWNER_ID) return;
      const users = await listUsers(env);
      if (!users.length) return;
      const lines = ['👥 *بازیکن‌ها:*', ''];
      users.forEach((u, i) => {
        const badge = u.lord ? ` 🏅 ${u.lord}` : '';
        lines.push(`${i + 1}. ${u.name}${badge} — ${u.count}`);
      });
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        lines.join('\n'),
        threadId ?? undefined,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // ─── /startgame ───
    case '/startgame': {
      const isPrivate = msg.chat.type === 'private';
      const button = isPrivate
        ? { text: '🎮 شروع بازی', web_app: { url: `${origin}/app` } }
        : { text: '🎮 شروع بازی', url: DIRECT_LINK };

      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        'دوست داری وقتی /start میزنی یه اتفاقی رخ بده؟\n' +
          'بزن این زیر رو خوشتیپ👇',
        threadId ?? undefined,
        { reply_markup: { inline_keyboard: [[button]] } }
      );
      await logEvent(env, { ev: 'startgame', private: isPrivate });
      return;
    }

    // ─── /roozshomar [Subject] [- description] ───
    case '/roozshomar': {
      const rawArgs = msg.text
        .replace(/^\/roozshomar(@\w+)?\s*/i, '')
        .trim();

      let subject = '';
      let description = '';
      if (rawArgs) {
        const sep = rawArgs.indexOf(' - ');
        if (sep >= 0) {
          subject = rawArgs.slice(0, sep).trim();
          description = rawArgs.slice(sep + 3).trim();
        } else {
          subject = rawArgs;
        }
      }

      const isCustom = !!subject;

      const targets = await readTargets(env);
      const idx = targets.findIndex((t) =>
        sameTarget(t, msg.chat.id, threadId)
      );

      // ─── Custom mode ───
      if (isCustom) {
        if (idx >= 0) {
          targets[idx].subject = subject;
          targets[idx].description = description || null;
          await writeTargets(env, targets);
          await logEvent(env, {
            ev: 'roozshomar_update',
            subject: subject.slice(0, 40),
            hasDesc: !!description,
          });
          await sendMessage(
            env.BOT_TOKEN,
            msg.chat.id,
            `روز شمار «${subject}» در این ${where} به‌روزرسانی شد.`,
            threadId ?? undefined
          );
        } else {
          targets.push({
            chatId: msg.chat.id,
            threadId,
            counter: 0,
            subject,
            description: description || null,
          });
          await writeTargets(env, targets);
          await logEvent(env, {
            ev: 'roozshomar_custom',
            subject: subject.slice(0, 40),
            hasDesc: !!description,
            total: targets.length,
          });
          await sendMessage(
            env.BOT_TOKEN,
            msg.chat.id,
            `روز شمار «${subject}» در این ${where} فعال شد.`,
            threadId ?? undefined
          );
        }
        return;
      }

      // ─── Default mode (no args) ───
      if (idx >= 0) {
        return;
      }

      targets.push({ chatId: msg.chat.id, threadId, counter: 0 });
      await writeTargets(env, targets);
      await logEvent(env, { ev: 'roozshomar', total: targets.length });

      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `روز شمار در این ${where} فعال شد، شاید این جمعه بیاد`,
        threadId ?? undefined
      );
      return;
    }

    // ─── /start ───
    case '/start': {
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        '<b>قابلیت های ربات:</b>\n' +
          '/roozshomar شروع روز شمار سرور آقا سگه\n' +
          '/end پایان روز شمار سرور آقا سگه\n' +
          '/server شروع اعلان های وضعیت سرور\n' +
          '/status وضعیت فعلی سرور\n' +
          '/serverdollar شروع اعلان قیمت دلار\n' +
          '/statusdollar قیمت فعلی دلار',
        threadId ?? undefined,
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      await logEvent(env, { ev: 'start_help' });
      return;
    }

    // ─── /end [Subject] ───
    case '/end': {
      const rawArgs = msg.text
        .replace(/^\/end(@\w+)?\s*/i, '')
        .trim();

      const targets = await readTargets(env);

      // ─── Custom mode: /end <Subject> ───
      if (rawArgs) {
        const wanted = rawArgs.toLowerCase();
        const idx = targets.findIndex(
          (t) =>
            sameTarget(t, msg.chat.id, threadId) &&
            t.subject &&
            String(t.subject).toLowerCase() === wanted
        );

        if (idx === -1) {
          await sendMessage(
            env.BOT_TOKEN,
            msg.chat.id,
            '⚠️ روز شماری با این موضوع اینجا فعال نیست.',
            threadId ?? undefined
          );
          return;
        }

        targets.splice(idx, 1);
        await writeTargets(env, targets);
        await logEvent(env, {
          ev: 'end_custom',
          subject: rawArgs.slice(0, 40),
        });
        // silent — no reply on success
        return;
      }

      // ─── Default mode: /end (no args) ───
      const idx = targets.findIndex(
        (t) => sameTarget(t, msg.chat.id, threadId) && !t.subject
      );

      if (idx === -1) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ از اینجا فعال نشده.',
          threadId ?? undefined
        );
        return;
      }

      targets.splice(idx, 1);
      await writeTargets(env, targets);
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `روز شمار در این ${where} پایان یافت، سرور اومد، مبارک خیلیا`,
        threadId ?? undefined
      );
      return;
    }

    // ─── /force-end ───
    case '/force-end': {
      await env.BOT_KV.delete('targets');
      await env.BOT_KV.delete('target');
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        '🛑 همه روز شمارها پاک شدند.',
        threadId ?? undefined
      );
      return;
    }

    // ─── /list ───
    case '/list': {
      const targets = await readTargets(env);
      if (!targets.length) {
        await sendMessage(env.BOT_TOKEN, msg.chat.id, '📭 هیچ مقصدی نیست.', threadId ?? undefined);
        return;
      }
      const label = makeAnonymizer(targets, msg.chat.id, threadId);
      const lines = ['📋 *مقصدهای فعال:*', ''];
      targets.forEach((t, i) => {
        const mark = label(t.chatId, t.threadId) === 'you' ? ' ← (اینجا)' : '';
        const subj = t.subject ? ` «${t.subject}»` : '';
        lines.push(`• chat ${i + 1}${subj} / counter ${t.counter}${mark}`);
      });
      await sendMessage(env.BOT_TOKEN, msg.chat.id, lines.join('\n'), threadId ?? undefined, { parse_mode: 'Markdown' });
      return;
    }

    // ─── /roozshomarmessage ───
    case '/roozshomarmessage': {
      if (msg.from?.id !== OWNER_ID) return;

      const reply = msg.reply_to_message;
      const raw = msg.text
        .replace(/^\/roozshomarmessage(@\w+)?\s*/i, '')
        .trim();

      if (!reply && !raw) return;

      const targets = await readTargets(env);
      if (!targets.length) return;

      let sent = 0;
      let failed = 0;
      for (const t of targets) {
        try {
          if (reply) {
            await copyMessage(
              env.BOT_TOKEN,
              t.chatId,
              reply.chat.id,
              reply.message_id,
              t.threadId ?? undefined
            );
          } else {
            await sendMessage(
              env.BOT_TOKEN,
              t.chatId,
              raw,
              t.threadId ?? undefined,
              { link_preview_options: { is_disabled: true } }
            );
          }
          sent++;
        } catch { failed++; }
      }

      await logEvent(env, {
        ev: 'broadcast',
        sent,
        failed,
        mode: reply ? 'copy' : 'text',
      });

      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `📢 ارسال شد به ${sent} مقصد${failed ? ` (${failed} ناموفق)` : ''}.`,
        threadId ?? undefined
      );
      return;
    }

    // ─── /setcounter ───
    case '/setcounter': {
      if (msg.from?.id !== OWNER_ID) return;
      const parts = msg.text.trim().split(/\s+/);
      if (parts.length < 4 || parts[1].toLowerCase() !== 'chat') return;
      const targetNum = parseInt(parts[2], 10);
      const newCounter = parseInt(parts[3], 10);
      if (!Number.isFinite(targetNum) || targetNum < 1) return;
      if (!Number.isFinite(newCounter) || newCounter < 0) return;
      const targets = await readTargets(env);
      if (targetNum > targets.length) {
        await sendMessage(env.BOT_TOKEN, msg.chat.id, `⚠️ فقط ${targets.length} مقصد.`, threadId ?? undefined);
        return;
      }
      targets[targetNum - 1].counter = newCounter;
      await writeTargets(env, targets);
      await sendMessage(env.BOT_TOKEN, msg.chat.id, `✅ chat ${targetNum} → ${newCounter}`, threadId ?? undefined);
      return;
    }

    // ─── /setcounterall ───
    case '/setcounterall': {
      if (msg.from?.id !== OWNER_ID) return;
      const parts = msg.text.trim().split(/\s+/);
      const newCounter = parseInt(parts[1], 10);
      if (!Number.isFinite(newCounter) || newCounter < 0) return;
      const targets = await readTargets(env);
      if (!targets.length) return;
      for (const t of targets) t.counter = newCounter;
      await writeTargets(env, targets);
      await sendMessage(env.BOT_TOKEN, msg.chat.id, `✅ ${targets.length} مقصد روی ${newCounter}`, threadId ?? undefined);
      return;
    }

    // ─── /ping ───
    case '/ping': {
      await sendMessage(env.BOT_TOKEN, msg.chat.id, `🏓 pong — ${new Date().toISOString()}`, threadId ?? undefined);
      return;
    }

    // ─── /debug ───
    case '/debug': {
      const lines = [];
      lines.push('🔍 *Debug*');
      lines.push('');
      lines.push('📍 Chat');
      lines.push(`  type: ${msg.chat.type}`);
      lines.push(`  thread: ${threadId ?? '—'}`);
      lines.push('');

      lines.push('⚙️ Env');
      lines.push(`  BOT_TOKEN: ${env.BOT_TOKEN ? '✅' : '❌'}`);
      lines.push(`  DB_ENCRYPTION_KEY: ${env.DB_ENCRYPTION_KEY ? '✅' : '❌'}`);
      lines.push(`  BOT_KV: ${env.BOT_KV ? '✅' : '❌'}`);
      lines.push(`  BTN_COUNTER (DO): ${env.BTN_COUNTER ? '✅' : '❌'}`);
      lines.push(`  GAME_COUNTER (DO): ${env.GAME_COUNTER ? '✅' : '❌'}`);
      lines.push('');

      if (env.BOT_KV) {
        try {
          const targets = await readTargets(env);
          const label = makeAnonymizer(targets, msg.chat.id, threadId);

          lines.push(`🎯 Daily targets (${targets.length})`);
          targets.forEach((t, i) => {
            const mark = label(t.chatId, t.threadId) === 'you' ? ' ← (this)' : '';
            const subj = t.subject ? ` «${t.subject}»` : '';
            lines.push(`  chat ${i + 1}${subj} · counter=${t.counter}${mark}`);
          });
          lines.push('');
        } catch (e) {
          lines.push(`🎯 Daily targets ⚠️ ${e.message}`);
          lines.push('');
        }

        try {
          lines.push('⏰ Hour targets');
          const hts = await readHourTargets(env);
          if (!hts.length) {
            lines.push('  (none)');
          } else {
            const hl = makeAnonymizer(hts, msg.chat.id, threadId);
            hts.forEach((t, i) => {
              const mark = hl(t.chatId, t.threadId) === 'you' ? ' ← (this)' : '';
              let nm;
              if (t.displayName) {
                nm = `plain:"${t.displayName}"`;
              } else if (t.userId) {
                nm = [t.firstName, t.lastName].filter(Boolean).join(' ') ||
                  `@${t.username || '?'}`;
              } else if (t.username) {
                nm = `@${t.username}`;
              } else {
                nm = 'Unknown';
              }
              lines.push(`  chat ${i + 1} · user=${nm} · counter=${t.counter}${mark}`);
            });
          }
          lines.push('');
        } catch (e) {
          lines.push(`⏰ Hour targets ⚠️ ${e.message}`);
          lines.push('');
        }

        try {
          lines.push('🖥 Server targets');
          const sts = await readServerTargets(env);
          if (!sts.length) {
            lines.push('  (none)');
          } else {
            const sl = makeAnonymizer(sts, msg.chat.id, threadId);
            sts.forEach((t, i) => {
              const mark = sl(t.chatId, t.threadId) === 'you' ? ' ← (this)' : '';
              lines.push(`  chat ${i + 1}${mark}`);
            });
          }
          lines.push('');
        } catch (e) {
          lines.push(`🖥 Server targets ⚠️ ${e.message}`);
          lines.push('');
        }

        try {
          lines.push('💵 Dollar targets');
          const dts = await readDollarTargets(env);
          if (!dts.length) {
            lines.push('  (none)');
          } else {
            const dl = makeAnonymizer(dts, msg.chat.id, threadId);
            dts.forEach((t, i) => {
              const mark = dl(t.chatId, t.threadId) === 'you' ? ' ← (this)' : '';
              lines.push(`  chat ${i + 1}${mark}`);
            });
          }
          lines.push('');
        } catch (e) {
          lines.push(`💵 Dollar targets ⚠️ ${e.message}`);
          lines.push('');
        }

        try {
          const sl = await readServerLast(env);
          lines.push('🖥 Server last status');
          if (!sl) {
            lines.push('  (unknown — no check yet)');
          } else {
            lines.push(`  online: ${sl.online ? '✅' : '❌'}`);
            lines.push(`  checked: ${Math.round((Date.now() - sl.at) / 1000)}s ago`);
          }
          lines.push('');
        } catch (e) {
          lines.push(`🖥 Server last status ⚠️ ${e.message}`);
          lines.push('');
        }

        try {
          const dl = await readDollarLast(env);
          lines.push('💵 Dollar last price');
          if (!dl) {
            lines.push('  (unknown — no check yet)');
          } else {
            lines.push(`  price: ${dl.price}`);
            lines.push(`  checked: ${Math.round((Date.now() - dl.at) / 1000)}s ago`);
          }
          lines.push('');
        } catch (e) {
          lines.push(`💵 Dollar last price ⚠️ ${e.message}`);
          lines.push('');
        }

        try {
          const idx = await readUnameIndex(env);
          lines.push('📇 Username index');
          lines.push(`  entries: ${Object.keys(idx).length}`);
          lines.push('');
        } catch (e) {
          lines.push(`📇 Username index ⚠️ ${e.message}`);
          lines.push('');
        }

        try {
          const users = await listUsers(env);
          const total = users.reduce((s, u) => s + u.count, 0);
          const lords = users.filter((u) => u.lord).length;
          lines.push('🎮 Game (KV)');
          lines.push(`  players: ${users.length}`);
          lines.push(`  total: ${total}`);
          lines.push(`  lords: ${lords}`);
          lines.push('');
        } catch (e) {
          lines.push(`🎮 Game (KV) ⚠️ ${e.message}`);
          lines.push('');
        }

        try {
          const stub = await getGameStub(env);
          const res = await stub.fetch('https://do/state', { method: 'GET' });
          const gs = await res.json();
          lines.push('🎮 Game (DO)');
          lines.push(`  total: ${gs.total}`);
          lines.push(`  players: ${gs.users.length}`);
          lines.push('');
        } catch (e) {
          lines.push(`🎮 Game (DO) ⚠️ ${e.message}`);
          lines.push('');
        }

        try {
          const bs = await getBtnState(env);
          lines.push('🔘 Button counter (DO)');
          lines.push(`  total clicks: ${bs.total}`);
          lines.push(`  tappers: ${bs.users.length}`);
          lines.push('');
        } catch (e) {
          lines.push(`🔘 Button counter ⚠️ ${e.message}`);
          lines.push('');
        }

        try {
          const rawErr = await env.BOT_KV.get(ERRORS_KEY, { cacheTtl: KV_CACHE_TTL });
          let errCount = 0;
          if (rawErr) {
            try {
              const list = decryptData(rawErr, env.DB_ENCRYPTION_KEY);
              errCount = Array.isArray(list) ? list.length : 0;
            } catch { errCount = 0; }
          }
          lines.push('🚨 Errors');
          lines.push(`  recorded: ${errCount}`);
          if (errCount > 0) lines.push('  use /errors to view');
          lines.push('');
        } catch (e) {
          lines.push(`🚨 Errors ⚠️ ${e.message}`);
          lines.push('');
        }
      }

      lines.push('🤖 Bot');
      try {
        const me = await telegram(env.BOT_TOKEN, 'getMe');
        lines.push(`  @${me.result.username}`);
      } catch (e) {
        lines.push(`  ⚠️ ${e.message}`);
      }
      lines.push('');

      lines.push('🪝 Webhook');
      try {
        const info = await telegram(env.BOT_TOKEN, 'getWebhookInfo');
        const r = info.result || {};
        lines.push(`  url: ${r.url ? '✅ set' : '❌'}`);
        lines.push(`  pending: ${r.pending_update_count ?? 0}`);
        if (r.last_error_message) {
          lines.push(`  ⚠️ ${r.last_error_message}`);
        } else {
          lines.push('  last_error: none ✅');
        }
      } catch (e) {
        lines.push(`  ⚠️ ${e.message}`);
      }
      lines.push('');

      lines.push('ℹ️ Commands');
      lines.push('  /server  /status');
      lines.push('  /serverdollar  /statusdollar');
      lines.push('  /hourstart @username | /hourstart any text  /hourend [force]');
      lines.push('  /button /startgame /start /end /force-end /list /players /test /ping /debug');
      lines.push('  /roozshomar');
      lines.push('  /errors [N]  /clearerrors  (owner)');
      lines.push('  /debugdollar  (owner)');
      lines.push('  /buttonlord @username <text>  (owner)');
      lines.push('  /editcounter <number>  (owner)');
      lines.push('  /lord /removelord /setcounter /setcounterall /migratedo /migratedogame  (owner)');
      lines.push('  /roozshomarmessage <text> | reply-to-any  (owner)');

      await sendMessage(env.BOT_TOKEN, msg.chat.id, lines.join('\n'), threadId ?? undefined);
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

async function sendPhoto(token, chatId, photoUrl, caption, threadId, extra = {}) {
  const body = { chat_id: chatId, photo: photoUrl, caption, ...extra };
  if (threadId) body.message_thread_id = threadId;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(
      `sendPhoto ${res.status}: ${data.description || JSON.stringify(data)}`
    );
  }
  return data;
}

async function copyMessage(token, chatId, fromChatId, messageId, threadId) {
  const body = {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId,
  };
  if (threadId) body.message_thread_id = threadId;

  const res = await fetch(
    `https://api.telegram.org/bot${token}/copyMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(
      `copyMessage ${res.status}: ${data.description || JSON.stringify(data)}`
    );
  }
  return data;
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

async function editMessageCaption(token, chatId, messageId, caption, extra = {}) {
  const res = await fetch(
    `https://api.telegram.org/bot${token}/editMessageCaption`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        caption,
        ...extra,
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(
      `editMessageCaption ${res.status}: ${data.description || JSON.stringify(data)}`
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
