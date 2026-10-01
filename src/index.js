// ============================================================
// Telegram RSS Bot for SubsPlease – Cloudflare Worker
// ============================================================

const RSS_URL = 'https://subsplease.org/rss/?t&r=1080';
const TELEGRAM_API = 'https://api.telegram.org/bot';

const SCHEDULE_TZ = { fa: 'Asia/Tehran', en: 'UTC' };

/** Bump to invalidate every cached MAL/eps entry. */
const MAL_CACHE_VERSION = 'v4';

let SUBREQUEST_COUNT = 0;

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
        console.log(`[COMMANDS] Fetched ${json.result.length} ${lang} commands`);
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
        const res = await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/setMyCommands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commands, scope: { type: 'chat', chat_id: chatId } }),
        });
        const json = await res.json();
        if (!json.ok) {
            console.warn(`[COMMANDS] setMyCommands (${chatId}, ${lang}) failed:`, JSON.stringify(json).slice(0, 200));
        } else {
            console.log(`[COMMANDS] Per-chat menu applied to ${chatId} (${lang})`);
        }
    } catch (e) {
        console.error('[COMMANDS] error:', e.message);
    }
}

// ============= ENCRYPTION HELPERS =============
let ENCRYPTION_KEY = 'default-key-please-change-me';

function encryptData(data) {
    const jsonStr = JSON.stringify(data);
    const encoder = new TextEncoder();
    const plaintext = encoder.encode(jsonStr);
    const keyBytes = encoder.encode(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32));
    const encrypted = new Uint8Array(plaintext.length);
    for (let i = 0; i < plaintext.length; i++) {
        encrypted[i] = plaintext[i] ^ keyBytes[i % keyBytes.length];
    }
    return btoa(String.fromCharCode(...encrypted));
}

function decryptData(encryptedStr) {
    const encrypted = Uint8Array.from(atob(encryptedStr), (c) => c.charCodeAt(0));
    const keyBytes = new TextEncoder().encode(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32));
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

// ============= TITLE MATCHING =============

function titleSimilarity(query, resultTitle) {
    const STOP = new Set([
        'the', 'a', 'an', 'of', 'and', 'to', 'in', 'on', 'at', 'is',
        'no', 'ni', 'wo', 'wa', 'ga', 'de', 'la', 'le',
        'season', 's', 'part', 'cour',
    ]);
    const norm = (s) =>
        String(s || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

    const queryWords = norm(query)
        .split(' ')
        .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));

    if (queryWords.length === 0) return 1;

    const result = norm(resultTitle);
    const matched = queryWords.filter((w) => result.includes(w)).length;
    const total = queryWords.length;
    const score = matched / total;

    let accept;
    if (total <= 2) {
        accept = matched === total;
    } else {
        accept = matched >= 2 && score >= 0.4;
    }

    // IMPORTANT: return 0 when not accepted, so the caller's threshold
    // check rejects it. Returning the raw score would let sub-threshold
    // matches leak through.
    return accept ? Math.max(score, 0.4) : 0;
}

const SIMILARITY_THRESHOLD = 0.4;

// ============= MAL CACHE (versioned) =============

async function getCachedMalLink(env, key) {
    const k = `mal:${MAL_CACHE_VERSION}:${key}`;
    try {
        const raw = await env.RSS_BOT_KV.get(k);
        if (!raw) return null;
        return decryptData(raw);
    } catch (e) { return null; }
}

async function setCachedMalLink(env, key, link) {
    if (!link) return;
    const k = `mal:${MAL_CACHE_VERSION}:${key}`;
    try { await env.RSS_BOT_KV.put(k, encryptData(link)); }
    catch (e) { console.error('[MAL] Cache set failed:', e.message); }
}

async function getCachedTotalEpisodes(env, key) {
    const k = `eps:${MAL_CACHE_VERSION}:${key}`;
    try {
        const raw = await env.RSS_BOT_KV.get(k);
        if (!raw) return null;
        return decryptData(raw);
    } catch (e) { return null; }
}

async function setCachedTotalEpisodes(env, key, total) {
    if (!total) return;
    const k = `eps:${MAL_CACHE_VERSION}:${key}`;
    try { await env.RSS_BOT_KV.put(k, encryptData(total)); }
    catch (e) { console.error('[EPS] Cache set failed:', e.message); }
}

// ============= MAL ID / EPISODES =============

function extractMalId(url) {
    if (!url) return null;
    const m = String(url).match(/myanimelist\.net\/anime\/(\d+)/);
    return m ? m[1] : null;
}

