// ============================================================
// Telegram RSS Bot for SubsPlease – Cloudflare Worker
// Encrypted KV · defensive error handling
// ============================================================

const RSS_URL = 'https://subsplease.org/rss/?t&r=1080';
const TELEGRAM_API = 'https://api.telegram.org/bot';

// ============= ENCRYPTION =============
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

function formatTitle(rawTitle, lang = 'en') {
    let title = rawTitle.replace(/^\[SubsPlease\]\s*/i, '');
    title = title.replace(/\.\w+$/, '');
    title = title.replace(/\s*\[[A-F0-9]{8}\]$/, '');
    title = title.replace(/\s*\(\d{3,4}p\)$/, '');
    title = title.trim();
    if (lang === 'fa') return `انیمه ${title} اومد!`;
    return `${title} Aired!`;
}

// ============= TELEGRAM API =============
async function sendMessage(env, chatId, text, extra = {}) {
    if (!env.BOT_TOKEN) {
        console.error('[ERROR] BOT_TOKEN missing – cannot send message');
        return { ok: false, description: 'BOT_TOKEN missing' };
    }
    const url = `${TELEGRAM_API}${env.BOT_TOKEN}/sendMessage`;
    const payload = { chat_id: chatId, text, parse_mode: 'HTML', ...extra };
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!data.ok) {
            console.error('[sendMessage] Telegram error:', JSON.stringify(data));
        }
        return data;
    } catch (e) {
        console.error('[sendMessage] fetch failed:', e);
        return { ok: false, description: String(e) };
    }
}

async function editMessage(env, chatId, messageId, text, extra = {}) {
    if (!env.BOT_TOKEN) return { ok: false };
    const url = `${TELEGRAM_API}${env.BOT_TOKEN}/editMessageText`;
    const payload = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra };
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        return await res.json();
    } catch (e) {
        return { ok: false, description: String(e) };
    }
}

async function answerCallback(env, callbackQueryId) {
    if (!env.BOT_TOKEN) return;
    try {
        await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQueryId }),
        });
    } catch (e) {
        console.error('[answerCallback] failed:', e);
    }
}

// ============= SAFE ENCRYPTED KV HELPERS =============
// Every function returns a safe fallback if KV is unbound or decryption
// fails. They NEVER throw.

function kvReady(env) {
    return env && env.RSS_BOT_KV && typeof env.RSS_BOT_KV.get === 'function';
}

async function getLang(env, chatId) {
    if (!kvReady(env)) return 'en';
    try {
        const raw = await env.RSS_BOT_KV.get(`lang:${chatId}`);
        if (!raw) return 'en';
        return decryptData(raw);
    } catch (e) {
        console.error(`[getLang] failed for ${chatId}:`, e);
        return 'en';
    }
}

async function setLang(env, chatId, lang) {
    if (!kvReady(env)) return false;
    try {
        await env.RSS_BOT_KV.put(`lang:${chatId}`, encryptData(lang));
        return true;
    } catch (e) {
        console.error('[setLang] failed:', e);
        return false;
    }
}

async function getBroadcastChats(env) {
    if (!kvReady(env)) return [];
    try {
        const raw = await env.RSS_BOT_KV.get('broadcast_chats');
        if (!raw) return [];
        return decryptData(raw);
    } catch (e) {
        console.error('[getBroadcastChats] failed:', e);
        return [];
    }
}

async function saveBroadcastChats(env, chats) {
    if (!kvReady(env)) return false;
    try {
        await env.RSS_BOT_KV.put('broadcast_chats', encryptData(chats));
        return true;
    } catch (e) {
        console.error('[saveBroadcastChats] failed:', e);
        return false;
    }
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
    const lang = await getLang(env, chatId); // safe
    const text =
        lang === 'fa'
            ? 'سلام! من ربات اطلاع‌رسانی انیمه هستم.\nبرای تغییر زبان از /language استفاده کنید.'
            : 'Hi! I am an anime release notification bot.\nUse /language to change the language.';
    await sendMessage(env, chatId, text);   // reply FIRST
    await addChatToBroadcast(env, chatId);  // register after — failure is harmless
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
    await addChatToBroadcast(env, chatId);
}

