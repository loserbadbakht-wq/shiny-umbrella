// ============================================================
// Telegram RSS Bot for SubsPlease – Cloudflare Worker
// With encrypted KV storage (XOR + Base64)
// ============================================================

const RSS_URL = 'https://subsplease.org/rss/?t&r=1080';
const TELEGRAM_API = 'https://api.telegram.org/bot';

// ============= ENCRYPTION HELPERS =============
// Same pattern as FilterOwner bot: XOR plaintext with a padded/truncated key,
// then Base64-encode the result. Not cryptographically strong, but hides
// data from casual inspection of the KV namespace.
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

/**
 * Fetch the latest RSS item title.
 */
async function fetchLatestTitle() {
    const res = await fetch(RSS_URL);
    const xml = await res.text();
    const match = xml.match(/<item>[\s\S]*?<title>(.*?)<\/title>/i);
    if (!match) return null;
    return match[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
}

/**
 * Transform a SubsPlease filename into a user-friendly message.
 *   "[SubsPlease] Azur Lane - Bisoku Zenshin! S2 - 11 (1080p) [1C413FA9].mkv"
 *      -> "Azur Lane - Bisoku Zenshin! S2 - 11 Aired!"         (en)
 *      -> "انیمه Azur Lane - Bisoku Zenshin! S2 - 11 اومد!"    (fa)
 */
function formatTitle(rawTitle, lang = 'en') {
    let title = rawTitle.replace(/^\[SubsPlease\]\s*/i, '');
    title = title.replace(/\.\w+$/, '');                      // remove .mkv
    title = title.replace(/\s*\[[A-F0-9]{8}\]$/, '');         // remove CRC hash
    title = title.replace(/\s*\(\d{3,4}p\)$/, '');            // remove (1080p)
    title = title.trim();

    if (lang === 'fa') {
        return `انیمه ${title} اومد!`;
    }
    return `${title} Aired!`;
}

// ============= TELEGRAM API HELPERS =============

async function sendMessage(env, chatId, text, extra = {}) {
    const url = `${TELEGRAM_API}${env.BOT_TOKEN}/sendMessage`;
    const payload = {
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        ...extra,
    };
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    // Return parsed body so callers can inspect errors.
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

/**
 * Get the language for a chat. Defaults to English ('en').
 * Values are stored encrypted via encryptData/decryptData.
 */
async function getLang(env, chatId) {
    const key = `lang:${chatId}`;
    try {
        const raw = await env.RSS_BOT_KV.get(key);
        if (!raw) return 'en';
        return decryptData(raw);
    } catch (e) {
        console.error(`[ERROR] Failed to decrypt lang for ${chatId}:`, e);
        // Recover from corrupted entry by overwriting with default.
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

/**
 * Broadcast chat list is stored as an encrypted JSON array under
 * a single key. This keeps the KV small and consistent with the
 * FilterOwner bot's encrypted-per-key approach.
 */
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

// ============= COMMAND HANDLERS =============

async function handleStart(env, chatId) {
    const lang = await getLang(env, chatId);
    const text =
        lang === 'fa'
            ? 'سلام! من ربات اطلاع‌رسانی انیمه هستم.\nبرای تغییر زبان از /language استفاده کنید.'
            : 'Hi! I am an anime release notification bot.\nUse /language to change the language.';
    await sendMessage(env, chatId, text);
    await addChatToBroadcast(env, chatId);
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

    const chats = await getBroadcastChats(env);
    if (chats.length === 0) return;

    // Cache per-language formatted text to avoid recomputation.
    const cache = { en: null, fa: null };

    for (const chatId of chats) {
        try {
            const lang = await getLang(env, chatId);
            if (!cache[lang]) {
                cache[lang] = formatTitle(rawTitle, lang);
            }
            const res = await sendMessage(env, chatId, cache[lang]);

            // Cleanup: remove chat if bot is blocked or kicked.
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
}

// ============= WORKER ENTRY POINT =============

export default {
    async fetch(request, env, ctx) {
        // Initialize encryption key from env (same secret as FilterOwner bot).
        ENCRYPTION_KEY = env.DB_ENCRYPTION_KEY || 'default-key-please-change-me';
        globalThis.ENCRYPTION_KEY = ENCRYPTION_KEY;

        if (!env.BOT_TOKEN) {
            console.error('BOT_TOKEN is not set');
            return new Response('Bot token missing', { status: 500 });
        }

        const url = new URL(request.url);

        // Health check.
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
            // ----- Messages -----
            if (update.message) {
                const msg = update.message;
                const chatId = msg.chat.id;
                const text = msg.text || '';

                // Any chat that talks to us becomes a broadcast target.
                await addChatToBroadcast(env, chatId);

                if (text.startsWith('/start')) {
                    await handleStart(env, chatId);
                } else if (text.startsWith('/language')) {
                    await handleLanguage(env, chatId);
                }
            }

            // ----- Callback queries -----
            if (update.callback_query) {
                await handleCallbackQuery(env, update.callback_query);
            }
        } catch (e) {
            console.error('[ERROR] Update handling failed:', e);
        }

        return new Response('OK', { status: 200 });
    },

    /**
     * Cron trigger — runs the RSS check on the schedule from wrangler.toml.
     */
    async scheduled(event, env, ctx) {
        ENCRYPTION_KEY = env.DB_ENCRYPTION_KEY || 'default-key-please-change-me';
        ctx.waitUntil(broadcastLatest(env));
    },
};