async function fetchEpisodesFromMalId(malId, attempt = 1) {
    if (!malId) return null;
    const url = `https://api.jikan.moe/v4/anime/${malId}`;
    try {
        const res = await fetch(url, {
            headers: {
                Accept: 'application/json',
                'User-Agent': 'Mozilla/5.0 (compatible; SubsPleaseBot/1.0)',
            },
        });
        console.log(`[MAL] /anime/${malId} → HTTP ${res.status}`);
        if (res.status === 429 && attempt < 3) {
            await new Promise((r) => setTimeout(r, 3000));
            return fetchEpisodesFromMalId(malId, attempt + 1);
        }
        if (!res.ok) return null;
        const json = await res.json();
        const eps = json?.data?.episodes || null;
        console.log(`[MAL] /anime/${malId} → episodes: ${eps}`);
        return eps;
    } catch (e) {
        console.error(`[MAL] /anime/${malId} error:`, e.message);
        return null;
    }
}

async function scrapeMalEpisodesFromPage(malUrl) {
    if (!malUrl) return null;
    try {
        const res = await fetch(malUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
        });
        console.log(`[MAL] Page scrape ${malUrl} → HTTP ${res.status}`);
        if (!res.ok) return null;
        const html = await res.text();
        let m = html.match(/Episodes:<\/span>\s*(\d+)/i);
        if (m) { const eps = parseInt(m[1], 10); console.log(`[MAL] Scrape → ${eps} (p1)`); return eps; }
        m = html.match(/Episodes:<\/span>[\s\S]{0,60}?>(\d+)</i);
        if (m) { const eps = parseInt(m[1], 10); console.log(`[MAL] Scrape → ${eps} (p2)`); return eps; }
        m = html.match(/"num_episodes"\s*:\s*(\d+)/);
        if (m) { const eps = parseInt(m[1], 10); console.log(`[MAL] Scrape → ${eps} (p3)`); return eps; }
        m = html.match(/Episodes[\s\S]{0,120}?(\d{1,4})\s*[<(]/);
        if (m) { const eps = parseInt(m[1], 10); console.log(`[MAL] Scrape → ${eps} (p4)`); return eps; }
        console.warn(`[MAL] Page scrape found nothing at ${malUrl}`);
        return null;
    } catch (e) {
        console.error('[MAL] Page scrape error:', e.message);
        return null;
    }
}

// ============= MAL SEARCH =============

