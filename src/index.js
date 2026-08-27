// ... (TEXTS object same as before) ...

// ============= COMMAND HANDLERS =============
// ... (startHandler, etc.) ...

async function startGroupHandler(ctx) {
    const chatId = ctx.chat.id;
    const chat = await ctx.api.getChat(chatId);
    const groupName = chat.title || 'Group';
    const lang = await getUserLanguage(ctx.kv, ctx.from.id);
    
    try {
        // Use ctx.me.id instead of ctx.bot.id
        const botMember = await ctx.api.getChatMember(chatId, ctx.me.id);
        console.log(`[DEBUG] Bot status in ${chatId}: ${botMember.status}`);
        if (!['administrator', 'creator'].includes(botMember.status)) {
            await ctx.reply(TEXTS[lang].need_admin_with_delete);
            return;
        }
    } catch (e) {
        console.error('[ERROR] Failed to check bot status:', e);
        await ctx.reply(TEXTS[lang].need_admin_with_delete);
        return;
    }
    
    await ctx.reply(TEXTS[lang].group_start.replace('{group_name}', groupName), {
        parse_mode: 'Markdown'
    });
}

// Similarly update filterOwnerHandler, unFilterOwnerHandler, clearFilteredHandler
// Replace ctx.bot.id with ctx.me.id in all of them.
// Also add the language command in the bot setup.

// ============= BUILD BOT =============
export default {
    async fetch(request, env) {
        const BOT_TOKEN = env.BOT_TOKEN;
        if (!BOT_TOKEN) {
            console.error("BOT_TOKEN is not set");
            return new Response("Bot token missing", { status: 500 });
        }

        ENCRYPTION_KEY = env.DB_ENCRYPTION_KEY || 'default-key-please-change-me';

        const bot = new Bot(BOT_TOKEN);
        const kv = env.KV;

        bot.use(async (ctx, next) => {
            ctx.kv = kv;
            await next();
        });

        bot.command('start', async (ctx) => {
            if (ctx.chat.type === 'private') {
                await startHandler(ctx);
            } else {
                await startGroupHandler(ctx);
            }
        });

        // Ensure the language command is registered
        bot.command('language', languageCommandHandler);
        // You can also add an alias for convenience
        bot.command('lang', languageCommandHandler);

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
