// ============================================================
// Telegram RSS Bot – KV-backed schedule + menu-based language
// + per-chat per-anime tag lists (add + remove)
// + profanity GIF replies (airing messages only, 6 random GIFs)
// + trigger words loaded from words.json
// + MAL Link rendered as a rich-message tg-button
// + RTL for Persian rich messages via is_rtl
// + rich-message URL extraction via unescaped full-payload search
// + highlighted anime name via <mark>
// + /schedule table with rich <input type="checkbox"> (date-accurate)
// + standalone web app at /app (+ /api/schedule, /api/anime)
// + anime detail modal (Alternative Titles + Information)
// + direct-link Mini App (BotFather Web App section) for groups
// + /debugreply diagnostic
// + FIX: use `url` button (not `web_app`) with t.me direct link
// + FIX: collapse batch-release duplicates (one row/message per anime)
//        with "تا" (FA) / "to" (EN) episode range wording
// + FIX: throttle + retry 429s during broadcast so simultaneous
//        airings all get delivered (no more lost messages)
// ============================================================

import PROFANITY_ANIMATIONS from './gifs.json';
import PROFANITY_KEYWORDS from './words.json';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const JIKAN_API = 'https://api.jikan.moe/v4';

const SCHEDULE_TZ = { fa: 'Asia/Tehran', en: 'UTC' };
const JST = 'Asia/Tokyo';

const WEEK_KV_KEY = 'sched:anilist:v5:week';
const WEEK_STALE_TTL_MS = 24 * 60 * 60 * 1000;
const TAG_TTL_SEC = 90 * 24 * 60 * 60;
const MAX_TAGS_PER_ANIME = 100;
const MAX_MENTIONS_SHOWN = 30;

// Minimum gap between two outgoing Telegram sends during broadcast.
// Keeps us well below both global (~30 msg/s) and per-chat (~1 msg/s)
// limits. If you have very large chat lists and hit the 30-min worker
// wall-time limit, lower this to 300.
const BROADCAST_GAP_MS = 500;
const BROADCAST_MAX_RETRIES = 4;

const WEBAPP_SHORT_NAME = 'schedule';

let SUBREQUEST_COUNT = 0;
let WORKER_ORIGIN = '';
let CACHED_BOT_USERNAME = null;
let CACHED_WEBAPP_LINK = null;

// ============= UTILITIES =============

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isPermanentSendError(desc) {
    return /blocked|chat not found|kicked|deactivated|bot was kicked/i.test(String(desc || ''));
}

// ============= SCHEDULE FROM KV =============

async function fetchScheduleWeek(env) {
    try {
        const raw = await env.RSS_BOT_KV.get(WEEK_KV_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed.week || {};
    } catch (e) {
        return {};
    }
}

function localMinutes(unixSec, tz) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(unixSec * 1000));
    let h = 0, m = 0;
    for (const p of parts) {
        if (p.type === 'hour') h = parseInt(p.value, 10) % 24;
        if (p.type === 'minute') m = parseInt(p.value, 10);
    }
    return h * 60 + m;
}

function getYmdForDay(tz, dayName) {
    const DAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const targetIdx = DAYS.indexOf(String(dayName).toLowerCase());
    if (targetIdx < 0) return null;

    const now = new Date();
    const todayName = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' })
        .format(now).toLowerCase();
    const todayIdx = DAYS.indexOf(todayName);
    if (todayIdx < 0) return null;

    let offset = targetIdx - todayIdx;
    if (offset < 0) offset += 7;

    const targetDate = new Date(now.getTime() + offset * 86400 * 1000);
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(targetDate);
}

function animeGroupKey(e) {
    if (!e) return null;
    if (e.anilist_id) return `anilist:${e.anilist_id}`;
    if (e.mal_id) return `mal:${e.mal_id}`;
    return `title:${e.title}`;
}

function collapseBatches(entries) {
    const byAnime = new Map();
    for (const e of entries) {
        const key = animeGroupKey(e);
        if (!byAnime.has(key)) byAnime.set(key, []);
        byAnime.get(key).push(e);
    }
    const grouped = [];
    for (const eps of byAnime.values()) {
        eps.sort((a, b) => (a.episode || 0) - (b.episode || 0));
        const first = { ...eps[0] };
        if (eps.length > 1) {
            const epNums = eps.map(x => x.episode).filter(Number.isFinite);
            first.batchEpisodes = {
                count: eps.length,
                min: epNums.length ? Math.min(...epNums) : null,
                max: epNums.length ? Math.max(...epNums) : null,
            };
        }
        grouped.push(first);
    }
    return grouped;
}

async function fetchScheduleForDay(env, dayKey, targetTz) {
    const week = await fetchScheduleWeek(env);
    if (!targetTz) return week[dayKey.toLowerCase()] || [];

    const targetYmd = getYmdForDay(targetTz, dayKey);
    if (!targetYmd) return [];

    const flat = [];
    for (const d of Object.keys(week)) flat.push(...week[d]);

    const out = [];
    for (const e of flat) {
        if (!e.airingAt) continue;
        const d = new Date(e.airingAt * 1000);
        const localYmd = new Intl.DateTimeFormat('en-CA', {
            timeZone: targetTz, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(d);
        if (localYmd === targetYmd) out.push(e);
    }

    out.sort((a, b) => {
        const ma = localMinutes(a.airingAt, targetTz);
        const mb = localMinutes(b.airingAt, targetTz);
        if (ma !== mb) return ma - mb;
        return a.airingAt - b.airingAt;
    });

    const grouped = collapseBatches(out);
    grouped.sort((a, b) => {
        const ma = localMinutes(a.airingAt, targetTz);
        const mb = localMinutes(b.airingAt, targetTz);
        if (ma !== mb) return ma - mb;
        return a.airingAt - b.airingAt;
    });
    return grouped;
}

// ============= TELEGRAM WEB APP LINK =============

async function getWebAppLink(env) {
    if (CACHED_WEBAPP_LINK) return CACHED_WEBAPP_LINK;

    if (!CACHED_BOT_USERNAME) {
        try {
            const res = await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/getMe`);
            const json = await res.json();
            if (json && json.ok && json.result && json.result.username) {
                CACHED_BOT_USERNAME = json.result.username;
            }
        } catch (e) {
            console.warn('[WEBAPP] getMe failed:', e.message);
        }
    }

    if (CACHED_BOT_USERNAME) {
        CACHED_WEBAPP_LINK = `https://t.me/${CACHED_BOT_USERNAME}/${WEBAPP_SHORT_NAME}`;
    } else {
        CACHED_WEBAPP_LINK = `${WORKER_ORIGIN}/app`;
    }

    return CACHED_WEBAPP_LINK;
}

// ============= BOTFATHER COMMAND READER =============

async function fetchBotFatherCommands(env, lang) {
    const payload = { scope: { type: 'default' } };
    if (lang === 'fa') payload.language_code = 'fa';
    try {
        const res = await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/getMyCommands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const json = await res.json();
        return Array.isArray(json.result) ? json.result : null;
    } catch (e) { return null; }
}

async function applyBotFatherCommandsToChat(env, chatId, lang) {
    const commands = await fetchBotFatherCommands(env, lang);
    if (!commands || commands.length === 0) return;
    try {
        await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/setMyCommands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commands, scope: { type: 'chat', chat_id: chatId } }),
        });
    } catch (e) {}
}

// ============= LANGUAGE VIA COMMAND MENU =============

const LANG_DETECT_CACHE = new Map();
const LANG_CACHE_TTL_MS = 5 * 60 * 1000;

function isPersianText(text) {
    return /[\u0600-\u06FF]/.test(String(text || ''));
}

async function getLang(env, chatId) {
    const key = String(chatId);
    const cached = LANG_DETECT_CACHE.get(key);
    if (cached && Date.now() - cached.ts < LANG_CACHE_TTL_MS) return cached.lang;
    try {
        const res = await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/getMyCommands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scope: { type: 'chat', chat_id: chatId } }),
        });
        const json = await res.json();
        const commands = Array.isArray(json.result) ? json.result : [];
        let lang = 'en';
        for (const c of commands) {
            if (isPersianText(c.description)) { lang = 'fa'; break; }
        }
        LANG_DETECT_CACHE.set(key, { lang, ts: Date.now() });
        return lang;
    } catch (e) { return 'en'; }
}

async function setLang(env, chatId, lang) {
    await applyBotFatherCommandsToChat(env, chatId, lang);
    LANG_DETECT_CACHE.set(String(chatId), { lang, ts: Date.now() });
}

// ============= ENCRYPTION =============
let ENCRYPTION_KEY = 'default-key-please-change-me';

function encryptData(data) {
    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    const keyBytes = new TextEncoder().encode(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32));
    const out = new Uint8Array(plaintext.length);
    for (let i = 0; i < plaintext.length; i++) out[i] = plaintext[i] ^ keyBytes[i % keyBytes.length];
    return btoa(String.fromCharCode(...out));
}

function decryptData(str) {
    const enc = Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
    const keyBytes = new TextEncoder().encode(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32));
    const out = new Uint8Array(enc.length);
    for (let i = 0; i < enc.length; i++) out[i] = enc[i] ^ keyBytes[i % keyBytes.length];
    return JSON.parse(new TextDecoder().decode(out));
}

