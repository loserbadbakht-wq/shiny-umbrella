// ============================================================
// Telegram RSS Bot for SubsPlease – Cloudflare Worker
// With encrypted KV storage, batch filter, duplicate prevention,
// season-aware MAL link + episode counter (Jikan search +
// /anime/{id} + MAL page scrape), bold titles, season/episode
// reformatter, PV-only /unsub, group /unsub hint, /debug
// (light mode), /maltest, and /schedule using native tables.
// ============================================================

const RSS_URL = 'https://subsplease.org/rss/?t&r=1080';
const TELEGRAM_API = 'https://api.telegram.org/bot';

const SCHEDULE_TZ = {
    fa: 'Asia/Tehran',
    en: 'UTC',
};

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
        if (!json.ok || !Array.isArray(json.result)) {
            console.warn(
                `[COMMANDS] getMyCommands failed for ${lang}:`,
                JSON.stringify(json).slice(0, 200)
            );
            return null;
        }
        console.log(`[COMMANDS] Fetched ${json.result.length} ${lang} commands from BotFather`);
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
            body: JSON.stringify({
                commands,
                scope: { type: 'chat', chat_id: chatId },
            }),
        });
        const json = await res.json();
        if (!json.ok) {
            console.warn(
                `[COMMANDS] Per-chat setMyCommands (${chatId}, ${lang}) failed:`,
                JSON.stringify(json).slice(0, 200)
            );
        } else {
            console.log(`[COMMANDS] Per-chat menu applied to ${chatId} (${lang})`);
        }
    } catch (e) {
        console.error('[COMMANDS] Per-chat setMyCommands error:', e.message);
    }
}

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

/**
 * Parse the raw RSS title into { base, season, episode }.
 *   "Grand Blue S3 - 11"            -> { base: "Grand Blue", season: 3, episode: 11 }
 *   "Sora wa Akai Kawa no Hotori - 13" -> { base: "Sora wa Akai Kawa no Hotori", season: null, episode: 13 }
 */
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

/**
 * Cache key for MAL/eps storage. Includes the season so that
 * "Grand Blue S3" and "Grand Blue" don't collide.
 */
function buildCacheKey(rawTitle) {
    const { base, season } = parseSeasonInfo(rawTitle);
    if (season && season > 1) return `${base} S${season}`;
    return base;
}

// ============= TITLE MATCHING =============

function titleSimilarity(query, resultTitle) {
    const STOP = new Set([
        'the', 'a', 'an', 'of', 'and', 'to', 'in', 'on', 'at', 'is',
        'no', 'ni', 'wo', 'wa', 'ga', 'de', 'la', 'le',
    ]);
    const norm = (s) =>
        String(s || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

    const queryWords = norm(query)
        .split(' ')
        .filter((w) => w.length > 2 && !STOP.has(w));

    if (queryWords.length === 0) return 1;

    const result = norm(resultTitle);
    const matched = queryWords.filter((w) => result.includes(w)).length;

    return matched / queryWords.length;
}

const SIMILARITY_THRESHOLD = 0.6;

// ============= MAL CACHE (KV, encrypted) =============

async function getCachedMalLink(env, key) {
    const k = `mal:${key}`;
    try {
        const raw = await env.RSS_BOT_KV.get(k);
        if (!raw) return null;
        return decryptData(raw);
    } catch (e) {
        return null;
    }
}

async function setCachedMalLink(env, key, link) {
    if (!link) return;
    const k = `mal:${key}`;
    try {
        await env.RSS_BOT_KV.put(k, encryptData(link));
    } catch (e) {
        console.error('[MAL] Cache set failed:', e.message);
    }
}

// ============= TOTAL EPISODES CACHE =============

async function getCachedTotalEpisodes(env, key) {
    const k = `eps:${key}`;
    try {
        const raw = await env.RSS_BOT_KV.get(k);
        if (!raw) return null;
        return decryptData(raw);
    } catch (e) {
        return null;
    }
}

async function setCachedTotalEpisodes(env, key, total) {
    if (!total) return;
    const k = `eps:${key}`;
    try {
        await env.RSS_BOT_KV.put(k, encryptData(total));
    } catch (e) {
        console.error('[EPS] Cache set failed:', e.message);
    }
}

// ============= MAL ID / EPISODES LOOKUP =============

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
                'User-Agent': 'SubsPleaseTelegramBot/1.0 (+https://workers.dev)',
            },
        });

        console.log(`[MAL] /anime/${malId} → HTTP ${res.status} (attempt ${attempt})`);

        if (res.status === 429 && attempt < 5) {
            const wait = 2000 * attempt;
            console.warn(`[MAL] /anime/${malId} 429, retrying in ${wait}ms...`);
            await new Promise((r) => setTimeout(r, wait));
            return fetchEpisodesFromMalId(malId, attempt + 1);
        }

        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            console.warn(`[MAL] /anime/${malId} non-OK: ${txt.slice(0, 200)}`);
            return null;
        }

        const json = await res.json();
        const eps = json?.data?.episodes || null;
        console.log(`[MAL] /anime/${malId} → episodes: ${eps}`);
        return eps;
    } catch (e) {
        console.error(`[MAL] /anime/${malId} fetch error:`, e.message);
        return null;
    }
}

