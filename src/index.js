import { Bot, webhookCallback } from 'grammy';

// ============= TEXT DICTIONARIES =============
const TEXTS = {
    // ... (same as before, keep all your texts) ...
};

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
    const encrypted = Uint8Array.from(atob(encryptedStr), c => c.charCodeAt(0));
    const keyBytes = new TextEncoder().encode(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32));
    const decrypted = new Uint8Array(encrypted.length);
    for (let i = 0; i < encrypted.length; i++) {
        decrypted[i] = encrypted[i] ^ keyBytes[i % keyBytes.length];
    }
    return JSON.parse(new TextDecoder().decode(decrypted));
}

// ============= KV STORAGE HELPERS =============
async function getGroupData(kv, chatId) {
    const key = `group_${chatId}`;
    try {
        const data = await kv.get(key);
        if (data) {
            try {
                return decryptData(data);
            } catch (e) {
                console.error(`[ERROR] Failed to decrypt data for group ${chatId}:`, e);
                const freshData = { gifs: [], stickers: [] };
                await kv.put(key, encryptData(freshData));
                return freshData;
            }
        }
        return { gifs: [], stickers: [] };
    } catch (e) {
        console.error(`[ERROR] Failed to get data for group ${chatId}:`, e);
        return { gifs: [], stickers: [] };
    }
}

async function saveGroupData(kv, chatId, data) {
    const key = `group_${chatId}`;
    await kv.put(key, encryptData(data));
}

async function getUserLanguage(kv, userId) {
    const key = `user_lang_${userId}`;
    const data = await kv.get(key);
    if (data) {
        try {
            return decryptData(data);
        } catch (e) {
            return 'en';
        }
    }
    return 'en';
}

async function saveUserLanguage(kv, userId, lang) {
    const key = `user_lang_${userId}`;
    await kv.put(key, encryptData(lang));
}

// ============= ADMIN CHECK HELPER =============
async function isBotAdmin(ctx) {
    try {
        const botMember = await ctx.api.getChatMember(ctx.chat.id, ctx.me.id);
        console.log(`[DEBUG] Bot status in ${ctx.chat.id}: ${botMember.status}`);
        return ['administrator', 'creator'].includes(botMember.status);
    } catch (e) {
        console.error('[ERROR] Failed to check bot status:', e);
        return false;
    }
}

// ============= DEBUG COMMANDS =============
async function testHandler(ctx) {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const lang = await getUserLanguage(ctx.kv, userId);
    await ctx.reply(
        TEXTS[lang].test_response
            .replace('{chat_id}', chatId)
            .replace('{user_id}', userId)
    );
}

async function kvTestHandler(ctx) {
    const userId = ctx.from.id;
    const lang = await getUserLanguage(ctx.kv, userId);
    const testKey = `test_${userId}_${Date.now()}`;
    try {
        await ctx.kv.put(testKey, encryptData({ test: 'hello', timestamp: Date.now() }));
        const value = await ctx.kv.get(testKey);
        const decrypted = value ? decryptData(value) : null;
        await ctx.reply(
            TEXTS[lang].kv_test
                .replace('{key}', testKey)
                .replace('{value}', decrypted ? JSON.stringify(decrypted) : 'null')
        );
        await ctx.kv.delete(testKey);
    } catch (error) {
        await ctx.reply(
            TEXTS[lang].kv_test_error.replace('{error}', error.message)
        );
    }
}

async function keydebugHandler(ctx) {
    const keyLength = ENCRYPTION_KEY ? ENCRYPTION_KEY.length : 0;
    const keyPreview = ENCRYPTION_KEY ? ENCRYPTION_KEY.slice(0, 10) + '...' : 'NOT SET';
    await ctx.reply(`🔑 ENCRYPTION_KEY:\nLength: ${keyLength}\nPreview: ${keyPreview}`);
}

// ============= COMMAND HANDLERS =============
async function startHandler(ctx) {
    const userId = ctx.from.id;
    const lang = await getUserLanguage(ctx.kv, userId);
    const keyboard = {
        inline_keyboard: [
            [
                { text: TEXTS[lang].language_btn, callback_data: 'change_language' },
                { text: TEXTS[lang].how_it_works_btn, callback_data: 'how_it_works' }
            ]
        ]
    };
    await ctx.reply(TEXTS[lang].welcome, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
    });
}

