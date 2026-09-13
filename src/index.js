// ============================================================
// Telegram RSS Bot for SubsPlease – Cloudflare Worker
// With encrypted KV storage, batch filter, duplicate prevention,
// MAL link resolution via DuckDuckGo, PV-only /unsub,
// group /unsub hint, and /debug command (formatted + per-message).
// ============================================================

const RSS_URL = 'https://subsplease.org/rss/?t&r=1080';
const TELEGRAM_API = 'https://api.telegram.org/bot';

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

/**
 * Fetch the N latest titles from the RSS feed (newest first).
 * @param {number} n
 * @returns {Promise<string[]>}
 */
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

async function searchMalLink(title) {
    if (!title) return null;

    const query = encodeURIComponent(`site:myanimelist.net ${title}`);
    const url = `https://html.duckduckgo.com/html/?q=${query}`;

    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        });

        if (!res.ok) {
            console.error(`DDG search failed: HTTP ${res.status}`);
            return null;
        }

        const html = await res.text();
        const match = html.match(
            /https?:\/\/myanimelist\.net\/anime\/\d+\/[A-Za-z0-9_!\-]+/
        );

        if (!match) {
            console.warn(`No MAL link found for "${title}"`);
            return null;
        }

        const link = match[0].replace(/\/$/, '');
        console.log(`MAL link for "${title}": ${link}`);
        return link;
    } catch (e) {
        console.error('Error searching MAL link:', e);
        return null;
    }
}

/**
 * Clean a raw SubsPlease title (remove prefix, extension, CRC, resolution).
 * @returns {string} the clean human-readable title
 */
function cleanTitle(rawTitle) {
    let title = rawTitle.replace(/^\[SubsPlease\]\s*/i, '');
    title = title.replace(/\.\w+$/, '');
    title = title.replace(/\s*\[[A-F0-9]{8}\]$/, '');
    title = title.replace(/\s*\(\d{3,4}p\)$/, '');
    title = title.replace(/\s*\[Batch\]\s*/i, ' ');
    title = title.replace(/\s+/g, ' ').trim();
    return title;
}

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
        message += `\n\n🔗 <a href="${malLink}">${label}</a>`;
    }

    return message;
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

/**
 * /debug — sends the 10 latest formatted titles (with MAL links),
 * one message per title, in the chat's selected language.
 */
async function handleDebug(env, chatId) {
    try {
        const rawTitles = await fetchLatestTitles(10);

        if (rawTitles.length === 0) {
            await sendMessage(env, chatId, '🐛 <b>Debug:</b> No titles found in RSS feed.');
            return;
        }

        const lang = await getLang(env, chatId);

        // Small header so the user knows a batch of debug messages is incoming.
        await sendMessage(
            env,
            chatId,
            `🐛 <b>Debug:</b> sending ${rawTitles.length} latest titles...`
        );

        for (let i = 0; i < rawTitles.length; i++) {
            const rawTitle = rawTitles[i];
            const clean = cleanTitle(rawTitle);

            // Resolve MAL link for this title (may be null on failure).
            const malLink = await searchMalLink(clean);

            // Build the same style of message as a real broadcast.
            const body = formatTitle(rawTitle, lang, malLink);

            // Prefix each message with its index for easy reading.
            const finalText = `<b>#${i + 1}</b>\n${body}`;

            await sendMessage(env, chatId, finalText);
        }

        await sendMessage(env, chatId, '🐛 <b>Debug complete.</b>');
    } catch (e) {
        console.error('[ERROR] /debug failed:', e);
        await sendMessage(env, chatId, `🐛 <b>Debug error:</b> ${e.message}`);
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
        const confirmText =
            lang === 'fa'
                ? '✅ زبان به فارسی تغییر کرد.'
                : '✅ Language changed to English.';
        await editMessage(env, chatId, messageId, confirmText);
        await answerCallback(env, id);
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
    const malLink = await searchMalLink(searchQuery);

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

                // -------- Private chats --------
                if (chatType === 'private') {
                    if (text.startsWith('/start')) {
                        await handleStart(env, chatId);
                    } else if (text.startsWith('/unsub')) {
                        await handleUnsub(env, chatId);
                    } else if (text.startsWith('/language')) {
                        await handleLanguage(env, chatId);
                    } else if (text.startsWith('/debug')) {
                        await handleDebug(env, chatId);
                    }
                }
                // -------- Groups & channels --------
                else {
                    await addChatToBroadcast(env, chatId);

                    if (text.startsWith('/unsub')) {
                        await handleUnsubInGroup(env, chatId);
                    } else if (text.startsWith('/language')) {
                        await handleLanguage(env, chatId);
                    } else if (text.startsWith('/debug')) {
                        await handleDebug(env, chatId);
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