// ============= BROADCAST CHAT LIST =============

async function getBroadcastChats(env) {
    const raw = await env.RSS_BOT_KV.get('broadcast_chats');
    if (!raw) return [];
    try { return decryptData(raw); } catch { return []; }
}
async function saveBroadcastChats(env, chats) {
    await env.RSS_BOT_KV.put('broadcast_chats', encryptData(chats));
}
async function addChatToBroadcast(env, chatId) {
    const chats = await getBroadcastChats(env);
    if (!chats.includes(chatId)) { chats.push(chatId); await saveBroadcastChats(env, chats); }
}
async function removeChatFromBroadcast(env, chatId) {
    const chats = await getBroadcastChats(env);
    const filtered = chats.filter((id) => id !== chatId);
    if (filtered.length !== chats.length) await saveBroadcastChats(env, filtered);
}

// ============= TAG LISTS (KV) =============

function animeKeyFromEntry(e) {
    if (!e) return null;
    if (e.mal_id) return `mal:${e.mal_id}`;
    if (e.anilist_id) return `anilist:${e.anilist_id}`;
    return null;
}

async function getTagList(env, chatId, animeKey) {
    const key = `tag:${chatId}:${animeKey}`;
    try {
        const raw = await env.RSS_BOT_KV.get(key);
        if (!raw) return [];
        return decryptData(raw);
    } catch { return []; }
}

async function saveTagList(env, chatId, animeKey, list) {
    const key = `tag:${chatId}:${animeKey}`;
    await env.RSS_BOT_KV.put(key, encryptData(list), { expirationTtl: TAG_TTL_SEC });
}

async function addTag(env, chatId, animeKey, user) {
    const list = await getTagList(env, chatId, animeKey);
    if (list.some((u) => u.userId === user.userId)) return { added: false, list, reason: 'duplicate' };
    if (list.length >= MAX_TAGS_PER_ANIME) return { added: false, list, reason: 'full' };
    list.push(user);
    await saveTagList(env, chatId, animeKey, list);
    return { added: true, list };
}

async function removeTag(env, chatId, animeKey, userId) {
    const list = await getTagList(env, chatId, animeKey);
    const filtered = list.filter((u) => u.userId !== userId);
    if (filtered.length === list.length) return { removed: false, list, reason: 'not-in-list' };
    await saveTagList(env, chatId, animeKey, filtered);
    return { removed: true, list: filtered };
}

function extractTitleFromAiringText(text) {
    if (!text) return null;
    const clean = String(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) return null;

    let m = clean.match(/(.+?)\s+Season\s+(\d+)\s*[-–]\s*Episode\s+\d+\s+Aired!/i);
    if (m) return { base: m[1].trim(), season: parseInt(m[2], 10) };

    m = clean.match(/(.+?)\s*[-–]\s*Episode\s+\d+\s+Aired!/i);
    if (m) return { base: m[1].trim(), season: null };

    m = clean.match(/قسمت\s+\d+\s+فصل\s+(\d+)\s+انیمه\s+(.+?)\s+اومد!/);
    if (m) return { base: m[2].trim(), season: parseInt(m[1], 10) };

    m = clean.match(/قسمت\s+\d+\s+انیمه\s+(.+?)\s+اومد!/);
    if (m) return { base: m[1].trim(), season: null };

    return null;
}