async function startGroupHandler(ctx) {
    const chatId = ctx.chat.id;
    const chat = await ctx.api.getChat(chatId);
    const groupName = chat.title || 'Group';
    const lang = await getUserLanguage(ctx.kv, ctx.from.id);
    if (!await isBotAdmin(ctx)) {
        await ctx.reply(TEXTS[lang].need_admin_with_delete);
        return;
    }
    await ctx.reply(TEXTS[lang].group_start.replace('{group_name}', groupName), {
        parse_mode: 'Markdown'
    });
}

async function languageCommandHandler(ctx) {
    if (!['group', 'supergroup'].includes(ctx.chat.type)) {
        await ctx.reply('❌ This command only works in groups!');
        return;
    }
    const userId = ctx.from.id;
    const lang = await getUserLanguage(ctx.kv, userId);
    const keyboard = {
        inline_keyboard: [
            [
                { text: '🇮🇷 فارسی', callback_data: 'lang_fa' },
                { text: '🇬🇧 English', callback_data: 'lang_en' }
            ]
        ]
    };
    await ctx.reply(TEXTS[lang].language_command, {
        reply_markup: keyboard
    });
}

async function resetGroupHandler(ctx) {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const lang = await getUserLanguage(ctx.kv, userId);
    if (!['group', 'supergroup'].includes(ctx.chat.type)) {
        await ctx.reply('❌ This command only works in groups!');
        return;
    }
    let isOwner = false;
    try {
        const member = await ctx.api.getChatMember(chatId, userId);
        isOwner = member.status === 'creator' || (member.status === 'administrator' && member.is_chat_owner);
    } catch (e) {
        await ctx.reply(TEXTS[lang].verify_failed);
        return;
    }
    if (!isOwner) {
        await ctx.reply(TEXTS[lang].only_owner);
        return;
    }
    try {
        const key = `group_${chatId}`;
        await ctx.kv.put(key, encryptData({ gifs: [], stickers: [] }));
        await ctx.reply(TEXTS[lang].reset_success);
    } catch (error) {
        console.error('Reset error:', error);
        await ctx.reply(TEXTS[lang].reset_error);
    }
}

async function filterOwnerHandler(ctx) {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const lang = await getUserLanguage(ctx.kv, userId);
    if (!['group', 'supergroup'].includes(ctx.chat.type)) {
        await ctx.reply(TEXTS[lang].cmd_only_groups);
        return;
    }
    if (!await isBotAdmin(ctx)) {
        await ctx.reply(TEXTS[lang].need_admin_first);
        return;
    }
    let isOwner = false;
    try {
        const member = await ctx.api.getChatMember(chatId, userId);
        isOwner = member.status === 'creator' || (member.status === 'administrator' && member.is_chat_owner);
    } catch (e) {
        await ctx.reply(TEXTS[lang].verify_failed);
        return;
    }
    const args = ctx.message.text.split(' ').slice(1);
    const reason = args.length > 0 ? args.join(' ') : 'Not specified';
    const replied = ctx.message.reply_to_message;
    if (!replied) {
        if (isOwner) {
            await ctx.reply(TEXTS[lang].filter_help);
        } else {
            await ctx.reply(TEXTS[lang].filter_added_not_owner);
        }
        return;
    }
    let mediaType = null;
    let fileId = null;
    let mediaNameEn = '';
    let mediaNameFa = '';
    if (replied.animation) {
        mediaType = 'gif';
        fileId = replied.animation.file_id;
        mediaNameEn = 'GIF';
        mediaNameFa = 'گیف';
    } else if (replied.sticker) {
        mediaType = 'sticker';
        fileId = replied.sticker.set_name || replied.sticker.file_id;
        mediaNameEn = 'Sticker Pack';
        mediaNameFa = 'استیکر پک';
    } else {
        if (isOwner) {
            await ctx.reply(TEXTS[lang].wrong_media_type);
        } else {
            await ctx.reply(TEXTS[lang].filter_added_not_owner);
        }
        return;
    }
    if (!isOwner) {
        await ctx.reply(TEXTS[lang].filter_added_not_owner);
        try {
            await ctx.api.deleteMessage(chatId, replied.message_id);
        } catch (e) {}
        return;
    }
    const groupData = await getGroupData(ctx.kv, chatId);
    const key = mediaType === 'gif' ? 'gifs' : 'stickers';
    const existing = groupData[key].find(item => item.file_id === fileId);
    if (existing) {
        const mediaDisplay = lang === 'fa' ? mediaNameFa : mediaNameEn;
        await ctx.reply(TEXTS[lang].already_banned
            .replace('{owner_name}', ctx.from.first_name || 'Owner')
            .replace('{media_type}', mediaDisplay)
        );
        try {
            await ctx.api.deleteMessage(chatId, replied.message_id);
        } catch (e) {}
        return;
    }
    const newEntry = {
        file_id: fileId,
        added_date: new Date().toISOString().replace('T', ' ').slice(0, 19),
        reason: reason
    };
    groupData[key].push(newEntry);
    await saveGroupData(ctx.kv, chatId, groupData);
    const ownerName = ctx.from.first_name || 'Owner';
    const mediaDisplay = lang === 'fa' ? mediaNameFa : mediaNameEn;
    await ctx.reply(TEXTS[lang].filter_added_owner
        .replace('{owner_name}', ownerName)
        .replace('{media_type}', mediaDisplay)
        .replace('{reason}', reason), {
        parse_mode: 'Markdown'
    });
    try {
        await ctx.api.deleteMessage(chatId, replied.message_id);
    } catch (e) {}
}

