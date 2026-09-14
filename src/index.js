// ============================================================
// Telegram RSS Bot for SubsPlease – Cloudflare Worker
// With encrypted KV storage, batch filter, duplicate prevention,
// MAL link resolution (Jikan + fallback + cache),
// PV-only /unsub, group /unsub hint, /debug, /maltest,
// and /schedule (bilingual: fa=Asia/Tehran, en=UTC).
// ============================================================

const RSS_URL = 'https://subsplease.org/rss/?t&r=1080';
const TELEGRAM_API = 'https://api.telegram.org/bot';

// Per-language timezone for the schedule.
const SCHEDULE_TZ = {
    fa: 'Asia/Tehran',
    en: 'UTC',
};

// ============= ENCRYPTION HELPERS =============
let ENCRYPTION_KEY = 'default-key-please-change-me';

function encryptData(data) {
    const jsonStr = JSON.stringify(data);
    const encoder = new TextEncoder();
    const plaintext = encoder.encode(jsonStr);
    const keyBytes = encoder.encode(
        ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32)
    );

    const encrypted = new Uint8Array(plaintext.length);
    for (let i = 0; i < plaintext.length; i++) {
        encrypted[i] = plaintext[i] ^ keyBytes[i % keyBytes.length];
    }
    return btoa(String.fromCharCode(...encrypted));
}

function decryptData(encryptedStr) {
    const encrypted = Uint8Array.from(atob(encryptedStr), (c) =>
        c.charCodeAt(0)
    );
    const keyBytes = new TextEncoder().encode(
        ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32)
    );

    const decrypted = new Uint8Array(encrypted.length);
    for (let i = 0; i < encrypted.length; i++) {
        decrypted[i] = encrypted[i] ^ keyBytes[i % keyBytes.length];
    }
    return JSON.parse(new TextDecoder().decode(decrypted));
}

// ============= RSS HELPERS =============

function decodeHtmlEntities(str) {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
}

async function fetchLatestTitles(n = 10) {
    const res = await fetch(RSS_URL);
    const xml = await res.text();

    const titles = [];
    const itemRegex = /<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<\/item>/gi;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && titles.length < n) {
        titles.push(decodeHtmlEntities(match[1]));
    }
    return titles;
}

async function fetchLatestTitle() {
    const titles = await fetchLatestTitles(1);
    return titles.length > 0 ? titles[0] : null;
}

function cleanTitle(rawTitle) {
    let title = rawTitle.replace(/^\[SubsPlease\]\s*/i, '');
    title = title.replace(/\.\w+$/, '');
    title = title.replace(/\s*\[[A-F0-9]{8}\]$/, '');
    title = title.replace(/\s*\(\d{3,4}p\)$/, '');
    title = title.replace(/\s*\[Batch\]\s*/i, ' ');
    title = title.replace(/\s+/g, ' ').trim();
    return title;
}

