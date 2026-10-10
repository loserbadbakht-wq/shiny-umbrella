// ============================================================
// Telegram RSS Bot – KV-backed schedule + menu-based language
// + per-chat per-anime tag lists (add + remove)
// + profanity GIF replies (airing messages only, three random GIFs)
// + MAL Link rendered as a rich-message tg-button
// + RTL for Persian rich messages via is_rtl
// ============================================================

const TELEGRAM_API = 'https://api.telegram.org/bot';

const SCHEDULE_TZ = { fa: 'Asia/Tehran', en: 'UTC' };
const JST = 'Asia/Tokyo';

const WEEK_KV_KEY = 'sched:anilist:v5:week';
const WEEK_STALE_TTL_MS = 24 * 60 * 60 * 1000;
const TAG_TTL_SEC = 90 * 24 * 60 * 60;
const MAX_TAGS_PER_ANIME = 100;
const MAX_MENTIONS_SHOWN = 30;

const PROFANITY_ANIMATIONS = [
    'CgACAgQAAxkBAAOPasEyhcd_ZClKhh-lFv-KBqkD8PMAAmUdAAIXGTFTrAz2uUsWczQ9BA',
    'CgACAgQAAxkBAAPWasFJjJyZY2GB54BUdZhgFHqDx4kAAh8eAAIcePlTn5i43E36lYg9BA',
    'CgACAgQAAxkBAAIBUWrI_6-D3uWts-ddpsNqHRybxpzqAAL6GgACfoYZUv8xSu4ohDOTPQQ',
];

let SUBREQUEST_COUNT = 0;

// ============= SCHEDULE FROM KV =============

