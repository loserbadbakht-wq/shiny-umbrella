import os
import json
import base64
import hashlib
from datetime import datetime
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ApplicationBuilder, CommandHandler, MessageHandler, filters, ContextTypes, CallbackQueryHandler

# ============= CONFIGURATION =============
TOKEN = os.getenv('BOT_TOKEN')
if not TOKEN:
    raise ValueError("BOT_TOKEN not set in environment variables!")

# Encryption key (from GitHub Secrets via environment)
ENCRYPTION_KEY = os.getenv('DB_ENCRYPTION_KEY')
if not ENCRYPTION_KEY:
    raise ValueError("DB_ENCRYPTION_KEY not set!")

# Use SHA-256 to derive a 32-byte key from the hex string
try:
    KEY = hashlib.sha256(ENCRYPTION_KEY.encode()).digest()
except Exception as e:
    raise ValueError(f"Invalid encryption key: {e}")

# ============= SIMPLE ENCRYPTION FUNCTIONS (No External Dependencies) =============
def encrypt_data(data: dict) -> str:
    """Simple XOR-based encryption (obfuscation) - NO EXTERNAL PACKAGES NEEDED"""
    json_str = json.dumps(data)
    plaintext = json_str.encode('utf-8')
    
    # Simple XOR encryption with the key (repeated)
    key_bytes = KEY * (len(plaintext) // len(KEY) + 1)
    encrypted = bytes([p ^ k for p, k in zip(plaintext, key_bytes)])
    
    return base64.b64encode(encrypted).decode('utf-8')

def decrypt_data(encrypted_str: str) -> dict:
    """Simple XOR-based decryption (obfuscation)"""
    encrypted = base64.b64decode(encrypted_str.encode('utf-8'))
    
    # Simple XOR decryption with the key (repeated)
    key_bytes = KEY * (len(encrypted) // len(KEY) + 1)
    decrypted = bytes([e ^ k for e, k in zip(encrypted, key_bytes)])
    
    return json.loads(decrypted.decode('utf-8'))

# ============= PERSISTENT STORAGE FUNCTIONS =============
async def get_kv_data(context: ContextTypes.DEFAULT_TYPE, key: str, default=None):
    """Get data from KV storage"""
    try:
        if hasattr(context.bot, 'kv'):
            value = await context.bot.kv.get(key)
            if value:
                return decrypt_data(value)
        return default
    except Exception as e:
        print(f"Error getting KV data: {e}")
        return default

async def set_kv_data(context: ContextTypes.DEFAULT_TYPE, key: str, value: dict):
    """Save data to KV storage (encrypted)"""
    try:
        encrypted = encrypt_data(value)
        if hasattr(context.bot, 'kv'):
            await context.bot.kv.put(key, encrypted)
    except Exception as e:
        print(f"Error setting KV data: {e}")

# ============= HELPER FUNCTIONS =============
async def get_group_data(chat_id: int, context: ContextTypes.DEFAULT_TYPE) -> dict:
    """Get or create data structure for a specific group from KV"""
    chat_id_str = str(chat_id)
    data = await get_kv_data(context, f'group_{chat_id_str}')
    if data is None:
        data = {"gifs": [], "stickers": []}
        await set_kv_data(context, f'group_{chat_id_str}', data)
    return data

async def save_group_data(chat_id: int, data: dict, context: ContextTypes.DEFAULT_TYPE):
    """Save group data to KV (encrypted)"""
    chat_id_str = str(chat_id)
    await set_kv_data(context, f'group_{chat_id_str}', data)

async def get_user_language(user_id: int, context: ContextTypes.DEFAULT_TYPE) -> str:
    """Get user's language preference from KV"""
    user_id_str = str(user_id)
    data = await get_kv_data(context, f'user_lang_{user_id_str}')
    return data if data else "en"

async def save_user_language(user_id: int, language: str, context: ContextTypes.DEFAULT_TYPE):
    """Save user's language preference to KV"""
    user_id_str = str(user_id)
    await set_kv_data(context, f'user_lang_{user_id_str}', language)

def format_date(date_str: str) -> str:
    """Format date string for display"""
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d %H:%M:%S")
        return dt.strftime("%Y-%m-%d %H:%M")
    except:
        return date_str

def is_owner(update: Update) -> bool:
    """Check if user is the group owner"""
    chat = update.effective_chat
    user_id = update.effective_user.id
    
    try:
        member = chat.get_member(user_id)
        return member.status in ["creator", "administrator"] and member.is_chat_owner()
    except:
        return False

async def check_bot_status(chat_id: int, context: ContextTypes.DEFAULT_TYPE) -> bool:
    """Check if bot is admin in the group"""
    try:
        bot_member = await context.bot.get_chat_member(chat_id, context.bot.id)
        return bot_member.status in ["administrator", "creator"]
    except:
        return False

async def get_owner_mention(chat_id: int, context: ContextTypes.DEFAULT_TYPE) -> tuple:
    """Get the group owner's mention and language"""
    try:
        admins = await context.bot.get_chat_administrators(chat_id)
        
        for admin in admins:
            if admin.status == "creator":
                owner = admin.user
                lang = await get_user_language(owner.id, context)
                
                if owner.first_name:
                    mention = f"[{owner.first_name}](tg://user?id={owner.id})"
                else:
                    mention = f"[Owner](tg://user?id={owner.id})"
                
                return mention, lang, owner.first_name
        
        return None, "en", None
    except Exception as e:
        print(f"Error getting owner: {e}")
        return None, "en", None

# ============= TEXT DICTIONARIES =============
TEXTS = {
    "en": {
        "welcome": """🤖 **Welcome to the shiny-umbrella Bot!**

This bot can help the owner of groups to prevent users from sending specific GIFs and sticker packs chosen by the owner, even if they are admins.

Now the owner can sleep like a baby, because the admins will lose their teasing privileges and will be forced to annoy each other with dad jokes for all eternity! 😄""",
        
        "language_prompt": "🌍 Please select your desired language:",
        "language_btn": "🌍 Language",
        "how_it_works_btn": "📖 How it works?",
        "how_it_works": """📖 **How the bot works:**

1. **Adding filters:** The owner can reply to a GIF or sticker with this command to filter it:
`/filterowner <reason (optional)>`

2. **Automatic removal:** Once added, whenever anyone (even admins!) sends that GIF or sticker, the bot will instantly delete it.

3. **Other commands:**
   • `/listfiltered` - This command lists all filtered GIFs and stickers along with their dates and IDs
   • `/unfilterowner <ID>` - Using the ID you received from the previous command, you can remove the desired GIF or sticker from the filter
   • `/clearfiltered` - This command clears all filters and **cannot be undone!** ⚠️""",
        
        "back_btn": "🔙 Back",
        
        "not_admin": "Hello {group_name}, this bot needs to be admin to filter🦍",
        "is_admin": "Hello {owner_mention}-sama! I will get to work now!🐒\n\nI will filter the GIFs and sticker packs you desire!\n\nIf you don't know how to use me, start me in PV!🙈",
        
        "filter_added_owner": "Master {owner_name}, this {media_type} is now in the Filter List!🐵\n**Reason:** {reason}",
        "filter_added_not_owner": "Sorry, you don't seem to be the owner🦍",
        
        "group_start": "Hello {group_name}, I'm shiny-umbrella Bot🦍. I help by keeping the group clean by filtering Owner's Desired GIFs and stickers, even if it used by admins\n\nCommands for the group owner:\n• /filterowner <reason> - Reply to a GIF/sticker to ban it (optional reason)\n• /unfilterowner <ID> - Remove a specific media from filter\n• /listfiltered - See all banned media\n• /clearfiltered - Remove ALL filters\n\nFor more info, use /start in my pv🙈",
        
        "already_banned": "{owner_name}-sama, this {media_type} is already in the Filter List🦍",
        
        "removed_from_filter": "✅ This {media_type} removed from the Filter List🙈",
        
        "invalid_id": "{search_id} is Invalid, click /listfiltered to see the right one🦍",
        
        "cleared_filters": "✅ Removed {total} items from the Filter List!🐵",
        
        "empty_filter_list": "Filter List is empty, add one by replying /filterowner <reason> to a GIF or Sticker🦍",
        
        "no_media_to_remove": "There is no GIF or Sticker Pack to remove in the Filter List🦍",
        
        "filter_help": "Reply to a GIF or sticker with /filterowner <reason> to filter it.\n\nExample: Send a GIF, then reply to it with /filterowner Spam GIF\nReason is optional",
        
        "wrong_media_type": "This bot can only filter GIF and Sticker Pack🦍",
        
        "filtered_media_warning": "This {media_type} is in the Filter List 🦍\nReason: {reason}"
    },
    
    "fa": {
        "welcome": """🤖 **به ربات shiny-umbrella خوش آمدید!**

این ربات می‌تونه به مالک کمک کنه تا ممبرهای گروه نتونن گیف و استیکر پک‌های موردنظر مالک رو بفرستن حتی اگه ادمین گروه باشن.

با این ربات دیگه ادمین‌ها هم نمی‌تونن با فرستادن گیف و استیکر مخرب کرم بریزن! 😄""",
        
        "language_prompt": "🌍 لطفاً زبان مورد نظر خود را انتخاب کنید:",
        "language_btn": "🌍 زبان",
        "how_it_works_btn": "📖 چجوری کار می‌کنه؟",
        "how_it_works": """📖 **ساز و کار ربات:**

۱. **افزودن فیلتر:** مالک می‌تونه با ریپلای زدن این کامند به گیف یا استیکر اون رو فیلتر کنه:
`/filterowner <دلیل فیلتر شدن (اختیاری)>`

۲. **حذف خودکار:** بعد از اضافه شدن، هرکی (حتی ادمین‌ها!) که اون گیف یا استیکر رو بفرسته، ربات فوراً اون را حذف می‌کنه

۳. **بقیه کامند ها:**
   • `/listfiltered` - این کامند تمام گیف و استیکر پک های فیلتر شده رو لیست میکنه، همراه با تاریخ و آیدی
   • `/unfilterowner <id>` - با استفاده از آیدی ای که در کامند قبلی دریافت کردید، میتونید گیف و استیکر موردنظرتون رو از فیلتر خارج کنید
   • `/clearfiltered` - این کامند تمام فیلتر هارو پاک میکنه و **قابل بازگشت نیست!** ⚠️""",
        
        "back_btn": "🔙 برگشت",
        
        "not_admin": "سلام {group_name}، این ربات برای فیلتر کردن نیاز داره که ادمین باشه🦍",
        "is_admin": "سلام {owner_mention}-ساما الان شروع به کار میکنم!🐒\n\nمن گیف ها و استیکر پک های موردنظرت رو فیلتر میکنم!\n\nاگه نمیدونی چجوری ازم استفاده کنی من رو تو PV استارت کن!🙈",
        
        "filter_added_owner": "ارباب {owner_name}، این {media_type} حالا تو لیست فیلتره!🐵\n**دلیل:** {reason}",
        "filter_added_not_owner": "ببخشیدا، ولی تو مالک بنظر نمیای🦍",
        
        "group_start": "سلام {group_name}، من ربات shiny-umbrella هستم.🦍  من با فیلتر کردن گیف‌ها و استیکرهای موردنظر مالک، حتی اگه توسط ادمین‌ها استفاده بشه، به تمیز نگه داشتن گروه کمک می‌کنم.\n\nدستورات برای مالک گروه:\n• /filterowner <reason>\nپاسخ به یک گیف/استیکر برای مسدود کردن آن (دلیل اختیاری)\n• /unfilterowner <ID>\nحذف یک رسانه خاص از فیلتر\n• /listfiltered \nمشاهده همه رسانه‌های مسدود شده\n• /clearfiltered \nحذف همه فیلترها\n\nبرای اطلاعات بیشتر، من رو در pv استارت کنید🙈",
        
        "already_banned": "{owner_name}-ساما، این {media_type} از قبل تو لیست فیلتر هست🦍",
        
        "removed_from_filter": "✅ این {media_type} از لیست فیلتر خارج شد🙈",
        
        "invalid_id": "{search_id} معتبر نیست، بزن رو /listfiltered تا درستش رو ببینی🦍",
        
        "cleared_filters": "✅ {total} آیتم از لیست فیلتر حذف شد!🐵",
        
        "empty_filter_list": "لیست فیلتر خالیه، با ریپلای زدن /filterowner <دلیل> به یک گیف یا استیکر یکی به لیست اضافه کن🦍",
        
        "no_media_to_remove": "گیف یا استیکر پکی در لیست برای حذف کردن وجود نداره🦍",
        
        "filter_help": "برای فیلتر کردن یک گیف یا استیکر، با\n/filterowner <دلیل>\nبه اون ریپلای بزنید. \n\nمثال: یک گیف ارسال کنید، بعد با \n/filterowner Spam GIF\nبهش ریپلای بزنید.\nدلیل اختیاریه",
        
        "wrong_media_type": "این ربات فقط میتونه گیف و استیکر پک رو فیلتر کنه🦍",
        
        "filtered_media_warning": "این {media_type} در لیست فیلتر قرار داره🦍\nدلیل: {reason}"
    }
}

# ============= COMMAND HANDLERS =============
async def start_private(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /start in private chat"""
    user_id = update.effective_user.id
    lang = await get_user_language(user_id, context)
    
    keyboard = [
        [
            InlineKeyboardButton(TEXTS[lang]["language_btn"], callback_data="change_language"),
            InlineKeyboardButton(TEXTS[lang]["how_it_works_btn"], callback_data="how_it_works")
        ]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    
    await update.message.reply_text(
        TEXTS[lang]["welcome"],
        reply_markup=reply_markup,
        parse_mode="Markdown"
    )

async def start_group(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /start in group chat"""
    chat_id = update.effective_chat.id
    chat = await context.bot.get_chat(chat_id)
    group_name = chat.title or "Group"
    
    is_admin = await check_bot_status(chat_id, context)
    
    if not is_admin:
        await update.message.reply_text(
            "⚠️ I need to be an admin to filter messages!\n"
            "Please promote me to admin with delete messages permission."
        )
        return
    
    lang = await get_user_language(update.effective_user.id, context)
    await update.message.reply_text(
        TEXTS[lang]["group_start"].format(group_name=group_name),
        parse_mode="Markdown"
    )

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Dispatch /start to appropriate handler based on chat type"""
    if update.effective_chat.type == "private":
        await start_private(update, context)
    else:
        await start_group(update, context)

async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle button clicks"""
    query = update.callback_query
    await query.answer()
    
    user_id = update.effective_user.id
    current_lang = await get_user_language(user_id, context)
    
    if query.data == "change_language":
        keyboard = [
            [
                InlineKeyboardButton("🇮🇷 فارسی", callback_data="lang_fa"),
                InlineKeyboardButton("🇬🇧 English", callback_data="lang_en")
            ]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        await query.edit_message_text(
            TEXTS[current_lang]["language_prompt"],
            reply_markup=reply_markup
        )
    
    elif query.data.startswith("lang_"):
        lang_code = query.data.split("_")[1]
        await save_user_language(user_id, lang_code, context)
        
        keyboard = [
            [
                InlineKeyboardButton(TEXTS[lang_code]["language_btn"], callback_data="change_language"),
                InlineKeyboardButton(TEXTS[lang_code]["how_it_works_btn"], callback_data="how_it_works")
            ]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        await query.edit_message_text(
            TEXTS[lang_code]["welcome"],
            reply_markup=reply_markup,
            parse_mode="Markdown"
        )
    
    elif query.data == "how_it_works":
        keyboard = [
            [InlineKeyboardButton(TEXTS[current_lang]["back_btn"], callback_data="back_to_main")]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        await query.edit_message_text(
            TEXTS[current_lang]["how_it_works"],
            reply_markup=reply_markup,
            parse_mode="Markdown"
        )
    
    elif query.data == "back_to_main":
        keyboard = [
            [
                InlineKeyboardButton(TEXTS[current_lang]["language_btn"], callback_data="change_language"),
                InlineKeyboardButton(TEXTS[current_lang]["how_it_works_btn"], callback_data="how_it_works")
            ]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        await query.edit_message_text(
            TEXTS[current_lang]["welcome"],
            reply_markup=reply_markup,
            parse_mode="Markdown"
        )

async def filterowner(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Add a GIF or sticker pack to the filter list with optional reason"""
    
    if update.effective_chat.type not in ["group", "supergroup"]:
        await update.message.reply_text("❌ This command only works in groups!")
        return
    
    chat_id = update.effective_chat.id
    
    if not await check_bot_status(chat_id, context):
        await update.message.reply_text("❌ I need to be an admin to filter messages! Please promote me first.")
        return
    
    owner_mention, lang, owner_name = await get_owner_mention(chat_id, context)
    is_owner_user = is_owner(update)
    
    args = context.args
    reason = " ".join(args) if args else "Not specified"
    
    replied = update.message.reply_to_message
    
    if not replied:
        if is_owner_user:
            await update.message.reply_text(TEXTS[lang]["filter_help"])
        else:
            await update.message.reply_text(TEXTS[lang]["filter_added_not_owner"])
        return
    
    if replied.animation:
        media_type = "gif"
        file_id = replied.animation.file_id
        media_name_en = "GIF"
        media_name_fa = "گیف"
    elif replied.sticker:
        media_type = "sticker"
        if replied.sticker.set_name:
            file_id = replied.sticker.set_name
        else:
            file_id = replied.sticker.file_id
        media_name_en = "Sticker Pack"
        media_name_fa = "استیکر پک"
    else:
        if is_owner_user:
            await update.message.reply_text(TEXTS[lang]["wrong_media_type"])
        else:
            await update.message.reply_text(TEXTS[lang]["filter_added_not_owner"])
        return
    
    if not is_owner_user:
        await update.message.reply_text(TEXTS[lang]["filter_added_not_owner"])
        try:
            await replied.delete()
        except:
            pass
        return
    
    group_data = await get_group_data(chat_id, context)
    key = "gifs" if media_type == "gif" else "stickers"
    
    existing = None
    for item in group_data[key]:
        if item["file_id"] == file_id:
            existing = item
            break
    
    if existing:
        media_display = media_name_fa if lang == "fa" else media_name_en
        await update.message.reply_text(
            TEXTS[lang]["already_banned"].format(
                owner_name=owner_name or "Owner",
                media_type=media_display
            )
        )
        try:
            await replied.delete()
        except:
            pass
        return
    
    new_entry = {
        "file_id": file_id,
        "added_date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "reason": reason
    }
    
    group_data[key].append(new_entry)
    await save_group_data(chat_id, group_data, context)
    
    owner_first_name = owner_name or "Owner"
    media_display = media_name_fa if lang == "fa" else media_name_en
    
    message = TEXTS[lang]["filter_added_owner"].format(
        owner_name=owner_first_name,
        media_type=media_display,
        reason=reason
    )
    
    await update.message.reply_text(message, parse_mode="Markdown")
    
    try:
        await replied.delete()
    except Exception as e:
        print(f"Error deleting original media: {e}")

async def unfilterowner(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Remove a media from the filter list using ID"""
    
    if update.effective_chat.type not in ["group", "supergroup"]:
        await update.message.reply_text("❌ This command only works in groups!")
        return
    
    chat_id = update.effective_chat.id
    
    if not await check_bot_status(chat_id, context):
        await update.message.reply_text("❌ I need to be an admin to filter messages! Please promote me first.")
        return
    
    if not is_owner(update):
        await update.message.reply_text("❌ Only the group owner can use this command!")
        return
    
    args = context.args
    if not args:
        await update.message.reply_text(
            "⚠️ Please provide the file ID to remove.\n\n"
            "Usage: `/unfilterowner <file_id>`\n"
            "Example: `/unfilterowner CgACAgQAAxkBAA...`\n\n"
            "💡 Get the ID from `/listfiltered`"
        )
        return
    
    search_id = args[0]
    lang = await get_user_language(update.effective_user.id, context)
    
    group_data = await get_group_data(chat_id, context)
    
    found = False
    removed_item = None
    media_name_en = ""
    media_name_fa = ""
    
    for media_type in ["gifs", "stickers"]:
        for item in group_data[media_type]:
            if item["file_id"].startswith(search_id) or item["file_id"] == search_id:
                group_data[media_type].remove(item)
                found = True
                removed_item = item
                if media_type == "gifs":
                    media_name_en = "GIF"
                    media_name_fa = "گیف"
                else:
                    media_name_en = "Sticker Pack"
                    media_name_fa = "استیکر پک"
                break
        if found:
            break
    
    if found and removed_item:
        await save_group_data(chat_id, group_data, context)
        media_display = media_name_fa if lang == "fa" else media_name_en
        await update.message.reply_text(
            TEXTS[lang]["removed_from_filter"].format(media_type=media_display)
        )
    else:
        await update.message.reply_text(
            TEXTS[lang]["invalid_id"].format(search_id=search_id)
        )

async def listfiltered(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """List all currently banned media with their IDs, dates, and reasons"""
    
    if update.effective_chat.type not in ["group", "supergroup"]:
        await update.message.reply_text("❌ This command only works in groups!")
        return
    
    chat_id = update.effective_chat.id
    lang = await get_user_language(update.effective_user.id, context)
    
    group_data = await get_group_data(chat_id, context)
    gif_count = len(group_data["gifs"])
    sticker_count = len(group_data["stickers"])
    total = gif_count + sticker_count
    
    if total == 0:
        await update.message.reply_text(TEXTS[lang]["empty_filter_list"])
        return
    
    chat = await context.bot.get_chat(chat_id)
    group_name = chat.title or "This Group"
    
    message = f"📋 **Filtered Media in {group_name}** ({total} total)\n\n"
    
    if gif_count > 0:
        message += f"**🎬 GIFs ({gif_count}):**\n"
        for i, item in enumerate(group_data["gifs"], 1):
            date = format_date(item['added_date'])
            reason = item.get('reason', 'Not specified')
            message += f"{i}. `{item['file_id']}`\n"
            message += f"   📅 {date}\n"
            message += f"   📝 {reason}\n"
        message += "\n"
    
    if sticker_count > 0:
        message += f"**🖼️ Sticker Packs ({sticker_count}):**\n"
        for i, item in enumerate(group_data["stickers"], 1):
            date = format_date(item['added_date'])
            reason = item.get('reason', 'Not specified')
            message += f"{i}. `{item['file_id']}`\n"
            message += f"   📅 {date}\n"
            message += f"   📝 {reason}\n"
        message += "\n"
    
    message += f"💡 **To remove:** `/unfilterowner <file_id>`\n"
    message += f"   Copy the full ID from above"
    
    await update.message.reply_text(message, parse_mode="Markdown")

async def clearfiltered(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Clear all banned media (owner only)"""
    
    if update.effective_chat.type not in ["group", "supergroup"]:
        await update.message.reply_text("❌ This command only works in groups!")
        return
    
    chat_id = update.effective_chat.id
    
    if not await check_bot_status(chat_id, context):
        await update.message.reply_text("❌ I need to be an admin to filter messages! Please promote me first.")
        return
    
    if not is_owner(update):
        await update.message.reply_text("❌ Only the group owner can use this command!")
        return
    
    lang = await get_user_language(update.effective_user.id, context)
    group_data = await get_group_data(chat_id, context)
    total = len(group_data["gifs"]) + len(group_data["stickers"])
    
    if total == 0:
        await update.message.reply_text(TEXTS[lang]["no_media_to_remove"])
        return
    
    group_data["gifs"] = []
    group_data["stickers"] = []
    await save_group_data(chat_id, group_data, context)
    
    await update.message.reply_text(TEXTS[lang]["cleared_filters"].format(total=total))

async def filter_media(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Delete messages that contain banned GIFs or stickers from banned sticker packs"""
    
    if update.effective_chat.type not in ["group", "supergroup"]:
        return
    
    chat_id = update.effective_chat.id
    
    if not await check_bot_status(chat_id, context):
        return
    
    message = update.message
    group_data = await get_group_data(chat_id, context)
    lang = await get_user_language(update.effective_user.id, context)
    
    if message.animation:
        file_id = message.animation.file_id
        for item in group_data["gifs"]:
            if item["file_id"] == file_id:
                await message.delete()
                media_display = "GIF" if lang == "en" else "گیف"
                await message.reply_text(
                    TEXTS[lang]["filtered_media_warning"].format(
                        media_type=media_display,
                        reason=item.get('reason', 'Not specified')
                    )
                )
                return
    
    if message.sticker:
        sticker_set_name = message.sticker.set_name
        if sticker_set_name:
            for item in group_data["stickers"]:
                if item["file_id"] == sticker_set_name:
                    await message.delete()
                    media_display = "Sticker Pack" if lang == "en" else "استیکر پک"
                    await message.reply_text(
                        TEXTS[lang]["filtered_media_warning"].format(
                            media_type=media_display,
                            reason=item.get('reason', 'Not specified')
                        )
                    )
                    return
        else:
            file_id = message.sticker.file_id
            for item in group_data["stickers"]:
                if item["file_id"] == file_id:
                    await message.delete()
                    media_display = "Sticker Pack" if lang == "en" else "استیکر پک"
                    await message.reply_text(
                        TEXTS[lang]["filtered_media_warning"].format(
                            media_type=media_display,
                            reason=item.get('reason', 'Not specified')
                        )
                    )
                    return

# ============= WEBHOOK HANDLER =============
async def webhook(request):
    """Handle incoming webhook requests from Telegram"""
    if request.method == "POST":
        try:
            data = await request.json()
            update = Update.de_json(data, app.bot)
            await app.process_update(update)
            return {"status": "ok"}
        except Exception as e:
            print(f"Error processing update: {e}")
            return {"status": "error", "message": str(e)}, 500
    
    return {"status": "ok", "message": "Webhook is active"}

# ============= BUILD APPLICATION =============
app = ApplicationBuilder().token(TOKEN).build()

# Add all handlers
app.add_handler(CommandHandler("start", start))
app.add_handler(CallbackQueryHandler(handle_callback))
app.add_handler(CommandHandler("filterowner", filterowner))
app.add_handler(CommandHandler("unfilterowner", unfilterowner))
app.add_handler(CommandHandler("listfiltered", listfiltered))
app.add_handler(CommandHandler("clearfiltered", clearfiltered))
app.add_handler(MessageHandler(
    filters.ANIMATION | filters.Sticker.ALL, 
    filter_media
))

# ============= MAIN (for local testing) =============
if __name__ == "__main__":
    print("🤖 shiny-umbrella Bot is running in polling mode for local testing...")
    print("🔒 Data is encrypted using XOR with SHA-256 derived key (built-in modules only)")
    app.run_polling()