function normalizeTitleForMatch(s) {
    return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

async function findAnimeKeyByTitle(env, base, season) {
    const week = await fetchScheduleWeek(env);
    const all = [];
    for (const d of Object.keys(week)) all.push(...week[d]);
    const target = normalizeTitleForMatch(base);
    for (const e of all) {
        const parsed = parseAnimeTitle(e.title);
        if (normalizeTitleForMatch(parsed.base) !== target) continue;
        if (season != null && parsed.season !== season) continue;
        if (season == null && parsed.season != null) continue;
        return animeKeyFromEntry(e);
    }
    return null;
}

async function extractAnimeKeyFromMessage(msg, env) {
    if (!msg) return null;

    try {
        const blob = JSON.stringify(msg).replace(/\\\//g, '/');
        let m = blob.match(/myanimelist\.net\/anime\/(\d+)/);
        if (m) { console.log(`[KEY] payload: mal:${m[1]}`); return `mal:${m[1]}`; }
        m = blob.match(/anilist\.co\/anime\/(\d+)/);
        if (m) { console.log(`[KEY] payload: anilist:${m[1]}`); return `anilist:${m[1]}`; }
    } catch (e) {
        console.warn(`[KEY] payload stringify failed: ${e.message}`);
    }

    if (msg.reply_markup && Array.isArray(msg.reply_markup.inline_keyboard)) {
        for (const row of msg.reply_markup.inline_keyboard) {
            for (const btn of row) {
                if (btn.url) {
                    let m = btn.url.match(/myanimelist\.net\/anime\/(\d+)/);
                    if (m) return `mal:${m[1]}`;
                    m = btn.url.match(/anilist\.co\/anime\/(\d+)/);
                    if (m) return `anilist:${m[1]}`;
                }
            }
        }
    }

    if (Array.isArray(msg.entities)) {
        for (const ent of msg.entities) {
            if (ent.type === 'text_link' && ent.url) {
                let m = ent.url.match(/myanimelist\.net\/anime\/(\d+)/);
                if (m) return `mal:${m[1]}`;
                m = ent.url.match(/anilist\.co\/anime\/(\d+)/);
                if (m) return `anilist:${m[1]}`;
            }
        }
    }

    const text = msg.text || msg.caption || '';
    let m = text.match(/myanimelist\.net\/anime\/(\d+)/);
    if (m) return `mal:${m[1]}`;
    m = text.match(/anilist\.co\/anime\/(\d+)/);
    if (m) return `anilist:${m[1]}`;

    if (env) {
        const parsed = extractTitleFromAiringText(text);
        if (parsed) {
            const found = await findAnimeKeyByTitle(env, parsed.base, parsed.season);
            if (found) return found;
        }
    }

    return null;
}

function renderUserMention(u) {
    if (u.username) return `@${escapeHtml(u.username)}`;
    const name = escapeHtml(u.firstName || 'User');
    return `<a href="tg://user?id=${u.userId}">${name}</a>`;
}

function formatTagList(users, lang) {
    if (!users || users.length === 0) return '';
    const label = lang === 'fa' ? 'لیست تگ این انیمه:' : 'Tag list for this anime:';
    const shown = users.slice(0, MAX_MENTIONS_SHOWN);
    const lines = shown.map(renderUserMention);
    let out = `<b>${label}</b>\n${lines.join('\n')}`;
    if (users.length > MAX_MENTIONS_SHOWN) {
        const extra = users.length - MAX_MENTIONS_SHOWN;
        out += lang === 'fa' ? `\n<i>و ${extra} نفر دیگر…</i>` : `\n<i>and ${extra} more…</i>`;
    }
    return out;
}

async function handleTagReply(env, msg) {
    try {
        console.log(`[TAG] invoked for msg ${msg.message_id} in ${msg.chat.id}`);
        const chatId = msg.chat.id;
        const from = msg.from;
        const replied = msg.reply_to_message;

        if (!replied) { console.log(`[TAG] no reply_to_message`); return; }
        if (!replied.from || !replied.from.is_bot) { console.log(`[TAG] reply not from bot`); return; }

        const animeKey = await extractAnimeKeyFromMessage(replied, env);
        console.log(`[TAG] extracted animeKey: ${animeKey}`);
        if (!animeKey) {
            console.log(`[TAG] no anime key, bailing`);
            return;
        }

        const user = {
            userId: from.id,
            username: from.username || null,
            firstName: from.first_name || null,
        };

        const lang = await getLang(env, chatId);
        const result = await addTag(env, chatId, animeKey, user);
        console.log(`[TAG] addTag: added=${result.added} reason=${result.reason || '-'} size=${result.list.length}`);

        const mention = `<a href="tg://user?id=${from.id}">${escapeHtml(from.first_name || 'User')}</a>`;
        let reply;
        if (result.added) {
            reply = lang === 'fa'
                ? `✅ ${mention} به لیست تگ اضافه شد.\n\nاز این پس در پیام‌های این انیمه تگ می‌شوید (${result.list.length} نفر).`
                : `✅ ${mention} added to the tag list.\n\nYou will be tagged in this anime's future airings (${result.list.length} user(s)).`;
        } else if (result.reason === 'duplicate') {
            reply = lang === 'fa' ? 'ℹ️ شما قبلاً در لیست تگ این انیمه هستید.' : 'ℹ️ You are already in this anime\'s tag list.';
        } else {
            reply = lang === 'fa' ? '⚠️ لیست تگ این انیمه پر است.' : '⚠️ This anime\'s tag list is full.';
        }

        const sendRes = await sendMessage(env, chatId, reply, { reply_to_message_id: msg.message_id });
        console.log(`[TAG] sendMessage result: ${JSON.stringify(sendRes).slice(0, 200)}`);
    } catch (e) {
        console.error(`[TAG] EXCEPTION: ${e.message}`, e.stack);
    }
}

async function handleUntagReply(env, msg) {
    const chatId = msg.chat.id;
    const from = msg.from;
    const replied = msg.reply_to_message;
    if (!replied || !replied.from || !replied.from.is_bot) return;

    const animeKey = await extractAnimeKeyFromMessage(replied, env);
    if (!animeKey) {
        console.log(`[UNTAG] reply in ${chatId} had no anime key`);
        return;
    }

    const lang = await getLang(env, chatId);
    const result = await removeTag(env, chatId, animeKey, from.id);
    const mention = `<a href="tg://user?id=${from.id}">${escapeHtml(from.first_name || 'User')}</a>`;

    let reply;
    if (result.removed) {
        reply = lang === 'fa'
            ? `✅ ${mention} از لیست تگ حذف شد.\n\nاز این پس در پیام‌های این انیمه تگ نمی‌شوید (${result.list.length} نفر باقی مانده).`
            : `✅ ${mention} removed from the tag list.\n\nYou will no longer be tagged for this anime (${result.list.length} user(s) remaining).`;
    } else {
        reply = lang === 'fa' ? 'ℹ️ شما در لیست تگ این انیمه نیستید.' : 'ℹ️ You are not in this anime\'s tag list.';
    }

    await sendMessage(env, chatId, reply, { reply_to_message_id: msg.message_id });
}

// ============= PROFANITY GIF =============

const PROFANITY_BOUNDARY = '[\\s!؟?.,،;:…\\-()\\[\\]"\']';

function hasWholeWord(text, word) {
    const re = new RegExp(`(?:^|${PROFANITY_BOUNDARY})${word}(?=${PROFANITY_BOUNDARY}|$)`, 'u');
    return re.test(text);
}

function isProfanityReply(msg) {
    const raw = String(msg.text || '').trim();
    if (!raw) return false;
    const stripped = raw.replace(/[!؟?.,…\s]+$/g, '').trim();
    for (const w of PROFANITY_KEYWORDS) if (stripped === w) return true;
    if (raw.length <= 60) {
        for (const w of PROFANITY_KEYWORDS) if (hasWholeWord(raw, w)) return true;
    }
    return false;
}

async function looksLikeAiringMessage(env, msg) {
    if (!msg) return false;
    if (!msg.from || !msg.from.is_bot) return false;
    const key = await extractAnimeKeyFromMessage(msg, env);
    if (key) return true;
    const text = msg.text || msg.caption || '';
    if (/Aired!/.test(text)) return true;
    if (/اومد!/.test(text)) return true;
    return false;
}

async function handleProfanityReply(env, msg) {
    const chatId = msg.chat.id;
    const fileId = PROFANITY_ANIMATIONS[Math.floor(Math.random() * PROFANITY_ANIMATIONS.length)];
    const res = await sendAnimation(env, chatId, fileId, { reply_to_message_id: msg.message_id });
    console.log(`[GIF] result: ${JSON.stringify(res).slice(0, 200)}`);
}

// ============= /debugreply DIAGNOSTIC =============

async function handleDebugReply(env, msg) {
    const replied = msg.reply_to_message;
    if (!replied) {
        await sendMessage(env, msg.chat.id, '🐛 No reply_to_message present.');
        return;
    }

    const summary = {
        message_id: replied.message_id,
        from: replied.from ? { id: replied.from.id, is_bot: replied.from.is_bot } : null,
        has_text: !!replied.text,
        entities: Array.isArray(replied.entities) ? replied.entities.length : null,
        reply_markup: replied.reply_markup ? 'yes' : null,
        rich_message_blob: replied.rich_message
            ? JSON.stringify(replied.rich_message).slice(0, 1500)
            : null,
        extra_keys: Object.keys(replied).filter((k) =>
            ['text', 'caption', 'entities', 'caption_entities', 'reply_markup', 'from', 'message_id'].indexOf(k) === -1
        ),
    };

    const jsonStr = JSON.stringify(summary, null, 2);
    const chunks = [];
    let remaining = jsonStr;
    while (remaining.length > 3500) {
        chunks.push(remaining.slice(0, 3500));
        remaining = remaining.slice(3500);
    }
    chunks.push(remaining);

    for (let i = 0; i < chunks.length; i++) {
        const header = chunks.length > 1 ? `🐛 <b>Debug Reply (${i + 1}/${chunks.length})</b>\n` : `🐛 <b>Debug Reply</b>\n`;
        await sendMessage(env, msg.chat.id, header + `<pre>${escapeHtml(chunks[i])}</pre>`);
    }
}

// ============= TITLE PARSING =============

function parseAnimeTitle(title) {
    let m = title.match(/^(.*?)\s+Season\s+(\d+)$/i);
    if (m) return { base: m[1].trim(), season: parseInt(m[2], 10) };
    m = title.match(/^(.*?)\s+(\d+)(?:st|nd|rd|th)\s+Season$/i);
    if (m) return { base: m[1].trim(), season: parseInt(m[2], 10) };
    m = title.match(/^(.*?)\s+(II|III|IV|V|VI|VII|VIII|IX|X)$/i);
    if (m) {
        const rm = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
        const s = rm[m[2].toLowerCase()];
        if (s) return { base: m[1].trim(), season: s };
    }
    return { base: title, season: null };
}

// ============= FORMATTING =============

function formatAiringMessage(title, epNum, totalEps, malLink, lang, prefix = '', batch = null) {
    const { base, season } = parseAnimeTitle(title);
    const isFa = lang === 'fa';
    const nameHtml = `<mark><b>${base}</b></mark>`;

    let body;
    if (batch) {
        const range = isFa ? `${batch.min} تا ${batch.max}` : `${batch.min} to ${batch.max}`;
        if (season) {
            body = isFa
                ? `قسمت‌های ${range} فصل ${season} انیمه ${nameHtml} اومد!`
                : `${nameHtml} Season ${season} - Episodes ${range} Aired!`;
        } else {
            body = isFa
                ? `قسمت‌های ${range} انیمه ${nameHtml} اومد!`
                : `${nameHtml} - Episodes ${range} Aired!`;
        }
        if (totalEps && batch.max >= totalEps) body += isFa ? ' (پایان)' : ' (end)';
    } else {
        if (season) {
            body = isFa
                ? `قسمت ${epNum} فصل ${season} انیمه ${nameHtml} اومد!`
                : `${nameHtml} Season ${season} - Episode ${epNum} Aired!`;
        } else {
            body = isFa
                ? `قسمت ${epNum} انیمه ${nameHtml} اومد!`
                : `${nameHtml} - Episode ${epNum} Aired!`;
        }
        if (totalEps && epNum >= totalEps) body += isFa ? ' (پایان)' : ' (end)';
    }

    const counterLabel = isFa ? 'تعداد قسمت‌ها' : 'Episode Count';
    const shown = batch ? batch.max : epNum;
    const counter = totalEps ? `${counterLabel}: ${shown}/${totalEps}` : `${counterLabel}: ${shown}/?`;

    let buttonHtml = '';
    if (malLink) {
        const url = String(malLink);
        let label;
        if (url.includes('myanimelist.net')) label = isFa ? 'لینک MAL' : 'MAL Link';
        else if (url.includes('anilist.co')) label = isFa ? 'لینک AniList' : 'AniList Link';
        else label = isFa ? 'لینک' : 'Link';
        buttonHtml = `<p><tg-button url="${url}">${label}</tg-button></p>`;
    }

    const prefixHtml = prefix ? `<p><b>${prefix}</b></p>` : '';
    return `${prefixHtml}<p>${body}</p><p>${counter}</p>${buttonHtml}`;
}

function formatAiringMessagePlain(title, epNum, totalEps, malLink, lang, prefix = '', batch = null) {
    const { base, season } = parseAnimeTitle(title);
    const pre = prefix ? `<b>${prefix}</b>\n` : '';
    const nameHtml = `<mark><b>${base}</b></mark>`;
    const isFa = lang === 'fa';

    let body;
    if (batch) {
        const range = isFa ? `${batch.min} تا ${batch.max}` : `${batch.min} to ${batch.max}`;
        if (season) {
            body = isFa
                ? `قسمت‌های ${range} فصل ${season} انیمه ${nameHtml} اومد!`
                : `${nameHtml} Season ${season} - Episodes ${range} Aired!`;
        } else {
            body = isFa
                ? `قسمت‌های ${range} انیمه ${nameHtml} اومد!`
                : `${nameHtml} - Episodes ${range} Aired!`;
        }
        if (totalEps && batch.max >= totalEps) body += isFa ? ' (پایان)' : ' (end)';
    } else {
        if (season) {
            body = isFa
                ? `قسمت ${epNum} فصل ${season} انیمه ${nameHtml} اومد!`
                : `${nameHtml} Season ${season} - Episode ${epNum} Aired!`;
        } else {
            body = isFa
                ? `قسمت ${epNum} انیمه ${nameHtml} اومد!`
                : `${nameHtml} - Episode ${epNum} Aired!`;
        }
        if (totalEps && epNum >= totalEps) body += isFa ? ' (پایان)' : ' (end)';
    }

    const counterLabel = isFa ? 'تعداد قسمت‌ها' : 'Episode Count';
    const shown = batch ? batch.max : epNum;
    body += `\n\n${counterLabel}: ${totalEps ? `${shown}/${totalEps}` : `${shown}/?`}`;

    if (malLink) {
        const url = String(malLink);
        let label;
        if (url.includes('myanimelist.net')) label = isFa ? 'لینک MAL' : 'MAL Link';
        else if (url.includes('anilist.co')) label = isFa ? 'لینک AniList' : 'AniList Link';
        else label = isFa ? 'لینک' : 'Link';
        body += `\n\n<a href="${url}">${label}</a>`;
    }

    return pre + body;
}

function convertToTz(unixSec, targetTz) {
    try {
        return new Intl.DateTimeFormat('en-GB', {
            timeZone: targetTz, hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(new Date(unixSec * 1000));
    } catch { return '--:--'; }
}

// ============= ANIME DETAIL (Jikan + MAL page fallback) =============

const ANIME_DETAIL_CACHE = new Map();
const ANIME_DETAIL_TTL_MS = 60 * 60 * 1000;

function stripTags(s) {
    return String(s || '')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+,\s*/g, ', ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractMalLabel(html, label) {
    const re = new RegExp(
        '<span class="dark_text">\\s*' + label + ':\\s*</span>([\\s\\S]*?)' +
        '(?=<span class="dark_text">|<\\/div>)',
        'i'
    );
    const m = html.match(re);
    if (!m) return null;
    const cleaned = stripTags(m[1]);
    return cleaned || null;
}

function parseMalHtml(html, malId) {
    const synonymsRaw = extractMalLabel(html, 'Synonyms');
    const synonyms = synonymsRaw
        ? synonymsRaw.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean)
        : [];

    const alt = {
        japanese: extractMalLabel(html, 'Japanese'),
        english: extractMalLabel(html, 'English'),
        synonyms,
    };

    const info = {
        type: extractMalLabel(html, 'Type'),
        episodes: extractMalLabel(html, 'Episodes'),
        status: extractMalLabel(html, 'Status'),
        aired: extractMalLabel(html, 'Aired'),
        producers: extractMalLabel(html, 'Producers'),
        licensors: extractMalLabel(html, 'Licensors'),
        studios: extractMalLabel(html, 'Studios'),
        source: extractMalLabel(html, 'Source'),
        genres: extractMalLabel(html, 'Genres'),
        duration: extractMalLabel(html, 'Duration'),
        rating: extractMalLabel(html, 'Rating'),
    };

    const hasAny = alt.japanese || alt.english || info.type || info.episodes;
    if (!hasAny) return null;

    return {
        id: malId,
        url: `https://myanimelist.net/anime/${malId}`,
        alternativeTitles: alt,
        information: info,
    };
}

function joinEntityNames(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return 'None found';
    const names = arr
        .map((x) => (typeof x === 'string' ? x : x && x.name))
        .filter(Boolean);
    return names.length ? names.join(', ') : 'None found';
}

function normalizeJikanAnime(a) {
    return {
        id: a.mal_id,
        url: a.url || `https://myanimelist.net/anime/${a.mal_id}`,
        alternativeTitles: {
            japanese: a.title_japanese || null,
            english: a.title_english || null,
            synonyms: Array.isArray(a.title_synonyms) ? a.title_synonyms : [],
        },
        information: {
            type: a.type || null,
            episodes: a.episodes != null ? String(a.episodes) : null,
            status: a.status || null,
            aired: (a.aired && a.aired.string) || null,
            producers: joinEntityNames(a.producers),
            licensors: joinEntityNames(a.licensors),
            studios: joinEntityNames(a.studios),
            source: a.source || null,
            genres: joinEntityNames(a.genres),
            duration: a.duration || null,
            rating: a.rating || null,
        },
    };
}

async function fetchAnimeFromJikan(malId, attempt = 1) {
    try {
        const res = await fetch(`${JIKAN_API}/anime/${malId}`, {
            headers: {
                Accept: 'application/json',
                'User-Agent': 'SubsPleaseTelegramBot/1.0 (+https://workers.dev)',
            },
        });
        if (res.status === 429 && attempt < 3) {
            await new Promise((r) => setTimeout(r, 1500 * attempt));
            return fetchAnimeFromJikan(malId, attempt + 1);
        }
        if (!res.ok) return null;
        const json = await res.json();
        if (!json || !json.data) return null;
        return normalizeJikanAnime(json.data);
    } catch (e) {
        console.warn('[ANIME] Jikan error:', e.message);
        return null;
    }
}

async function fetchAnimeFromMalPage(malId) {
    try {
        const res = await fetch(`https://myanimelist.net/anime/${malId}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
        });
        if (!res.ok) return null;
        const html = await res.text();
        return parseMalHtml(html, malId);
    } catch (e) {
        console.warn('[ANIME] MAL scrape error:', e.message);
        return null;
    }
}

async function fetchAnimeDetails(env, malId) {
    const key = String(malId);
    const hit = ANIME_DETAIL_CACHE.get(key);
    if (hit && Date.now() - hit.ts < ANIME_DETAIL_TTL_MS) {
        return hit.data;
    }

    const fromJikan = await fetchAnimeFromJikan(malId);
    if (fromJikan) {
        ANIME_DETAIL_CACHE.set(key, { ts: Date.now(), data: fromJikan });
        return fromJikan;
    }

    const fromHtml = await fetchAnimeFromMalPage(malId);
    if (fromHtml) {
        ANIME_DETAIL_CACHE.set(key, { ts: Date.now(), data: fromHtml });
        return fromHtml;
    }

    return null;
}

async function handleApiAnime(env, request) {
    const url = new URL(request.url);
    const idRaw = url.searchParams.get('id');
    const malId = parseInt(idRaw, 10);

    if (!malId || malId < 1 || malId > 99999999) {
        return new Response(JSON.stringify({ error: 'invalid id' }), {
            status: 400,
            headers: { 'content-type': 'application/json; charset=utf-8' },
        });
    }

    const details = await fetchAnimeDetails(env, malId);
    if (!details) {
        return new Response(JSON.stringify({ error: 'not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json; charset=utf-8' },
        });
    }

    return new Response(JSON.stringify(details), {
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'public, max-age=3600',
            'access-control-allow-origin': '*',
        },
    });
}

// ============= WEB APP =============

function getScheduleAppHtml() {
    return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0f1220">
<title>Anime Schedule</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#0f1220;--card:#171b2e;--fg:#e8ebf5;--muted:#9aa3bd;--accent:#6c8cff;--line:#252a42;--ok:#3ddc97}
@media (prefers-color-scheme: light){:root{--bg:#f4f6fb;--card:#fff;--fg:#14172a;--muted:#5b6380;--accent:#3b5bdb;--line:#e3e7f2;--ok:#0f9d63}}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font-family:Vazirmatn,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
html[lang="en"] body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:880px;margin:0 auto;padding:20px 16px 44px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;flex-wrap:wrap}
h1{font-size:1.35rem;margin:0;font-weight:700}
.lang{display:flex;gap:4px;background:var(--card);padding:4px;border-radius:10px;border:1px solid var(--line)}
.lang button{border:0;background:transparent;color:var(--muted);padding:6px 12px;border-radius:8px;cursor:pointer;font:inherit;font-weight:600}
.lang button.on{background:var(--accent);color:#fff}
.tabs{display:flex;gap:8px;overflow-x:auto;padding-bottom:8px;margin-bottom:14px}
.tabs button{white-space:nowrap;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:8px 14px;border-radius:999px;cursor:pointer;font:inherit;font-weight:600;font-size:.92rem}
.tabs button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
table{width:100%;border-collapse:collapse}
th,td{padding:12px 14px;text-align:start;border-bottom:1px solid var(--line);font-size:.95rem}
th{font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:700}
tr:last-child td{border-bottom:0}
td.time{width:92px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
td.title{font-weight:600}
td.title a{color:inherit;text-decoration:none}
td.title a:hover{text-decoration:underline}
input[type=checkbox]{accent-color:var(--ok);transform:translateY(1px);margin-inline-end:6px}
.title-link{border:0;background:transparent;color:inherit;font:inherit;font-weight:600;padding:0;cursor:pointer;text-align:start}
.title-link:hover{text-decoration:underline}
.empty,.loading{padding:30px;text-align:center;color:var(--muted)}
footer{margin-top:14px;text-align:center;color:var(--muted);font-size:.78rem}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px;z-index:50;backdrop-filter:blur(2px)}
.modal[hidden]{display:none}
.modal-card{background:var(--card);border:1px solid var(--line);border-radius:16px;max-width:640px;width:100%;max-height:85vh;overflow:auto;padding:22px 22px 20px;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.35)}
.modal-close{position:absolute;top:8px;inset-inline-end:10px;border:0;background:transparent;color:var(--muted);font-size:1.6rem;line-height:1;cursor:pointer;padding:4px 8px;border-radius:8px}
.modal-close:hover{background:var(--line);color:var(--fg)}
.modal h3{margin:0 22px 4px 0;font-size:1.12rem;font-weight:700;line-height:1.35}
.detail-section{margin-top:18px}
.detail-section h4{margin:0 0 8px;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700}
.detail-row{display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--line);font-size:.93rem;line-height:1.4}
.detail-row:last-child{border-bottom:0}
.detail-row .k{min-width:96px;color:var(--muted);font-weight:600;flex-shrink:0}
.detail-row .v{flex:1;word-break:break-word}
.mal-open{display:inline-block;margin-top:16px;color:var(--accent);font-weight:600;text-decoration:none}
.mal-open:hover{text-decoration:underline}
@media(max-width:520px){h1{font-size:1.15rem}th,td{padding:10px 10px}td.time{width:74px}.detail-row .k{min-width:80px}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1 id="hTitle">📅 برنامه انیمه‌ها</h1>
    <div class="lang">
      <button id="btnFa" type="button">فارسی</button>
      <button id="btnEn" type="button">English</button>
    </div>
  </header>
  <nav class="tabs" id="tabs"></nav>
  <main id="content"><div class="loading">…</div></main>
  <footer><span id="updated"></span></footer>
</div>

<div class="modal" id="modal" hidden>
  <div class="modal-card" role="dialog" aria-modal="true">
    <button class="modal-close" id="modalClose" type="button" aria-label="Close">×</button>
    <div id="modalBody"></div>
  </div>
</div>

<script>
(function(){
  var $=function(id){return document.getElementById(id);};
  var DAYS_EN=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  var DAYS_FA_ORDER=['Saturday','Sunday','Monday','Tuesday','Wednesday','Thursday','Friday'];
  var LABELS_EN={Monday:'Mon',Tuesday:'Tue',Wednesday:'Wed',Thursday:'Thu',Friday:'Fri',Saturday:'Sat',Sunday:'Sun'};
  var LABELS_FA={Monday:'دوشنبه',Tuesday:'سه‌شنبه',Wednesday:'چهارشنبه',Thursday:'پنجشنبه',Friday:'جمعه',Saturday:'شنبه',Sunday:'یکشنبه'};
  var DETAIL_LABELS={
    fa:{alt:'عناوین جایگزین',info:'اطلاعات',japanese:'ژاپنی',english:'انگلیسی',synonyms:'مترادف‌ها',type:'نوع',episodes:'تعداد قسمت',status:'وضعیت',aired:'پخش',producers:'تهیه‌کننده',licensors:'دارنده مجوز',studios:'استودیو',source:'منبع',genres:'ژانرها',duration:'مدت',rating:'رده‌بندی',openMal:'باز کردن در MAL ↗',loading:'در حال بارگذاری…',error:'خطا در دریافت اطلاعات',empty:'—',na:'در دسترس نیست'},
    en:{alt:'Alternative Titles',info:'Information',japanese:'Japanese',english:'English',synonyms:'Synonyms',type:'Type',episodes:'Episodes',status:'Status',aired:'Aired',producers:'Producers',licensors:'Licensors',studios:'Studios',source:'Source',genres:'Genres',duration:'Duration',rating:'Rating',openMal:'Open on MAL ↗',loading:'Loading…',error:'Failed to load details',empty:'—',na:'Not available'}
  };
  var state={lang:'fa',day:null};
  try{var s=localStorage.getItem('schedLang');if(s==='fa'||s==='en')state.lang=s;}catch(e){}
  function tz(){return state.lang==='fa'?'Asia/Tehran':'UTC';}
  function order(){return state.lang==='fa'?DAYS_FA_ORDER:DAYS_EN;}
  function label(d){return state.lang==='fa'?LABELS_FA[d]:LABELS_EN[d];}
  function currentDay(){
    var n=new Intl.DateTimeFormat('en-US',{timeZone:tz(),weekday:'long'}).format(new Date());
    return DAYS_EN.indexOf(n)>=0?n:'Saturday';
  }
  function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function dl(){return DETAIL_LABELS[state.lang];}

  function renderTabs(){
    var nav=$('tabs');nav.innerHTML='';
    order().forEach(function(d){
      var b=document.createElement('button');
      b.type='button';b.textContent=label(d);
      if(d===state.day)b.className='on';
      b.onclick=function(){state.day=d;renderTabs();load();};
      nav.appendChild(b);
    });
  }

  function load(){
    var content=$('content');
    content.innerHTML='<div class="loading">…</div>';
    var url='/api/schedule?day='+encodeURIComponent(state.day)+'&tz='+encodeURIComponent(tz());
    fetch(url,{cache:'no-store'}).then(function(r){return r.json();}).then(function(data){
      render(data);
      var lang=state.lang==='fa'?'fa-IR':'en-GB';
      $('updated').textContent=(state.lang==='fa'?'آخرین بروزرسانی: ':'Updated: ')+new Date().toLocaleTimeString(lang);
    }).catch(function(){
      content.innerHTML='<div class="card"><div class="empty">'+(state.lang==='fa'?'خطا در دریافت برنامه':'Failed to load schedule')+'</div></div>';
    });
  }

  function render(data){
    var content=$('content');
    var entries=(data&&data.entries)?data.entries:[];
    if(!entries.length){
      content.innerHTML='<div class="card"><div class="empty">'+(state.lang==='fa'?'هیچ انتشار برنامه‌ریزی‌شده‌ای وجود ندارد.':'No releases scheduled.')+'</div></div>';
      return;
    }
    var html='<div class="card"><table><thead><tr><th>'+(state.lang==='fa'?'ساعت':'Time')+'</th><th>'+(state.lang==='fa'?'انیمه':'Show')+'</th></tr></thead><tbody>';
    entries.forEach(function(e){
      var suffix='';
      if(e.batchEpisodes&&e.batchEpisodes.count>1){
        var b=e.batchEpisodes;
        var range=state.lang==='fa'?(b.min+' تا '+b.max):(b.min+' to '+b.max);
        suffix=state.lang==='fa'?(' (قسمت '+range+'، پخش یک‌جا)'):(' (eps '+range+', batch)');
      }
      html+='<tr><td class="time">'+esc(e.time)+'</td><td class="title">';
      html+='<input type="checkbox" disabled '+(e.aired?'checked':'')+'>';
      if(e.malId){
        html+='<button type="button" class="title-link" data-mal-id="'+esc(e.malId)+'" data-title="'+esc(e.title)+'">'+esc(e.title)+'</button>';
      }else if(e.url){
        html+='<a href="'+esc(e.url)+'" target="_blank" rel="noopener">'+esc(e.title)+'</a>';
      }else{
        html+=esc(e.title);
      }
      html+=esc(suffix);
      html+='</td></tr>';
    });
    html+='</tbody></table></div>';
    content.innerHTML=html;
  }

  function openModal(){
    $('modal').hidden=false;
    document.body.style.overflow='hidden';
  }
  function closeModal(){
    $('modal').hidden=true;
    $('modalBody').innerHTML='';
    document.body.style.overflow='';
  }

  function openAnime(malId, fallbackTitle){
    var body=$('modalBody');
    var l=dl();
    body.innerHTML='<h3>'+esc(fallbackTitle||'')+'</h3><div class="loading">'+esc(l.loading)+'</div>';
    openModal();

    fetch('/api/anime?id='+encodeURIComponent(malId),{cache:'no-store'})
      .then(function(r){
        if(!r.ok) throw new Error('HTTP '+r.status);
        return r.json();
      })
      .then(function(d){
        if(!d||!d.alternativeTitles) throw new Error('no data');
        renderDetail(d, fallbackTitle);
      })
      .catch(function(){
        body.innerHTML='<h3>'+esc(fallbackTitle||'')+'</h3><div class="empty">'+esc(l.error)+'</div>';
      });
  }

  function row(k,v){
    var l=dl();
    var val=(v==null||v==='')?l.na:v;
    return '<div class="detail-row"><span class="k">'+esc(k)+'</span><span class="v">'+esc(val)+'</span></div>';
  }

  function renderDetail(d, fallbackTitle){
    var l=dl();
    var alt=d.alternativeTitles||{};
    var info=d.information||{};
    var syn=(alt.synonyms&&alt.synonyms.length)?alt.synonyms.join(', '):null;
    var title=fallbackTitle||alt.english||alt.japanese||'Anime';

    var h='<h3>'+esc(title)+'</h3>';

    h+='<div class="detail-section"><h4>'+esc(l.alt)+'</h4>';
    h+=row(l.japanese, alt.japanese);
    h+=row(l.english, alt.english);
    h+=row(l.synonyms, syn);
    h+='</div>';

    h+='<div class="detail-section"><h4>'+esc(l.info)+'</h4>';
    h+=row(l.type, info.type);
    h+=row(l.episodes, info.episodes);
    h+=row(l.status, info.status);
    h+=row(l.aired, info.aired);
    h+=row(l.producers, info.producers);
    h+=row(l.licensors, info.licensors);
    h+=row(l.studios, info.studios);
    h+=row(l.source, info.source);
    h+=row(l.genres, info.genres);
    h+=row(l.duration, info.duration);
    h+=row(l.rating, info.rating);
    h+='</div>';

    if(d.url){
      h+='<div><a class="mal-open" href="'+esc(d.url)+'" target="_blank" rel="noopener">'+esc(l.openMal)+'</a></div>';
    }

    $('modalBody').innerHTML=h;
  }

  $('content').addEventListener('click',function(ev){
    var btn=ev.target.closest('.title-link');
    if(!btn) return;
    openAnime(btn.getAttribute('data-mal-id'), btn.getAttribute('data-title'));
  });

  $('modalClose').onclick=closeModal;
  $('modal').addEventListener('click',function(e){ if(e.target===$('modal')) closeModal(); });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape' && !$('modal').hidden) closeModal(); });

  function setLang(l){
    state.lang=l;
    try{localStorage.setItem('schedLang',l);}catch(e){}
    document.documentElement.lang=l;
    document.documentElement.dir=(l==='fa')?'rtl':'ltr';
    $('hTitle').textContent=(l==='fa')?'📅 برنامه انیمه‌ها':'📅 Anime Schedule';
    $('btnFa').className=(l==='fa')?'on':'';
    $('btnEn').className=(l==='en')?'on':'';
    state.day=currentDay();
    renderTabs();
    load();
  }

  $('btnFa').onclick=function(){setLang('fa');};
  $('btnEn').onclick=function(){setLang('en');};
  setLang(state.lang);
  setInterval(function(){load();},60000);
  document.addEventListener('visibilitychange',function(){if(!document.hidden)load();});
})();
</script>
</body>
</html>`;
}

async function handleScheduleApp(env) {
    return new Response(getScheduleAppHtml(), {
        headers: {
            'content-type': 'text/html; charset=UTF-8',
            'cache-control': 'no-store',
        },
    });
}

async function handleApiSchedule(env, request) {
    const url = new URL(request.url);
    const day = url.searchParams.get('day') || 'Monday';
    const tz = url.searchParams.get('tz') || 'UTC';

    const allowedTz = ['UTC', 'Asia/Tehran'];
    const safeTz = allowedTz.indexOf(tz) >= 0 ? tz : 'UTC';

    const entries = await fetchScheduleForDay(env, day, safeTz);
    const nowUnix = Math.floor(Date.now() / 1000);

    const data = entries.map((e) => ({
        title: e.title,
        airingAt: e.airingAt,
        time: convertToTz(e.airingAt, safeTz),
        aired: e.airingAt <= nowUnix,
        malId: e.mal_id || null,
        anilistId: e.anilist_id || null,
        url: e.url || null,
        batchEpisodes: e.batchEpisodes || null,
    }));

    return new Response(JSON.stringify({ day, tz: safeTz, entries: data }), {
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
        },
    });
}

// ============= TELEGRAM API =============

async function sendMessage(env, chatId, text, extra = {}) {
    const res = await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }),
    });
    try { return await res.json(); } catch { return { ok: res.ok }; }
}