async function tryJikanWithEpisodes(query, attempt = 1, expectedSeason = null) {
    const url = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=10`;
    try {
        const res = await fetch(url, {
            headers: {
                Accept: 'application/json',
                'User-Agent': 'Mozilla/5.0 (compatible; SubsPleaseBot/1.0)',
            },
        });
        console.log(`[MAL] Jikan "${query}" → HTTP ${res.status}`);
        if (res.status === 429 && attempt < 3) {
            await new Promise((r) => setTimeout(r, 3000));
            return tryJikanWithEpisodes(query, attempt + 1, expectedSeason);
        }
        if (!res.ok) return null;
        const json = await res.json();
        const list = Array.isArray(json.data) ? json.data : [];
        console.log(`[MAL] Jikan "${query}" → ${list.length} result(s)`);

        for (const anime of list) {
            if (!anime.url) continue;
            const titles = [anime.title, anime.title_english, anime.title_japanese].filter(Boolean);

            if (expectedSeason && expectedSeason >= 2) {
                if (!titles.some((t) => titleHasSeason(t, expectedSeason))) {
                    console.log(`[MAL]   skip "${anime.title}" (no S${expectedSeason} marker)`);
                    continue;
                }
            }

            const bestScore = Math.max(...titles.map((t) => titleSimilarity(query, t)));
            if (bestScore < SIMILARITY_THRESHOLD) {
                console.log(`[MAL]   skip "${anime.title}" (score ${bestScore.toFixed(2)})`);
                continue;
            }

            console.log(`[MAL] ✓ "${query}" → "${anime.title}" (${anime.url}, eps=${anime.episodes}, score=${bestScore.toFixed(2)})`);
            return { link: anime.url, totalEpisodes: anime.episodes || null };
        }

        console.warn(`[MAL] No match in "${query}" results`);
        return null;
    } catch (e) {
        console.error(`[MAL] Jikan error "${query}":`, e.message);
        return null;
    }
}

async function tryMalScrape(query) {
    try {
        const url = `https://myanimelist.net/anime.php?q=${encodeURIComponent(query)}&cat=anime`;
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        });
        console.log(`[MAL] Scrape "${query}" → HTTP ${res.status}`);
        if (!res.ok) return null;
        const html = await res.text();
        const match = html.match(/href="(https?:\/\/myanimelist\.net\/anime\/\d+\/[A-Za-z0-9_!\-]+)"/);
        if (match) {
            const url2 = match[1].replace(/\/$/, '');
            console.log(`[MAL] Scrape hit "${query}": ${url2}`);
            return url2;
        }
        console.warn(`[MAL] Scrape no link for "${query}"`);
    } catch (e) {
        console.error('[MAL] Scrape error:', e.message);
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
    console.log(`[MAL] ─── resolve "${title}" (key="${cacheKey}", season=${season}, light=${light})`);

    // ---- 1. Cache ----
    const cachedLink = await getCachedMalLink(env, cacheKey);
    if (cachedLink) {
        console.log(`[MAL] Cache hit "${cacheKey}": ${cachedLink}`);
        const cachedTotal = await getCachedTotalEpisodes(env, cacheKey);
        if (cachedTotal) return { link: cachedLink, totalEpisodes: cachedTotal };
        if (light) return { link: cachedLink, totalEpisodes: null };
        const malId = extractMalId(cachedLink);
        let total = await fetchEpisodesFromMalId(malId);
        if (!total) total = await scrapeMalEpisodesFromPage(cachedLink);
        if (total) await setCachedTotalEpisodes(env, cacheKey, total);
        return { link: cachedLink, totalEpisodes: total };
    }

    // ---- Build candidate queries ----
    const candidates = [];
    const push = (q) => {
        const v = (q || '').trim();
        if (v.length > 2 && !candidates.includes(v)) candidates.push(v);
    };

    if (hasSeason) {
        push(`${base} Season ${season}`);
        push(`${base} ${season}`);
        const roman = { 2: 'II', 3: 'III', 4: 'IV', 5: 'V', 6: 'VI', 7: 'VII', 8: 'VIII' };
        if (roman[season]) push(`${base} ${roman[season]}`);
        push(base); // last resort for season: base will still hit S1 if nothing else
    } else {
        push(base);
        push(base.replace(/\s*[-–]\s*/g, ' '));
        const words = base.split(/\s+/);
        if (words.length > 2) push(words.slice(0, 2).join(' '));
        push(words[0]);
    }

    // light mode: use a compact candidate list
    let list;
    if (light) {
        list = hasSeason ? [`${base} ${season}`, base] : [base];
    } else {
        list = candidates;
    }
    console.log(`[MAL] Candidates${light ? ' (light)' : ''}: ${JSON.stringify(list)}`);

    let link = null;
    let totalEpisodes = null;

    // ---- 2. Jikan ----
    for (const query of list) {
        SUBREQUEST_COUNT++;
        const result = await tryJikanWithEpisodes(query, 1, hasSeason ? season : null);
        if (result && result.link) {
            link = result.link;
            totalEpisodes = result.totalEpisodes;
            break;
        }
        await new Promise((r) => setTimeout(r, light ? 400 : 700));
    }

    // ---- 3. MAL scrape fallback (used in both light and full modes) ----
    if (!link) {
        console.warn(`[MAL] Jikan failed "${cacheKey}", trying MAL scrape...`);
        SUBREQUEST_COUNT++;
        const scrapeQuery = hasSeason ? `${base} ${season}` : base;
        link = await tryMalScrape(scrapeQuery);
        if (!link && !light && candidates.length > 1) {
            SUBREQUEST_COUNT++;
            link = await tryMalScrape(candidates[1]);
        }
    }

    // ---- Light mode: skip episode lookups, but DO cache the link ----
    if (light) {
        if (link) await setCachedMalLink(env, cacheKey, link);
        if (totalEpisodes) await setCachedTotalEpisodes(env, cacheKey, totalEpisodes);
        console.log(`[MAL] ─── result: link=${link || 'null'}, eps=${totalEpisodes || 'null'}`);
        return { link, totalEpisodes };
    }

    // ---- 4. Fill in episodes ----
    if (link && !totalEpisodes) {
        const malId = extractMalId(link);
        if (malId) {
            SUBREQUEST_COUNT++;
            totalEpisodes = await fetchEpisodesFromMalId(malId);
        }
    }

    if (link && !totalEpisodes) {
        SUBREQUEST_COUNT++;
        totalEpisodes = await scrapeMalEpisodesFromPage(link);
    }

    if (link) await setCachedMalLink(env, cacheKey, link);
    if (totalEpisodes) await setCachedTotalEpisodes(env, cacheKey, totalEpisodes);

    console.log(`[MAL] ─── result: link=${link || 'null'}, eps=${totalEpisodes || 'null'}`);
    return { link, totalEpisodes };
}

