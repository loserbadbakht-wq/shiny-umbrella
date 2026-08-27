import { Bot, webhookCallback } from 'grammy';

// ============= CONFIGURATION =============
// Read from environment (passed via --var from GitHub Secrets)
const BOT_TOKEN = env.BOT_TOKEN || process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('BOT_TOKEN not set!');

const ENCRYPTION_KEY = env.DB_ENCRYPTION_KEY || process.env.DB_ENCRYPTION_KEY || 'default-key-please-change-me';

// ============= ENCRYPTION HELPERS =============
// Simple XOR encryption (no external packages needed)
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
    const data = await kv.get(key);
    if (data) {
        try {
            return decryptData(data);
        } catch (e) {
            return { gifs: [], stickers: [] };
        }
    }
    return { gifs: [], stickers: [] };
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

// ============= TEXT DICTIONARIES =============
const TEXTS = {
    en: {
        welcome: `🤖 **Welcome to the shiny-umbrella Bot!**

This bot can help the owner of groups to prevent users from sending specific GIFs and sticker packs chosen by the owner, even if they are admins.

Now the owner can sleep like a baby, because the admins will lose their teasing privileges and will be forced to annoy each other with dad jokes for all eternity! 😄`,

        language_prompt: '🌍 Please select your desired language:',
        language_btn: '🌍 Language',
        how_it_works_btn: '📖 How it works?',
        how_it_works: `📖 **How the bot works:**

1. **Adding filters:** The owner can reply to a GIF or sticker with this command to filter it:
\`/filterowner <reason (optional)>\`

2. **Automatic removal:** Once added, whenever anyone (even admins!) sends that GIF or sticker, the bot will instantly delete it.

3. **Other commands:**
   • \`/listfiltered\` - This command lists all filtered GIFs and stickers along with their dates and IDs
   • \`/unfilterowner <ID>\` - Using the ID you received from the previous command, you can remove the desired GIF or sticker from the filter
   • \`/clearfiltered\` - This command clears all filters and **cannot be undone!** ⚠️`,

        back_btn: '🔙 Back',
        not_admin: 'Hello {group_name}, this bot needs to be admin to filter🦍',
        is_admin: 'Hello {owner_mention}-sama! I will get to work now!🐒\n\nI will filter the GIFs and sticker packs you desire!\n\nIf you don\'t know how to use me, start me in PV!🙈',
        filter_added_owner: 'Master {owner_name}, this {media_type} is now in the Filter List!🐵\n**Reason:** {reason}',
        filter_added_not_owner: 'Sorry, you don\'t seem to be the owner🦍',
        group_start: 'Hello {group_name}, I\'m shiny-umbrella Bot🦍. I help by keeping the group clean by filtering Owner\'s Desired GIFs and stickers, even if it used by admins\n\nCommands for the group owner:\n• /filterowner <reason> - Reply to a GIF/sticker to ban it (optional reason)\n• /unfilterowner <ID> - Remove a specific media from filter\n• /listfiltered - See all banned media\n• /clearfiltered - Remove ALL filters\n\nFor more info, use /start in my pv🙈',
        already_banned: '{owner_name}-sama, this {media_type} is already in the Filter List🦍',
        removed_from_filter: '✅ This {media_type} removed from the Filter List🙈',
        invalid_id: '{search_id} is Invalid, click /listfiltered to see the right one🦍',
        cleared_filters: '✅ Removed {total} items from the Filter List!🐵',
        empty_filter_list: 'Filter List is empty, add one by replying /filterowner <reason> to a GIF or Sticker🦍',
        no_media_to_remove: 'There is no GIF or Sticker Pack to remove in the Filter List🦍',
        filter_help: 'Reply to a GIF or sticker with /filterowner <reason> to filter it.\n\nExample: Send a GIF, then reply to it with /filterowner Spam GIF\nReason is optional',
        wrong_media_type: 'This bot can only filter GIF and Sticker Pack🦍',
        filtered_media_warning: 'This {media_type} is in the Filter List 🦍\nReason: {reason}'
    },
    fa: {
        welcome: `🤖 **به ربات shiny-umbrella خوش آمدید!**

این ربات می‌تونه به مالک کمک کنه تا ممبرهای گروه نتونن گیف و استیکر پک‌های موردنظر مالک رو بفرستن حتی اگه ادمین گروه باشن.

با این ربات دیگه ادمین‌ها هم نمی‌تونن با فرستادن گیف و استیکر مخرب کرم بریزن! 😄`,

        language_prompt: '🌍 لطفاً زبان مورد نظر خود را انتخاب کنید:',
        language_btn: '🌍 زبان',
        how_it_works_btn: '📖 چجوری کار می‌کنه؟',
        how_it_works: `📖 **ساز و کار ربات:**

۱. **افزودن فیلتر:** مالک می‌تونه با ریپلای زدن این کامند به گیف یا استیکر اون رو فیلتر کنه:
\`/filterowner <دلیل فیلتر شدن (اختیاری)>\`

۲. **حذف خودکار:** بعد از اضافه شدن، هرکی (حتی ادمین‌ها!) که اون گیف یا استیکر رو بفرسته، ربات فوراً اون را حذف می‌کنه

۳. **بقیه کامند ها:**
   • \`/listfiltered\` - این کامند تمام گیف و استیکر پک های فیلتر شده رو لیست میکنه، همراه با تاریخ و آیدی
   • \`/unfilterowner <id>\` - با استفاده از آیدی ای که در کامند قبلی دریافت کردید، میتونید گیف و استیکر موردنظرتون رو از فیلتر خارج کنید
   • \`/clearfiltered\` - این کامند تمام فیلتر هارو پاک میکنه و **قابل بازگشت نیست!** ⚠️`,

        back_btn: '🔙 برگشت',
        not_admin: 'سلام {group_name}، این ربات برای فیلتر کردن نیاز داره که ادمین باشه🦍',
        is_admin: 'سلام {owner_mention}-ساما الان شروع به کار میکنم!🐒\n\nمن گیف ها و استیکر پک های موردنظرت رو فیلتر میکنم!\n\nاگه نمیدونی چجوری ازم استفاده کنی من رو تو PV استارت کن!🙈',
        filter_added_owner: 'ارباب {owner_name}، این {media_type} حالا تو لیست فیلتره!🐵\n**دلیل:** {reason}',
        filter_added_not_owner: 'ببخشیدا، ولی تو مالک بنظر نمیای🦍',
        group_start: 'سلام {group_name}، من ربات shiny-umbrella هستم.🦍  من با فیلتر کردن گیف‌ها و استیکرهای موردنظر مالک، حتی اگه توسط ادمین‌ها استفاده بشه، به تمیز نگه داشتن گروه کمک می‌کنم.\n\nدستورات برای مالک گروه:\n• /filterowner <reason>\nپاسخ به یک گیف/استیکر برای مسدود کردن آن (دلیل اختیاری)\n• /unfilterowner <ID>\nحذف یک رسانه خاص از فیلتر\n• /listfiltered \nمشاهده همه رسانه‌های مسدود شده\n• /clearfiltered \nحذف همه فیلترها\n\nبرای اطلاعات بیشتر، من رو در pv استارت کنید🙈',
        already_banned: '{owner_name}-ساما، این {media_type} از قبل تو لیست فیلتر هست🦍',
        removed_from_filter: '✅ این {media_type} از لیست فیلتر خارج شد🙈',
        invalid_id: '{search_id} معتبر نیست، بزن رو /listfiltered تا درستش رو ببینی🦍',
        cleared_filters: '✅ {total} آیتم از لیست فیلتر حذف شد!🐵',
        empty_filter_list: 'لیست فیلتر خالیه، با ریپلای زدن /filterowner <دلیل> به یک گیف یا استیکر یکی به لیست اضافه کن🦍',
        no_media_to_remove: 'گیف یا استیکر پکی در لیست برای حذف کردن وجود نداره🦍',
        filter_help: 'برای فیلتر کردن یک گیف یا استیکر، با\n/filterowner <دلیل>\nبه اون ریپلای بزنید. \n\nمثال: یک گیف ارسال کنید، بعد با \n/filterowner Spam GIF\nبهش ریپلای بزنید.\nدلیل اختیاریه',
        wrong_media_type: 'این ربات فقط میتونه گیف و استیکر پک رو فیلتر کنه🦍',
        filtered_media_warning: 'این {media_type} در لیست فیلتر قرار داره🦍\nدلیل: {reason}'
    }
};

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
    
    // Check if bot is admin
    try {
        const botMember = await ctx.api.getChatMember(chatId, ctx.bot.id);
        if (!['administrator', 'creator'].includes(botMember.status)) {
            await ctx.reply('⚠️ I need to be an admin to filter messages!\nPlease promote me to admin with delete messages permission.');
            return;
        }
    } catch (e) {
        await ctx.reply('⚠️ I need to be an admin to filter messages!\nPlease promote me to admin with delete messages permission.');
        return;
    }
    
    const lang = await getUserLanguage(ctx.kv, ctx.from.id);
    await ctx.reply(TEXTS[lang].group_start.replace('{group_name}', groupName), {
        parse_mode: 'Markdown'
    });
}

