// ============================================================
// Telegram RSS Bot – AniList-driven airing + schedule
// ============================================================

const TELEGRAM_API = 'https://api.telegram.org/bot';
const ANILIST_API = 'https://graphql.anilist.co';

const SCHEDULE_TZ = { fa: 'Asia/Tehran', en: 'UTC' };
const JST = 'Asia/Tokyo';

const WEEK_CACHE_TTL_MS = 3 * 60 * 60 * 1000;      // 3 hours
const WEEK_KV_TTL_SEC = 26 * 60 * 60;              // 26 hours

let SUBREQUEST_COUNT = 0;

// ============= ANILIST FETCH =============

const ANILIST_QUERY = `
query($start: Int, $end: Int, $page: Int) {
  Page(perPage: 50, page: $page) {
    pageInfo { hasNextPage }
    airingSchedules(airingAt_greater: $start, airingAt_lesser: $end) {
      episode
      airingAt
      media {
        id
        idMal
        title { romaji english native }
        episodes
        siteUrl
        format
      }
    }
  }
}`;

async function anilistFetch(variables, attempt = 1) {
    try {
        const res = await fetch(ANILIST_API, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                // Browser-like headers — AniList's WAF rejects bare API clients
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Origin': 'https://anilist.co',
                'Referer': 'https://anilist.co/',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            body: JSON.stringify({ query: ANILIST_QUERY, variables }),
        });
        SUBREQUEST_COUNT++;

        const retryable = res.status === 429 || res.status === 403
            || res.status === 500 || res.status === 502
            || res.status === 503 || res.status === 504;

        if (retryable && attempt < 4) {
            const wait = 1500 * attempt;
            console.warn(`[ANILIST] HTTP ${res.status} (attempt ${attempt}/4), waiting ${wait}ms...`);
            await new Promise((r) => setTimeout(r, wait));
            return anilistFetch(variables, attempt + 1);
        }

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = await res.json();
        if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
        return json?.data?.Page || { airingSchedules: [], pageInfo: {} };
    } catch (e) {
        if (attempt < 4) {
            const wait = 1500 * attempt;
            console.warn(`[ANILIST] ${e.message} (attempt ${attempt}/4), retry in ${wait}ms...`);
            await new Promise((r) => setTimeout(r, wait));
            return anilistFetch(variables, attempt + 1);
        }
        throw e;
    }
}

// ============= WEEK CACHE =============