// ============= FORMATTING =============

function formatTitle(rawTitle, lang = 'en', malLink = null, totalEpisodes = null, currentEpisode = null) {
    const { base, season, episode: parsedEpisode } = parseSeasonInfo(rawTitle);
    let episode = currentEpisode != null ? currentEpisode : parsedEpisode;

    let message;
    if (season) {
        if (lang === 'fa') message = `قسمت ${episode} فصل ${season} انیمه <b>${base}</b> اومد!`;
        else message = `<b>${base} Season ${season} - Episode ${episode}</b> Aired!`;
    } else if (episode != null) {
        if (lang === 'fa') message = `قسمت ${episode} انیمه <b>${base}</b> اومد!`;
        else message = `<b>${base} - Episode ${episode}</b> Aired!`;
    } else {
        if (lang === 'fa') message = `انیمه <b>${base}</b> اومد!`;
        else message = `<b>${base}</b> Aired!`;
    }

    if (episode && totalEpisodes && parseInt(episode, 10) >= totalEpisodes) {
        message += lang === 'fa' ? ' (پایان)' : ' (end)';
    }

    const counterLabel = lang === 'fa' ? 'تعداد قسمت‌ها' : 'Episode Count';
    if (episode && totalEpisodes) {
        message += `\n\n${counterLabel}: ${episode}/${totalEpisodes}`;
    } else if (episode) {
        message += `\n\n${counterLabel}: ${episode}/?`;
    }

    if (malLink) {
        const label = lang === 'fa' ? 'لینک MAL' : 'MAL Link';
        message += `\n\n<a href="${malLink}">${label}</a>`;
    }

    return message;
}

// ============= TELEGRAM API HELPERS =============

async function sendMessage(env, chatId, text, extra = {}) {
    const url = `${TELEGRAM_API}${env.BOT_TOKEN}/sendMessage`;
    const payload = {
        chat_id: chatId, text, parse_mode: 'HTML',
        disable_web_page_preview: true, ...extra,
    };
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    try { return await res.json(); } catch { return { ok: res.ok }; }
}

async function sendRichMessage(env, chatId, html, extra = {}) {
    const url = `${TELEGRAM_API}${env.BOT_TOKEN}/sendRichMessage`;
    const payload = { chat_id: chatId, rich_message: { html }, ...extra };
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    try { return await res.json(); } catch { return { ok: res.ok }; }
}

async function editRichMessage(env, chatId, messageId, html, extra = {}) {
    const url = `${TELEGRAM_API}${env.BOT_TOKEN}/editMessageText`;
    const payload = { chat_id: chatId, message_id: messageId, rich_message: { html }, ...extra };
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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

async function getLastTitle(env) {
    const raw = await env.RSS_BOT_KV.get('last_title');
    if (!raw) return null;
    try { return decryptData(raw); } catch { return null; }
}

async function setLastTitle(env, title) {
    await env.RSS_BOT_KV.put('last_title', encryptData(title));
}

// ============= SCHEDULE HELPERS =============

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const DAY_LABELS_EN = { Monday:'Mon',Tuesday:'Tue',Wednesday:'Wed',Thursday:'Thu',Friday:'Fri',Saturday:'Sat',Sunday:'Sun' };
const DAY_FULL_FA = { Monday:'دوشنبه',Tuesday:'سه‌شنبه',Wednesday:'چهارشنبه',Thursday:'پنجشنبه',Friday:'جمعه',Saturday:'شنبه',Sunday:'یکشنبه' };
const DAYS_FA_ORDER = ['Saturday','Sunday','Monday','Tuesday','Wednesday','Thursday','Friday'];

function scheduleApiUrl(tz) { return `https://subsplease.org/api/?f=schedule&tz=${encodeURIComponent(tz)}`; }

function getCurrentDay(tz) {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' });
    const dayName = fmt.format(new Date());
    return DAYS.includes(dayName) ? dayName : 'Saturday';
}

async function fetchSchedule(tz) {
    const res = await fetch(scheduleApiUrl(tz), {
        headers: { 'User-Agent': 'SubsPleaseTelegramBot/1.0 (+https://workers.dev)', Accept: 'application/json' },
    });
    SUBREQUEST_COUNT++;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.schedule) throw new Error('No schedule');
    return json.schedule;
}