// ---- Debug command ----
async function handleDebug(env, chatId) {
    const hasToken = !!env.BOT_TOKEN;
    const tokenPreview = hasToken
        ? `${env.BOT_TOKEN.slice(0, 8)}…${env.BOT_TOKEN.slice(-4)}`
        : 'MISSING';

    const hasKV = kvReady(env);
    let kvStatus = 'not bound';
    let storedChats = 0;
    if (hasKV) {
        try {
            const chats = await getBroadcastChats(env);
            storedChats = chats.length;
            kvStatus = 'OK';
        } catch (e) {
            kvStatus = `error: ${e.message}`;
        }
    }

    const encKeyLen = (env.DB_ENCRYPTION_KEY || '').length;

    // Also test an actual send so we know the API token works.
    const apiTest = await sendMessage(env, chatId, '🩺 API test OK');

    const lines = [
        `🩺 <b>Debug</b>`,
        ``,
        `BOT_TOKEN: ${hasToken ? '✅ ' + tokenPreview : '❌ MISSING'}`,
        `RSS_BOT_KV binding: ${hasKV ? '✅ present' : '❌ UNDEFINED'}`,
        `KV read test: ${kvStatus}`,
        `Broadcast chats stored: ${storedChats}`,
        `DB_ENCRYPTION_KEY length: ${encKeyLen}`,
        `sendMessage test: ${apiTest.ok ? '✅ OK' : '❌ ' + (apiTest.description || 'unknown')}`,
    ];
    await sendMessage(env, chatId, lines.join('\n'));
}

async function handleCallbackQuery(env, callbackQuery) {
    const { id, data, message } = callbackQuery || {};
    if (!message) {
        await answerCallback(env, id);
        return;
    }
    const chatId = message.chat.id;
    const messageId = message.message_id;

    if (data && data.startsWith('lang:')) {
        const lang = data.split(':')[1];
        const ok = await setLang(env, chatId, lang);
        const confirmText = ok
            ? lang === 'fa'
                ? '✅ زبان به فارسی تغییر کرد.'
                : '✅ Language changed to English.'
            : '⚠️ Could not save language (KV not available).';
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

    const cache = { en: null, fa: null };

    for (const chatId of chats) {
        try {
            const lang = await getLang(env, chatId);
            if (!cache[lang]) cache[lang] = formatTitle(rawTitle, lang);
            const res = await sendMessage(env, chatId, cache[lang]);
            if (res && res.ok === false) {
                const desc = res.description || '';
                if (
                    desc.includes('blocked') ||
                    desc.includes('chat not found') ||
                    desc.includes('kicked') ||
                    desc.includes('user is deactivated')
                ) {
                    console.warn(`Removing ${chatId}: ${desc}`);
                    await removeChatFromBroadcast(env, chatId);
                }
            }
        } catch (err) {
            console.error(`Failed to send to ${chatId}:`, err);
        }
    }
}

// ============= WORKER ENTRY =============
export default {
    async fetch(request, env, ctx) {
        // Init key for this invocation (module scope isn't always shared).
        ENCRYPTION_KEY = env.DB_ENCRYPTION_KEY || 'default-key-please-change-me';

        const url = new URL(request.url);

        if (request.method === 'GET') {
            return new Response('OK', { status: 200 });
        }
        if (request.method !== 'POST') {
            return new Response('Method Not Allowed', { status: 405 });
        }

        // Log every incoming update – visible in `wrangler tail`.
        let update;
        try {
            update = await request.json();
        } catch {
            return new Response('Bad Request', { status: 400 });
        }
        console.log('[UPDATE]', JSON.stringify(update).slice(0, 500));

        // ---- Messages ----
        if (update.message) {
            const msg = update.message;
            const chatId = msg.chat.id;
            const text = msg.text || '';

            // Reply to commands FIRST, then register the chat.
            if (text.startsWith('/start')) {
                await handleStart(env, chatId);
            } else if (text.startsWith('/language')) {
                await handleLanguage(env, chatId);
            } else if (text.startsWith('/debug')) {
                await handleDebug(env, chatId);
            } else {
                // Any other message also registers the chat.
                await addChatToBroadcast(env, chatId);
            }
        }

        // ---- Callback queries ----
        if (update.callback_query) {
            try {
                await handleCallbackQuery(env, update.callback_query);
            } catch (e) {
                console.error('[callback] failed:', e);
            }
        }

        return new Response('OK', { status: 200 });
    },

    async scheduled(event, env, ctx) {
        ENCRYPTION_KEY = env.DB_ENCRYPTION_KEY || 'default-key-please-change-me';
        ctx.waitUntil(broadcastLatest(env));
    },
};
