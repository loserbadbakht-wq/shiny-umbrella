// ============================================================
// Telegram RSS Bot – SubsPlease airing + Jikan MAL search
// ============================================================

const RSS_URL = 'https://subsplease.org/rss/?t&r=1080';
const SUBSPLEASE_SCHEDULE = 'https://subsplease.org/api/?f=schedule&tz=UTC';
const TELEGRAM_API = 'https://api.telegram.org/bot';
const JIKAN_API = 'https://api.jikan.moe/v4';

const SCHEDULE_TZ = { fa: 'Asia/Tehran', en: 'UTC' };

let SUBREQUEST_COUNT = 0;

// ============= JIKAN FETCH =============

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
            const retryable = res.status === 429 || res.status >= 500;
            if (!retryable) return res;
            const wait = 1000 * attempt;
            console.warn(`[JIKAN] ${label} → HTTP ${res.status} (${attempt}/${maxAttempts}), wait ${wait}ms`);
            lastError = `HTTP ${res.status}`;
            await new Promise((r) => setTimeout(r, wait));
        } catch (e) {
            const wait = 1000 * attempt;
            console.warn(`[JIKAN] ${label} → ${e.message} (${attempt}/${maxAttempts})`);
            lastError = e.message;
            await new Promise((r) => setTimeout(r, wait));
        }
    }
    throw new Error(`${label} failed: ${lastError}`);
}

// ============= RSS HELPERS =============

function decodeHtmlEntities(str) {
    return str
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

async function fetchLatestTitles(n = 10) {
    const res = await fetch(RSS_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SubsPleaseBot/1.0)' },
    });
    SUBREQUEST_COUNT++;
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

function parseSeasonInfo(rawTitle) {
    const title = cleanTitle(rawTitle);
    const seasonMatch = title.match(/^(.*?)\s+S(\d+)\s*[-–]\s*(\d+)\s*$/i);
    if (seasonMatch) {
        return {
            base: seasonMatch[1].trim(),
            season: parseInt(seasonMatch[2], 10),
            episode: parseInt(seasonMatch[3], 10),
        };
    }
    const epMatch = title.match(/^(.*?)\s*[-–]\s*(\d+)\s*$/);
    if (epMatch) {
        return {
            base: epMatch[1].trim(),
            season: null,
            episode: parseInt(epMatch[2], 10),
        };
    }
    return { base: title, season: null, episode: null };
}

function buildCacheKey(rawTitle) {
    const { base, season } = parseSeasonInfo(rawTitle);
    if (season && season > 1) return `${base} S${season}`;
    return base;
}

// ============= SEASON MATCHING =============

function titleHasSeason(title, seasonNum) {
    if (!seasonNum || seasonNum < 2) return true;
    const t = String(title || '').toLowerCase();
    if (new RegExp(`\\bseason\\s+${seasonNum}\\b`).test(t)) return true;
    const ordinals = { 2: '2nd', 3: '3rd', 4: '4th', 5: '5th', 6: '6th', 7: '7th', 8: '8th', 9: '9th' };
    if (ordinals[seasonNum] && new RegExp(`\\b${ordinals[seasonNum]}\\s+season\\b`).test(t)) return true;
    const roman = { 2: 'ii', 3: 'iii', 4: 'iv', 5: 'v', 6: 'vi', 7: 'vii', 8: 'viii' };
    if (roman[seasonNum] && new RegExp(`\\b${roman[seasonNum]}\\b`).test(t)) return true;
    if (new RegExp(`\\b${seasonNum}\\b`).test(t)) return true;
    return false;
}

function titleSimilarity(query, resultTitle) {
    const STOP = new Set([
        'the','a','an','of','and','to','in','on','at','is',
        'no','ni','wo','wa','ga','de','la','le','season','s','part','cour',
    ]);
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const queryWords = norm(query).split(' ').filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
    if (queryWords.length === 0) return 1;
    const result = norm(resultTitle);
    const matched = queryWords.filter((w) => result.includes(w)).length;
    const total = queryWords.length;
    const score = matched / total;
    let accept;
    if (total <= 2) accept = matched === total;
    else accept = matched >= 2 && score >= 0.4;
    return accept ? Math.max(score, 0.4) : 0;
}

