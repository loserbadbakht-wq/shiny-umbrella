// ============================================================
// Telegram RSS Bot – Jikan-driven airing + cached schedule
// ============================================================

const TELEGRAM_API = 'https://api.telegram.org/bot';
const JIKAN_API = 'https://api.jikan.moe/v4';

const SCHEDULE_TZ = { fa: 'Asia/Tehran', en: 'UTC' };

const SCHED_CACHE_TTL_MS = 3 * 60 * 60 * 1000;     // 3 hours fresh
const SCHED_STALE_TTL_MS = 24 * 60 * 60 * 1000;    // 24 hours stale-acceptable
const SCHED_KV_TTL_SEC = 26 * 60 * 60;             // KV auto-expire (26h)

let SUBREQUEST_COUNT = 0;
const JST = 'Asia/Tokyo';

// ============= JIKAN FETCH WITH RETRY =============

async function jikanFetch(url, label = 'jikan', maxAttempts = 3) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const res = await fetch(url, {
                headers: {
                    Accept: 'application/json',
                    'User-Agent': 'Mozilla/5.0 (compatible; SubsPleaseBot/1.0)',
                },
            });
            SUBREQUEST_COUNT++;

            if (res.ok) return res;

            const retryable = res.status === 429
                || res.status === 500
                || res.status === 502
                || res.status === 503
                || res.status === 504;

            if (!retryable) {
                console.warn(`[JIKAN] ${label} → HTTP ${res.status} (not retryable)`);
                return res;
            }

            const wait = 800 * Math.pow(2, attempt - 1);
            console.warn(`[JIKAN] ${label} → HTTP ${res.status} (attempt ${attempt}/${maxAttempts}), waiting ${wait}ms...`);
            lastError = `HTTP ${res.status}`;
            await new Promise((r) => setTimeout(r, wait));
        } catch (e) {
            const wait = 800 * Math.pow(2, attempt - 1);
            console.warn(`[JIKAN] ${label} → network error (attempt ${attempt}/${maxAttempts}): ${e.message}`);
            lastError = e.message;
            await new Promise((r) => setTimeout(r, wait));
        }
    }

    throw new Error(`${label} failed after ${maxAttempts} attempts: ${lastError}`);
}

/**
 * Low-level: fetch one page from a specific Jikan schedule endpoint.
 * Returns { data, lastVisiblePage } or throws.
 */
async function fetchSchedulePage(endpoint, page, label) {
    const url = `${JIKAN_API}${endpoint}${endpoint.includes('?') ? '&' : '?'}limit=25&page=${page}`;
    const res = await jikanFetch(url, label);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return {
        data: json.data || [],
        lastVisiblePage: json.pagination?.last_visible_page || 1,
    };
}

// ============= SCHEDULE FETCH WITH CACHE + FALLBACKS =============

async function fetchScheduleForDay(env, jstDay) {
    const cacheKey = `sched:v2:${jstDay}`;

    // ---- 1. Fresh cache ----
    try {
        const cached = await env.RSS_BOT_KV.get(cacheKey);
        if (cached) {
            const parsed = JSON.parse(cached);
            const age = Date.now() - (parsed.ts || 0);
            if (age < SCHED_CACHE_TTL_MS) {
                console.log(`[SCHEDULE] fresh cache hit for ${jstDay} (age ${Math.round(age / 60000)}m)`);
                return parsed.data;
            }
        }
    } catch (e) {
        console.warn(`[SCHEDULE] cache read failed: ${e.message}`);
    }

    // ---- 2. Try Jikan (two endpoint formats) ----
    const endpoints = [
        { path: `/schedules?filter=${encodeURIComponent(jstDay)}`, name: 'schedules?filter' },
        { path: `/schedules/${encodeURIComponent(jstDay)}`, name: 'schedules/{day}' },
    ];

    for (const ep of endpoints) {
        try {
            console.log(`[SCHEDULE] trying ${ep.name} for ${jstDay}`);
            const all = [];
            let page = 1;
            const MAX_PAGES = 4;

            while (page <= MAX_PAGES) {
                const { data, lastVisiblePage } = await fetchSchedulePage(ep.path, page, `${ep.name} p${page}`);
                all.push(...data);
                if (page >= lastVisiblePage || data.length === 0) break;
                page++;
                await new Promise((r) => setTimeout(r, 400));
            }

            if (all.length > 0) {
                // Save to cache
                try {
                    await env.RSS_BOT_KV.put(
                        cacheKey,
                        JSON.stringify({ ts: Date.now(), data: all }),
                        { expirationTtl: SCHED_KV_TTL_SEC }
                    );
                    console.log(`[SCHEDULE] cached ${all.length} entries for ${jstDay}`);
                } catch (e) {
                    console.warn(`[SCHEDULE] cache write failed: ${e.message}`);
                }
                return all;
            }
        } catch (e) {
            console.warn(`[SCHEDULE] ${ep.name} failed: ${e.message}`);
        }
    }

    // ---- 3. Stale cache fallback ----
    try {
        const cached = await env.RSS_BOT_KV.get(cacheKey);
        if (cached) {
            const parsed = JSON.parse(cached);
            const age = Date.now() - (parsed.ts || 0);
            if (age < SCHED_STALE_TTL_MS) {
                console.warn(`[SCHEDULE] all endpoints failed; using stale cache (age ${Math.round(age / 60000)}m)`);
                return parsed.data;
            }
        }
    } catch (e) {
        console.warn(`[SCHEDULE] stale cache read failed: ${e.message}`);
    }

    // ---- 4. Nothing worked ----
    throw new Error(`All schedule sources failed for ${jstDay}`);
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
        if (!json.ok || !Array.isArray(json.result)) return null;
        return json.result;
    } catch (e) {
        console.error('[COMMANDS] getMyCommands error:', e.message);
        return null;
    }
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
    } catch (e) { console.error('[COMMANDS] error:', e.message); }
}