function buildBaseQuery(title) {
    return title
        .replace(/\s*[-–]\s*S\d+\s*[-–]\s*\d+.*$/i, '')
        .replace(/\s*S\d+\s*[-–]\s*\d+.*$/i, '')
        .replace(/\s*[-–]\s*\d+.*$/i, '')
        .replace(/\s*\(\d{4}\)$/i, '')
        .replace(/[!?:.]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ============= MAL CACHE (KV, encrypted) =============

async function getCachedMalLink(env, cleanTitle) {
    const key = `mal:${cleanTitle}`;
    try {
        const raw = await env.RSS_BOT_KV.get(key);
        if (!raw) return null;
        return decryptData(raw);
    } catch (e) {
        return null;
    }
}

async function setCachedMalLink(env, cleanTitle, link) {
    if (!link) return;
    const key = `mal:${cleanTitle}`;
    try {
        await env.RSS_BOT_KV.put(key, encryptData(link));
    } catch (e) {
        console.error('[MAL] Cache set failed:', e.message);
    }
}

// ============= MAL SEARCH =============

async function tryJikan(query, attempt = 1) {
    const url = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=1`;

    try {
        const res = await fetch(url, {
            headers: {
                Accept: 'application/json',
                'User-Agent': 'SubsPleaseTelegramBot/1.0 (+https://workers.dev)',
            },
        });

        console.log(`[MAL] Jikan "${query}" → HTTP ${res.status} (attempt ${attempt})`);

        if (res.status === 429 && attempt < 5) {
            const wait = 2000 * attempt;
            console.warn(`[MAL] Jikan 429 for "${query}", retrying in ${wait}ms...`);
            await new Promise((r) => setTimeout(r, wait));
            return tryJikan(query, attempt + 1);
        }

        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            console.warn(`[MAL] Jikan non-OK for "${query}": ${txt.slice(0, 200)}`);
            return null;
        }

        const json = await res.json();
        const count = Array.isArray(json.data) ? json.data.length : 0;
        console.log(`[MAL] Jikan "${query}" → ${count} result(s)`);

        if (count > 0 && json.data[0].url) {
            const link = json.data[0].url;
            console.log(`[MAL] Jikan hit for "${query}": ${link}`);
            return link;
        }

        console.warn(`[MAL] Jikan 0 usable results for "${query}"`);
    } catch (e) {
        console.error(`[MAL] Jikan fetch error for "${query}":`, e.message);
    }
    return null;
}

async function tryMalScrape(query) {
    try {
        const url = `https://myanimelist.net/anime.php?q=${encodeURIComponent(query)}&cat=anime`;
        const res = await fetch(url, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        });
        console.log(`[MAL] Scrape "${query}" → HTTP ${res.status}`);
        if (!res.ok) return null;

        const html = await res.text();
        const match = html.match(
            /href="(https?:\/\/myanimelist\.net\/anime\/\d+\/[A-Za-z0-9_!\-]+)"/
        );
        if (match) {
            const url2 = match[1].replace(/\/$/, '');
            console.log(`[MAL] Scrape hit for "${query}": ${url2}`);
            return url2;
        }
        console.warn(`[MAL] Scrape found no link for "${query}"`);
    } catch (e) {
        console.error('[MAL] Scrape error:', e.message);
    }
    return null;
}

async function searchMalLink(env, title) {
    if (!title) return null;

    const cached = await getCachedMalLink(env, title);
    if (cached) {
        console.log(`[MAL] Cache hit for "${title}": ${cached}`);
        return cached;
    }

    const baseQuery = buildBaseQuery(title);
    if (!baseQuery) return null;

    const candidates = [];
    const push = (q) => {
        const v = (q || '').trim();
        if (v.length > 2 && !candidates.includes(v)) candidates.push(v);
    };

    push(baseQuery);
    push(baseQuery.split(/\s*[-–]\s*/)[0]);
    push(baseQuery.replace(/\s*[-–]\s*/g, ' '));

    const words = baseQuery.split(/\s+/);
    if (words.length > 2) {
        push(words.slice(0, 2).join(' '));
    }
    push(words[0]);

    console.log(`[MAL] Candidates for "${title}": ${JSON.stringify(candidates)}`);

    let link = null;
    for (const query of candidates) {
        link = await tryJikan(query);
        if (link) break;
        await new Promise((r) => setTimeout(r, 600));
    }

    if (!link) {
        console.warn(`[MAL] All Jikan candidates failed for "${title}", trying scrape...`);
        link = await tryMalScrape(baseQuery);
        if (!link && candidates.length > 1) {
            link = await tryMalScrape(candidates[1]);
        }
    }

    if (link) {
        await setCachedMalLink(env, title, link);
    }

    return link;
}

// ============= FORMATTING =============

function formatTitle(rawTitle, lang = 'en', malLink = null) {
    const title = cleanTitle(rawTitle);

    let message;
    if (lang === 'fa') {
        message = `انیمه ${title} اومد!`;
    } else {
        message = `${title} Aired!`;
    }

    if (malLink) {
        const label = lang === 'fa' ? 'لینک MAL' : 'MAL Link';
        message += `\n\n<a href="${malLink}">${label}</a>`;
    }

    return message;
}

// ============= MESSAGE SPLITTER =============