const SIMILARITY_THRESHOLD = 0.4;

// ============= MAL CACHE =============

const MAL_CACHE_VERSION = 'v1';

async function getCachedMalLink(env, key) {
    const k = `mal:${MAL_CACHE_VERSION}:${key}`;
    try {
        const raw = await env.RSS_BOT_KV.get(k);
        if (!raw) return null;
        return decryptData(raw);
    } catch { return null; }
}

async function setCachedMalLink(env, key, link) {
    if (!link) return;
    try { await env.RSS_BOT_KV.put(`mal:${MAL_CACHE_VERSION}:${key}`, encryptData(link)); } catch {}
}

async function getCachedTotalEpisodes(env, key) {
    const k = `eps:${MAL_CACHE_VERSION}:${key}`;
    try {
        const raw = await env.RSS_BOT_KV.get(k);
        if (!raw) return null;
        return decryptData(raw);
    } catch { return null; }
}

async function setCachedTotalEpisodes(env, key, total) {
    if (!total) return;
    try { await env.RSS_BOT_KV.put(`eps:${MAL_CACHE_VERSION}:${key}`, encryptData(total)); } catch {}
}

// ============= JIKAN SEARCH =============

const TYPE_PRIORITY = { tv: 5, ona: 4, ova: 3, special: 2, movie: 1, music: 0 };

async function tryJikanWithEpisodes(query, expectedSeason = null, typeFilter = null) {
    let url = `${JIKAN_API}/anime?q=${encodeURIComponent(query)}&limit=10`;
    if (typeFilter) url += `&type=${typeFilter}`;

    let res;
    try { res = await jikanFetch(url, `search "${query}"`); } catch (e) {
        console.warn(`[MAL] ${e.message}`);
        return null;
    }
    if (!res.ok) return null;

    const json = await res.json();
    const list = Array.isArray(json.data) ? json.data : [];
    if (list.length === 0) return null;

    let best = null;
    for (const anime of list) {
        if (!anime.url) continue;
        const titles = [anime.title, anime.title_english, anime.title_japanese].filter(Boolean);
        if (expectedSeason && expectedSeason >= 2) {
            if (!titles.some((t) => titleHasSeason(t, expectedSeason))) continue;
        }
        const rawScore = Math.max(...titles.map((t) => titleSimilarity(query, t)));
        if (rawScore < SIMILARITY_THRESHOLD) continue;

        const queryWordCount = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2).length;
        const resultWordCount = String(anime.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2).length;
        const extraWords = Math.max(0, resultWordCount - queryWordCount);
        const score = Math.max(0, rawScore - extraWords * 0.08);

        const typePriority = TYPE_PRIORITY[String(anime.type || '').toLowerCase()] || 0;
        const eps = anime.episodes || 0;
        const wins = !best
            || score > best.score
            || (score === best.score && typePriority > best.typePriority)
            || (score === best.score && typePriority === best.typePriority && eps > best.eps);
        if (wins) best = { anime, score, typePriority, eps };
    }

    if (best) {
        console.log(`[MAL] ✓ "${query}" → "${best.anime.title}" (type=${best.anime.type}, eps=${best.anime.episodes})`);
        return { link: best.anime.url, totalEpisodes: best.anime.episodes || null };
    }
    return null;
}