async function sendRichMessage(env, chatId, html, extra = {}) {
    const { is_rtl, ...rest } = extra;
    const richMessage = { html };
    if (is_rtl) richMessage.is_rtl = true;
    const res = await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/sendRichMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, rich_message: richMessage, ...rest }),
    });
    try { return await res.json(); } catch { return { ok: res.ok }; }
}

async function sendAiringMessage(env, chatId, title, epNum, totalEps, malLink, lang, prefix = '', batch = null) {
    const richHtml = formatAiringMessage(title, epNum, totalEps, malLink, lang, prefix, batch);
    const richRes = await sendRichMessage(env, chatId, richHtml, { is_rtl: lang === 'fa' });
    if (richRes && richRes.ok) return richRes;
    console.warn('[AIRING] rich failed, plain fallback');
    const plain = formatAiringMessagePlain(title, epNum, totalEps, malLink, lang, prefix, batch);
    return await sendMessage(env, chatId, plain);
}

// ── Rate-limit-aware wrappers (broadcast context only) ──
//
// On 429 we honour Telegram's `retry_after` and try again. On other
// transient errors we back off exponentially. On permanent errors
// (blocked / kicked / deactivated) we give up immediately so the
// caller can prune the chat list.
async function sendAiringWithRetry(env, chatId, title, epNum, totalEps, url, lang, batch) {
    let res = null;
    for (let attempt = 1; attempt <= BROADCAST_MAX_RETRIES; attempt++) {
        res = await sendAiringMessage(env, chatId, title, epNum, totalEps, url, lang, '', batch);
        if (res && res.ok) return res;

        const desc = (res && res.description) || '';
        if (isPermanentSendError(desc)) return res;

        const retryAfter = res && res.parameters && res.parameters.retry_after;
        if (attempt < BROADCAST_MAX_RETRIES) {
            const waitMs = retryAfter ? (retryAfter + 1) * 1000 : 800 * attempt;
            console.warn(`[BROADCAST] sendAiring retry ${attempt}/${BROADCAST_MAX_RETRIES} for chat ${chatId} in ${waitMs}ms — ${desc}`);
            await sleep(waitMs);
        }
    }
    return res;
}