async function unFilterOwnerHandler(ctx) {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const lang = await getUserLanguage(ctx.kv, userId);
    if (!['group', 'supergroup'].includes(ctx.chat.type)) {
        await ctx.reply(TEXTS[lang].cmd_only_groups);
        return;
    }
    if (!await isBotAdmin(ctx)) {
        await ctx.reply(TEXTS[lang].need_admin_first);
        return;
    }
    let isOwner = false;
    try {
        const member = await ctx.api.getChatMember(chatId, userId);
        isOwner = member.status === 'creator' || (member.status === 'administrator' && member.is_chat_owner);
    } catch (e) {
        await ctx.reply(TEXTS[lang].verify_failed);
        return;
    }
    if (!isOwner) {
        await ctx.reply(TEXTS[lang].only_owner);
        return;
    }
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length === 0) {
        let mediaTypeDisplay = 'GIF (sticker pack)';
        if (lang === 'fa') {
            mediaTypeDisplay = 'گیف (استیکر پک)';
        }
        await ctx.reply(TEXTS[lang].provide_file_id.replace('{media_type}', mediaTypeDisplay));
        return;
    }
    const searchId = args[0];
    const groupData = await getGroupData(ctx.kv, chatId);
    let found = false;
    let removedItem = null;
    let mediaNameEn = '';
    let mediaNameFa = '';
    for (const mediaType of ['gifs', 'stickers']) {
        for (const item of groupData[mediaType]) {
            if (item.file_id.startsWith(searchId) || item.file_id === searchId) {
                groupData[mediaType] = groupData[mediaType].filter(i => i !== item);
                found = true;
                removedItem = item;
                if (mediaType === 'gifs') {
                    mediaNameEn = 'GIF';
                    mediaNameFa = 'گیف';
                } else {
                    mediaNameEn = 'Sticker Pack';
                    mediaNameFa = 'استیکر پک';
                }
                break;
            }
        }
        if (found) break;
    }
    if (found && removedItem) {
        await saveGroupData(ctx.kv, chatId, groupData);
        const mediaDisplay = lang === 'fa' ? mediaNameFa : mediaNameEn;
        await ctx.reply(TEXTS[lang].removed_from_filter.replace('{media_type}', mediaDisplay));
    } else {
        await ctx.reply(TEXTS[lang].invalid_id.replace('{search_id}', searchId));
    }
}