async function scrapeMalEpisodesFromPage(malUrl) {
    if (!malUrl) return null;

    try {
        const res = await fetch(malUrl, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                Accept:
                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
        });

        console.log(`[MAL] Page scrape ${malUrl} → HTTP ${res.status}`);
        if (!res.ok) return null;

        const html = await res.text();

        let m = html.match(/Episodes:<\/span>\s*(\d+)/i);
        if (m) {
            const eps = parseInt(m[1], 10);
            console.log(`[MAL] Page scrape → episodes: ${eps} (pattern 1)`);
            return eps;
        }

        m = html.match(/Episodes:<\/span>[\s\S]{0,60}?>(\d+)</i);
        if (m) {
            const eps = parseInt(m[1], 10);
            console.log(`[MAL] Page scrape → episodes: ${eps} (pattern 2)`);
            return eps;
        }

        m = html.match(/"num_episodes"\s*:\s*(\d+)/);
        if (m) {
            const eps = parseInt(m[1], 10);
            console.log(`[MAL] Page scrape → episodes: ${eps} (pattern 3)`);
            return eps;
        }

        m = html.match(/Episodes[\s\S]{0,120}?(\d{1,4})\s*[<(]/);
        if (m) {
            const eps = parseInt(m[1], 10);
            console.log(`[MAL] Page scrape → episodes: ${eps} (pattern 4)`);
            return eps;
        }

        console.warn(`[MAL] Page scrape found no episode count at ${malUrl}`);
        return null;
    } catch (e) {
        console.error('[MAL] Page scrape error:', e.message);
        return null;
    }
}

// ============= MAL SEARCH =============