async function sendMessageWithRetry(env, chatId, text, extra = {}) {
    let res = null;
    for (let attempt = 1; attempt <= BROADCAST_MAX_RETRIES; attempt++) {
        res = await sendMessage(env, chatId, text, extra);
        if (res && res.ok) return res;

        const desc = (res && res.description) || '';
        if (isPermanentSendError(desc)) return res;

        const retryAfter = res && res.parameters && res.parameters.retry_after;
        if (attempt < BROADCAST_MAX_RETRIES) {
            const waitMs = retryAfter ? (retryAfter + 1) * 1000 : 800 * attempt;
            console.warn(`[BROADCAST] sendMessage retry ${attempt}/${BROADCAST_MAX_RETRIES} for chat ${chatId} in ${waitMs}ms — ${desc}`);
            await sleep(waitMs);
        }
    }
    return res;
}

async function sendAnimation(env, chatId, fileId, extra = {}) {
    const res = await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/sendAnimation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, animation: fileId, ...extra }),
    });
    try { return await res.json(); } catch { return { ok: res.ok }; }
}

async function editMessage(env, chatId, messageId, text, extra = {}) {
    const res = await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }),
    });
    try { return await res.json(); } catch { return { ok: res.ok }; }
}

async function editRichMessage(env, chatId, messageId, html, extra = {}) {
    const { is_rtl, ...rest } = extra;
    const richMessage = { html };
    if (is_rtl) richMessage.is_rtl = true;
    const res = await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, rich_message: richMessage, ...rest }),
    });
    try { return await res.json(); } catch { return { ok: res.ok }; }
}