async function filterOwnerHandler(ctx) {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    
    // Check if in group
    if (!['group', 'supergroup'].includes(ctx.chat.type)) {
        await ctx.reply('❌ This command only works in groups!');
        return;
    }
    
    // Check if bot is admin
    try {
        const botMember = await ctx.api.getChatMember(chatId, ctx.bot.id);
        if (!['administrator', 'creator'].includes(botMember.status)) {
            await ctx.reply('❌ I need to be an admin to filter messages! Please promote me first.');
            return;
        }
    } catch (e) {
        await ctx.reply('❌ I need to be an admin to filter messages!');
        return;
    }
    
    // Check if user is owner
    let isOwner = false;
    try {
        const member = await ctx.api.getChatMember(chatId, userId);
        isOwner = member.status === 'creator' || (member.status === 'administrator' && member.is_chat_owner);
    } catch (e) {
        await ctx.reply('❌ Could not verify your permissions.');
        return;
    }
    
    const lang = await getUserLanguage(ctx.kv, userId);
    
    // Extract reason
    const args = ctx.message.text.split(' ').slice(1);
    const reason = args.length > 0 ? args.join(' ') : 'Not specified';
    
    // Check if replying to a message
    const replied = ctx.message.reply_to_message;
    if (!replied) {
        if (isOwner) {
            await ctx.reply(TEXTS[lang].filter_help);
        } else {
            await ctx.reply(TEXTS[lang].filter_added_not_owner);
        }
        return;
    }
    
    // Determine media type
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
    
    // Get group data
    const groupData = await getGroupData(ctx.kv, chatId);
    const key = mediaType === 'gif' ? 'gifs' : 'stickers';
    
    // Check if already banned
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
    
    // Add to banned list
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
    
    // Check if in group
    if (!['group', 'supergroup'].includes(ctx.chat.type)) {
        await ctx.reply('❌ This command only works in groups!');
        return;
    }
    
    // Check if bot is admin
    try {
        const botMember = await ctx.api.getChatMember(chatId, ctx.bot.id);
        if (!['administrator', 'creator'].includes(botMember.status)) {
            await ctx.reply('❌ I need to be an admin to filter messages! Please promote me first.');
            return;
        }
    } catch (e) {
        await ctx.reply('❌ I need to be an admin to filter messages!');
        return;
    }
    
    // Check if user is owner
    let isOwner = false;
    try {
        const member = await ctx.api.getChatMember(chatId, userId);
        isOwner = member.status === 'creator' || (member.status === 'administrator' && member.is_chat_owner);
    } catch (e) {
        await ctx.reply('❌ Could not verify your permissions.');
        return;
    }
    
    if (!isOwner) {
        await ctx.reply('❌ Only the group owner can use this command!');
        return;
    }
    
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length === 0) {
        await ctx.reply(
            '⚠️ Please provide the file ID to remove.\n\n' +
            'Usage: `/unfilterowner <file_id>`\n' +
            'Example: `/unfilterowner CgACAgQAAxkBAA...`\n\n' +
            '💡 Get the ID from `/listfiltered`'
        );
        return;
    }
    
    const searchId = args[0];
    const lang = await getUserLanguage(ctx.kv, userId);
    
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
    const groupData = await getGroupData(ctx.kv, chatId);
    
    const total = groupData.gifs.length + groupData.stickers.length;
    if (total === 0) {
        await ctx.reply(TEXTS[lang].empty_filter_list);
        return;
    }
    
    const chat = await ctx.api.getChat(chatId);
    const groupName = chat.title || 'This Group';
    
    let message = `📋 **Filtered Media in ${groupName}** (${total} total)\n\n`;
    
    if (groupData.gifs.length > 0) {
        message += `**🎬 GIFs (${groupData.gifs.length}):**\n`;
        groupData.gifs.forEach((item, i) => {
            const date = item.added_date.slice(0, 16).replace('T', ' ');
            message += `${i+1}. \`${item.file_id}\`\n`;
            message += `   📅 ${date}\n`;
            message += `   📝 ${item.reason}\n`;
        });
        message += '\n';
    }
    
    if (groupData.stickers.length > 0) {
        message += `**🖼️ Sticker Packs (${groupData.stickers.length}):**\n`;
        groupData.stickers.forEach((item, i) => {
            const date = item.added_date.slice(0, 16).replace('T', ' ');
            message += `${i+1}. \`${item.file_id}\`\n`;
            message += `   📅 ${date}\n`;
            message += `   📝 ${item.reason}\n`;
        });
        message += '\n';
    }
    
    message += `💡 **To remove:** \`/unfilterowner <file_id>\`\n`;
    message += `   Copy the full ID from above`;
    
    await ctx.reply(message, { parse_mode: 'Markdown' });
}

