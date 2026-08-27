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
    
    // Limit to prevent keyboard overflow
    const MAX_ITEMS = 20;
    let shownCount = 0;
    const inlineKeyboard = [];
    
    // Helper to add items
    function addItems(items, typeLabel) {
        for (const item of items) {
            if (shownCount >= MAX_ITEMS) break;
            const date = item.added_date.slice(0, 16).replace('T', ' ');
            const displayId = item.file_id.length > 30 ? item.file_id.slice(0, 30) + '...' : item.file_id;
            message += `${shownCount + 1}. \`${displayId}\`\n`;
            message += `   📅 ${date}\n`;
            message += `   📝 ${item.reason}\n\n`;
            inlineKeyboard.push([
                { 
                    text: `📋 Copy ${typeLabel} #${shownCount + 1}`, 
                    callback_data: `copy_${item.file_id}`
                }
            ]);
            shownCount++;
        }
    }
    
    if (groupData.gifs.length > 0) {
        message += `**🎬 GIFs (${groupData.gifs.length}):**\n`;
        addItems(groupData.gifs, 'GIF');
    }
    
    if (groupData.stickers.length > 0 && shownCount < MAX_ITEMS) {
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
        // Fallback: Send without buttons
        await ctx.reply(message, { 
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });
    }
          }