function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDaySchedule(day, entries, lang) {
    const isFa = lang === 'fa';
    const dayName = isFa ? DAY_FULL_FA[day] : day;
    const tzLabel = isFa ? 'به وقت ایران' : 'UTC';
    let html = `<h3>📅 ${dayName} (${tzLabel})</h3>`;
    if (!entries || entries.length === 0) {
        html += isFa ? '<p><i>هیچ انتشار برنامه‌ریزی‌شده‌ای وجود ندارد.</i></p>' : '<p><i>No releases scheduled.</i></p>';
        return html;
    }
    const shown = entries.slice(0, 100);
    html += '<table bordered striped columns="1,6">';
    html += isFa ? '<tr><th>ساعت</th><th>انیمه</th></tr>' : '<tr><th>Time</th><th>Show</th></tr>';
    for (const e of shown) {
        html += `<tr><td nowrap>${escapeHtml(e.time)}</td><td>${escapeHtml(e.title)}</td></tr>`;
    }
    html += '</table>';
    return html;
}

function formatDaySchedulePlain(day, entries, lang) {
    const isFa = lang === 'fa';
    const dayName = isFa ? DAY_FULL_FA[day] : day;
    const tzLabel = isFa ? 'به وقت ایران' : 'UTC';
    let msg = `📅 <b>${dayName}</b> (${tzLabel})\n\n`;
    if (!entries || entries.length === 0) {
        msg += isFa ? '<i>هیچ انتشار برنامه‌ریزی‌شده‌ای وجود ندارد.</i>' : '<i>No releases scheduled.</i>';
        return msg;
    }
    for (const e of entries) msg += `<code>${escapeHtml(e.time)}</code>  ${escapeHtml(e.title)}\n`;
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

async function sendScheduleMessage(env, chatId, day, entries, lang, keyboard) {
    const richRes = await sendRichMessage(env, chatId, formatDaySchedule(day, entries, lang), { reply_markup: keyboard });
    if (richRes && richRes.ok) return;
    await sendMessage(env, chatId, formatDaySchedulePlain(day, entries, lang), { reply_markup: keyboard });
}

async function editScheduleMessage(env, chatId, messageId, day, entries, lang, keyboard) {
    const richRes = await editRichMessage(env, chatId, messageId, formatDaySchedule(day, entries, lang), { reply_markup: keyboard });
    if (richRes && richRes.ok) return;
    await editMessage(env, chatId, messageId, formatDaySchedulePlain(day, entries, lang), { reply_markup: keyboard });
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

async function handleDebug(env, chatId) {
    try {
        const rawTitles = await fetchLatestTitles(30);
        const filtered = rawTitles.filter((t) => !/\bbatch\b/i.test(t)).slice(0, 10);
        if (filtered.length === 0) {
            await sendMessage(env, chatId, '🐛 <b>Debug:</b> No non-batch titles found.');
            return;
        }
        const lang = await getLang(env, chatId);
        await sendMessage(env, chatId, `🐛 <b>Debug:</b> sending ${filtered.length} titles (light)...`);
        for (let i = 0; i < filtered.length; i++) {
            const rawTitle = filtered[i];
            const clean = cleanTitle(rawTitle);
            const { link: malLink, totalEpisodes } = await searchMalLink(env, clean, { light: true });
            const { episode: currentEpisode } = parseSeasonInfo(clean);
            const body = formatTitle(rawTitle, lang, malLink, totalEpisodes, currentEpisode);
            await sendMessage(env, chatId, `<b>#${i + 1}</b>\n${body}`);
            SUBREQUEST_COUNT++;
            // 400ms spacing keeps us under Jikan's 3 req/sec rate limit.
            await new Promise((r) => setTimeout(r, 400));
        }
        await sendMessage(env, chatId, `🐛 <b>Debug complete.</b>\nSubrequests used: ${SUBREQUEST_COUNT}`);
        console.log(`[DEBUG] Total subrequests: ${SUBREQUEST_COUNT}`);
    } catch (e) {
        console.error('[ERROR] /debug failed:', e);
        await sendMessage(env, chatId, `🐛 <b>Debug error:</b> ${e.message}`);
    }
}

async function handleMalTest(env, chatId) {
    const samples = [
        'LIAR GAME - 26',
        'Re Zero kara Hajimeru Isekai Seikatsu - 85',
        'Tensei Shitara Ken Deshita S2 - 1',
        'Clevatess S2 - 13',
        'Grand Blue S3 - 11',
    ];
    let out = '🧪 <b>MAL Search Test</b>\n\n';
    for (const s of samples) {
        const { base, season } = parseSeasonInfo(s);
        const cacheKey = buildCacheKey(s);
        const { link, totalEpisodes } = await searchMalLink(env, s, { light: true });
        const en = formatTitle(s, 'en', null, totalEpisodes, null);
        out += `<b>Input:</b> <code>${s}</code>\n`;
        out += `<b>Base:</b> <code>${base}</code>\n`;
        out += `<b>Season:</b> ${season || 'none'}\n`;
        out += `<b>CacheKey:</b> <code>${cacheKey}</code>\n`;
        out += `<b>Total Episodes:</b> ${totalEpisodes || 'unknown'}\n`;
        out += `<b>EN:</b> ${en}\n`;
        out += `<b>Link:</b> ${link ? `<a href="${link}">${link}</a>` : '❌ none'}\n\n`;
        await new Promise((r) => setTimeout(r, 500));
    }
    await sendMessage(env, chatId, out);
}

async function handleSchedule(env, chatId) {
    try {
        const lang = await getLang(env, chatId);
        const tz = SCHEDULE_TZ[lang] || SCHEDULE_TZ.en;
        const schedule = await fetchSchedule(tz);
        const today = getCurrentDay(tz);
        await sendScheduleMessage(env, chatId, today, schedule[today], lang, buildDayKeyboard(today, lang));
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
        const day = data.slice('sched:'.length);
        if (!DAYS.includes(day)) { await answerCallback(env, id); return; }
        try {
            const lang = await getLang(env, chatId);
            const tz = SCHEDULE_TZ[lang] || SCHEDULE_TZ.en;
            const schedule = await fetchSchedule(tz);
            await editScheduleMessage(env, chatId, messageId, day, schedule[day], lang, buildDayKeyboard(day, lang));
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

// ============= RSS BROADCAST =============

async function broadcastLatest(env) {
    const rawTitle = await fetchLatestTitle();
    if (!rawTitle) { console.error('No title.'); return; }
    if (/\bbatch\b/i.test(rawTitle)) { console.log(`Skip batch: ${rawTitle}`); return; }

    const lastTitle = await getLastTitle(env);
    if (lastTitle === rawTitle) { console.log(`No change: ${rawTitle}`); return; }

    const chats = await getBroadcastChats(env);
    if (chats.length === 0) { await setLastTitle(env, rawTitle); return; }

    const searchQuery = cleanTitle(rawTitle);
    const { link: malLink, totalEpisodes } = await searchMalLink(env, searchQuery);
    const { episode: currentEpisode } = parseSeasonInfo(searchQuery);

    const cache = { en: null, fa: null };

    for (const chatId of chats) {
        try {
            const lang = await getLang(env, chatId);
            if (!cache[lang]) {
                cache[lang] = formatTitle(rawTitle, lang, malLink, totalEpisodes, currentEpisode);
            }
            const res = await sendMessage(env, chatId, cache[lang]);
            SUBREQUEST_COUNT++;
            if (res && res.ok === false) {
                const desc = res.description || '';
                if (desc.includes('blocked') || desc.includes('chat not found') || desc.includes('kicked') || desc.includes('user is deactivated')) {
                    await removeChatFromBroadcast(env, chatId);
                }
            }
        } catch (err) {
            console.error(`Failed to send to ${chatId}:`, err);
        }
    }

    await setLastTitle(env, rawTitle);
    console.log(`[BROADCAST] Subrequests used: ${SUBREQUEST_COUNT}`);
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
                    else if (text.startsWith('/debug')) await handleDebug(env, chatId);
                    else if (text.startsWith('/maltest')) await handleMalTest(env, chatId);
                    else if (text.startsWith('/schedule')) await handleSchedule(env, chatId);
                } else {
                    await addChatToBroadcast(env, chatId);
                    if (text.startsWith('/unsub')) await handleUnsubInGroup(env, chatId);
                    else if (text.startsWith('/language')) await handleLanguage(env, chatId);
                    else if (text.startsWith('/debug')) await handleDebug(env, chatId);
                    else if (text.startsWith('/maltest')) await handleMalTest(env, chatId);
                    else if (text.startsWith('/schedule')) await handleSchedule(env, chatId);
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