function getJstDayAndTime(unixSec) {
    const d = new Date(unixSec * 1000);
    const day = new Intl.DateTimeFormat('en-US', { timeZone: JST, weekday: 'long' })
        .format(d).toLowerCase();
    const time = new Intl.DateTimeFormat('en-GB', {
        timeZone: JST, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d);
    return { day, time };
}

function normalizeEntry(entry) {
    const media = entry.media || {};
    const title = media.title?.english
        || media.title?.romaji
        || media.title?.native
        || '';
    const malId = media.idMal || null;
    return {
        mal_id: malId,
        anilist_id: media.id,
        title,
        episodes: media.episodes || null,
        format: media.format || 'TV',
        airingAt: entry.airingAt,
        episode: entry.episode || null,
        url: malId
            ? `https://myanimelist.net/anime/${malId}`
            : media.siteUrl,
    };
}

async function fetchScheduleWeek(env) {
    const cacheKey = 'sched:anilist:v2';

    // ---- Fresh cache ----
    let cachedWeek = null;
    let cachedAge = Infinity;
    try {
        const raw = await env.RSS_BOT_KV.get(cacheKey);
        if (raw) {
            const parsed = JSON.parse(raw);
            cachedWeek = parsed.week;
            cachedAge = Date.now() - (parsed.ts || 0);
            if (cachedAge < WEEK_CACHE_TTL_MS) {
                console.log(`[SCHEDULE] fresh cache (age ${Math.round(cachedAge / 60000)}m)`);
                return cachedWeek;
            }
        }
    } catch (e) {
        console.warn(`[SCHEDULE] cache read failed: ${e.message}`);
    }

    // ---- Fetch from AniList (7-day window starting today JST) ----
    try {
        const nowJstYmd = new Intl.DateTimeFormat('en-CA', {
            timeZone: JST, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date());
        const startJst = new Date(`${nowJstYmd}T00:00:00+09:00`);
        const startUnix = Math.floor(startJst.getTime() / 1000);
        const endUnix = startUnix + 7 * 86400;

        const all = [];
        for (let page = 1; page <= 4; page++) {
            const pageData = await anilistFetch({ start: startUnix, end: endUnix, page });
            const entries = pageData.airingSchedules || [];
            all.push(...entries);
            if (!pageData.pageInfo?.hasNextPage) break;
            await new Promise((r) => setTimeout(r, 200));
        }

        console.log(`[SCHEDULE] AniList returned ${all.length} entries`);

        const week = {};
        for (const e of all) {
            const norm = normalizeEntry(e);
            if (!norm.title || !norm.episode) continue;
            const { day, time } = getJstDayAndTime(norm.airingAt);
            if (!week[day]) week[day] = [];
            week[day].push({ ...norm, jstTime: time });
        }

        // Sort each day
        for (const d of Object.keys(week)) {
            week[d].sort((a, b) => a.airingAt - b.airingAt);
        }

        // Cache
        try {
            await env.RSS_BOT_KV.put(
                cacheKey,
                JSON.stringify({ ts: Date.now(), week }),
                { expirationTtl: WEEK_KV_TTL_SEC }
            );
        } catch (e) {}

        return week;
    } catch (e) {
        console.warn(`[SCHEDULE] AniList failed: ${e.message}`);
        if (cachedWeek) {
            console.warn(`[SCHEDULE] using stale cache (age ${Math.round(cachedAge / 60000)}m)`);
            return cachedWeek;
        }
        throw e;
    }
}

async function fetchScheduleForDay(env, dayKey) {
    const week = await fetchScheduleWeek(env);
    return week[dayKey.toLowerCase()] || [];
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

// ============= KV HELPERS =============

async function getLang(env, chatId) {
    const key = `lang:${chatId}`;
    try {
        const raw = await env.RSS_BOT_KV.get(key);
        return raw ? decryptData(raw) : 'en';
    } catch { return 'en'; }
}
async function setLang(env, chatId, lang) {
    await env.RSS_BOT_KV.put(`lang:${chatId}`, encryptData(lang));
}
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

function formatAiringMessage(title, epNum, totalEps, malLink, lang) {
    const { base, season } = parseAnimeTitle(title);

    let msg;
    if (season) {
        if (lang === 'fa') msg = `قسمت ${epNum} فصل ${season} انیمه <b>${base}</b> اومد!`;
        else msg = `<b>${base}</b> Season ${season} - Episode ${epNum} Aired!`;
    } else {
        if (lang === 'fa') msg = `قسمت ${epNum} انیمه <b>${base}</b> اومد!`;
        else msg = `<b>${base}</b> - Episode ${epNum} Aired!`;
    }

    if (totalEps && epNum >= totalEps) {
        msg += lang === 'fa' ? ' (پایان)' : ' (end)';
    }

    const counterLabel = lang === 'fa' ? 'تعداد قسمت‌ها' : 'Episode Count';
    msg += `\n\n${counterLabel}: ${totalEps ? `${epNum}/${totalEps}` : `${epNum}/?`}`;

    if (malLink) {
        const label = lang === 'fa' ? 'لینک MAL' : 'MAL Link';
        msg += `\n\n<a href="${malLink}">${label}</a>`;
    }

    return msg;
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
        body: JSON.stringify({
            chat_id: chatId, text, parse_mode: 'HTML',
            disable_web_page_preview: true, ...extra,
        }),
    });
    try { return await res.json(); } catch { return { ok: res.ok }; }
}

async function editMessage(env, chatId, messageId, text, extra = {}) {
    const res = await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId, message_id: messageId, text,
            parse_mode: 'HTML', disable_web_page_preview: true, ...extra,
        }),
    });
    try { return await res.json(); } catch { return { ok: res.ok }; }
}

async function sendRichMessage(env, chatId, html, extra = {}) {
    const res = await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/sendRichMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, rich_message: { html }, ...extra }),
    });
    try { return await res.json(); } catch { return { ok: res.ok }; }
}

async function editRichMessage(env, chatId, messageId, html, extra = {}) {
    const res = await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId, message_id: messageId, rich_message: { html }, ...extra,
        }),
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
    console.log(`[AIRING] tick`);

    let week;
    try {
        week = await fetchScheduleWeek(env);
    } catch (e) {
        console.error('[AIRING] schedule unavailable:', e.message);
        return;
    }

    const nowUnix = Math.floor(Date.now() / 1000);
    const windowStart = nowUnix - 25 * 60;
    const windowEnd = nowUnix + 60;

    const candidates = [];
    for (const d of Object.keys(week)) {
        for (const e of week[d]) {
            if (e.airingAt >= windowStart && e.airingAt <= windowEnd) {
                candidates.push(e);
            }
        }
    }
    console.log(`[AIRING] ${candidates.length} aired in last 25 min`);

    if (candidates.length === 0) return;

    const chats = await getBroadcastChats(env);
    if (chats.length === 0) return;

    for (const e of candidates) {
        try {
            const stateKey = `aired:anilist:${e.anilist_id}`;
            const stored = await env.RSS_BOT_KV.get(stateKey);
            if (stored === String(e.episode)) continue;

            console.log(`[AIRING] NEW: ${e.title} ep ${e.episode}`);

            const cache = { en: null, fa: null };
            for (const chatId of chats) {
                try {
                    const lang = await getLang(env, chatId);
                    if (!cache[lang]) {
                        cache[lang] = formatAiringMessage(
                            e.title, e.episode, e.episodes, e.url, lang
                        );
                    }
                    const res = await sendMessage(env, chatId, cache[lang]);
                    SUBREQUEST_COUNT++;
                    if (res && res.ok === false) {
                        const desc = res.description || '';
                        if (desc.includes('blocked') || desc.includes('chat not found') ||
                            desc.includes('kicked') || desc.includes('user is deactivated')) {
                            await removeChatFromBroadcast(env, chatId);
                        }
                    }
                } catch (err) {}
            }

            await env.RSS_BOT_KV.put(stateKey, String(e.episode), { expirationTtl: 30 * 86400 });
        } catch (err) {
            console.error(`[AIRING] ${e.anilist_id} error:`, err.message);
        }
    }

    console.log(`[AIRING] done. subrequests: ${SUBREQUEST_COUNT}`);
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
    const richRes = await sendRichMessage(env, chatId, formatDaySchedule(dayKey, entries, lang), { reply_markup: keyboard });
    if (richRes && richRes.ok) return;
    await sendMessage(env, chatId, formatDaySchedulePlain(dayKey, entries, lang), { reply_markup: keyboard });
}