async function searchMalLink(env, title, opts = {}) {
    const light = opts.light === true;
    if (!title) return { link: null, totalEpisodes: null };

    const { base, season } = parseSeasonInfo(title);
    if (!base) return { link: null, totalEpisodes: null };
    const hasSeason = season && season >= 2;
    const cacheKey = buildCacheKey(title);

    const cachedLink = await getCachedMalLink(env, cacheKey);
    if (cachedLink) {
        const cachedTotal = await getCachedTotalEpisodes(env, cacheKey);
        return { link: cachedLink, totalEpisodes: cachedTotal };
    }

    const candidates = [];
    const push = (q) => {
        const v = (q || '').trim();
        if (v.length > 2 && !candidates.includes(v)) candidates.push(v);
    };

    if (hasSeason) {
        push(base);
        push(`${base} ${season}`);
        const roman = { 2: 'II', 3: 'III', 4: 'IV', 5: 'V', 6: 'VI', 7: 'VII', 8: 'VIII' };
        if (roman[season]) push(`${base} ${roman[season]}`);
    } else {
        push(base);
        push(base.replace(/\s*[-–]\s*/g, ' '));
        const words = base.split(/\s+/);
        if (words.length > 2) push(words.slice(0, 2).join(' '));
        push(words[0]);
    }

    const list = light ? [base] : candidates;
    let link = null, totalEpisodes = null;

    for (const q of list) {
        const r = await tryJikanWithEpisodes(q, hasSeason ? season : null, 'tv');
        if (r) { link = r.link; totalEpisodes = r.totalEpisodes; break; }
        if (!r) {
            const r2 = await tryJikanWithEpisodes(q, hasSeason ? season : null, null);
            if (r2) { link = r2.link; totalEpisodes = r2.totalEpisodes; break; }
        }
        await new Promise((r) => setTimeout(r, 400));
    }

    if (link) await setCachedMalLink(env, cacheKey, link);
    if (totalEpisodes) await setCachedTotalEpisodes(env, cacheKey, totalEpisodes);
    return { link, totalEpisodes };
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
    try {
        const raw = await env.RSS_BOT_KV.get(`lang:${chatId}`);
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

async function getLastTitle(env) {
    const raw = await env.RSS_BOT_KV.get('last_title');
    if (!raw) return null;
    try { return decryptData(raw); } catch { return null; }
}
async function setLastTitle(env, title) {
    await env.RSS_BOT_KV.put('last_title', encryptData(title));
}

// ============= BOTFATHER COMMAND READER =============

async function fetchBotFatherCommands(env, lang) {
    const payload = { scope: { type: 'default' } };
    if (lang === 'fa') payload.language_code = 'fa';
    try {
        const res = await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/getMyCommands`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const json = await res.json();
        return Array.isArray(json.result) ? json.result : null;
    } catch { return null; }
}

async function applyBotFatherCommandsToChat(env, chatId, lang) {
    const commands = await fetchBotFatherCommands(env, lang);
    if (!commands || commands.length === 0) return;
    try {
        await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/setMyCommands`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commands, scope: { type: 'chat', chat_id: chatId } }),
        });
    } catch {}
}

// ============= FORMATTING =============

function formatAiringMessage(rawTitle, lang = 'en', malLink = null, totalEps = null, currentEp = null) {
    const { base, season, episode: parsedEp } = parseSeasonInfo(rawTitle);
    const episode = currentEp != null ? currentEp : parsedEp;

    let msg;
    if (season) {
        if (lang === 'fa') msg = `قسمت ${episode} فصل ${season} انیمه <b>${base}</b> اومد!`;
        else msg = `<b>${base}</b> Season ${season} - Episode ${episode} Aired!`;
    } else if (episode != null) {
        if (lang === 'fa') msg = `قسمت ${episode} انیمه <b>${base}</b> اومد!`;
        else msg = `<b>${base}</b> - Episode ${episode} Aired!`;
    } else {
        if (lang === 'fa') msg = `انیمه <b>${base}</b> اومد!`;
        else msg = `<b>${base}</b> Aired!`;
    }

    if (episode && totalEps && episode >= totalEps) {
        msg += lang === 'fa' ? ' (پایان)' : ' (end)';
    }

    const counterLabel = lang === 'fa' ? 'تعداد قسمت‌ها' : 'Episode Count';
    if (episode && totalEps) msg += `\n\n${counterLabel}: ${episode}/${totalEps}`;
    else if (episode) msg += `\n\n${counterLabel}: ${episode}/?`;

    if (malLink) {
        const label = lang === 'fa' ? 'لینک MAL' : 'MAL Link';
        msg += `\n\n<a href="${malLink}">${label}</a>`;
    }
    return msg;
}

