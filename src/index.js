// ============= CONFIG =============
const MSG_LINE_1 = 'روز شمار سرور آقا سگه، روز';
const MSG_LINE_2 =
  'امروز هم سرور ماینکرفت اونی-چان نیومد ૮₍ ˃ ⤙ ˂ ₎ა';

const CRON_MIDNIGHT = '30 20 * * *'; // 00:00 Iran

const KV_CACHE_TTL = 30;
const ADMIN_ID = 302287170;

const DIRECT_LINK = 'https://t.me/AqhaSageServerRoozShomarBot/game';

// Image for /button message
const BUTTON_IMAGE =
  'https://cdn.donmai.us/original/46/ea/__original_drawn_by_soya_torga__46eaa11d83f35adb94e2edf6b9e7f29a.jpg';

// Max users shown in the /button caption (caption limit is 1024 chars)
const BTN_TOP_LIMIT = 25;

// Right-to-Left Mark — forces each line to render RTL
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

// ============= HTML ESCAPING =============
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
  await env.BOT_KV.put(
    'targets',
    encryptData(targets, env.DB_ENCRYPTION_KEY)
  );
}

function sameTarget(a, chatId, threadId) {
  return a.chatId === chatId && (a.threadId ?? null) === (threadId ?? null);
}

// ============= GAME HELPERS (per-user keys + index) =============
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
  await env.BOT_KV.put(
    INDEX_KEY,
    encryptData(ids, env.DB_ENCRYPTION_KEY)
  );
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

// ============= BUTTON COUNTER HELPERS =============
const BTN_TOTAL_KEY = 'btn:total';
const BTN_USER_PREFIX = 'btn:user:';
const BTN_INDEX_KEY = 'btn:index';

async function readBtnTotal(env) {
  const raw = await env.BOT_KV.get(BTN_TOTAL_KEY, {
    cacheTtl: KV_CACHE_TTL,
  });
  if (!raw) return 0;
  try {
    const d = decryptData(raw, env.DB_ENCRYPTION_KEY);
    return typeof d.v === 'number' ? d.v : 0;
  } catch {
    return 0;
  }
}

async function writeBtnTotal(env, v) {
  await env.BOT_KV.put(
    BTN_TOTAL_KEY,
    encryptData({ v }, env.DB_ENCRYPTION_KEY)
  );
}

async function readBtnUser(env, id) {
  const raw = await env.BOT_KV.get(BTN_USER_PREFIX + id, {
    cacheTtl: KV_CACHE_TTL,
  });
  if (!raw) return null;
  try {
    const d = decryptData(raw, env.DB_ENCRYPTION_KEY);
    if (d && typeof d.count === 'number') return d;
    return null;
  } catch {
    return null;
  }
}

async function writeBtnUser(env, id, data) {
  await env.BOT_KV.put(
    BTN_USER_PREFIX + id,
    encryptData(data, env.DB_ENCRYPTION_KEY)
  );
}