async function tryJikanWithEpisodes(query, attempt = 1) {
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
            return tryJikanWithEpisodes(query, attempt + 1);
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
            const anime = json.data[0];
            const resultTitle =
                anime.title || anime.title_english || anime.title_japanese || '';

            const score = titleSimilarity(query, resultTitle);
            if (score < SIMILARITY_THRESHOLD) {
                console.warn(
                    `[MAL] Result "${resultTitle}" doesn't match "${query}" ` +
                    `(score ${score.toFixed(2)} < ${SIMILARITY_THRESHOLD}), skipping`
                );
                return null;
            }

            const link = anime.url;
            const totalEpisodes = anime.episodes || null;
            console.log(
                `[MAL] Jikan hit for "${query}": ${link} ` +
                `(episodes: ${totalEpisodes}, score: ${score.toFixed(2)})`
            );
            return { link, totalEpisodes };
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

/**
 * Season-aware MAL link + episode counter resolver.
 *
 * - For "Grand Blue S3 - 11", the base query becomes "Grand Blue S3" and
 *   candidate queries include "Grand Blue Season 3" and "Grand Blue 3"
 *   so Jikan returns the correct season's MAL entry.
 * - Cache key includes the season, so S1/S2/S3 each cache separately.
 */
async function searchMalLink(env, title, opts = {}) {
    const light = opts.light === true;
    if (!title) return { link: null, totalEpisodes: null };

    const { base, season } = parseSeasonInfo(title);
    if (!base) return { link: null, totalEpisodes: null };

    const cacheKey = buildCacheKey(title);
    console.log(`[MAL] Season-aware cache key: "${cacheKey}" (season=${season})`);

    // ---- 1. Cache lookup ----
    const cachedLink = await getCachedMalLink(env, cacheKey);
    if (cachedLink) {
        console.log(`[MAL] Cache hit for "${cacheKey}": ${cachedLink}`);
        const cachedTotal = await getCachedTotalEpisodes(env, cacheKey);
        if (cachedTotal) {
            return { link: cachedLink, totalEpisodes: cachedTotal };
        }
        if (light) {
            return { link: cachedLink, totalEpisodes: null };
        }
        const malId = extractMalId(cachedLink);
        let total = await fetchEpisodesFromMalId(malId);
        if (!total) total = await scrapeMalEpisodesFromPage(cachedLink);
        if (total) await setCachedTotalEpisodes(env, cacheKey, total);
        return { link: cachedLink, totalEpisodes: total };
    }

    // ---- Build candidates (season-aware) ----
    const candidates = [];
    const push = (q) => {
        const v = (q || '').trim();
        if (v.length > 2 && !candidates.includes(v)) candidates.push(v);
    };

    if (season && season > 1) {
        // Season-specific queries first
        push(`${base} Season ${season}`);
        push(`${base} ${season}`);
        push(`${base} S${season}`);
    }

    // Base-title queries (fall back for S1 / no season)
    push(base);
    push(base.replace(/\s*[-–]\s*/g, ' '));

    const words = base.split(/\s+/);
    if (words.length > 2) {
        push(words.slice(0, 2).join(' '));
    }
    push(words[0]);

    const list = light ? candidates.slice(0, season && season > 1 ? 2 : 1) : candidates;
    console.log(
        `[MAL] Candidates for "${title}"${light ? ' (light)' : ''}: ${JSON.stringify(list)}`
    );

    let link = null;
    let totalEpisodes = null;

    // ---- 2. Jikan search ----
    for (const query of list) {
        SUBREQUEST_COUNT++;
        const result = await tryJikanWithEpisodes(query);
        if (result && result.link) {
            link = result.link;
            totalEpisodes = result.totalEpisodes;
            break;
        }
        await new Promise((r) => setTimeout(r, light ? 200 : 600));
    }

    // ---- Light mode bail-out ----
    if (light) {
        if (link) await setCachedMalLink(env, cacheKey, link);
        if (totalEpisodes) await setCachedTotalEpisodes(env, cacheKey, totalEpisodes);
        return { link, totalEpisodes };
    }

    // ---- 3. Scrape fallback ----
    if (!link) {
        console.warn(`[MAL] Jikan failed for "${cacheKey}", trying scrape...`);
        SUBREQUEST_COUNT++;
        link = await tryMalScrape(base);
        if (!link && candidates.length > 1) {
            SUBREQUEST_COUNT++;
            link = await tryMalScrape(candidates[1]);
        }
    }

    // ---- 4. /anime/{id} for episodes ----
    if (link && !totalEpisodes) {
        const malId = extractMalId(link);
        if (malId) {
            SUBREQUEST_COUNT++;
            totalEpisodes = await fetchEpisodesFromMalId(malId);
        }
    }

    // ---- 5. MAL page scrape for episodes ----
    if (link && !totalEpisodes) {
        SUBREQUEST_COUNT++;
        totalEpisodes = await scrapeMalEpisodesFromPage(link);
    }

    if (link) await setCachedMalLink(env, cacheKey, link);
    if (totalEpisodes) await setCachedTotalEpisodes(env, cacheKey, totalEpisodes);

    return { link, totalEpisodes };
}

// ============= FORMATTING =============

function formatTitle(rawTitle, lang = 'en', malLink = null, totalEpisodes = null, currentEpisode = null) {
    const { base, season, episode: parsedEpisode } = parseSeasonInfo(rawTitle);

    let episode = currentEpisode != null ? currentEpisode : parsedEpisode;

    let message;
    if (season) {
        if (lang === 'fa') {
            message = `قسمت ${episode} فصل ${season} انیمه <b>${base}</b> اومد!`;
        } else {
            message = `<b>${base} Season ${season} - Episode ${episode}</b> Aired!`;
        }
    } else if (episode != null) {
        if (lang === 'fa') {
            message = `قسمت ${episode} انیمه <b>${base}</b> اومد!`;
        } else {
            message = `<b>${base} - Episode ${episode}</b> Aired!`;
        }
    } else {
        if (lang === 'fa') {
            message = `انیمه <b>${base}</b> اومد!`;
        } else {
            message = `<b>${base}</b> Aired!`;
        }
    }

    if (episode && totalEpisodes && parseInt(episode, 10) >= totalEpisodes) {
        if (lang === 'fa') {
            message += ' (پایان)';
        } else {
            message += ' (end)';
        }
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

async function sendRichMessage(env, chatId, html, extra = {}) {
    const url = `${TELEGRAM_API}${env.BOT_TOKEN}/sendRichMessage`;
    const payload = {
        chat_id: chatId,
        rich_message: { html },
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

async function editRichMessage(env, chatId, messageId, html, extra = {}) {
    const url = `${TELEGRAM_API}${env.BOT_TOKEN}/editMessageText`;
    const payload = {
        chat_id: chatId,
        message_id: messageId,
        rich_message: { html },
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

const DAYS = [
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday',
];

const DAY_LABELS_EN = {
    Monday: 'Mon',
    Tuesday: 'Tue',
    Wednesday: 'Wed',
    Thursday: 'Thu',
    Friday: 'Fri',
    Saturday: 'Sat',
    Sunday: 'Sun',
};

const DAY_FULL_FA = {
    Monday: 'دوشنبه',
    Tuesday: 'سه‌شنبه',
    Wednesday: 'چهارشنبه',
    Thursday: 'پنجشنبه',
    Friday: 'جمعه',
    Saturday: 'شنبه',
    Sunday: 'یکشنبه',
};

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

function getCurrentDay(tz) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'long',
    });
    const dayName = fmt.format(new Date());
    return DAYS.includes(dayName) ? dayName : 'Saturday';
}

async function fetchSchedule(tz) {
    const res = await fetch(scheduleApiUrl(tz), {
        headers: {
            'User-Agent': 'SubsPleaseTelegramBot/1.0 (+https://workers.dev)',
            Accept: 'application/json',
        },
    });
    SUBREQUEST_COUNT++;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.schedule) throw new Error('No schedule data returned');
    return json.schedule;
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatDaySchedule(day, entries, lang) {
    const isFa = lang === 'fa';
    const dayName = isFa ? DAY_FULL_FA[day] : day;
    const tzLabel = isFa ? 'به وقت ایران' : 'UTC';

    let html = `<h3>📅 ${dayName} (${tzLabel})</h3>`;

    if (!entries || entries.length === 0) {
        html += isFa
            ? '<p><i>هیچ انتشار برنامه‌ریزی‌شده‌ای وجود ندارد.</i></p>'
            : '<p><i>No releases scheduled.</i></p>';
        return html;
    }

    const MAX_ROWS = 100;
    const shown = entries.slice(0, MAX_ROWS);

    html += '<table bordered striped columns="1,6">';
    html += isFa
        ? '<tr><th>ساعت</th><th>انیمه</th></tr>'
        : '<tr><th>Time</th><th>Show</th></tr>';

    for (const entry of shown) {
        html +=
            `<tr><td nowrap>${escapeHtml(entry.time)}</td>` +
            `<td>${escapeHtml(entry.title)}</td></tr>`;
    }

    html += '</table>';

    if (entries.length > MAX_ROWS) {
        const more = entries.length - MAX_ROWS;
        html += isFa
            ? `<p><i>… و ${more} مورد دیگر</i></p>`
            : `<p><i>… and ${more} more</i></p>`;
    }

    return html;
}

function formatDaySchedulePlain(day, entries, lang) {
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
        msg += `<code>${escapeHtml(entry.time)}</code>  ${escapeHtml(entry.title)}\n`;
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

    const row1 = buttons.slice(0, 4);
    const row2 = buttons.slice(4);
    const rows = [row1, row2].filter((r) => r.length > 0);

    return { inline_keyboard: rows };
}

async function sendScheduleMessage(env, chatId, day, entries, lang, keyboard) {
    const html = formatDaySchedule(day, entries, lang);
    const richRes = await sendRichMessage(env, chatId, html, {
        reply_markup: keyboard,
    });

    if (richRes && richRes.ok) return;

    console.warn(
        '[SCHEDULE] sendRichMessage failed, falling back to plain text:',
        JSON.stringify(richRes).slice(0, 300)
    );

    const plain = formatDaySchedulePlain(day, entries, lang);
    await sendMessage(env, chatId, plain, { reply_markup: keyboard });
}

async function editScheduleMessage(env, chatId, messageId, day, entries, lang, keyboard) {
    const html = formatDaySchedule(day, entries, lang);
    const richRes = await editRichMessage(env, chatId, messageId, html, {
        reply_markup: keyboard,
    });

    if (richRes && richRes.ok) return;

    console.warn(
        '[SCHEDULE] editRichMessage failed, falling back to plain text:',
        JSON.stringify(richRes).slice(0, 300)
    );

    const plain = formatDaySchedulePlain(day, entries, lang);
    await editMessage(env, chatId, messageId, plain, { reply_markup: keyboard });
}

// ============= COMMAND HANDLERS =============

async function handleStart(env, chatId) {
    const lang = await getLang(env, chatId);

    await applyBotFatherCommandsToChat(env, chatId, lang);

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
            `🐛 <b>Debug:</b> sending ${filtered.length} latest titles (light mode)...`
        );

        for (let i = 0; i < filtered.length; i++) {
            const rawTitle = filtered[i];
            const clean = cleanTitle(rawTitle);

            const { link: malLink, totalEpisodes } = await searchMalLink(env, clean, {
                light: true,
            });

            const { episode: currentEpisode } = parseSeasonInfo(clean);

            const body = formatTitle(rawTitle, lang, malLink, totalEpisodes, currentEpisode);
            const finalText = `<b>#${i + 1}</b>\n${body}`;

            await sendMessage(env, chatId, finalText);
            SUBREQUEST_COUNT++;

            await new Promise((r) => setTimeout(r, 100));
        }

        await sendMessage(
            env,
            chatId,
            `🐛 <b>Debug complete.</b>\nSubrequests used: ${SUBREQUEST_COUNT}`
        );
        console.log(`[DEBUG] Total subrequests: ${SUBREQUEST_COUNT}`);
    } catch (e) {
        console.error('[ERROR] /debug failed:', e);
        await sendMessage(env, chatId, `🐛 <b>Debug error:</b> ${e.message}`);
    }
}

async function handleMalTest(env, chatId) {
    const samples = [
        'Grand Blue S3 - 11',
        'Grand Blue S2 - 5',
        'LIAR GAME - 24',
        'Sora wa Akai Kawa no Hotori - 13',
    ];

    let out = '🧪 <b>MAL Search Test</b>\n\n';

    for (const s of samples) {
        const { base, season } = parseSeasonInfo(s);
        const cacheKey = buildCacheKey(s);
        const { link, totalEpisodes } = await searchMalLink(env, s, { light: true });
        const en = formatTitle(s, 'en', null, totalEpisodes, null);
        const fa = formatTitle(s, 'fa', null, totalEpisodes, null);

        out += `<b>Input:</b> <code>${s}</code>\n`;
        out += `<b>Base:</b> <code>${base}</code>\n`;
        out += `<b>Season:</b> ${season || 'none'}\n`;
        out += `<b>CacheKey:</b> <code>${cacheKey}</code>\n`;
        out += `<b>Total Episodes:</b> ${totalEpisodes || 'unknown'}\n`;
        out += `<b>EN:</b> ${en}\n`;
        out += `<b>FA:</b> ${fa}\n`;
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
        const keyboard = buildDayKeyboard(today, lang);

        await sendScheduleMessage(
            env,
            chatId,
            today,
            schedule[today],
            lang,
            keyboard
        );
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

    if (data && data.startsWith('lang:')) {
        const lang = data.split(':')[1];

        await setLang(env, chatId, lang);
        await applyBotFatherCommandsToChat(env, chatId, lang);

        const confirmText =
            lang === 'fa'
                ? '✅ زبان به فارسی تغییر کرد.'
                : '✅ Language changed to English.';
        await editMessage(env, chatId, messageId, confirmText);
        await answerCallback(env, id);
        return;
    }

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
            const keyboard = buildDayKeyboard(day, lang);

            await editScheduleMessage(
                env,
                chatId,
                messageId,
                day,
                schedule[day],
                lang,
                keyboard
            );
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

    const { link: malLink, totalEpisodes } = await searchMalLink(env, searchQuery);

    const { episode: currentEpisode } = parseSeasonInfo(searchQuery);

    const cache = { en: null, fa: null };

    for (const chatId of chats) {
        try {
            const lang = await getLang(env, chatId);
            if (!cache[lang]) {
                cache[lang] = formatTitle(
                    rawTitle,
                    lang,
                    malLink,
                    totalEpisodes,
                    currentEpisode
                );
            }
            const res = await sendMessage(env, chatId, cache[lang]);
            SUBREQUEST_COUNT++;

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
    console.log(`[BROADCAST] Subrequests used: ${SUBREQUEST_COUNT}`);
}

// ============= WORKER ENTRY POINT =============

export default {
    async fetch(request, env, ctx) {
        SUBREQUEST_COUNT = 0;
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
        SUBREQUEST_COUNT = 0;
        ENCRYPTION_KEY = env.DB_ENCRYPTION_KEY || 'default-key-please-change-me';
        ctx.waitUntil(broadcastLatest(env));
    },
};