async function answerCallback(env, callbackQueryId) {
    return fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
}

// ============= AIRING POLLER =============

async function broadcastLatest(env) {
    const week = await fetchScheduleWeek(env);
    const total = Object.values(week).reduce((s, l) => s + l.length, 0);
    if (total === 0) return;

    const nowUnix = Math.floor(Date.now() / 1000);
    const windowStart = nowUnix - 25 * 60;
    const windowEnd = nowUnix + 60;

    const candidates = [];
    for (const d of Object.keys(week)) {
        for (const e of week[d]) {
            if (e.airingAt && e.airingAt >= windowStart && e.airingAt <= windowEnd) candidates.push(e);
        }
    }
    if (candidates.length === 0) return;

    const toSend = collapseBatches(candidates);

    const chats = await getBroadcastChats(env);
    if (chats.length === 0) return;

    console.log(`[BROADCAST] processing ${toSend.length} airing(s) × ${chats.length} chat(s) with ${BROADCAST_GAP_MS}ms gap`);

    for (const e of toSend) {
        try {
            const epKey = e.batchEpisodes && e.batchEpisodes.max != null
                ? e.batchEpisodes.max
                : e.episode;

            const stateKey = `aired:anilist:${e.anilist_id || e.mal_id || e.title}`;
            const stored = await env.RSS_BOT_KV.get(stateKey);
            if (stored === String(epKey)) continue;

            const animeKey = animeKeyFromEntry(e);
            let anyTransientFailure = false;

            for (const chatId of chats) {
                try {
                    const lang = await getLang(env, chatId);

                    // Airing message (throttled + retry on 429)
                    const res = await sendAiringWithRetry(
                        env, chatId, e.title, epKey, e.episodes, e.url, lang, e.batchEpisodes || null
                    );
                    SUBREQUEST_COUNT++;

                    if (res && res.ok === false) {
                        const desc = res.description || '';
                        if (isPermanentSendError(desc)) {
                            await removeChatFromBroadcast(env, chatId);
                        } else {
                            anyTransientFailure = true;
                            console.warn(`[BROADCAST] airing send failed chat=${chatId} title="${e.title}": ${desc}`);
                        }
                    }

                    // Space out the next Telegram call.
                    await sleep(BROADCAST_GAP_MS);

                    // Tag block (throttled + retry on 429)
                    if (animeKey) {
                        const tagList = await getTagList(env, chatId, animeKey);
                        if (tagList.length > 0) {
                            const tagRes = await sendMessageWithRetry(env, chatId, formatTagList(tagList, lang));
                            SUBREQUEST_COUNT++;
                            if (tagRes && tagRes.ok === false) {
                                const desc = tagRes.description || '';
                                if (isPermanentSendError(desc)) {
                                    await removeChatFromBroadcast(env, chatId);
                                } else {
                                    anyTransientFailure = true;
                                    console.warn(`[BROADCAST] tag send failed chat=${chatId}: ${desc}`);
                                }
                            }
                            await sleep(BROADCAST_GAP_MS);
                        }
                    }
                } catch (err) {
                    anyTransientFailure = true;
                    console.warn(`[BROADCAST] exception for chat ${chatId}: ${err.message}`);
                }
            }

            if (anyTransientFailure) {
                // Leave state unadvanced → retry on next tick within the 25-min window.
                // Rare enough that duplicate deliveries are acceptable vs. lost messages.
                console.warn(`[BROADCAST] not advancing state for ${stateKey}=${epKey} (will retry next tick)`);
            } else {
                await env.RSS_BOT_KV.put(stateKey, String(epKey), { expirationTtl: 30 * 86400 });
            }
        } catch (err) {
            console.error(`[BROADCAST] outer exception: ${err.message}`);
        }
    }
}