function splitMessage(text, maxLength = 4000) {
    const lines = text.split('\n');
    const chunks = [];
    let current = '';

    for (const line of lines) {
        const candidate = current ? current + '\n' + line : line;
        if (candidate.length > maxLength) {
            if (current) chunks.push(current);
            current = line;
        } else {
            current = candidate;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

function truncateForEdit(text, maxLength = 4000) {
    if (text.length <= maxLength) return text;
    return (
        text.slice(0, maxLength - 40).replace(/\n[^\n]*$/, '') +
        '\n\n<i>… (truncated)</i>'
    );
}

// ============= TELEGRAM API HELPERS =============

async function sendMessage(env, chatId, text, extra = {}) {
    const url = `${TELEGRAM_API}${env.BOT_TOKEN}/sendMessage`;
    const payload = {
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...extra,
    };
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    try {
        return await res.json();
    } catch {
        return { ok: res.ok };
    }
}

async function editMessage(env, chatId, messageId, text, extra = {}) {
    const url = `${TELEGRAM_API}${env.BOT_TOKEN}/editMessageText`;
    const payload = {
        chat_id: chatId,
        message_id: messageId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...extra,
    };
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    try {
        return await res.json();
    } catch {
        return { ok: res.ok };
    }
}

async function answerCallback(env, callbackQueryId) {
    return fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
}

// ============= ENCRYPTED KV HELPERS =============

async function getLang(env, chatId) {
    const key = `lang:${chatId}`;
    try {
        const raw = await env.RSS_BOT_KV.get(key);
        if (!raw) return 'en';
        return decryptData(raw);
    } catch (e) {
        console.error(`[ERROR] Failed to decrypt lang for ${chatId}:`, e);
        try {
            await env.RSS_BOT_KV.put(key, encryptData('en'));
        } catch {}
        return 'en';
    }
}

async function setLang(env, chatId, lang) {
    const key = `lang:${chatId}`;
    await env.RSS_BOT_KV.put(key, encryptData(lang));
}

async function getBroadcastChats(env) {
    const raw = await env.RSS_BOT_KV.get('broadcast_chats');
    if (!raw) return [];
    try {
        return decryptData(raw);
    } catch (e) {
        console.error('[ERROR] Failed to decrypt broadcast_chats:', e);
        try {
            await env.RSS_BOT_KV.put('broadcast_chats', encryptData([]));
        } catch {}
        return [];
    }
}

async function saveBroadcastChats(env, chats) {
    await env.RSS_BOT_KV.put('broadcast_chats', encryptData(chats));
}

async function addChatToBroadcast(env, chatId) {
    const chats = await getBroadcastChats(env);
    if (!chats.includes(chatId)) {
        chats.push(chatId);
        await saveBroadcastChats(env, chats);
    }
}

async function removeChatFromBroadcast(env, chatId) {
    const chats = await getBroadcastChats(env);
    const filtered = chats.filter((id) => id !== chatId);
    if (filtered.length !== chats.length) {
        await saveBroadcastChats(env, filtered);
    }
}

// ============= LAST-SENT STATE =============

async function getLastTitle(env) {
    const raw = await env.RSS_BOT_KV.get('last_title');
    if (!raw) return null;
    try {
        return decryptData(raw);
    } catch (e) {
        console.error('[ERROR] Failed to decrypt last_title:', e);
        return null;
    }
}

async function setLastTitle(env, title) {
    await env.RSS_BOT_KV.put('last_title', encryptData(title));
}

// ============= SCHEDULE HELPERS =============

// Canonical English day names — used as API keys and callback data.
const DAYS = [
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday',
];

// Short English labels for buttons.
const DAY_LABELS_EN = {
    Monday: 'Mon',
    Tuesday: 'Tue',
    Wednesday: 'Wed',
    Thursday: 'Thu',
    Friday: 'Fri',
    Saturday: 'Sat',
    Sunday: 'Sun',
};

// Persian full day names (header + buttons).
const DAY_FULL_FA = {
    Monday: 'دوشنبه',
    Tuesday: 'سه‌شنبه',
    Wednesday: 'چهارشنبه',
    Thursday: 'پنجشنبه',
    Friday: 'جمعه',
    Saturday: 'شنبه',
    Sunday: 'یکشنبه',
};

// Iranian week order (Saturday first) — used when lang is fa.
const DAYS_FA_ORDER = [
    'Saturday',
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
];

function scheduleApiUrl(tz) {
    return `https://subsplease.org/api/?f=schedule&tz=${encodeURIComponent(tz)}`;
}

/**
 * Get the current day name in the given IANA timezone.
 * Uses Intl.DateTimeFormat with timeZone option.
 */
function getCurrentDay(tz) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'long',
    });
    const dayName = fmt.format(new Date()); // e.g. "Monday"
    return DAYS.includes(dayName) ? dayName : 'Saturday';
}