async function editScheduleMessage(env, chatId, messageId, dayKey, entries, lang, keyboard) {
    const richRes = await editRichMessage(env, chatId, messageId, formatDaySchedule(dayKey, entries, lang), { reply_markup: keyboard });
    if (richRes && richRes.ok) return;
    await editMessage(env, chatId, messageId, formatDaySchedulePlain(dayKey, entries, lang), { reply_markup: keyboard });
}

async function handleSchedule(env, chatId) {
    try {
        const lang = await getLang(env, chatId);
        const tz = SCHEDULE_TZ[lang] || SCHEDULE_TZ.en;
        const today = getCurrentDay(tz);
        const entries = await fetchScheduleForDay(env, today);
        await sendScheduleMessage(env, chatId, today, entries, lang, buildDayKeyboard(today, lang));
    } catch (e) {
        console.error('[ERROR] /schedule failed:', e);
        const lang = await getLang(env, chatId);
        await sendMessage(env, chatId, lang === 'fa' ? `📅 <b>خطای برنامه:</b> ${e.message}` : `📅 <b>Schedule error:</b> ${e.message}`);
    }
}

// ============= OTHER COMMANDS =============

async function handleStart(env, chatId) {
    const lang = await getLang(env, chatId);
    await applyBotFatherCommandsToChat(env, chatId, lang);
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
        reply_markup: {
            inline_keyboard: [[
                { text: 'فارسی🇮🇷', callback_data: 'lang:fa' },
                { text: '🇬🇧English', callback_data: 'lang:en' },
            ]],
        },
    });
}

async function handleCallbackQuery(env, callbackQuery) {
    const { id, data, message } = callbackQuery;
    const chatId = message.chat.id;
    const messageId = message.message_id;

    if (data && data.startsWith('lang:')) {
        const lang = data.split(':')[1];
        await setLang(env, chatId, lang);
        await applyBotFatherCommandsToChat(env, chatId, lang);
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
            const entries = await fetchScheduleForDay(env, dayKey);
            await editScheduleMessage(env, chatId, messageId, dayKey, entries, lang, buildDayKeyboard(dayKey, lang));
            await answerCallback(env, id);
        } catch (e) {
            console.error('[ERROR] sched callback failed:', e);
            await answerCallback(env, id);
            const lang = await getLang(env, chatId);
            await sendMessage(env, chatId, lang === 'fa' ? `📅 <b>خطای برنامه:</b> ${e.message}` : `📅 <b>Schedule error:</b> ${e.message}`);
        }
        return;
    }
}

async function handleDebug(env, chatId) {
    try {
        const nowUnix = Math.floor(Date.now() / 1000);
        const windowStart = nowUnix - 25 * 60;
        const windowEnd = nowUnix + 60;

        const week = await fetchScheduleWeek(env);

        let total = 0;
        const upcoming = [];
        for (const d of Object.keys(week)) {
            total += week[d].length;
            for (const e of week[d]) {
                if (e.airingAt >= windowStart && e.airingAt <= windowEnd) upcoming.push(e);
            }
        }

        let out = `🐛 <b>Debug</b>\n`;
        out += `Entries in week cache: ${total}\n`;
        out += `Recently aired (last 25m): ${upcoming.length}\n\n`;

        for (const e of upcoming.slice(0, 15)) {
            const stored = await env.RSS_BOT_KV.get(`aired:anilist:${e.anilist_id}`);
            const notified = stored === String(e.episode) ? '✅' : '🆕';
            out += `${notified} <b>${e.title}</b>\n`;
            out += `   Ep ${e.episode}/${e.episodes || '?'}\n`;
        }

        out += `\nSubrequests: ${SUBREQUEST_COUNT}`;
        await sendMessage(env, chatId, out);
    } catch (e) {
        console.error('[ERROR] /debug failed:', e);
        await sendMessage(env, chatId, `🐛 <b>Debug error:</b> ${e.message}`);
    }
}

// ============= WORKER ENTRY POINT =============

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