// ============= ENCRYPTION HELPERS =============
let ENCRYPTION_KEY = 'default-key-please-change-me';

function encryptData(data) {
    const jsonStr = JSON.stringify(data);
    const encoder = new TextEncoder();
    const plaintext = encoder.encode(jsonStr);
    const keyBytes = encoder.encode(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32));
    const encrypted = new Uint8Array(plaintext.length);
    for (let i = 0; i < plaintext.length; i++) encrypted[i] = plaintext[i] ^ keyBytes[i % keyBytes.length];
    return btoa(String.fromCharCode(...encrypted));
}

function decryptData(encryptedStr) {
    const encrypted = Uint8Array.from(atob(encryptedStr), (c) => c.charCodeAt(0));
    const keyBytes = new TextEncoder().encode(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32));
    const decrypted = new Uint8Array(encrypted.length);
    for (let i = 0; i < encrypted.length; i++) decrypted[i] = encrypted[i] ^ keyBytes[i % keyBytes.length];
    return JSON.parse(new TextDecoder().decode(decrypted));
}

// ============= KV HELPERS =============

async function getLang(env, chatId) {
    const key = `lang:${chatId}`;
    try {
        const raw = await env.RSS_BOT_KV.get(key);
        if (!raw) return 'en';
        return decryptData(raw);
    } catch (e) {
        try { await env.RSS_BOT_KV.put(key, encryptData('en')); } catch {}
        return 'en';
    }
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

// ============= EPISODE LOOKUP =============

async function fetchLatestEpisode(animeId) {
    const firstUrl = `${JIKAN_API}/anime/${animeId}/episodes`;
    const firstRes = await jikanFetch(firstUrl, `episodes ${animeId} p1`, 2);
    if (!firstRes.ok) return null;

    let json = await firstRes.json();
    const lastPage = json?.pagination?.last_visible_page || 1;

    if (lastPage > 1) {
        const lastUrl = `${JIKAN_API}/anime/${animeId}/episodes?page=${lastPage}`;
        const lastRes = await jikanFetch(lastUrl, `episodes ${animeId} p${lastPage}`, 2);
        if (!lastRes.ok) return null;
        json = await lastRes.json();
    }

    const eps = json.data || [];
    if (eps.length === 0) return null;
    return eps[eps.length - 1];
}

// ============= TIME CONVERSION =============

function convertJstTimeTo(jstTime, targetTz) {
    if (!jstTime) return '--:--';
    try {
        const now = new Date();
        const ymd = new Intl.DateTimeFormat('en-CA', {
            timeZone: JST, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(now);
        const d = new Date(`${ymd}T${jstTime}:00+09:00`);
        return new Intl.DateTimeFormat('en-GB', {
            timeZone: targetTz,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).format(d);
    } catch (e) {
        return jstTime;
    }
}

// ============= TITLE PARSING =============

function parseJikanTitle(title) {
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

// ============= MESSAGE FORMATTING =============

function formatAiringMessage(anime, epNum, totalEps, malLink, lang) {
    const { base, season } = parseJikanTitle(anime.title || '');

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
    if (totalEps) msg += `\n\n${counterLabel}: ${epNum}/${totalEps}`;
    else msg += `\n\n${counterLabel}: ${epNum}/?`;

    if (malLink) {
        const label = lang === 'fa' ? 'لینک MAL' : 'MAL Link';
        msg += `\n\n<a href="${malLink}">${label}</a>`;
    }

    return msg;
}

// ============= TELEGRAM API HELPERS =============

async function sendMessage(env, chatId, text, extra = {}) {
    const url = `${TELEGRAM_API}${env.BOT_TOKEN}/sendMessage`;
    const payload = {
        chat_id: chatId, text, parse_mode: 'HTML',
        disable_web_page_preview: true, ...extra,
    };
    const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    try { return await res.json(); } catch { return { ok: res.ok }; }
}

async function editMessage(env, chatId, messageId, text, extra = {}) {
    const url = `${TELEGRAM_API}${env.BOT_TOKEN}/editMessageText`;
    const payload = {
        chat_id: chatId, message_id: messageId, text,
        parse_mode: 'HTML', disable_web_page_preview: true, ...extra,
    };
    const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    try { return await res.json(); } catch { return { ok: res.ok }; }
}

async function sendRichMessage(env, chatId, html, extra = {}) {
    const url = `${TELEGRAM_API}${env.BOT_TOKEN}/sendRichMessage`;
    const payload = { chat_id: chatId, rich_message: { html }, ...extra };
    const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    try { return await res.json(); } catch { return { ok: res.ok }; }
}

async function editRichMessage(env, chatId, messageId, html, extra = {}) {
    const url = `${TELEGRAM_API}${env.BOT_TOKEN}/editMessageText`;
    const payload = { chat_id: chatId, message_id: messageId, rich_message: { html }, ...extra };
    const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    try { return await res.json(); } catch { return { ok: res.ok }; }
}

async function answerCallback(env, callbackQueryId) {
    return fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
}

// ============= AIRING POLLER =============

function getJstNow() {
    const now = new Date();
    const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: JST, weekday: 'long' });
    const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: JST, hour: 'numeric', hour12: false });
    const minuteFmt = new Intl.DateTimeFormat('en-US', { timeZone: JST, minute: 'numeric' });
    const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: JST, year: 'numeric', month: '2-digit', day: '2-digit' });

    return {
        now,
        day: dayFmt.format(now).toLowerCase(),
        hour: parseInt(hourFmt.format(now), 10),
        minute: parseInt(minuteFmt.format(now), 10),
        ymd: ymdFmt.format(now),
    };
}