async function fetchSchedule(tz) {
    const res = await fetch(scheduleApiUrl(tz), {
        headers: {
            'User-Agent': 'SubsPleaseTelegramBot/1.0 (+https://workers.dev)',
            Accept: 'application/json',
        },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.schedule) throw new Error('No schedule data returned');
    return json.schedule;
}

/**
 * Format a day's schedule in the given language. Times come from the API
 * already in the timezone we requested, so no manual conversion is needed.
 */
function formatDaySchedule(day, entries, lang) {
    const isFa = lang === 'fa';

    const dayName = isFa ? DAY_FULL_FA[day] : day;
    const tzLabel = isFa ? 'به وقت ایران' : 'UTC';

    let msg = `📅 <b>${dayName}</b> (${tzLabel})\n\n`;

    if (!entries || entries.length === 0) {
        msg += isFa
            ? '<i>هیچ انتشار برنامه‌ریزی‌شده‌ای وجود ندارد.</i>'
            : '<i>No releases scheduled.</i>';
        return msg;
    }

    for (const entry of entries) {
        const safeTitle = String(entry.title || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        msg += `<code>${entry.time}</code>  ${safeTitle}\n`;
    }
    return msg;
}

/**
 * Build the day keyboard. Callback data stays English so the API keys
 * keep working; only the labels and order change per language.
 */
function buildDayKeyboard(activeDay, lang) {
    const isFa = lang === 'fa';
    const order = isFa ? DAYS_FA_ORDER : DAYS;
    const labels = isFa
        ? DAY_FULL_FA
        : DAY_LABELS_EN;

    const buttons = order.map((d) => ({
        text: d === activeDay ? `⭐ ${labels[d]}` : labels[d],
        callback_data: `sched:${d}`,
    }));

    const row1 = buttons.slice(0, 4);
    const row2 = buttons.slice(4);
    const rows = [row1, row2].filter((r) => r.length > 0);

    return { inline_keyboard: rows };
}

// ============= COMMAND HANDLERS =============

async function handleStart(env, chatId) {
    const lang = await getLang(env, chatId);
    const text =
        lang === 'fa'
            ? 'سلام! من ربات اطلاع‌رسانی انیمه هستم.\n✅ شما مشترک شدید.\nبرای تغییر زبان از /language استفاده کنید.\nبرای لغو اشتراک از /unsub استفاده کنید.'
            : 'Hi! I am an anime release notification bot.\n✅ You are now subscribed.\nUse /language to change the language.\nUse /unsub to unsubscribe.';
    await sendMessage(env, chatId, text);
    await addChatToBroadcast(env, chatId);
}

async function handleUnsub(env, chatId) {
    const lang = await getLang(env, chatId);
    await removeChatFromBroadcast(env, chatId);
    const text =
        lang === 'fa'
            ? '❌ اشتراک شما لغو شد.\nبرای فعال‌سازی مجدد از /start استفاده کنید.'
            : '❌ You have been unsubscribed.\nUse /start to subscribe again.';
    await sendMessage(env, chatId, text);
}

async function handleUnsubInGroup(env, chatId) {
    const lang = await getLang(env, chatId);
    const text =
        lang === 'fa'
            ? 'ℹ️ این ربات به‌صورت گروهی مشترک می‌شود و نمی‌توانید فقط خودتان را از لیست ارسال لغو کنید.\n\nاگر نمی‌خواهید این گروه پیام دریافت کند، لطفاً ربات را از گروه حذف کنید (Kick/Remove).'
            : 'ℹ️ This bot subscribes the whole group at once, so you can\'t unsubscribe just yourself from the broadcast list.\n\nIf you don\'t want this group to receive messages, please remove the bot from the group (Kick/Remove).';
    await sendMessage(env, chatId, text);
}

async function handleDebug(env, chatId) {
    try {
        const rawTitles = await fetchLatestTitles(30);
        const filtered = rawTitles.filter((t) => !/\bbatch\b/i.test(t)).slice(0, 10);

        if (filtered.length === 0) {
            await sendMessage(env, chatId, '🐛 <b>Debug:</b> No non-batch titles found in RSS feed.');
            return;
        }

        const lang = await getLang(env, chatId);

        await sendMessage(
            env,
            chatId,
            `🐛 <b>Debug:</b> sending ${filtered.length} latest titles...`
        );

        for (let i = 0; i < filtered.length; i++) {
            const rawTitle = filtered[i];
            const clean = cleanTitle(rawTitle);
            const malLink = await searchMalLink(env, clean);
            const body = formatTitle(rawTitle, lang, malLink);
            const finalText = `<b>#${i + 1}</b>\n${body}`;

            await sendMessage(env, chatId, finalText);

            await new Promise((r) => setTimeout(r, 400));
        }

        await sendMessage(env, chatId, '🐛 <b>Debug complete.</b>');
    } catch (e) {
        console.error('[ERROR] /debug failed:', e);
        await sendMessage(env, chatId, `🐛 <b>Debug error:</b> ${e.message}`);
    }
}

async function handleMalTest(env, chatId) {
    const samples = [
        'Azur Lane - Bisoku Zenshin! S2 - 11',
        'One Piece - 1122',
        'Bleach - TYBW - 38',
    ];

    let out = '🧪 <b>MAL Search Test</b>\n\n';

    for (const s of samples) {
        const base = buildBaseQuery(s);
        const link = await searchMalLink(env, s);

        out += `<b>Input:</b> <code>${s}</code>\n`;
        out += `<b>Base:</b> <code>${base}</code>\n`;
        out += `<b>Link:</b> ${link ? `<a href="${link}">${link}</a>` : '❌ none'}\n\n`;

        await new Promise((r) => setTimeout(r, 1000));
    }

    await sendMessage(env, chatId, out);
}

/**
 * /schedule — shows today's schedule with 7 day buttons, in the chat's
 * chosen language and corresponding timezone (fa=Asia/Tehran, en=UTC).
 */
async function handleSchedule(env, chatId) {
    try {
        const lang = await getLang(env, chatId);
        const tz = SCHEDULE_TZ[lang] || SCHEDULE_TZ.en;

        const schedule = await fetchSchedule(tz);
        const today = getCurrentDay(tz);

        const text = truncateForEdit(formatDaySchedule(today, schedule[today], lang));
        const keyboard = buildDayKeyboard(today, lang);

        await sendMessage(env, chatId, text, { reply_markup: keyboard });
    } catch (e) {
        console.error('[ERROR] /schedule failed:', e);
        const lang = await getLang(env, chatId);
        const errText = lang === 'fa'
            ? `📅 <b>خطای برنامه:</b> ${e.message}`
            : `📅 <b>Schedule error:</b> ${e.message}`;
        await sendMessage(env, chatId, errText);
    }
}

async function handleLanguage(env, chatId) {
    const keyboard = {
        inline_keyboard: [
            [
                { text: 'فارسی🇮🇷', callback_data: 'lang:fa' },
                { text: '🇬🇧English', callback_data: 'lang:en' },
            ],
        ],
    };
    await sendMessage(env, chatId, '🌐 Choose your language:', {
        reply_markup: keyboard,
    });
}

async function handleCallbackQuery(env, callbackQuery) {
    const { id, data, message } = callbackQuery;
    const chatId = message.chat.id;
    const messageId = message.message_id;

    // ----- Language buttons -----
    if (data && data.startsWith('lang:')) {
        const lang = data.split(':')[1];
        await setLang(env, chatId, lang);
        const confirmText =
            lang === 'fa'
                ? '✅ زبان به فارسی تغییر کرد.'
                : '✅ Language changed to English.';
        await editMessage(env, chatId, messageId, confirmText);
        await answerCallback(env, id);
        return;
    }

    // ----- Schedule day buttons -----
    if (data && data.startsWith('sched:')) {
        const day = data.slice('sched:'.length);
        if (!DAYS.includes(day)) {
            await answerCallback(env, id);
            return;
        }

        try {
            const lang = await getLang(env, chatId);
            const tz = SCHEDULE_TZ[lang] || SCHEDULE_TZ.en;

            const schedule = await fetchSchedule(tz);
            const text = truncateForEdit(formatDaySchedule(day, schedule[day], lang));
            const keyboard = buildDayKeyboard(day, lang);
            await editMessage(env, chatId, messageId, text, {
                reply_markup: keyboard,
            });
            await answerCallback(env, id);
        } catch (e) {
            console.error('[ERROR] sched callback failed:', e);
            await answerCallback(env, id);
            const lang = await getLang(env, chatId);
            const errText = lang === 'fa'
                ? `📅 <b>خطای برنامه:</b> ${e.message}`
                : `📅 <b>Schedule error:</b> ${e.message}`;
            await sendMessage(env, chatId, errText);
        }
        return;
    }
}

// ============= RSS BROADCAST =============

async function broadcastLatest(env) {
    const rawTitle = await fetchLatestTitle();
    if (!rawTitle) {
        console.error('No title found in RSS feed.');
        return;
    }

    if (/\bbatch\b/i.test(rawTitle)) {
        console.log(`Skipping batch release: ${rawTitle}`);
        return;
    }

    const lastTitle = await getLastTitle(env);
    if (lastTitle === rawTitle) {
        console.log(`No change since last broadcast: ${rawTitle}`);
        return;
    }

    const chats = await getBroadcastChats(env);
    if (chats.length === 0) {
        await setLastTitle(env, rawTitle);
        return;
    }

    const searchQuery = cleanTitle(rawTitle);
    const malLink = await searchMalLink(env, searchQuery);

    const cache = { en: null, fa: null };

    for (const chatId of chats) {
        try {
            const lang = await getLang(env, chatId);
            if (!cache[lang]) {
                cache[lang] = formatTitle(rawTitle, lang, malLink);
            }
            const res = await sendMessage(env, chatId, cache[lang]);

            if (res && res.ok === false) {
                const desc = res.description || '';
                if (
                    desc.includes('blocked') ||
                    desc.includes('chat not found') ||
                    desc.includes('kicked') ||
                    desc.includes('user is deactivated')
                ) {
                    console.warn(`Removing ${chatId} from broadcast list: ${desc}`);
                    await removeChatFromBroadcast(env, chatId);
                }
            }
        } catch (err) {
            console.error(`Failed to send to ${chatId}:`, err);
        }
    }

    await setLastTitle(env, rawTitle);
}

// ============= WORKER ENTRY POINT =============

export default {
    async fetch(request, env, ctx) {
        ENCRYPTION_KEY = env.DB_ENCRYPTION_KEY || 'default-key-please-change-me';
        globalThis.ENCRYPTION_KEY = ENCRYPTION_KEY;

        if (!env.BOT_TOKEN) {
            console.error('BOT_TOKEN is not set');
            return new Response('Bot token missing', { status: 500 });
        }

        if (request.method === 'GET') {
            return new Response('OK', { status: 200 });
        }

        if (request.method !== 'POST') {
            return new Response('Method Not Allowed', { status: 405 });
        }

        let update;
        try {
            update = await request.json();
        } catch {
            return new Response('Bad Request', { status: 400 });
        }

        try {
            if (update.message) {
                const msg = update.message;
                const chatId = msg.chat.id;
                const text = msg.text || '';
                const chatType = msg.chat.type;

                if (chatType === 'private') {
                    if (text.startsWith('/start')) {
                        await handleStart(env, chatId);
                    } else if (text.startsWith('/unsub')) {
                        await handleUnsub(env, chatId);
                    } else if (text.startsWith('/language')) {
                        await handleLanguage(env, chatId);
                    } else if (text.startsWith('/debug')) {
                        await handleDebug(env, chatId);
                    } else if (text.startsWith('/maltest')) {
                        await handleMalTest(env, chatId);
                    } else if (text.startsWith('/schedule')) {
                        await handleSchedule(env, chatId);
                    }
                } else {
                    await addChatToBroadcast(env, chatId);

                    if (text.startsWith('/unsub')) {
                        await handleUnsubInGroup(env, chatId);
                    } else if (text.startsWith('/language')) {
                        await handleLanguage(env, chatId);
                    } else if (text.startsWith('/debug')) {
                        await handleDebug(env, chatId);
                    } else if (text.startsWith('/maltest')) {
                        await handleMalTest(env, chatId);
                    } else if (text.startsWith('/schedule')) {
                        await handleSchedule(env, chatId);
                    }
                }
            }

            if (update.callback_query) {
                await handleCallbackQuery(env, update.callback_query);
            }
        } catch (e) {
            console.error('[ERROR] Update handling failed:', e);
        }

        return new Response('OK', { status: 200 });
    },

    async scheduled(event, env, ctx) {
        ENCRYPTION_KEY = env.DB_ENCRYPTION_KEY || 'default-key-please-change-me';
        ctx.waitUntil(broadcastLatest(env));
    },
};