async function clearFilteredHandler(ctx) {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    
    // Check if in group
    if (!['group', 'supergroup'].includes(ctx.chat.type)) {
        await ctx.reply('❌ This command only works in groups!');
        return;
    }
    
    // Check if bot is admin
    try {
        const botMember = await ctx.api.getChatMember(chatId, ctx.bot.id);
        if (!['administrator', 'creator'].includes(botMember.status)) {
            await ctx.reply('❌ I need to be an admin to filter messages! Please promote me first.');
            return;
        }
    } catch (e) {
        await ctx.reply('❌ I need to be an admin to filter messages!');
        return;
    }
    
    // Check if user is owner
    let isOwner = false;
    try {
        const member = await ctx.api.getChatMember(chatId, userId);
        isOwner = member.status === 'creator' || (member.status === 'administrator' && member.is_chat_owner);
    } catch (e) {
        await ctx.reply('❌ Could not verify your permissions.');
        return;
    }
    
    if (!isOwner) {
        await ctx.reply('❌ Only the group owner can use this command!');
        return;
    }
    
    const lang = await getUserLanguage(ctx.kv, userId);
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

// ============= FILTER MEDIA HANDLER =============
async function filterMediaHandler(ctx) {
    const chatId = ctx.chat.id;
    
    // Check if bot is admin
    try {
        const botMember = await ctx.api.getChatMember(chatId, ctx.bot.id);
        if (!['administrator', 'creator'].includes(botMember.status)) {
            return;
        }
    } catch (e) {
        return;
    }
    
    const message = ctx.message;
    let fileId = null;
    let mediaType = null;
    let mediaNameEn = '';
    let mediaNameFa = '';
    
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
    } else {
        return;
    }
    
    const groupData = await getGroupData(ctx.kv, chatId);
    const key = mediaType === 'gif' ? 'gifs' : 'stickers';
    
    const banned = groupData[key].find(item => item.file_id === fileId);
    if (banned) {
        const lang = await getUserLanguage(ctx.kv, ctx.from.id);
        const mediaDisplay = lang === 'fa' ? mediaNameFa : mediaNameEn;
        
        try {
            await ctx.api.deleteMessage(chatId, message.message_id);
            await ctx.reply(TEXTS[lang].filtered_media_warning
                .replace('{media_type}', mediaDisplay)
                .replace('{reason}', banned.reason)
            );
        } catch (e) {}
    }
}

// ============= CALLBACK QUERY HANDLER =============
async function callbackHandler(ctx) {
    const userId = ctx.from.id;
    const currentLang = await getUserLanguage(ctx.kv, userId);
    
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
        await saveUserLanguage(ctx.kv, userId, langCode);
        
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
}

// ============= BUILD BOT =============
export default {
    async fetch(request, env) {
        const bot = new Bot(BOT_TOKEN);
        
        // Store KV reference
        bot.kv = env.KV;
        
        // Add handlers
        bot.command('start', async (ctx) => {
            if (ctx.chat.type === 'private') {
                await startHandler(ctx);
            } else {
                await startGroupHandler(ctx);
            }
        });
        
        bot.command('filterowner', filterOwnerHandler);
        bot.command('unfilterowner', unFilterOwnerHandler);
        bot.command('listfiltered', listFilteredHandler);
        bot.command('clearfiltered', clearFilteredHandler);
        
        // Media filter
        bot.on([':animation', ':sticker'], filterMediaHandler);
        
        // Callback queries
        bot.on('callback_query:data', callbackHandler);
        
        // Create webhook handler
        const handler = webhookCallback(bot, 'cloudflare-mod');
        
        return handler(request);
    }
};