// ============= /schedule =============

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const DAY_LABELS_EN = { Monday:'Mon',Tuesday:'Tue',Wednesday:'Wed',Thursday:'Thu',Friday:'Fri',Saturday:'Sat',Sunday:'Sun' };
const DAY_FULL_FA = { Monday:'دوشنبه',Tuesday:'سه‌شنبه',Wednesday:'چهارشنبه',Thursday:'پنجشنبه',Friday:'جمعه',Saturday:'شنبه',Sunday:'یکشنبه' };
const DAYS_FA_ORDER = ['Saturday','Sunday','Monday','Tuesday','Wednesday','Thursday','Friday'];

function getCurrentDay(tz) {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' });
    const dayName = fmt.format(new Date());
    return DAYS.includes(dayName) ? dayName : 'Saturday';
}

function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function batchSuffix(b, lang) {
    if (!b || b.count <= 1) return '';
    const isFa = lang === 'fa';
    const range = isFa ? `${b.min} تا ${b.max}` : `${b.min} to ${b.max}`;
    return isFa ? ` (قسمت ${range}، پخش یک‌جا)` : ` (eps ${range}, batch)`;
}

function formatDaySchedule(dayKey, entries, lang) {
    const isFa = lang === 'fa';
    const dayName = isFa ? DAY_FULL_FA[dayKey] : dayKey;
    const targetTz = SCHEDULE_TZ[lang] || SCHEDULE_TZ.en;
    const tzLabel = isFa ? 'به وقت ایران' : 'UTC';
    const nowUnix = Math.floor(Date.now() / 1000);

    let html = `<h3>📅 ${dayName} (${tzLabel})</h3>`;

    if (!entries || entries.length === 0) {
        html += isFa
            ? '<p><i>هیچ انتشار برنامه‌ریزی‌شده‌ای وجود ندارد.</i></p>'
            : '<p><i>No releases scheduled.</i></p>';
        return html;
    }

    html += '<table bordered striped columns="1,6">';
    html += isFa
        ? '<tr><th>ساعت</th><th>انیمه</th></tr>'
        : '<tr><th>Time</th><th>Show</th></tr>';

    for (const e of entries) {
        const t = convertToTz(e.airingAt, targetTz);
        const titleSafe = escapeHtml(e.title);
        const aired = e.airingAt && e.airingAt <= nowUnix;
        const box = aired
            ? '<input type="checkbox" checked>'
            : '<input type="checkbox">';
        const suffix = escapeHtml(batchSuffix(e.batchEpisodes, lang));
        html += `<tr><td nowrap>${t}</td><td>${box} ${titleSafe}${suffix}</td></tr>`;
    }

    html += '</table>';
    return html;
}

function formatDaySchedulePlain(dayKey, entries, lang) {
    const isFa = lang === 'fa';
    const dayName = isFa ? DAY_FULL_FA[dayKey] : dayKey;
    const targetTz = SCHEDULE_TZ[lang] || SCHEDULE_TZ.en;
    const tzLabel = isFa ? 'به وقت ایران' : 'UTC';
    const nowUnix = Math.floor(Date.now() / 1000);

    let msg = `📅 <b>${dayName}</b> (${tzLabel})\n\n`;

    if (!entries || entries.length === 0) {
        msg += isFa
            ? '<i>هیچ انتشار برنامه‌ریزی‌شده‌ای وجود ندارد.</i>'
            : '<i>No releases scheduled.</i>';
        return msg;
    }

    for (const e of entries) {
        const t = convertToTz(e.airingAt, targetTz);
        const aired = e.airingAt && e.airingAt <= nowUnix;
        const box = aired ? '☑️' : '☐';
        const suffix = escapeHtml(batchSuffix(e.batchEpisodes, lang));
        msg += `<code>${t}</code>  ${box} ${escapeHtml(e.title)}${suffix}\n`;
    }
    return msg;
}

function buildDayKeyboard(activeDay, lang, chatType = 'private') {
    const isFa = lang === 'fa';
    const order = isFa ? DAYS_FA_ORDER : DAYS;
    const labels = isFa ? DAY_FULL_FA : DAY_LABELS_EN;
    const buttons = order.map((d) => ({
        text: d === activeDay ? `⭐ ${labels[d]}` : labels[d],
        callback_data: `sched:${d}`,
    }));
    const rows = [buttons.slice(0, 4), buttons.slice(4)].filter(r => r.length > 0);

    const webAppUrl = CACHED_WEBAPP_LINK || `${WORKER_ORIGIN}/app`;

    rows.push([{
        text: isFa ? '📱 وب اپ' : '📱 Web App',
        url: webAppUrl,
    }]);

    return { inline_keyboard: rows };
}

async function sendScheduleMessage(env, chatId, dayKey, entries, lang, keyboard) {
    const richRes = await sendRichMessage(env, chatId, formatDaySchedule(dayKey, entries, lang), {
        reply_markup: keyboard, is_rtl: lang === 'fa',
    });
    if (richRes && richRes.ok) return richRes;

    console.warn('[SCHEDULE] rich failed:', JSON.stringify(richRes).slice(0, 300));

    const plainRes = await sendMessage(env, chatId, formatDaySchedulePlain(dayKey, entries, lang), {
        reply_markup: keyboard,
    });
    if (!plainRes || !plainRes.ok) {
        console.error('[SCHEDULE] plain fallback failed:', JSON.stringify(plainRes).slice(0, 300));
    }
    return plainRes;
}

async function editScheduleMessage(env, chatId, messageId, dayKey, entries, lang, keyboard) {
    const richRes = await editRichMessage(env, chatId, messageId, formatDaySchedule(dayKey, entries, lang), {
        reply_markup: keyboard, is_rtl: lang === 'fa',
    });
    if (richRes && richRes.ok) return richRes;

    console.warn('[SCHEDULE] editRich failed:', JSON.stringify(richRes).slice(0, 300));

    const plainRes = await editMessage(env, chatId, messageId, formatDaySchedulePlain(dayKey, entries, lang), {
        reply_markup: keyboard,
    });
    if (!plainRes || !plainRes.ok) {
        console.error('[SCHEDULE] editPlain fallback failed:', JSON.stringify(plainRes).slice(0, 300));
    }
    return plainRes;
}

async function handleSchedule(env, chatId, chatType) {
    try {
        const lang = await getLang(env, chatId);
        const tz = SCHEDULE_TZ[lang] || SCHEDULE_TZ.en;
        const today = getCurrentDay(tz);
        const entries = await fetchScheduleForDay(env, today, tz);
        await sendScheduleMessage(env, chatId, today, entries, lang, buildDayKeyboard(today, lang, chatType));
    } catch (e) {
        const lang = await getLang(env, chatId);
        await sendMessage(env, chatId, lang === 'fa' ? `📅 <b>خطای برنامه:</b> ${e.message}` : `📅 <b>Schedule error:</b> ${e.message}`);
    }
}

// ============= /app =============

async function handleAppCommand(env, chatId, chatType) {
    if (!CACHED_WEBAPP_LINK) {
        await sendMessage(env, chatId, '❌ Web app link unavailable.');
        return;
    }
    const lang = await getLang(env, chatId);
    const text = lang === 'fa'
        ? '📱 برنامه هفتگی انیمه‌ها را در وب اپ ببینید:'
        : '📱 View the weekly anime schedule in the web app:';

    const button = {
        text: lang === 'fa' ? 'باز کردن وب اپ' : 'Open Web App',
        url: CACHED_WEBAPP_LINK,
    };

    await sendMessage(env, chatId, text, {
        reply_markup: { inline_keyboard: [[button]] },
    });
}

// ============= OTHER COMMANDS =============

async function handleStart(env, chatId) {
    const lang = await getLang(env, chatId);
    await setLang(env, chatId, lang);
    const text = lang === 'fa'
        ? 'سلام! من ربات اطلاع‌رسانی انیمه هستم.\n✅ شما مشترک شدید.\nبرای تغییر زبان از /language استفاده کنید.\nبرای لغو اشتراک از /unsub استفاده کنید.'
        : 'Hi! I am an anime release notification bot.\n✅ You are now subscribed.\nUse /language to change the language.\nUse /unsub to unsubscribe.';
    await sendMessage(env, chatId, text);
    await addChatToBroadcast(env, chatId);
}