async function listFilteredHandler(ctx) {
    const chatId = ctx.chat.id;
    const lang = await getUserLanguage(ctx.kv, ctx.from.id);
    let groupData;
    try {
        groupData = await getGroupData(ctx.kv, chatId);
    } catch (e) {
        console.error('[ERROR] Failed to get group data:', e);
        await ctx.reply('❌ Error loading data. Please try again.');
        return;
    }
    const total = (groupData.gifs?.length || 0) + (groupData.stickers?.length || 0);
    if (total === 0) {
        if (lang === 'fa') {
            await ctx.reply('📋 لیست فیلتر خالیه، با ریپلای زدن /filterowner <دلیل> به یک گیف یا استیکر یکی به لیست اضافه کن🦍');
        } else {
            await ctx.reply('📋 Filter List is empty, add one by replying /filterowner <reason> to a GIF or Sticker🦍');
        }
        return;
    }
    try {
        const chat = await ctx.api.getChat(chatId);
        const groupName = chat.title || 'This Group';
        let message = `📋 **Filtered Media in ${groupName}** (${total} total)\n\n`;
        message += `_Tap and hold any ID to copy it_\n\n`;
        if (groupData.gifs && groupData.gifs.length > 0) {
            message += `**🎬 GIFs (${groupData.gifs.length}):**\n`;
            let index = 1;
            for (const item of groupData.gifs) {
                try {
                    const date = item.added_date ? item.added_date.slice(0, 16).replace('T', ' ') : 'Unknown date';
                    const reason = item.reason || 'Not specified';
                    message += `${index}. \`${item.file_id || 'unknown'}\`\n`;
                    message += `   📅 ${date}\n`;
                    message += `   📝 ${reason}\n\n`;
                    index++;
                } catch (e) {
                    console.error('[ERROR] Failed to process GIF item:', item, e);
                }
            }
        }
        if (groupData.stickers && groupData.stickers.length > 0) {
            message += `**🖼️ Sticker Packs (${groupData.stickers.length}):**\n`;
            let index = 1;
            for (const item of groupData.stickers) {
                try {
                    const date = item.added_date ? item.added_date.slice(0, 16).replace('T', ' ') : 'Unknown date';
                    const reason = item.reason || 'Not specified';
                    message += `${index}. \`${item.file_id || 'unknown'}\`\n`;
                    message += `   📅 ${date}\n`;
                    message += `   📝 ${reason}\n\n`;
                    index++;
                } catch (e) {
                    console.error('[ERROR] Failed to process Sticker item:', item, e);
                }
            }
        }
        message += `\n💡 **To remove:** \`/unfilterowner <file_id>\`\n`;
        message += `   Tap and hold any ID above to copy it`;
        await ctx.reply(message, { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (error) {
        console.error('[ERROR] Failed to send listFiltered response:', error);
        try {
            await ctx.reply(`📋 Filtered Media (${total} total)\n\nUse /resetgroup to reset data.`);
        } catch (fallbackError) {
            console.error('[ERROR] Fallback also failed:', fallbackError);
            await ctx.reply('❌ Error displaying filtered list. Please use /resetgroup to reset the data.');
        }
    }
}

async function clearFilteredHandler(ctx) {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const lang = await getUserLanguage(ctx.kv, userId);
    if (!['group', 'supergroup'].includes(ctx.chat.type)) {
        await ctx.reply(TEXTS[lang].cmd_only_groups);
        return;
    }
    if (!await isBotAdmin(ctx)) {
        await ctx.reply(TEXTS[lang].need_admin_first);
        return;
    }
    let isOwner = false;
    try {
        const member = await ctx.api.getChatMember(chatId, userId);
        isOwner = member.status === 'creator' || (member.status === 'administrator' && member.is_chat_owner);
    } catch (e) {
        await ctx.reply(TEXTS[lang].verify_failed);
        return;
    }
    if (!isOwner) {
        await ctx.reply(TEXTS[lang].only_owner);
        return;
    }
    const groupData = await getGroupData(ctx.kv, chatId);
    const total = groupData.gifs.length + groupData.stickers.length;
    if (total === 0) {
        await ctx.reply(TEXTS[lang].no_media_to_remove);
        return;
    }
    groupData.gifs = [];
    groupData.stickers = [];
    await saveGroupData(ctx.kv, chatId, groupData);
    await ctx.reply(TEXTS[lang].cleared_filters.replace('{total}', total));
}

// ============= FILTER MEDIA HANDLER (stores warnings for cron deletion) =============
async function filterMediaHandler(ctx) {
    const chatId = ctx.chat.id;
    if (!await isBotAdmin(ctx)) return;
    const message = ctx.message;
    let fileId = null, mediaType = null, mediaNameEn = '', mediaNameFa = '';
    if (message.animation) {
        fileId = message.animation.file_id;
        mediaType = 'gif';
        mediaNameEn = 'GIF';
        mediaNameFa = 'گیف';
    } else if (message.sticker) {
        fileId = message.sticker.set_name || message.sticker.file_id;
        mediaType = 'sticker';
        mediaNameEn = 'Sticker Pack';
        mediaNameFa = 'استیکر پک';
    } else return;
    const groupData = await getGroupData(ctx.kv, chatId);
    const key = mediaType === 'gif' ? 'gifs' : 'stickers';
    const banned = groupData[key].find(item => item.file_id === fileId);
    if (!banned) return;
    const lang = await getUserLanguage(ctx.kv, ctx.from.id);
    const mediaDisplay = lang === 'fa' ? mediaNameFa : mediaNameEn;
    try {
        await ctx.api.deleteMessage(chatId, message.message_id);
        const warningText = TEXTS[lang].filtered_media_warning
            .replace('{media_type}', mediaDisplay)
            .replace('{reason}', banned.reason);
        const sentMessage = await ctx.reply(warningText);
        // Store warning in KV for cron cleanup
        const warningData = {
            chat_id: sentMessage.chat.id,
            message_id: sentMessage.message_id,
            sent_at: Date.now()
        };
        await ctx.kv.put(`warning_${sentMessage.message_id}`, JSON.stringify(warningData), { expirationTtl: 120 }); // expire after 2 minutes
    } catch (e) {
        console.error('Error in filterMediaHandler:', e);
    }
}

// ============= STATUS COMMAND =============
async function statusHandler(ctx) {
    if (!['group', 'supergroup'].includes(ctx.chat.type)) {
        await ctx.reply('❌ This command only works in groups.');
        return;
    }
    const lang = await getUserLanguage(ctx.kv, ctx.from.id);
    try {
        const botMember = await ctx.api.getChatMember(ctx.chat.id, ctx.me.id);
        await ctx.reply(TEXTS[lang].status_ok.replace('{status}', botMember.status));
    } catch (e) {
        await ctx.reply(TEXTS[lang].status_error.replace('{error}', e.message));
    }
}

// ============= CALLBACK QUERY HANDLER =============
async function callbackHandler(ctx) {
    const userId = ctx.from.id;
    const currentLang = await getUserLanguage(ctx.kv, userId);
    if (ctx.callbackQuery.data.startsWith('copy_')) {
        const fileId = ctx.callbackQuery.data.replace('copy_', '');
        await ctx.reply(
            TEXTS[currentLang].copied_id.replace('{file_id}', fileId),
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { 
                                text: '📋 Copy ID', 
                                callback_data: `copy_send_${fileId}`
                            }
                        ]
                    ]
                }
            }
        );
        await ctx.answerCallbackQuery(TEXTS[currentLang].copy_confirm);
        return;
    }
    if (ctx.callbackQuery.data.startsWith('copy_send_')) {
        const fileId = ctx.callbackQuery.data.replace('copy_send_', '');
        await ctx.reply(
            TEXTS[currentLang].id_sent.replace('{file_id}', fileId),
            { parse_mode: 'Markdown' }
        );
        await ctx.answerCallbackQuery(TEXTS[currentLang].copy_confirm);
        return;
    }
    if (ctx.callbackQuery.data === 'change_language') {
        const keyboard = {
            inline_keyboard: [
                [
                    { text: '🇮🇷 فارسی', callback_data: 'lang_fa' },
                    { text: '🇬🇧 English', callback_data: 'lang_en' }
                ]
            ]
        };
        await ctx.editMessageText(TEXTS[currentLang].language_prompt, {
            reply_markup: keyboard
        });
        await ctx.answerCallbackQuery();
        return;
    }
    if (ctx.callbackQuery.data === 'how_it_works') {
        const keyboard = {
            inline_keyboard: [
                [{ text: TEXTS[currentLang].back_btn, callback_data: 'back_to_main' }]
            ]
        };
        await ctx.editMessageText(TEXTS[currentLang].how_it_works, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
        await ctx.answerCallbackQuery();
        return;
    }
    if (ctx.callbackQuery.data === 'back_to_main') {
        const keyboard = {
            inline_keyboard: [
                [
                    { text: TEXTS[currentLang].language_btn, callback_data: 'change_language' },
                    { text: TEXTS[currentLang].how_it_works_btn, callback_data: 'how_it_works' }
                ]
            ]
        };
        await ctx.editMessageText(TEXTS[currentLang].welcome, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
        await ctx.answerCallbackQuery();
        return;
    }
    if (ctx.callbackQuery.data.startsWith('lang_')) {
        const langCode = ctx.callbackQuery.data.split('_')[1];
        try {
            await saveUserLanguage(ctx.kv, userId, langCode);
            const isGroup = ctx.chat?.type && ['group', 'supergroup'].includes(ctx.chat.type);
            if (isGroup) {
                const message = TEXTS[langCode].lang_changed;
                await ctx.reply(message);
                await ctx.answerCallbackQuery();
                try {
                    await ctx.deleteMessage();
                } catch (e) {}
                return;
            } else {
                const keyboard = {
                    inline_keyboard: [
                        [
                            { text: TEXTS[langCode].language_btn, callback_data: 'change_language' },
                            { text: TEXTS[langCode].how_it_works_btn, callback_data: 'how_it_works' }
                        ]
                    ]
                };
                await ctx.editMessageText(TEXTS[langCode].welcome, {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                });
                await ctx.answerCallbackQuery();
            }
        } catch (error) {
            console.error('Language change error:', error);
            await ctx.answerCallbackQuery('❌ Error changing language');
            await ctx.reply('❌ There was an error changing your language. Please try again.');
        }
        return;
    }
}

// ============= CRON SCHEDULED HANDLER =============
async function scheduled(event, env, ctx) {
    const kv = env.KV;
    const BOT_TOKEN = env.BOT_TOKEN;
    const bot = new Bot(BOT_TOKEN);
    const now = Date.now();
    const keys = await kv.list({ prefix: 'warning_' });
    for (const key of keys.keys) {
        const data = await kv.get(key.name);
        if (data) {
            try {
                const parsed = JSON.parse(data);
                if (now - parsed.sent_at > 15000) { // 15 seconds
                    try {
                        await bot.api.deleteMessage(parsed.chat_id, parsed.message_id);
                        console.log(`✅ Deleted warning ${key.name}`);
                    } catch (e) {
                        console.log(`⚠️ Could not delete ${key.name}:`, e.message);
                    }
                    await kv.delete(key.name);
                }
            } catch (e) {
                console.error(`Error processing ${key.name}:`, e);
                await kv.delete(key.name); // clean up invalid entries
            }
        }
    }
}

// ============= BUILD BOT =============
export default {
    async fetch(request, env, ctx) {
        const BOT_TOKEN = env.BOT_TOKEN;
        if (!BOT_TOKEN) {
            console.error("BOT_TOKEN is not set");
            return new Response("Bot token missing", { status: 500 });
        }
        ENCRYPTION_KEY = env.DB_ENCRYPTION_KEY || 'default-key-please-change-me';
        globalThis.ENCRYPTION_KEY = ENCRYPTION_KEY;

        const bot = new Bot(BOT_TOKEN);
        const kv = env.KV;
        bot.use(async (ctx, next) => {
            ctx.kv = kv;
            await next();
        });

        // Commands
        bot.command('test', testHandler);
        bot.command('kvtest', kvTestHandler);
        bot.command('keydebug', keydebugHandler);
        bot.command('start', async (ctx) => {
            if (ctx.chat.type === 'private') {
                await startHandler(ctx);
            } else {
                await startGroupHandler(ctx);
            }
        });
        bot.command('language', languageCommandHandler);
        bot.command('lang', languageCommandHandler);
        bot.command('status', statusHandler);
        bot.command('resetgroup', resetGroupHandler);
        bot.command('filterowner', filterOwnerHandler);
        bot.command('unfilterowner', unFilterOwnerHandler);
        bot.command('listfiltered', listFilteredHandler);
        bot.command('clearfiltered', clearFilteredHandler);

        // Media filter
        bot.on([':animation', ':sticker'], filterMediaHandler);
        bot.on('callback_query:data', callbackHandler);

        const handler = webhookCallback(bot, 'cloudflare-mod');
        return handler(request);
    },
    scheduled
};