// ============= TELEGRAM API =============

async function sendMessage(env, chatId, text, extra = {}) {
    const res = await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }),
    });
    try { return await res.json(); } catch { return { ok: res.ok }; }
}

async function editMessage(env, chatId, messageId, text, extra = {}) {
    const res = await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/editMessageText`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }),
    });
    try { return await res.json(); } catch { return { ok: res.ok }; }
}

async function sendRichMessage(env, chatId, html, extra = {}) {
    const res = await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/sendRichMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, rich_message: { html }, ...extra }),
    });
    try { return await res.json(); } catch { return { ok: res.ok }; }
}

async function editRichMessage(env, chatId, messageId, html, extra = {}) {
    const res = await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/editMessageText`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, rich_message: { html }, ...extra }),
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

async function broadcastLatest(env) {
    const rawTitle = await fetchLatestTitle();
    if (!rawTitle) { console.error('[AIRING] no title'); return; }

    if (/\bbatch\b/i.test(rawTitle)) {
        console.log(`[AIRING] skip batch: ${rawTitle}`);
        return;
    }

    const lastTitle = await getLastTitle(env);
    if (lastTitle === rawTitle) {
        console.log(`[AIRING] no change`);
        return;
    }

    const chats = await getBroadcastChats(env);
    if (chats.length === 0) {
        await setLastTitle(env, rawTitle);
        return;
    }

    const clean = cleanTitle(rawTitle);
    const { link: malLink, totalEpisodes } = await searchMalLink(env, clean);
    const { episode: currentEpisode } = parseSeasonInfo(clean);

    console.log(`[AIRING] NEW: ${clean} (ep ${currentEpisode}, mal=${malLink}, total=${totalEpisodes})`);

    const cache = { en: null, fa: null };
    for (const chatId of chats) {
        try {
            const lang = await getLang(env, chatId);
            if (!cache[lang]) {
                cache[lang] = formatAiringMessage(rawTitle, lang, malLink, totalEpisodes, currentEpisode);
            }
            const res = await sendMessage(env, chatId, cache[lang]);
            SUBREQUEST_COUNT++;
            if (res && res.ok === false) {
                const desc = res.description || '';
                if (desc.includes('blocked') || desc.includes('chat not found') || desc.includes('kicked') || desc.includes('user is deactivated')) {
                    await removeChatFromBroadcast(env, chatId);
                }
            }
        } catch (err) {}
    }

    await setLastTitle(env, rawTitle);
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

async function fetchSubsPleaseSchedule(tz) {
    const url = `https://subsplease.org/api/?f=schedule&tz=${encodeURIComponent(tz)}`;
    let res;
    try {
        res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; SubsPleaseBot/1.0)',
                Accept: 'application/json',
            },
        });
        SUBREQUEST_COUNT++;
    } catch (e) {
        throw new Error(`network error: ${e.message}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.schedule) throw new Error('no schedule');
    return json.schedule;
}

function formatDaySchedule(dayKey, entries, lang) {
    const isFa = lang === 'fa';
    const dayName = isFa ? DAY_FULL_FA[dayKey] : dayKey;
    const tzLabel = isFa ? 'به وقت ایران' : 'UTC';

    let html = `<h3>📅 ${dayName} (${tzLabel})</h3>`;
    if (!entries || entries.length === 0) {
        html += isFa ? '<p><i>هیچ انتشار برنامه‌ریزی‌شده‌ای وجود ندارد.</i></p>' : '<p><i>No releases scheduled.</i></p>';
        return html;
    }

    html += '<table bordered striped columns="1,6">';
    html += isFa ? '<tr><th>ساعت</th><th>انیمه</th></tr>' : '<tr><th>Time</th><th>Show</th></tr>';
    for (const e of entries) {
        html += `<tr><td nowrap>${escapeHtml(e.time || '--:--')}</td><td>${escapeHtml(e.title || '')}</td></tr>`;
    }
    html += '</table>';
    return html;
}

function formatDaySchedulePlain(dayKey, entries, lang) {
    const isFa = lang === 'fa';
    const dayName = isFa ? DAY_FULL_FA[dayKey] : dayKey;
    const tzLabel = isFa ? 'به وقت ایران' : 'UTC';

    let msg = `📅 <b>${dayName}</b> (${tzLabel})\n\n`;
    if (!entries || entries.length === 0) {
        msg += isFa ? '<i>هیچ انتشار برنامه‌ریزی‌شده‌ای وجود ندارد.</i>' : '<i>No releases scheduled.</i>';
        return msg;
    }
    for (const e of entries) {
        msg += `<code>${escapeHtml(e.time || '--:--')}</code>  ${escapeHtml(e.title || '')}\n`;
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
    return { inline_keyboard: [buttons.slice(0, 4), buttons.slice(4)].filter((r) => r.length > 0) };
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
        const schedule = await fetchSubsPleaseSchedule(tz);
        const entries = schedule[today] || [];
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
            const tz = SCHEDULE_TZ[lang] || SCHEDULE_TZ.en;
            const schedule = await fetchSubsPleaseSchedule(tz);
            const entries = schedule[dayKey] || [];
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
        const titles = await fetchLatestTitles(10);
        const nonBatch = titles.filter((t) => !/\bbatch\b/i.test(t));

        let out = `🐛 <b>Debug</b>\n`;
        out += `Latest RSS titles: ${titles.length}\n`;
        out += `Non-batch: ${nonBatch.length}\n`;
        out += `Last notified: <code>${(await getLastTitle(env)) || '—'}</code>\n\n`;

        for (const t of nonBatch.slice(0, 5)) {
            const clean = cleanTitle(t);
            const { base, season, episode } = parseSeasonInfo(clean);
            const cacheKey = buildCacheKey(clean);
            const cachedLink = await getCachedMalLink(env, cacheKey);
            const cachedEps = await getCachedTotalEpisodes(env, cacheKey);
            out += `• <b>${base}</b>`;
            if (season) out += ` S${season}`;
            out += ` ep ${episode}\n`;
            out += `   MAL: ${cachedLink ? '✅' : '❌'} · eps: ${cachedEps || '?'}\n`;
        }

        out += `\nSubrequests: ${SUBREQUEST_COUNT}`;
        await sendMessage(env, chatId, out);
    } catch (e) {
        console.error('[ERROR] /debug failed:', e);
        await sendMessage(env, chatId, `🐛 <b>Debug error:</b> ${e.message}`);
    }
}

async function handleMalTest(env, chatId) {
    const samples = [
        'Grand Blue S3 - 11',
        'Re Zero kara Hajimeru Isekai Seikatsu - 85',
        'Tensei Shitara Ken Deshita S2 - 1',
        'LIAR GAME - 26',
    ];
    let out = '🧪 <b>MAL Search Test</b>\n\n';
    for (const s of samples) {
        const { base, season } = parseSeasonInfo(s);
        const { link, totalEpisodes } = await searchMalLink(env, s, { light: true });
        out += `<b>Input:</b> <code>${s}</code>\n`;
        out += `<b>Base:</b> <code>${base}</code>\n`;
        out += `<b>Season:</b> ${season || 'none'}\n`;
        out += `<b>Total Episodes:</b> ${totalEpisodes || 'unknown'}\n`;
        out += `<b>Link:</b> ${link ? `<a href="${link}">${link}</a>` : '❌ none'}\n\n`;
        await new Promise((r) => setTimeout(r, 500));
    }
    await sendMessage(env, chatId, out);
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
                    else if (text.startsWith('/maltest')) await handleMalTest(env, chatId);
                } else {
                    await addChatToBroadcast(env, chatId);
                    if (text.startsWith('/unsub')) await handleUnsubInGroup(env, chatId);
                    else if (text.startsWith('/language')) await handleLanguage(env, chatId);
                    else if (text.startsWith('/schedule')) await handleSchedule(env, chatId);
                    else if (text.startsWith('/debug')) await handleDebug(env, chatId);
                    else if (text.startsWith('/maltest')) await handleMalTest(env, chatId);
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