async function handleUnsub(env, chatId) {
    const lang = await getLang(env, chatId);
    await removeChatFromBroadcast(env, chatId);
    const text = lang === 'fa'
        ? '❌ اشتراک شما لغو شد.\nبرای فعال‌سازی مجدد از /start استفاده کنید.'
        : '❌ You have been unsubscribed.\nUse /start to subscribe again.';
    await sendMessage(env, chatId, text);
}

async function handleUnsubInGroup(env, chatId) {
    const lang = await getLang(env, chatId);
    const text = lang === 'fa'
        ? 'ℹ️ این ربات به‌صورت گروهی مشترک می‌شود و نمی‌توانید فقط خودتان را از لیست ارسال لغو کنید.\n\nاگر نمی‌خواهید این گروه پیام دریافت کند، لطفاً ربات را از گروه حذف کنید (Kick/Remove).'
        : 'ℹ️ This bot subscribes the whole group at once, so you can\'t unsubscribe just yourself from the broadcast list.\n\nIf you don\'t want this group to receive messages, please remove the bot from the group (Kick/Remove).';
    await sendMessage(env, chatId, text);
}

async function handleLanguage(env, chatId) {
    await sendMessage(env, chatId, '🌐 Choose your language:', {
        reply_markup: { inline_keyboard: [[{ text: 'فارسی🇮🇷', callback_data: 'lang:fa' }, { text: '🇬🇧English', callback_data: 'lang:en' }]] },
    });
}

async function handleCallbackQuery(env, callbackQuery) {
    const { id, data, message } = callbackQuery;
    const chatId = message.chat.id;
    const messageId = message.message_id;
    const chatType = message.chat.type || 'private';

    if (data && data.startsWith('lang:')) {
        const lang = data.split(':')[1];
        await setLang(env, chatId, lang);
        const confirmText = lang === 'fa' ? '✅ زبان به فارسی تغییر کرد.' : '✅ Language changed to English.';
        await editMessage(env, chatId, messageId, confirmText);
        await answerCallback(env, id);
        return;
    }

    if (data && data.startsWith('sched:')) {
        const dayKey = data.slice('sched:'.length);
        if (!DAYS.includes(dayKey)) { await answerCallback(env, id); return; }
        try {
            const lang = await getLang(env, chatId);
            const tz = SCHEDULE_TZ[lang] || SCHEDULE_TZ.en;
            const entries = await fetchScheduleForDay(env, dayKey, tz);
            await editScheduleMessage(env, chatId, messageId, dayKey, entries, lang, buildDayKeyboard(dayKey, lang, chatType));
            await answerCallback(env, id);
        } catch (e) {
            await answerCallback(env, id);
            const lang = await getLang(env, chatId);
            await sendMessage(env, chatId, lang === 'fa' ? `📅 <b>خطای برنامه:</b> ${e.message}` : `📅 <b>Schedule error:</b> ${e.message}`);
        }
        return;
    }
}

// ============= /debug =============

async function handleDebug(env, chatId) {
    try {
        const lang = await getLang(env, chatId);
        const nowUnix = Math.floor(Date.now() / 1000);
        const week = await fetchScheduleWeek(env);

        const allPast = [];
        for (const d of Object.keys(week)) {
            for (const e of week[d]) {
                if (e.airingAt && e.airingAt <= nowUnix) allPast.push(e);
            }
        }
        allPast.sort((a, b) => b.airingAt - a.airingAt);
        const latestRaw = allPast.slice(0, 10);
        const latest = collapseBatches(latestRaw);

        if (latest.length === 0) {
            await sendMessage(env, chatId, '🐛 <b>Debug:</b> No aired entries yet.');
            return;
        }

        await sendMessage(env, chatId, `🐛 <b>Debug:</b> sending the ${latest.length} latest aired entries...`);
        await sleep(BROADCAST_GAP_MS);

        for (let i = 0; i < latest.length; i++) {
            const e = latest[i];
            const epKey = e.batchEpisodes && e.batchEpisodes.max != null ? e.batchEpisodes.max : e.episode;
            await sendAiringWithRetry(
                env, chatId, e.title, epKey, e.episodes, e.url, lang, e.batchEpisodes || null
            );
            SUBREQUEST_COUNT++;
            await sleep(BROADCAST_GAP_MS);
        }

        await sendMessage(env, chatId, `🐛 <b>Debug complete.</b>\nSubrequests: ${SUBREQUEST_COUNT}`);
    } catch (e) {
        await sendMessage(env, chatId, `🐛 <b>Debug error:</b> ${e.message}`);
    }
}

// ============= WORKER ENTRY POINT =============

const TAG_KEYWORDS = new Set(['tag', 'تگ', 'تگ کن', 'tag me']);
const UNTAG_KEYWORDS = new Set(['remove tag', 'untag', 'حذف تگ', 'حذف تگ کن', 'تگ حذف']);

function normalizeReplyText(text) {
    return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isTagReply(msg) {
    const raw = String(msg.text || '').trim();
    const lower = raw.toLowerCase();
    if (TAG_KEYWORDS.has(lower)) return true;
    if (TAG_KEYWORDS.has(raw)) return true;
    if (/^(tag|تگ)(\s|$)/i.test(lower)) return true;
    return false;
}

function isUntagReply(msg) {
    const t = normalizeReplyText(msg.text);
    return UNTAG_KEYWORDS.has(t) || UNTAG_KEYWORDS.has(String(msg.text || '').trim());
}

export default {
    async fetch(request, env, ctx) {
        SUBREQUEST_COUNT = 0;
        ENCRYPTION_KEY = env.DB_ENCRYPTION_KEY || 'default-key-please-change-me';
        globalThis.ENCRYPTION_KEY = ENCRYPTION_KEY;

        const reqUrl = new URL(request.url);
        WORKER_ORIGIN = reqUrl.origin;

        if (!env.BOT_TOKEN) return new Response('Bot token missing', { status: 500 });

        await getWebAppLink(env);

        if (request.method === 'GET') {
            if (reqUrl.pathname === '/' || reqUrl.pathname === '/app') {
                return handleScheduleApp(env);
            }
            if (reqUrl.pathname === '/api/schedule') {
                return handleApiSchedule(env, request);
            }
            if (reqUrl.pathname === '/api/anime') {
                return handleApiAnime(env, request);
            }
            return new Response('OK', { status: 200 });
        }

        if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

        let update;
        try { update = await request.json(); } catch { return new Response('Bad Request', { status: 400 }); }

        try {
            if (update.message) {
                const msg = update.message;
                const chatId = msg.chat.id;
                const text = msg.text || '';
                const chatType = msg.chat.type;

                if (msg.reply_to_message && text.trim() === '/debugreply') {
                    await handleDebugReply(env, msg);
                    return new Response('OK', { status: 200 });
                }

                if (msg.reply_to_message && isProfanityReply(msg)) {
                    const isAiring = await looksLikeAiringMessage(env, msg.reply_to_message);
                    if (isAiring) {
                        await handleProfanityReply(env, msg);
                        return new Response('OK', { status: 200 });
                    }
                    console.log(`[GIF] skipped: reply not airing`);
                }

                if (msg.reply_to_message && isUntagReply(msg)) {
                    await handleUntagReply(env, msg);
                    return new Response('OK', { status: 200 });
                }

                if (msg.reply_to_message && isTagReply(msg)) {
                    await handleTagReply(env, msg);
                    return new Response('OK', { status: 200 });
                }

                if (chatType === 'private') {
                    if (text.startsWith('/start')) await handleStart(env, chatId);
                    else if (text.startsWith('/unsub')) await handleUnsub(env, chatId);
                    else if (text.startsWith('/language')) await handleLanguage(env, chatId);
                    else if (text.startsWith('/schedule')) await handleSchedule(env, chatId, chatType);
                    else if (text.startsWith('/app')) await handleAppCommand(env, chatId, chatType);
                    else if (text.startsWith('/debug')) await handleDebug(env, chatId);
                } else {
                    await addChatToBroadcast(env, chatId);
                    if (text.startsWith('/unsub')) await handleUnsubInGroup(env, chatId);
                    else if (text.startsWith('/language')) await handleLanguage(env, chatId);
                    else if (text.startsWith('/schedule')) await handleSchedule(env, chatId, chatType);
                    else if (text.startsWith('/app')) await handleAppCommand(env, chatId, chatType);
                    else if (text.startsWith('/debug')) await handleDebug(env, chatId);
                }
            }

            if (update.callback_query) await handleCallbackQuery(env, update.callback_query);
        } catch (e) {
            console.error('[ERROR] Update handling failed:', e);
        }

        return new Response('OK', { status: 200 });
    },

    async scheduled(event, env, ctx) {
        SUBREQUEST_COUNT = 0;
        ENCRYPTION_KEY = env.DB_ENCRYPTION_KEY || 'default-key-please-change-me';
        ctx.waitUntil(broadcastLatest(env));
    },
};