async function fetchScheduleWeek(env) {
    try {
        const raw = await env.RSS_BOT_KV.get(WEEK_KV_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed.week || {};
    } catch (e) {
        console.warn(`[SCHEDULE] KV read failed: ${e.message}`);
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

async function fetchScheduleForDay(env, dayKey, targetTz) {
    const week = await fetchScheduleWeek(env);
    if (!targetTz) return week[dayKey.toLowerCase()] || [];

    const flat = [];
    for (const d of Object.keys(week)) flat.push(...week[d]);

    const targetDay = dayKey.toLowerCase();
    const out = [];
    for (const e of flat) {
        if (!e.airingAt) continue;
        const d = new Date(e.airingAt * 1000);
        const localDay = new Intl.DateTimeFormat('en-US', {
            timeZone: targetTz, weekday: 'long',
        }).format(d).toLowerCase();
        if (localDay === targetDay) out.push(e);
    }

    out.sort((a, b) => {
        const ma = localMinutes(a.airingAt, targetTz);
        const mb = localMinutes(b.airingAt, targetTz);
        if (ma !== mb) return ma - mb;
        return a.airingAt - b.airingAt;
    });
    return out;
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
    if (cached && Date.now() - cached.ts < LANG_CACHE_TTL_MS) {
        return cached.lang;
    }
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
    } catch (e) {
        return 'en';
    }
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
    if (list.some((u) => u.userId === user.userId)) {
        return { added: false, list, reason: 'duplicate' };
    }
    if (list.length >= MAX_TAGS_PER_ANIME) {
        return { added: false, list, reason: 'full' };
    }
    list.push(user);
    await saveTagList(env, chatId, animeKey, list);
    return { added: true, list };
}

async function removeTag(env, chatId, animeKey, userId) {
    const list = await getTagList(env, chatId, animeKey);
    const filtered = list.filter((u) => u.userId !== userId);
    if (filtered.length === list.length) {
        return { removed: false, list, reason: 'not-in-list' };
    }
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

    // 1. Inline keyboard button URLs — covers both rich <tg-button>
    //    and regular inline-keyboard URL buttons.
    if (msg.reply_markup && Array.isArray(msg.reply_markup.inline_keyboard)) {
        for (const row of msg.reply_markup.inline_keyboard) {
            for (const btn of row) {
                if (btn.url) {
                    let m = btn.url.match(/myanimelist\.net\/anime\/(\d+)/);
                    if (m) { console.log(`[KEY] from button URL: mal:${m[1]}`); return `mal:${m[1]}`; }
                    m = btn.url.match(/anilist\.co\/anime\/(\d+)/);
                    if (m) { console.log(`[KEY] from button URL: anilist:${m[1]}`); return `anilist:${m[1]}`; }
                }
            }
        }
    }

    // 2. text_link entities (plain messages with <a href>)
    if (Array.isArray(msg.entities)) {
        for (const ent of msg.entities) {
            if (ent.type === 'text_link' && ent.url) {
                let m = ent.url.match(/myanimelist\.net\/anime\/(\d+)/);
                if (m) { console.log(`[KEY] from entity: mal:${m[1]}`); return `mal:${m[1]}`; }
                m = ent.url.match(/anilist\.co\/anime\/(\d+)/);
                if (m) { console.log(`[KEY] from entity: anilist:${m[1]}`); return `anilist:${m[1]}`; }
            }
        }
    }

    // 3. Raw URL anywhere in text
    const text = msg.text || msg.caption || '';
    let m = text.match(/myanimelist\.net\/anime\/(\d+)/);
    if (m) { console.log(`[KEY] from text URL: mal:${m[1]}`); return `mal:${m[1]}`; }
    m = text.match(/anilist\.co\/anime\/(\d+)/);
    if (m) { console.log(`[KEY] from text URL: anilist:${m[1]}`); return `anilist:${m[1]}`; }

    // 4. Title parsing + schedule cache lookup
    if (env) {
        const parsed = extractTitleFromAiringText(text);
        if (parsed) {
            const found = await findAnimeKeyByTitle(env, parsed.base, parsed.season);
            if (found) { console.log(`[KEY] from title lookup: ${found}`); return found; }
            console.warn(`[KEY] parsed "${parsed.base}" (S${parsed.season}) but no match in schedule`);
        } else {
            console.warn(`[KEY] could not parse title from: ${JSON.stringify(text).slice(0, 200)}`);
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
        out += lang === 'fa'
            ? `\n<i>و ${extra} نفر دیگر…</i>`
            : `\n<i>and ${extra} more…</i>`;
    }
    return out;
}

async function handleTagReply(env, msg) {
    const chatId = msg.chat.id;
    const from = msg.from;
    const replied = msg.reply_to_message;
    if (!replied || !replied.from || !replied.from.is_bot) return;

    const animeKey = await extractAnimeKeyFromMessage(replied, env);
    if (!animeKey) {
        console.log(`[TAG] reply in ${chatId} had no anime key, ignoring`);
        return;
    }

    const user = {
        userId: from.id,
        username: from.username || null,
        firstName: from.first_name || null,
    };

    const lang = await getLang(env, chatId);
    const result = await addTag(env, chatId, animeKey, user);
    const mention = `<a href="tg://user?id=${from.id}">${escapeHtml(from.first_name || 'User')}</a>`;

    let reply;
    if (result.added) {
        reply = lang === 'fa'
            ? `✅ ${mention} به لیست تگ اضافه شد.\n\nاز این پس در پیام‌های این انیمه تگ می‌شوید (${result.list.length} نفر).`
            : `✅ ${mention} added to the tag list.\n\nYou will be tagged in this anime's future airings (${result.list.length} user(s)).`;
    } else if (result.reason === 'duplicate') {
        reply = lang === 'fa'
            ? 'ℹ️ شما قبلاً در لیست تگ این انیمه هستید.'
            : 'ℹ️ You are already in this anime\'s tag list.';
    } else {
        reply = lang === 'fa'
            ? '⚠️ لیست تگ این انیمه پر است.'
            : '⚠️ This anime\'s tag list is full.';
    }

    await sendMessage(env, chatId, reply, { reply_to_message_id: msg.message_id });
}

async function handleUntagReply(env, msg) {
    const chatId = msg.chat.id;
    const from = msg.from;
    const replied = msg.reply_to_message;
    if (!replied || !replied.from || !replied.from.is_bot) return;

    const animeKey = await extractAnimeKeyFromMessage(replied, env);
    if (!animeKey) {
        console.log(`[UNTAG] reply in ${chatId} had no anime key, ignoring`);
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
        reply = lang === 'fa'
            ? 'ℹ️ شما در لیست تگ این انیمه نیستید.'
            : 'ℹ️ You are not in this anime\'s tag list.';
    }

    await sendMessage(env, chatId, reply, { reply_to_message_id: msg.message_id });
}

// ============= PROFANITY GIF =============

const PROFANITY_KEYWORDS = [
    'گایید', 'خفه', 'کیر',
    'کون', 'کس', 'کص', 'جنده', 'کونی', 'کصکش',
];

const PROFANITY_BOUNDARY = '[\\s!؟?.,،;:…\\-()\\[\\]"\']';

function hasWholeWord(text, word) {
    const re = new RegExp(
        `(?:^|${PROFANITY_BOUNDARY})${word}(?=${PROFANITY_BOUNDARY}|$)`,
        'u'
    );
    return re.test(text);
}

function isProfanityReply(msg) {
    const raw = String(msg.text || '').trim();
    if (!raw) return false;

    const stripped = raw.replace(/[!؟?.,…\s]+$/g, '').trim();
    for (const w of PROFANITY_KEYWORDS) {
        if (stripped === w) return true;
    }

    if (raw.length <= 60) {
        for (const w of PROFANITY_KEYWORDS) {
            if (hasWholeWord(raw, w)) return true;
        }
    }
    return false;
}

async function looksLikeAiringMessage(env, msg) {
    if (!msg) return false;
    if (!msg.from || !msg.from.is_bot) return false;

    // Any successful key extraction means it's an airing message.
    const key = await extractAnimeKeyFromMessage(msg, env);
    if (key) return true;

    // Cheap text heuristics as a safety net.
    const text = msg.text || msg.caption || '';
    if (/Aired!/.test(text)) return true;
    if (/اومد!/.test(text)) return true;
    if (/Episode Count/.test(text)) return true;
    if (/تعداد قسمت‌ها/.test(text)) return true;

    return false;
}

async function handleProfanityReply(env, msg) {
    const chatId = msg.chat.id;
    const fileId = PROFANITY_ANIMATIONS[Math.floor(Math.random() * PROFANITY_ANIMATIONS.length)];
    const res = await sendAnimation(env, chatId, fileId, {
        reply_to_message_id: msg.message_id,
    });
    console.log(`[GIF] result: ${JSON.stringify(res).slice(0, 200)}`);
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

function formatAiringMessage(title, epNum, totalEps, malLink, lang, prefix = '') {
    const { base, season } = parseAnimeTitle(title);
    const isFa = lang === 'fa';

    let body;
    if (season) {
        if (isFa) body = `قسمت ${epNum} فصل ${season} انیمه <b>${base}</b> اومد!`;
        else body = `<b>${base}</b> Season ${season} - Episode ${epNum} Aired!`;
    } else {
        if (isFa) body = `قسمت ${epNum} انیمه <b>${base}</b> اومد!`;
        else body = `<b>${base}</b> - Episode ${epNum} Aired!`;
    }

    if (totalEps && epNum >= totalEps) {
        body += isFa ? ' (پایان)' : ' (end)';
    }

    const counterLabel = isFa ? 'تعداد قسمت‌ها' : 'Episode Count';
    const counter = totalEps ? `${counterLabel}: ${epNum}/${totalEps}` : `${counterLabel}: ${epNum}/?`;

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

function formatAiringMessagePlain(title, epNum, totalEps, malLink, lang, prefix = '') {
    const { base, season } = parseAnimeTitle(title);
    const pre = prefix ? `<b>${prefix}</b>\n` : '';
    let body;
    if (season) {
        if (lang === 'fa') body = `قسمت ${epNum} فصل ${season} انیمه <b>${base}</b> اومد!`;
        else body = `<b>${base}</b> Season ${season} - Episode ${epNum} Aired!`;
    } else {
        if (lang === 'fa') body = `قسمت ${epNum} انیمه <b>${base}</b> اومد!`;
        else body = `<b>${base}</b> - Episode ${epNum} Aired!`;
    }
    if (totalEps && epNum >= totalEps) body += lang === 'fa' ? ' (پایان)' : ' (end)';
    const counterLabel = lang === 'fa' ? 'تعداد قسمت‌ها' : 'Episode Count';
    body += `\n\n${counterLabel}: ${totalEps ? `${epNum}/${totalEps}` : `${epNum}/?`}`;
    if (malLink) {
        const url = String(malLink);
        let label;
        if (url.includes('myanimelist.net')) label = lang === 'fa' ? 'لینک MAL' : 'MAL Link';
        else if (url.includes('anilist.co')) label = lang === 'fa' ? 'لینک AniList' : 'AniList Link';
        else label = lang === 'fa' ? 'لینک' : 'Link';
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

async function sendAiringMessage(env, chatId, title, epNum, totalEps, malLink, lang, prefix = '') {
    const richHtml = formatAiringMessage(title, epNum, totalEps, malLink, lang, prefix);
    const richRes = await sendRichMessage(env, chatId, richHtml, { is_rtl: lang === 'fa' });
    if (richRes && richRes.ok) return richRes;

    console.warn('[AIRING] rich send failed, plain fallback:', JSON.stringify(richRes).slice(0, 300));
    const plain = formatAiringMessagePlain(title, epNum, totalEps, malLink, lang, prefix);
    return await sendMessage(env, chatId, plain);
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
            if (e.airingAt && e.airingAt >= windowStart && e.airingAt <= windowEnd) {
                candidates.push(e);
            }
        }
    }
    if (candidates.length === 0) return;

    const chats = await getBroadcastChats(env);
    if (chats.length === 0) return;

    for (const e of candidates) {
        try {
            const stateKey = `aired:anilist:${e.anilist_id}`;
            const stored = await env.RSS_BOT_KV.get(stateKey);
            if (stored === String(e.episode)) continue;

            const animeKey = animeKeyFromEntry(e);

            for (const chatId of chats) {
                try {
                    const lang = await getLang(env, chatId);
                    const res = await sendAiringMessage(
                        env, chatId,
                        e.title, e.episode, e.episodes, e.url,
                        lang
                    );
                    SUBREQUEST_COUNT++;

                    if (animeKey) {
                        const tagList = await getTagList(env, chatId, animeKey);
                        if (tagList.length > 0) {
                            const tagSuffix = formatTagList(tagList, lang);
                            await sendMessage(env, chatId, tagSuffix);
                            SUBREQUEST_COUNT++;
                        }
                    }

                    if (res && res.ok === false) {
                        const desc = res.description || '';
                        if (desc.includes('blocked') || desc.includes('chat not found') || desc.includes('kicked') || desc.includes('user is deactivated')) {
                            await removeChatFromBroadcast(env, chatId);
                        }
                    }
                } catch (err) {}
            }
            await env.RSS_BOT_KV.put(stateKey, String(e.episode), { expirationTtl: 30 * 86400 });
        } catch (err) {}
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

function formatDaySchedule(dayKey, entries, lang) {
    const isFa = lang === 'fa';
    const dayName = isFa ? DAY_FULL_FA[dayKey] : dayKey;
    const targetTz = SCHEDULE_TZ[lang] || SCHEDULE_TZ.en;
    const tzLabel = isFa ? 'به وقت ایران' : 'UTC';
    let html = `<h3>📅 ${dayName} (${tzLabel})</h3>`;
    if (!entries || entries.length === 0) {
        html += isFa ? '<p><i>هیچ انتشار برنامه‌ریزی‌شده‌ای وجود ندارد.</i></p>' : '<p><i>No releases scheduled.</i></p>';
        return html;
    }
    html += '<table bordered striped columns="1,6">';
    html += isFa ? '<tr><th>ساعت</th><th>انیمه</th></tr>' : '<tr><th>Time</th><th>Show</th></tr>';
    for (const e of entries) {
        const t = convertToTz(e.airingAt, targetTz);
        html += `<tr><td nowrap>${t}</td><td>${escapeHtml(e.title)}</td></tr>`;
    }
    html += '</table>';
    return html;
}

function formatDaySchedulePlain(dayKey, entries, lang) {
    const isFa = lang === 'fa';
    const dayName = isFa ? DAY_FULL_FA[dayKey] : dayKey;
    const targetTz = SCHEDULE_TZ[lang] || SCHEDULE_TZ.en;
    const tzLabel = isFa ? 'به وقت ایران' : 'UTC';
    let msg = `📅 <b>${dayName}</b> (${tzLabel})\n\n`;
    if (!entries || entries.length === 0) {
        msg += isFa ? '<i>هیچ انتشار برنامه‌ریزی‌شده‌ای وجود ندارد.</i>' : '<i>No releases scheduled.</i>';
        return msg;
    }
    for (const e of entries) {
        const t = convertToTz(e.airingAt, targetTz);
        msg += `<code>${t}</code>  ${escapeHtml(e.title)}\n`;
    }
    return msg;
}

function buildDayKeyboard(activeDay, lang) {
    const isFa = lang === 'fa';
    const order = isFa ? DAYS_FA_ORDER : DAYS;
    const labels = isFa ? DAY_FULL_FA : DAY_LABELS_EN;
    const buttons = order.map((d) => ({
        text: d === activeDay ? `⭐ ${labels[d]}` : labels[d],
        callback_data: `sched:${d}`,
    }));
    return { inline_keyboard: [buttons.slice(0, 4), buttons.slice(4)].filter(r => r.length > 0) };
}

async function sendScheduleMessage(env, chatId, dayKey, entries, lang, keyboard) {
    const richHtml = formatDaySchedule(dayKey, entries, lang);
    const richRes = await sendRichMessage(env, chatId, richHtml, {
        reply_markup: keyboard,
        is_rtl: lang === 'fa',
    });
    if (richRes && richRes.ok) return;
    await sendMessage(env, chatId, formatDaySchedulePlain(dayKey, entries, lang), { reply_markup: keyboard });
}

async function editScheduleMessage(env, chatId, messageId, dayKey, entries, lang, keyboard) {
    const richHtml = formatDaySchedule(dayKey, entries, lang);
    const richRes = await editRichMessage(env, chatId, messageId, richHtml, {
        reply_markup: keyboard,
        is_rtl: lang === 'fa',
    });
    if (richRes && richRes.ok) return;
    await editMessage(env, chatId, messageId, formatDaySchedulePlain(dayKey, entries, lang), { reply_markup: keyboard });
}

async function handleSchedule(env, chatId) {
    try {
        const lang = await getLang(env, chatId);
        const tz = SCHEDULE_TZ[lang] || SCHEDULE_TZ.en;
        const today = getCurrentDay(tz);
        const entries = await fetchScheduleForDay(env, today, tz);
        await sendScheduleMessage(env, chatId, today, entries, lang, buildDayKeyboard(today, lang));
    } catch (e) {
        const lang = await getLang(env, chatId);
        await sendMessage(env, chatId, lang === 'fa' ? `📅 <b>خطای برنامه:</b> ${e.message}` : `📅 <b>Schedule error:</b> ${e.message}`);
    }
}

// ============= OTHER COMMANDS =============

async function handleStart(env, chatId) {
    const lang = await getLang(env, chatId);
    await setLang(env, chatId, lang);
    const text = lang === 'fa'
        ? 'سلام! من ربات اطلاع‌رسانی انیمه هستم.\n✅ شما مشترک شدید.\nبرای تغییر زبان از /language استفاده کنید.\nبرای لغو اشتراک از /unsub استفاده کنید.\n\nبرای تگ شدن در یک انیمه، روی پیام قسمت اون انیمه ریپلای کنید و بنویسید «تگ».\nبرای حذف تگ، ریپلای کنید و بنویسید «حذف تگ».'
        : 'Hi! I am an anime release notification bot.\n✅ You are now subscribed.\nUse /language to change the language.\nUse /unsub to unsubscribe.\n\nTo get tagged for an anime, reply to its episode message with "tag".\nTo remove yourself, reply with "remove tag".';
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
            await editScheduleMessage(env, chatId, messageId, dayKey, entries, lang, buildDayKeyboard(dayKey, lang));
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
        const latest = allPast.slice(0, 10);

        if (latest.length === 0) {
            await sendMessage(env, chatId, '🐛 <b>Debug:</b> No aired entries yet.');
            return;
        }

        await sendMessage(env, chatId, `🐛 <b>Debug:</b> sending the ${latest.length} latest aired entries...`);

        for (let i = 0; i < latest.length; i++) {
            const e = latest[i];
            await sendAiringMessage(env, chatId, e.title, e.episode, e.episodes, e.url, lang, `#${i + 1}`);
            SUBREQUEST_COUNT++;
            await new Promise((r) => setTimeout(r, 150));
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
    const t = normalizeReplyText(msg.text);
    return TAG_KEYWORDS.has(t) || TAG_KEYWORDS.has(String(msg.text || '').trim());
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

        if (!env.BOT_TOKEN) return new Response('Bot token missing', { status: 500 });
        if (request.method === 'GET') return new Response('OK', { status: 200 });
        if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

        let update;
        try { update = await request.json(); } catch { return new Response('Bad Request', { status: 400 }); }

        try {
            if (update.message) {
                const msg = update.message;
                const chatId = msg.chat.id;
                const text = msg.text || '';
                const chatType = msg.chat.type;

                if (msg.reply_to_message && isProfanityReply(msg)) {
                    const isAiring = await looksLikeAiringMessage(env, msg.reply_to_message);
                    if (isAiring) {
                        await handleProfanityReply(env, msg);
                        return new Response('OK', { status: 200 });
                    }
                    console.log(`[GIF] skipped: reply ${msg.reply_to_message.message_id} not airing`);
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
                    else if (text.startsWith('/schedule')) await handleSchedule(env, chatId);
                    else if (text.startsWith('/debug')) await handleDebug(env, chatId);
                } else {
                    await addChatToBroadcast(env, chatId);
                    if (text.startsWith('/unsub')) await handleUnsubInGroup(env, chatId);
                    else if (text.startsWith('/language')) await handleLanguage(env, chatId);
                    else if (text.startsWith('/schedule')) await handleSchedule(env, chatId);
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
