import { Bot, webhookCallback } from 'grammy';

// ============= TEXT DICTIONARIES =============
const TEXTS = {
    en: {
        welcome: `🤖 **Welcome to the FilterOwner Bot!**

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
        group_start: 'Hello {group_name}, I\'m FilterOwner Bot🦍. I help by keeping the group clean by filtering Owner\'s Desired GIFs and stickers, even if it used by admins\n\nCommands for the group owner:\n• /filterowner <reason> - Reply to a GIF/sticker to ban it (optional reason)\n• /unfilterowner <ID> - Remove a specific media from filter\n• /listfiltered - See all banned media\n• /clearfiltered - Remove ALL filters\n\nFor more info, use /start in my pv🙈',
        already_banned: '{owner_name}-sama, this {media_type} is already in the Filter List🦍',
        removed_from_filter: '✅ This {media_type} removed from the Filter List🙈',
        invalid_id: '{search_id} is Invalid, click /listfiltered to see the right one🦍',
        cleared_filters: '✅ Removed {total} items from the Filter List!🐵',
        empty_filter_list: 'Filter List is empty, add one by replying /filterowner <reason> to a GIF or Sticker🦍',
        no_media_to_remove: 'There is no GIF or Sticker Pack to remove in the Filter List🦍',
        filter_help: 'Reply to a GIF or sticker with /filterowner <reason> to filter it.\n\nExample: Send a GIF, then reply to it with /filterowner Spam GIF\nReason is optional',
        wrong_media_type: 'This bot can only filter GIF and Sticker Pack🦍',
        filtered_media_warning: 'This {media_type} is in the Filter List 🦍\nReason: {reason}',
        cmd_only_groups: 'This command only work in Groups 🦍',
        need_admin_first: 'This bot needs to admin to work, admin it🦍',
        need_admin_short: 'This bot needs to admin to work🦍',
        verify_failed: 'Couldn\'t verify your permissions, are you sure you are the owner?🦍',
        only_owner: 'Sorry dude, only group owner can use this command🦍',
        need_admin_with_delete: 'This bot must be an admin with delete access to filter🦍',
        provide_file_id: 'After /unfilterowner you need to enter the ID of that {media_type}🦍\nThe ID of the filtered files is here🦧: /listfiltered',
        copied_id: '📋 **Copied!**\n\n`{file_id}`\n\n_Tap and hold the ID above to copy it_',
        id_sent: '🆔 **File ID:**\n\n`{file_id}`\n\n_Tap and hold to copy_',
        copy_confirm: '✅ ID ready to copy!',
        language_command: '🌍 Please select your desired language:',
        status_ok: '✅ Bot status: **{status}**',
        status_error: '❌ Error checking bot status: {error}',
        lang_changed: '✅ Your language has been changed to English!',
        reset_success: '✅ Group data has been reset! The bot should work now.',
        reset_error: '❌ Error resetting group data. Please try again.',
        // Debug messages
        test_response: '✅ Bot is working!\nChat ID: {chat_id}\nUser ID: {user_id}',
        kv_test: '✅ KV is working!\nKey: {key}\nValue: {value}',
        kv_test_error: '❌ KV test failed: {error}'
    },
    fa: {
        welcome: `🤖 **به ربات FilterOwner خوش آمدید!**

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
        group_start: 'سلام {group_name}، من ربات FilterOwner هستم.🦍  من با فیلتر کردن گیف‌ها و استیکرهای موردنظر مالک، حتی اگه توسط ادمین‌ها استفاده بشه، به تمیز نگه داشتن گروه کمک می‌کنم.\n\nدستورات برای مالک گروه:\n• /filterowner <reason>\nپاسخ به یک گیف/استیکر برای مسدود کردن آن (دلیل اختیاری)\n• /unfilterowner <ID>\nحذف یک رسانه خاص از فیلتر\n• /listfiltered \nمشاهده همه رسانه‌های مسدود شده\n• /clearfiltered \nحذف همه فیلترها\n\nبرای اطلاعات بیشتر، من رو در pv استارت کنید🙈',
        already_banned: '{owner_name}-ساما، این {media_type} از قبل تو لیست فیلتر هست🦍',
        removed_from_filter: '✅ این {media_type} از لیست فیلتر خارج شد🙈',
        invalid_id: '{search_id} معتبر نیست، بزن رو /listfiltered تا درستش رو ببینی🦍',
        cleared_filters: '✅ {total} آیتم از لیست فیلتر حذف شد!🐵',
        empty_filter_list: 'لیست فیلتر خالیه، با ریپلای زدن /filterowner <دلیل> به یک گیف یا استیکر یکی به لیست اضافه کن🦍',
        no_media_to_remove: 'گیف یا استیکر پکی در لیست برای حذف کردن وجود نداره🦍',
        filter_help: 'برای فیلتر کردن یک گیف یا استیکر، با\n/filterowner <دلیل>\nبه اون ریپلای بزنید. \n\nمثال: یک گیف ارسال کنید، بعد با \n/filterowner Spam GIF\nبهش ریپلای بزنید.\nدلیل اختیاریه',
        wrong_media_type: 'این ربات فقط میتونه گیف و استیکر پک رو فیلتر کنه🦍',
        filtered_media_warning: 'این {media_type} در لیست فیلتر قرار داره🦍\nدلیل: {reason}',
        cmd_only_groups: 'این کامند فقط تو گروه ها کار میکنه🦍',
        need_admin_first: 'این ربات برای فیلتر کردن باید ادمین باشه، ادمینش کنید🦍',
        need_admin_short: 'این ربات برای فیلتر کردن نیاز داره که ادمین باشه🦍',
        verify_failed: 'نمیتونم دسترسی هاتو تشخیص بدم، مطمئنی مالکی؟🦍',
        only_owner: 'شرمنده مشتی، فقط مالک گروه میتونه از این کامند استفاده کنه🦍',
        need_admin_with_delete: 'این ربات برای فیلتر کردن باید ادمین با دسترسی پاک کردن باشه🦍',
        provide_file_id: 'بعد از /unfilterowner باید آیدی اون {media_type} رو وارد کنی🦍\nآیدی فایل های فیلتر شده اینجان🦧: /listfiltered',
        copied_id: '📋 **کپی شد!**\n\n`{file_id}`\n\n_برای کپی کردن آیدی، روی آن فشار دهید و نگه دارید_',
        id_sent: '🆔 **آیدی فایل:**\n\n`{file_id}`\n\n_برای کپی کردن، روی آن فشار دهید و نگه دارید_',
        copy_confirm: '✅ آیدی آماده کپی است!',
        language_command: '🌍 لطفاً زبان مورد نظر خود را انتخاب کنید:',
        status_ok: '✅ وضعیت ربات: **{status}**',
        status_error: '❌ خطا در بررسی وضعیت ربات: {error}',
        lang_changed: '✅ زبان شما به فارسی تغییر کرد!',
        reset_success: '✅ اطلاعات گروه بازنشانی شد! ربات باید الان کار کنه.',
        reset_error: '❌ خطا در بازنشانی اطلاعات گروه. لطفاً دوباره تلاش کنید.',
        // Debug messages
        test_response: '✅ ربات کار میکنه!\nChat ID: {chat_id}\nUser ID: {user_id}',
        kv_test: '✅ KV کار میکنه!\nKey: {key}\nValue: {value}',
        kv_test_error: '❌ تست KV شکست خورد: {error}'
    }
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

// ============= FIXED LISTFILTERED HANDLER =============
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
    message += `_Tap on an ID to copy it_\n\n`;
    
    // Limit to prevent keyboard overflow (Telegram max is ~100 buttons)
    const MAX_ITEMS = 20;
    let shownCount = 0;
    const inlineKeyboard = [];
    
    // Helper function to safely format date
    function formatDate(dateStr) {
        if (!dateStr) return 'Unknown date';
        try {
            return dateStr.slice(0, 16).replace('T', ' ');
        } catch (e) {
            return 'Unknown date';
        }
    }
    
    // Helper function to safely get reason
    function getReason(item) {
        return item.reason || 'Not specified';
    }
    
    // Helper function to safely get file_id
    function getFileId(item) {
        return item.file_id || 'unknown';
    }
    
    function addItems(items, typeLabel) {
        for (const item of items) {
            if (shownCount >= MAX_ITEMS) break;
            try {
                const date = formatDate(item.added_date);
                const fileId = getFileId(item);
                const displayId = fileId.length > 30 ? fileId.slice(0, 30) + '...' : fileId;
                const reason = getReason(item);
                
                message += `${shownCount + 1}. \`${displayId}\`\n`;
                message += `   📅 ${date}\n`;
                message += `   📝 ${reason}\n\n`;
                inlineKeyboard.push([
                    { 
                        text: `📋 Copy ${typeLabel} #${shownCount + 1}`, 
                        callback_data: `copy_${fileId}`
                    }
                ]);
                shownCount++;
            } catch (e) {
                console.error(`[ERROR] Failed to process item:`, item, e);
                // Skip this item and continue
            }
        }
    }
    
    if (groupData.gifs && groupData.gifs.length > 0) {
        message += `**🎬 GIFs (${groupData.gifs.length}):**\n`;
        addItems(groupData.gifs, 'GIF');
    }
    
    if (groupData.stickers && groupData.stickers.length > 0 && shownCount < MAX_ITEMS) {
        message += `**🖼️ Sticker Packs (${groupData.stickers.length}):**\n`;
        addItems(groupData.stickers, 'Sticker');
    }
    
    if (total > MAX_ITEMS) {
        message += `\n_Showing ${MAX_ITEMS} of ${total} items. Use /clearfiltered to remove all._\n`;
    }
    
    message += `\n💡 **To remove:** \`/unfilterowner <file_id>\`\n`;
    message += `   Tap a button below to copy the ID, then paste it in the command`;
    
    const keyboard = {
        inline_keyboard: inlineKeyboard
    };
    
    try {
        await ctx.reply(message, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard,
            disable_web_page_preview: true
        });
    } catch (error) {
        console.error('[ERROR] Failed to send listFiltered response:', error);
        // Fallback: Send without buttons if keyboard is too large
        try {
            await ctx.reply(message, { 
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });
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

// ============= FILTER MEDIA HANDLER =============
async function filterMediaHandler(ctx) {
    const chatId = ctx.chat.id;
    
    if (!await isBotAdmin(ctx)) {
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

// ============= BUILD BOT =============
export default {
    async fetch(request, env) {
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

        // Debug commands
        bot.command('test', testHandler);
        bot.command('kvtest', kvTestHandler);
        bot.command('keydebug', keydebugHandler);

        // Main commands
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

        bot.on([':animation', ':sticker'], filterMediaHandler);
        bot.on('callback_query:data', callbackHandler);

        const handler = webhookCallback(bot, 'cloudflare-mod');
        return handler(request);
    }
};