async function readBtnIndex(env) {
  const raw = await env.BOT_KV.get(BTN_INDEX_KEY, {
    cacheTtl: KV_CACHE_TTL,
  });
  if (!raw) return [];
  try {
    const arr = decryptData(raw, env.DB_ENCRYPTION_KEY);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function writeBtnIndex(env, ids) {
  await env.BOT_KV.put(
    BTN_INDEX_KEY,
    encryptData(ids, env.DB_ENCRYPTION_KEY)
  );
}

async function addToBtnIndex(env, id) {
  const ids = await readBtnIndex(env);
  const s = String(id);
  if (!ids.includes(s)) {
    ids.push(s);
    await writeBtnIndex(env, ids);
  }
}

// Returns every user who has ever tapped the button, sorted by count desc.
// Each entry has `id`, `name`, `username` (if any), `count`, `lord` (if any).
async function listBtnUsers(env) {
  const idSet = new Set();

  for (const id of await readBtnIndex(env)) idSet.add(String(id));

  let cursor;
  do {
    const res = await env.BOT_KV.list({ prefix: BTN_USER_PREFIX, cursor });
    for (const k of res.keys) {
      idSet.add(k.name.slice(BTN_USER_PREFIX.length));
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);

  const users = [];
  for (const id of idSet) {
    const u = await readBtnUser(env, id);
    if (!u) continue;
    const lord = u.username ? await readLord(env, u.username) : null;
    users.push({
      id: /^\d+$/.test(id) ? parseInt(id, 10) : id,
      name: u.name || 'User',
      username: u.username || null,
      lord: lord || null,
      count: u.count,
    });
  }

  users.sort((a, b) => b.count - a.count);
  return users;
}

// Plain caption — every line prefixed with RLM so mixed content renders RTL
function buttonCaption(total, users) {
  const lines = [];

  lines.push(`${RLM}انگشت های کل: ${total}`);
  lines.push('');

  if (!users.length) {
    lines.push(`${RLM}هنوز کسی انگشت نزده`);
  } else {
    const top = users.slice(0, BTN_TOP_LIMIT);
    for (const u of top) {
      lines.push(`${RLM}انگشت های ${u.name}: ${u.count}`);
    }
    if (users.length > BTN_TOP_LIMIT) {
      lines.push(`${RLM}و ${users.length - BTN_TOP_LIMIT} نفر دیگه...`);
    }
  }

  lines.push('');
  lines.push(`${RLM}اونی-چان انگشتم نکن!`);

  return capToLimit(lines);
}

// Lord caption — only the username is hyperlinked to their Telegram profile.
// "آقا سگه" is a plain-text prefix, "«lord»" is a plain-text suffix.
// Requires parse_mode: 'HTML'.
function buttonLordCaption(total, users) {
  const lines = [];

  lines.push(`${RLM}انگشت های کل: ${total}`);
  lines.push('');

  if (!users.length) {
    lines.push(`${RLM}هنوز کسی انگشت نزده`);
  } else {
    const top = users.slice(0, BTN_TOP_LIMIT);
    for (const u of top) {
      const safeName = htmlEsc(u.name);
      const safeLord = u.lord ? htmlEsc(u.lord) : null;

      // Only the <a>...</a> part is clickable
      const linkedName = `<a href="tg://user?id=${u.id}">${safeName}</a>`;
      const namePart = u.lord
        ? `آقا سگه ${linkedName} «${safeLord}»`
        : safeName;

      lines.push(`${RLM}انگشت های ${namePart}: ${u.count}`);
    }
    if (users.length > BTN_TOP_LIMIT) {
      lines.push(`${RLM}و ${users.length - BTN_TOP_LIMIT} نفر دیگه...`);
    }
  }

  lines.push('');
  lines.push(`${RLM}اونی-چان انگشتم نکن!`);

  return capToLimit(lines);
}

// Truncate caption at line boundaries to avoid breaking HTML tags mid-way
function capToLimit(lines) {
  let caption = lines.join('\n');
  if (caption.length <= 1024) return caption;

  // Drop lines from the end until it fits (keep at least the header)
  const trimmed = [...lines];
  while (trimmed.length > 2 && trimmed.join('\n').length > 1024) {
    trimmed.splice(trimmed.length - 2, 1); // drop last content line, keep footer
  }
  caption = trimmed.join('\n');
  if (caption.length > 1024) {
    caption = caption.slice(0, 1015) + '…';
  }
  return caption;
}

// lord = false → plain /button (no parse_mode)
// lord = true  → /buttonlord (HTML parse_mode + hyperlinked lords)
function buttonKeyboard(lord = false) {
  return {
    inline_keyboard: [
      [
        {
          text: '/start',
          callback_data: lord ? 'btn:click:lord' : 'btn:click',
        },
      ],
    ],
  };
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
  let body = {};
  try {
    body = await request.json();
  } catch { /* ignore */ }

  const user = await validateInitData(body.initData, env.BOT_TOKEN);
  if (!user) return jsonResponse({ error: 'unauthorized' }, 401);

  await migrateOldGame(env);

  const users = await listUsers(env);
  const total = users.reduce((s, u) => s + u.count, 0);

  const top = users.slice(0, 50);
  if (!top.some((u) => u.id === user.id)) {
    const me = users.find((u) => u.id === user.id);
    if (me) top.push(me);
  }

  return jsonResponse({ total, users: top });
}

async function handleTap(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch { /* ignore */ }

  const user = await validateInitData(body.initData, env.BOT_TOKEN);
  if (!user) return jsonResponse({ error: 'unauthorized' }, 401);

  let n = parseInt(body.count, 10);
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > 200) n = 200;

  const displayName =
    [user.first_name, user.last_name].filter(Boolean).join(' ') ||
    user.username ||
    'User';

  const existing = await readUser(env, user.id);
  const newCount = (existing?.count || 0) + n;
  const username = user.username || existing?.username || null;

  await writeUser(env, user.id, {
    name: displayName,
    username,
    count: newCount,
  });

  await addToIndex(env, user.id);

  const lord = username ? await readLord(env, username) : null;

  const users = await listUsers(env);

  const idx = users.findIndex((u) => u.id === user.id);
  const me = {
    id: user.id,
    name: displayName,
    username,
    lord: lord || null,
    count: newCount,
  };
  if (idx >= 0) users[idx] = me;
  else users.push(me);
  users.sort((a, b) => b.count - a.count);

  const total = users.reduce((s, u) => s + u.count, 0);

  const top = users.slice(0, 50);
  if (!top.some((u) => u.id === user.id)) {
    const m = users.find((u) => u.id === user.id);
    if (m) top.push(m);
  }

  return jsonResponse({ total, users: top });
}

// ============= CALLBACK QUERY HANDLER =============
async function handleCallbackQuery(update, env) {
  const cq = update.callback_query;
  if (!cq) return;

  try {
    await answerCallbackQuery(env.BOT_TOKEN, cq.id);
  } catch { /* ignore */ }

  const isPlain = cq.data === 'btn:click';
  const isLord = cq.data === 'btn:click:lord';
  if (!isPlain && !isLord) return;

  const userId = cq.from?.id;
  if (!userId) return;

  const name =
    cq.from.first_name ||
    cq.from.username ||
    'User';
  const username = cq.from.username || null;

  const [total, u] = await Promise.all([
    readBtnTotal(env),
    readBtnUser(env, userId),
  ]);

  const newTotal = total + 1;
  const newUserCount = (u?.count || 0) + 1;

  await Promise.all([
    writeBtnTotal(env, newTotal),
    writeBtnUser(env, userId, {
      name,
      username: username || u?.username || null,
      count: newUserCount,
    }),
    addToBtnIndex(env, userId),
  ]);

  const allUsers = await listBtnUsers(env);

  const newCaption = isLord
    ? buttonLordCaption(newTotal, allUsers)
    : buttonCaption(newTotal, allUsers);

  const extra = isLord
    ? { parse_mode: 'HTML', reply_markup: buttonKeyboard(true) }
    : { reply_markup: buttonKeyboard(false) };

  try {
    await editMessageCaption(
      env.BOT_TOKEN,
      cq.message.chat.id,
      cq.message.message_id,
      newCaption,
      extra
    );
  } catch (e) {
    console.error('edit button caption failed:', e.message);
  }

  await logEvent(env, {
    ev: 'btn_click',
    total: newTotal,
    user: newUserCount,
    lord: isLord,
  });
}

// ============= WORKER =============
export default {
  async fetch(request, env) {
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
      return new Response('Bad Request', { status: 400 });
    }

    if (update.callback_query) {
      try {
        await handleCallbackQuery(update, env);
      } catch (err) {
        await logEvent(env, { ev: 'crash', msg: err.message });
        console.error('❌ callback crashed:', err.stack || err.message);
      }
      return new Response('OK', { status: 200 });
    }

    const msg = update.message;
    if (msg?.text) {
      await logEvent(env, {
        ev: 'update',
        cmd: parseCommand(msg.text),
      });
    }

    try {
      await handleUpdate(update, env, url.origin);
    } catch (err) {
      await logEvent(env, { ev: 'crash', msg: err.message });
      console.error('❌ handleUpdate crashed:', err.stack || err.message);
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
  },

  async scheduled(event, env) {
    console.log(`⏰ Cron fired: ${event.cron}`);
    await logEvent(env, { ev: 'cron', cron: event.cron });

    if (!env.BOT_TOKEN || !env.DB_ENCRYPTION_KEY || !env.BOT_KV) {
      console.error('❌ Missing env bindings');
      await logEvent(env, { ev: 'cron_error', msg: 'missing env bindings' });
      return;
    }

    if (event.cron !== CRON_MIDNIGHT) {
      console.log(`⚠️ Unknown cron fired: ${event.cron}`);
      return;
    }

    const targets = await readTargets(env);
    if (!targets.length) {
      console.log('⚠️ No targets set yet.');
      await logEvent(env, { ev: 'cron_skip', reason: 'no targets' });
      return;
    }

    let sent = 0;
    let failed = 0;

    for (const t of targets) {
      const threadId = t.threadId ?? undefined;
      try {
        const counter = (t.counter || 0) + 1;
        const text = `${MSG_LINE_1} ${counter}\n${MSG_LINE_2}`;
        await sendMessage(env.BOT_TOKEN, t.chatId, text, threadId);
        t.counter = counter;
        sent++;
      } catch (err) {
        failed++;
        console.error(`❌ Send failed: ${err.message}`);
        await logEvent(env, { ev: 'send_error', msg: err.message });
      }
    }

    try {
      await writeTargets(env, targets);
    } catch (e) {
      console.error('❌ Failed to persist counters:', e.message);
    }

    console.log(`✅ Cron done: sent=${sent} failed=${failed}`);
    await logEvent(env, { ev: 'cron_done', sent, failed });
  },
};

// ============= UPDATE HANDLER =============
async function handleUpdate(update, env, origin) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const cmd = parseCommand(msg.text);
  if (!cmd) return;

  if (!env.BOT_TOKEN) {
    console.error('❌ BOT_TOKEN env var is missing');
    return;
  }

  const threadId = topicOf(msg) ?? null;
  const where = !threadId
    ? msg.chat.type === 'private'
      ? 'چت خصوصی'
      : 'چت'
    : 'تاپیک';

  switch (cmd) {
    // ─── /button ───
    case '/button': {
      const [total, users] = await Promise.all([
        readBtnTotal(env),
        listBtnUsers(env),
      ]);

      await sendPhoto(
        env.BOT_TOKEN,
        msg.chat.id,
        BUTTON_IMAGE,
        buttonCaption(total, users),
        threadId ?? undefined,
        { reply_markup: buttonKeyboard(false) }
      );

      await logEvent(env, { ev: 'button_msg', total, players: users.length });
      return;
    }

    // ─── /buttonlord ───
    case '/buttonlord': {
      const [total, users] = await Promise.all([
        readBtnTotal(env),
        listBtnUsers(env),
      ]);

      await sendPhoto(
        env.BOT_TOKEN,
        msg.chat.id,
        BUTTON_IMAGE,
        buttonLordCaption(total, users),
        threadId ?? undefined,
        {
          parse_mode: 'HTML',
          reply_markup: buttonKeyboard(true),
        }
      );

      await logEvent(env, {
        ev: 'buttonlord_msg',
        total,
        players: users.length,
      });
      return;
    }

    // ─── /editcounter <number> (reply to a bot message) ───
    case '/editcounter': {
      if (msg.from?.id !== ADMIN_ID) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⛔ فقط ادمین میتواند شمارنده را ویرایش کند.',
          threadId ?? undefined
        );
        return;
      }

      const reply = msg.reply_to_message;
      if (!reply) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          'ℹ️ باید روی یک پیام ربات ریپلای کنی.\n' +
            'استفاده: `/editcounter <number>`',
          threadId ?? undefined
        );
        return;
      }

      if (!reply.from?.is_bot) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ فقط روی پیام ربات میشه این کار رو کرد.',
          threadId ?? undefined
        );
        return;
      }

      const replyText = reply.text || '';
      if (!replyText.includes(MSG_LINE_1)) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ این پیام یک پیام روز شمار نیست.',
          threadId ?? undefined
        );
        return;
      }

      const parts = msg.text.trim().split(/\s+/);
      if (parts.length < 2) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          'ℹ️ استفاده: `/editcounter <number>` (با ریپلای)',
          threadId ?? undefined
        );
        return;
      }

      const newCounter = parseInt(parts[1], 10);
      if (!Number.isFinite(newCounter) || newCounter < 0) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ شمارنده باید عدد ≥ 0 باشد.',
          threadId ?? undefined
        );
        return;
      }

      const newText = replyText.replace(
        /(روز شمار سرور آقا سگه، روز )\d+/,
        `$1${newCounter}`
      );

      if (newText === replyText) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          'ℹ️ شمارنده همین الان هم همین عدد بود.',
          threadId ?? undefined
        );
        return;
      }

      try {
        await editMessageText(
          env.BOT_TOKEN,
          msg.chat.id,
          reply.message_id,
          newText
        );
      } catch (e) {
        console.error('editcounter failed:', e.message);
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          `❌ خطا در ویرایش پیام: ${e.message}`,
          threadId ?? undefined
        );
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

    // ─── /lord @username <text> ───
    case '/lord': {
      if (msg.from?.id !== ADMIN_ID) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⛔ فقط ادمین میتواند لقب بدهد.',
          threadId ?? undefined
        );
        return;
      }

      const parts = msg.text.trim().split(/\s+/);
      if (parts.length < 3) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          'ℹ️ استفاده: `/lord @username متن لقب`\n' +
            'مثال: `/lord @ali پادشاه`',
          threadId ?? undefined
        );
        return;
      }

      const username = parts[1].replace(/^@/, '').toLowerCase();
      if (!/^[a-z0-9_]{3,32}$/.test(username)) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ یوزرنیم معتبر نیست. باید با @ شروع بشه.',
          threadId ?? undefined
        );
        return;
      }

      const lordText = parts.slice(2).join(' ').trim();
      if (!lordText) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          'ℹ️ متن لقب را وارد کن.',
          threadId ?? undefined
        );
        return;
      }

      await writeLord(env, username, lordText);
      await logEvent(env, {
        ev: 'lord_set',
        username,
        len: lordText.length,
      });
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `✅ لقب «${lordText}» برای @${username} تنظیم شد.`,
        threadId ?? undefined
      );
      return;
    }

    // ─── /removelord @username ───
    case '/removelord': {
      if (msg.from?.id !== ADMIN_ID) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⛔ فقط ادمین میتواند لقب را حذف کند.',
          threadId ?? undefined
        );
        return;
      }

      const parts = msg.text.trim().split(/\s+/);
      if (parts.length < 2) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          'ℹ️ استفاده: `/removelord @username`',
          threadId ?? undefined
        );
        return;
      }

      const username = parts[1].replace(/^@/, '').toLowerCase();
      if (!/^[a-z0-9_]{3,32}$/.test(username)) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ یوزرنیم معتبر نیست. باید با @ شروع بشه.',
          threadId ?? undefined
        );
        return;
      }

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

    // ─── /players (admin) ───
    case '/players': {
      if (msg.from?.id !== ADMIN_ID) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⛔ فقط ادمین.',
          threadId ?? undefined
        );
        return;
      }
      const users = await listUsers(env);
      if (!users.length) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '📭 هیچ بازیکنی نیست.',
          threadId ?? undefined
        );
        return;
      }
      const lines = ['👥 *بازیکنها:*', ''];
      users.forEach((u, i) => {
        const badge = u.lord ? ` 🏅 ${u.lord}` : '';
        lines.push(`${i + 1}. ${u.name}${badge} — ${u.count}`);
      });
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        lines.join('\n'),
        threadId ?? undefined
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
        {
          reply_markup: {
            inline_keyboard: [[button]],
          },
        }
      );
      await logEvent(env, { ev: 'startgame', private: isPrivate });
      return;
    }

    // ─── /start ───
    case '/start': {
      const targets = await readTargets(env);
      const existing = targets.find((t) =>
        sameTarget(t, msg.chat.id, threadId)
      );

      await env.BOT_KV.put(
        'last_start',
        encryptData(
          { chatId: msg.chat.id, threadId, at: Date.now() },
          env.DB_ENCRYPTION_KEY
        ),
        { expirationTtl: 120 }
      );

      if (existing) {
        await logEvent(env, { ev: 'start_silent', total: targets.length });
        return;
      }

      targets.push({ chatId: msg.chat.id, threadId, counter: 0 });
      await writeTargets(env, targets);
      await logEvent(env, { ev: 'start', total: targets.length });

      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `روز شمار در این ${where} فعال شد، شاید این جمعه بیاید`,
        threadId ?? undefined
      );
      return;
    }

    // ─── /end ───
    case '/end': {
      const targets = await readTargets(env);
      const idx = targets.findIndex((t) =>
        sameTarget(t, msg.chat.id, threadId)
      );

      if (idx === -1) {
        let viaPointer = false;
        try {
          const rawPtr = await env.BOT_KV.get('last_start', {
            cacheTtl: KV_CACHE_TTL,
          });
          if (rawPtr) {
            const p = decryptData(rawPtr, env.DB_ENCRYPTION_KEY);
            if (
              p.chatId === msg.chat.id &&
              (p.threadId ?? null) === threadId
            ) {
              viaPointer = true;
            }
          }
        } catch { /* ignore */ }

        if (!viaPointer) {
          await logEvent(env, { ev: 'end_mismatch' });
          await sendMessage(
            env.BOT_TOKEN,
            msg.chat.id,
            '⚠️ روز شمار از اینجا فعال نشده، نمیتوانی از اینجا هم متوقفش کنی.',
            threadId ?? undefined
          );
          return;
        }
      } else {
        targets.splice(idx, 1);
        await writeTargets(env, targets);
      }

      await env.BOT_KV.delete('last_start');
      await logEvent(env, { ev: 'end_ok', remaining: targets.length });

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
      await env.BOT_KV.delete('last_start');
      await logEvent(env, { ev: 'force_end' });
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
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '📭 هیچ مقصدی ثبت نشده.',
          threadId ?? undefined
        );
        return;
      }
      const label = makeAnonymizer(targets, msg.chat.id, threadId);
      const lines = ['📋 *مقصدهای فعال:*', ''];
      targets.forEach((t, i) => {
        const mark = label(t.chatId, t.threadId) === 'you' ? ' ← (اینجا)' : '';
        lines.push(`• chat ${i + 1} / counter ${t.counter}${mark}`);
      });
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        lines.join('\n'),
        threadId ?? undefined
      );
      return;
    }

    // ─── /test ───
    case '/test': {
      const targets = await readTargets(env);
      const t = targets.find((x) => sameTarget(x, msg.chat.id, threadId));
      if (!t) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ اول /start بزن.',
          threadId ?? undefined
        );
        return;
      }
      const tId = t.threadId ?? undefined;
      await sendMessage(
        env.BOT_TOKEN,
        t.chatId,
        `🧪 (test) ${MSG_LINE_1} ${(t.counter || 0) + 1}\n${MSG_LINE_2}`,
        tId
      );
      await logEvent(env, { ev: 'test_sent' });
      return;
    }

    // ─── /roozshomarmessage <text> ───
    case '/roozshomarmessage': {
      if (msg.from?.id !== ADMIN_ID) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⛔ فقط ادمین میتواند پیام همگانی بفرستد.',
          threadId ?? undefined
        );
        return;
      }
      const raw = msg.text
        .replace(/^\/roozshomarmessage(@\w+)?\s*/i, '')
        .trim();
      if (!raw) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          'ℹ️ استفاده: `/roozshomarmessage متن پیام`',
          threadId ?? undefined
        );
        return;
      }
      const targets = await readTargets(env);
      if (!targets.length) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '📭 هیچ مقصدی ثبت نشده.',
          threadId ?? undefined
        );
        return;
      }
      let sent = 0;
      let failed = 0;
      for (const t of targets) {
        try {
          await sendMessage(
            env.BOT_TOKEN,
            t.chatId,
            raw,
            t.threadId ?? undefined
          );
          sent++;
        } catch (err) {
          failed++;
          console.error(`❌ Broadcast failed: ${err.message}`);
        }
      }
      await logEvent(env, {
        ev: 'broadcast',
        sent,
        failed,
        len: raw.length,
      });
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `📢 ارسال شد به ${sent} مقصد${failed ? ` (${failed} ناموفق)` : ''}.`,
        threadId ?? undefined
      );
      return;
    }

    // ─── /setcounter chat <N> <counter> ───
    case '/setcounter': {
      if (msg.from?.id !== ADMIN_ID) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⛔ فقط ادمین میتواند شمارنده را تغییر دهد.',
          threadId ?? undefined
        );
        return;
      }
      const parts = msg.text.trim().split(/\s+/);
      if (parts.length < 4 || parts[1].toLowerCase() !== 'chat') {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          'ℹ️ استفاده: `/setcounter chat <N> <counter>`\n' +
            'مثال: `/setcounter chat 2 15`\n' +
            'برای دیدن شمارهها: `/list`',
          threadId ?? undefined
        );
        return;
      }
      const targetNum = parseInt(parts[2], 10);
      const newCounter = parseInt(parts[3], 10);
      if (
        !Number.isFinite(targetNum) ||
        targetNum < 1 ||
        !Number.isFinite(newCounter) ||
        newCounter < 0
      ) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ شماره چت باید ≥ 1 و شمارنده باید ≥ 0 باشد.',
          threadId ?? undefined
        );
        return;
      }
      const targets = await readTargets(env);
      if (targetNum > targets.length) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          `⚠️ فقط ${targets.length} مقصد وجود دارد. از /list استفاده کن.`,
          threadId ?? undefined
        );
        return;
      }
      const t = targets[targetNum - 1];
      const oldCounter = t.counter || 0;
      t.counter = newCounter;
      await writeTargets(env, targets);
      await logEvent(env, {
        ev: 'setcounter',
        chatN: targetNum,
        from: oldCounter,
        to: newCounter,
      });
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `✅ شمارنده chat ${targetNum} از ${oldCounter} به ${newCounter} تغییر کرد.`,
        threadId ?? undefined
      );
      return;
    }

    // ─── /setcounterall <counter> ───
    case '/setcounterall': {
      if (msg.from?.id !== ADMIN_ID) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⛔ فقط ادمین میتواند شمارنده را تغییر دهد.',
          threadId ?? undefined
        );
        return;
      }
      const parts = msg.text.trim().split(/\s+/);
      if (parts.length < 2) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          'ℹ️ استفاده: `/setcounterall <counter>`\n' +
            'مثال: `/setcounterall 10`',
          threadId ?? undefined
        );
        return;
      }
      const newCounter = parseInt(parts[1], 10);
      if (!Number.isFinite(newCounter) || newCounter < 0) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ شمارنده باید عدد ≥ 0 باشد.',
          threadId ?? undefined
        );
        return;
      }
      const targets = await readTargets(env);
      if (!targets.length) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '📭 هیچ مقصدی ثبت نشده.',
          threadId ?? undefined
        );
        return;
      }
      for (const t of targets) t.counter = newCounter;
      await writeTargets(env, targets);
      await logEvent(env, {
        ev: 'setcounterall',
        count: targets.length,
        to: newCounter,
      });
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `✅ شمارنده ${targets.length} مقصد روی ${newCounter} تنظیم شد.`,
        threadId ?? undefined
      );
      return;
    }

    // ─── /ping ───
    case '/ping': {
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `🏓 pong — ${new Date().toISOString()}`,
        threadId ?? undefined
      );
      return;
    }

    // ─── /debug ───
    case '/debug': {
      const lines = [];
      lines.push('🔍 *Debug*');
      lines.push('');
      lines.push('📍 Chat');
      lines.push(`  type: ${msg.chat.type}`);
      lines.push(`  is_topic_message: ${msg.is_topic_message ?? false}`);
      lines.push(`  thread: ${threadId ?? '—'}`);
      lines.push('');

      lines.push('⚙️ Env');
      lines.push(`  BOT_TOKEN: ${env.BOT_TOKEN ? '✅' : '❌ missing'}`);
      lines.push(
        `  DB_ENCRYPTION_KEY: ${env.DB_ENCRYPTION_KEY ? '✅' : '❌ missing'}`
      );
      lines.push(`  BOT_KV: ${env.BOT_KV ? '✅' : '❌ missing'}`);
      lines.push('');

      if (env.BOT_KV) {
        const targets = await readTargets(env);
        const label = makeAnonymizer(targets, msg.chat.id, threadId);

        lines.push(`🎯 Targets (${targets.length})`);
        if (!targets.length) {
          lines.push('  (none)');
        } else {
          targets.forEach((t, i) => {
            const mark = label(t.chatId, t.threadId) === 'you'
              ? ' ← (this chat)'
              : '';
            lines.push(`  chat ${i + 1} · counter=${t.counter}${mark}`);
          });
        }
        lines.push('');

        lines.push('💾 Pointer ["last_start"]');
        try {
          const rawPtr = await env.BOT_KV.get('last_start', {
            cacheTtl: KV_CACHE_TTL,
          });
          if (!rawPtr) {
            lines.push('  (empty)');
          } else {
            const p = decryptData(rawPtr, env.DB_ENCRYPTION_KEY);
            lines.push(`  chat: ${label(p.chatId, p.threadId)}`);
            lines.push(
              `  age: ${Math.round((Date.now() - p.at) / 1000)}s ago`
            );
          }
        } catch (e) {
          lines.push(`  ⚠️ pointer read failed: ${e.message}`);
        }
        lines.push('');

        lines.push('🎮 Game');
        try {
          const users = await listUsers(env);
          const total = users.reduce((s, u) => s + u.count, 0);
          const lords = users.filter((u) => u.lord).length;
          const indexIds = await readIndex(env);
          lines.push(`  players: ${users.length}`);
          lines.push(`  index: ${indexIds.length}`);
          lines.push(`  total: ${total}`);
          lines.push(`  lords: ${lords}`);
        } catch (e) {
          lines.push(`  ⚠️ game read failed: ${e.message}`);
        }
        lines.push('');

        lines.push('🔘 Button counter');
        try {
          const bt = await readBtnTotal(env);
          const bUsers = await listBtnUsers(env);
          const bLords = bUsers.filter((u) => u.lord).length;
          lines.push(`  total clicks: ${bt}`);
          lines.push(`  tappers: ${bUsers.length}`);
          lines.push(`  lords among tappers: ${bLords}`);
        } catch (e) {
          lines.push(`  ⚠️ read failed: ${e.message}`);
        }
        lines.push('');
      }

      lines.push('🤖 Bot');
      try {
        const me = await telegram(env.BOT_TOKEN, 'getMe');
        lines.push(`  @${me.result.username}`);
      } catch (e) {
        lines.push(`  ⚠️ getMe failed: ${e.message}`);
      }
      lines.push('');

      lines.push('🪝 Webhook');
      try {
        const info = await telegram(env.BOT_TOKEN, 'getWebhookInfo');
        const r = info.result || {};
        lines.push(`  url: ${r.url ? '✅ set' : '❌ (none)'}`);
        lines.push(`  pending: ${r.pending_update_count ?? 0}`);
        if (r.last_error_message) {
          lines.push(`  ⚠️ last_error: ${r.last_error_message}`);
        } else {
          lines.push('  last_error: (none) ✅');
        }
      } catch (e) {
        lines.push(`  ⚠️ getWebhookInfo failed: ${e.message}`);
      }
      lines.push('');

      lines.push('🔗 Direct link');
      lines.push(`  ${DIRECT_LINK}`);
      lines.push('');

      lines.push('⏰ Expected crons (UTC)');
      lines.push(`  ${CRON_MIDNIGHT}  → 00:00 Iran`);
      lines.push('');

      lines.push('📜 Recent events');
      try {
        const raw = await env.BOT_KV.get('telemetry', {
          cacheTtl: KV_CACHE_TTL,
        });
        let log = [];
        if (raw) {
          try {
            log = decryptData(raw, env.DB_ENCRYPTION_KEY);
            if (!Array.isArray(log)) log = [];
          } catch { log = []; }
        }
        if (log.length === 0) {
          lines.push('  (none)');
        } else {
          for (const e of log.slice(0, 10)) {
            const ts = e.t.replace('T', ' ').slice(0, 19);
            const parts = [ts, e.ev];
            if (e.cmd) parts.push(`cmd=${e.cmd}`);
            if (e.cron) parts.push(`cron=${e.cron}`);
            if (e.counter != null) parts.push(`counter=${e.counter}`);
            if (e.total != null) parts.push(`total=${e.total}`);
            if (e.sent != null) parts.push(`sent=${e.sent}`);
            if (e.failed != null) parts.push(`failed=${e.failed}`);
            if (e.reason) parts.push(`reason=${e.reason}`);
            if (e.msg) parts.push(`msg=${e.msg}`);
            if (e.len != null) parts.push(`len=${e.len}`);
            if (e.chatN != null) parts.push(`chatN=${e.chatN}`);
            if (e.from != null) parts.push(`from=${e.from}`);
            if (e.to != null) parts.push(`to=${e.to}`);
            if (e.count != null) parts.push(`count=${e.count}`);
            if (e.private != null) parts.push(`private=${e.private}`);
            if (e.username) parts.push(`user=@${e.username}`);
            if (e.user != null) parts.push(`userCount=${e.user}`);
            if (e.players != null) parts.push(`players=${e.players}`);
            if (e.lord != null) parts.push(`lord=${e.lord}`);
            lines.push(`  ${parts.join(' ')}`);
          }
        }
      } catch (e) {
        lines.push(`  ⚠️ telemetry read failed: ${e.message}`);
      }
      lines.push('');

      lines.push('ℹ️ Commands');
      lines.push('  /button /buttonlord /startgame /start /end /force-end /list /players /test /ping /debug');
      lines.push('  /editcounter <number>  (admin, reply to a bot msg)');
      lines.push('  /lord @username <text>  (admin)');
      lines.push('  /removelord @username  (admin)');
      lines.push('  /roozshomarmessage <text>  (admin)');
      lines.push('  /setcounter chat <N> <counter>  (admin)');
      lines.push('  /setcounterall <counter>  (admin)');

      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        lines.join('\n'),
        threadId ?? undefined
      );
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
      `Telegram sendMessage ${res.status}: ${
        data.description || JSON.stringify(data)
      }`
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
      `Telegram sendPhoto ${res.status}: ${
        data.description || JSON.stringify(data)
      }`
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
      `editMessageText ${res.status}: ${
        data.description || JSON.stringify(data)
      }`
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
      `editMessageCaption ${res.status}: ${
        data.description || JSON.stringify(data)
      }`
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
      `answerCallbackQuery ${res.status}: ${
        data.description || JSON.stringify(data)
      }`
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