async function broadcastLatest(env) {
    const { day, hour, minute, ymd } = getJstNow();
    const nowMin = hour * 60 + minute;
    console.log(`[AIRING] JST ${ymd} ${hour}:${String(minute).padStart(2, '0')} (${day})`);

    let schedule;
    try {
        schedule = await fetchScheduleForDay(env, day);
    } catch (e) {
        console.error('[AIRING] schedule fetch failed:', e.message);
        return;
    }
    console.log(`[AIRING] ${schedule.length} anime air on ${day}`);

    const recent = schedule.filter((a) => {
        const t = a.broadcast?.time;
        if (!t) return false;
        const [h, m] = t.split(':').map(Number);
        const diff = nowMin - (h * 60 + m);
        return diff >= 0 && diff <= 25;
    });
    console.log(`[AIRING] ${recent.length} aired in last 25 min`);

    if (recent.length === 0) return;

    const chats = await getBroadcastChats(env);
    if (chats.length === 0) return;

    for (const anime of recent) {
        try {
            const latest = await fetchLatestEpisode(anime.mal_id);
            if (!latest || !latest.aired) continue;

            const airedDate = new Date(latest.aired);
            const airedJstYmd = new Intl.DateTimeFormat('en-CA', {
                timeZone: JST, year: 'numeric', month: '2-digit', day: '2-digit',
            }).format(airedDate);
            if (airedJstYmd !== ymd) continue;

            const epNum = latest.mal_id;
            const stateKey = `aired:${anime.mal_id}`;
            const stored = await env.RSS_BOT_KV.get(stateKey);
            if (stored === String(epNum)) continue;

            console.log(`[AIRING] NEW: ${anime.title} ep ${epNum}`);

            const totalEps = anime.episodes || null;
            const cache = { en: null, fa: null };
            for (const chatId of chats) {
                try {
                    const lang = await getLang(env, chatId);
                    if (!cache[lang]) {
                        cache[lang] = formatAiringMessage(anime, epNum, totalEps, anime.url, lang);
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
                } catch (err) {
                    console.error(`[AIRING] send to ${chatId} failed:`, err.message);
                }
            }

            await env.RSS_BOT_KV.put(stateKey, String(epNum), { expirationTtl: 30 * 86400 });
        } catch (e) {
            console.error(`[AIRING] anime ${anime.mal_id} failed:`, e.message);
        }
    }

    console.log(`[AIRING] done. subrequests used: ${SUBREQUEST_COUNT}`);
}

// ============= SCHEDULE COMMAND =============

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

    const sorted = [...entries].sort((a, b) => {
        const ta = a.broadcast?.time || '99:99';
        const tb = b.broadcast?.time || '99:99';
        return ta.localeCompare(tb);
    });

    html += '<table bordered striped columns="1,6">';
    html += isFa ? '<tr><th>ساعت</th><th>انیمه</th></tr>' : '<tr><th>Time</th><th>Show</th></tr>';

    for (const e of sorted) {
        const jstTime = e.broadcast?.time;
        const targetTime = jstTime ? convertJstTimeTo(jstTime, targetTz) : '--:--';
        html += `<tr><td nowrap>${targetTime}</td><td>${escapeHtml(e.title || '')}</td></tr>`;
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

    const sorted = [...entries].sort((a, b) => {
        const ta = a.broadcast?.time || '99:99';
        const tb = b.broadcast?.time || '99:99';
        return ta.localeCompare(tb);
    });

    for (const e of sorted) {
        const jstTime = e.broadcast?.time;
        const targetTime = jstTime ? convertJstTimeTo(jstTime, targetTz) : '--:--';
        msg += `<code>${targetTime}</code>  ${escapeHtml(e.title || '')}\n`;
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

// ============= COMMAND HANDLERS =============

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

async function handleSchedule(env, chatId) {
    try {
        const lang = await getLang(env, chatId);
        const tz = SCHEDULE_TZ[lang] || SCHEDULE_TZ.en;
        const today = getCurrentDay(tz);
        const schedule = await fetchScheduleForDay(env, today.toLowerCase());
        await sendScheduleMessage(env, chatId, today, schedule, lang, buildDayKeyboard(today, lang));
    } catch (e) {
        console.error('[ERROR] /schedule failed:', e);
        const lang = await getLang(env, chatId);
        await sendMessage(env, chatId, lang === 'fa' ? `📅 <b>خطای برنامه:</b> ${e.message}` : `📅 <b>Schedule error:</b> ${e.message}`);
    }
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
            const schedule = await fetchScheduleForDay(env, dayKey.toLowerCase());
            await editScheduleMessage(env, chatId, messageId, dayKey, schedule, lang, buildDayKeyboard(dayKey, lang));
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

// ============= DEBUG COMMAND =============

async function handleDebug(env, chatId) {
    try {
        const { day, hour, minute, ymd } = getJstNow();
        const nowMin = hour * 60 + minute;

        const schedule = await fetchScheduleForDay(env, day);
        const recent = schedule.filter((a) => {
            const t = a.broadcast?.time;
            if (!t) return false;
            const [h, m] = t.split(':').map(Number);
            const diff = nowMin - (h * 60 + m);
            return diff >= 0 && diff <= 25;
        });

        let out = `🐛 <b>Debug</b>\nJST: ${ymd} ${hour}:${String(minute).padStart(2, '0')} (${day})\n`;
        out += `Airing today: ${schedule.length}\n`;
        out += `Recently aired (last 25m): ${recent.length}\n\n`;

        for (const anime of recent.slice(0, 10)) {
            const latest = await fetchLatestEpisode(anime.mal_id);
            const stored = await env.RSS_BOT_KV.get(`aired:${anime.mal_id}`);
            const epNum = latest?.mal_id || '?';
            const notified = stored === String(epNum) ? '✅' : '🆕';
            out += `${notified} <b>${anime.title}</b>\n`;
            out += `   Ep ${epNum}/${anime.episodes || '?'} · broadcast ${anime.broadcast?.time}\n`;
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
