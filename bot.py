import os
import json
from datetime import datetime
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, ChatMember
from telegram.ext import ApplicationBuilder, CommandHandler, MessageHandler, filters, ContextTypes, CallbackQueryHandler, ChatMemberHandler

# ============= CONFIGURATION =============
TOKEN = os.getenv('BOT_TOKEN')
if not TOKEN:
    raise ValueError("BOT_TOKEN not set in environment variables!")

DB_ENCRYPTION_KEY = os.getenv('DB_ENCRYPTION_KEY')
if not DB_ENCRYPTION_KEY:
    raise ValueError("DB_ENCRYPTION_KEY not set in environment variables!")

# ============= ENCRYPTED DATABASE SETUP =============
from pysqlcipher3 import dbapi2 as sqlite

def get_db_connection():
    """Get a connection to the encrypted SQLite database"""
    conn = sqlite.connect('bot_data.db')
    conn.execute("PRAGMA key = '{}'".format(DB_ENCRYPTION_KEY))
    return conn

def init_db():
    """Initialize the database tables if they don't exist"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS groups (
            group_id TEXT PRIMARY KEY,
            data TEXT NOT NULL
        )
    ''')
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS user_languages (
            user_id TEXT PRIMARY KEY,
            language TEXT NOT NULL
        )
    ''')
    
    conn.commit()
    conn.close()

def get_group_data(chat_id: int) -> dict:
    """Get or create data structure for a specific group"""
    chat_id_str = str(chat_id)
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT data FROM groups WHERE group_id = ?", (chat_id_str,))
    result = cursor.fetchone()
    
    if result:
        data = json.loads(result[0])
    else:
        data = {"gifs": [], "stickers": []}
        cursor.execute(
            "INSERT INTO groups (group_id, data) VALUES (?, ?)",
            (chat_id_str, json.dumps(data))
        )
        conn.commit()
    
    conn.close()
    return data

def save_group_data(chat_id: int, data: dict):
    """Save group data to the encrypted database"""
    chat_id_str = str(chat_id)
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute(
        "UPDATE groups SET data = ? WHERE group_id = ?",
        (json.dumps(data), chat_id_str)
    )
    conn.commit()
    conn.close()

def get_user_language(user_id: int) -> str:
    """Get user's preferred language"""
    user_id_str = str(user_id)
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT language FROM user_languages WHERE user_id = ?", (user_id_str,))
    result = cursor.fetchone()
    conn.close()
    
    return result[0] if result else "en"

def save_user_language(user_id: int, language: str):
    """Save user's language preference"""
    user_id_str = str(user_id)
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute(
        "INSERT OR REPLACE INTO user_languages (user_id, language) VALUES (?, ?)",
        (user_id_str, language)
    )
    conn.commit()
    conn.close()

# Initialize the database on startup
init_db()

# ============= TEXT DICTIONARIES =============
TEXTS = {
    "en": {
        "welcome": """🤖 **Welcome to the Group Guardian Bot!**

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
        "filter_removed_original": "🗑️ Original media removed as requested!",
        
        # New messages
        "group_start": "Hello {group_name}, I'm the FilterOwnerBot🦍. I help by keeping the group clean by filtering Owner's Desired GIFs and stickers, even if it used by admins\n\nCommands for the group owner:\n• /filterowner <reason> - Reply to a GIF/sticker to ban it (optional reason)\n• /unfilterowner <ID> - Remove a specific media from filter\n• /listfiltered - See all banned media\n• /clearfiltered - Remove ALL filters\n\nFor more info, use /start in my pv🙈",
        
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
        "welcome": """🤖 **به ربات نگهبان گروه خوش آمدید!**

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
        "filter_removed_original": "🗑️ مدیا اصلی طبق درخواست شما حذف شد!",
        
        # New messages
        "group_start": "سلام {group_name}، من ربات FilterOwnerBot هستم.🦍  من با فیلتر کردن گیف‌ها و استیکرهای موردنظر مالک، حتی اگه توسط ادمین‌ها استفاده بشه، به تمیز نگه داشتن گروه کمک می‌کنم.\n\nدستورات برای مالک گروه:\n• /filterowner <reason>\nپاسخ به یک گیف/استیکر برای مسدود کردن آن (دلیل اختیاری)\n• /unfilterowner <ID>\nحذف یک رسانه خاص از فیلتر\n• /listfiltered \nمشاهده همه رسانه‌های مسدود شده\n• /clearfiltered \nحذف همه فیلترها\n\nبرای اطلاعات بیشتر، من رو در pv استارت کنید🙈",
        
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

# ============= HELPER FUNCTIONS =============
def get_media_info(chat_id: int, file_id: str, media_type: str) -> dict:
    """Get media info from banned data for a specific group"""
    group_data = get_group_data(chat_id)
    key = "gifs" if media_type == "gif" else "stickers"
    for item in group_data[key]:
        if item["file_id"] == file_id:
            return item
    return None

def format_date(date_str: str) -> str:
    """Format date string for display"""
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d %H:%M:%S")
        return dt.strftime("%Y-%m-%d %H:%M")
    except:
        return date_str

async def get_owner_mention(chat_id: int, context: ContextTypes.DEFAULT_TYPE) -> tuple:
    """Get the group owner's mention and language"""
    try:
        admins = await context.bot.get_chat_administrators(chat_id)
        
        for admin in admins:
            if admin.status == "creator":
                owner = admin.user
                lang = get_user_language(owner.id)
                
                if owner.first_name:
                    mention = f"[{owner.first_name}](tg://user?id={owner.id})"
                else:
                    mention = f"[Owner](tg://user?id={owner.id})"
                
                return mention, lang, owner.first_name
        
        return None, "en", None
    except Exception as e:
        print(f"Error getting owner: {e}")
        return None, "en", None

async def check_bot_status(chat_id: int, context: ContextTypes.DEFAULT_TYPE) -> bool:
    """Check if bot is admin in the group"""
    try:
        bot_member = await context.bot.get_chat_member(chat_id, context.bot.id)
        return bot_member.status in ["administrator", "creator"]
    except:
        return False

async def send_status_message(chat_id: int, context: ContextTypes.DEFAULT_TYPE, is_admin: bool, owner_mention: str = None, lang: str = "en"):
    """Send status message to group"""
    try:
        chat = await context.bot.get_chat(chat_id)
        group_name = chat.title or "Group"
        
        if is_admin and owner_mention:
            message = TEXTS[lang]["is_admin"].format(owner_mention=owner_mention)
            await context.bot.send_message(
                chat_id=chat_id,
                text=message,
                parse_mode="Markdown"
            )
        else:
            message = TEXTS[lang]["not_admin"].format(group_name=group_name)
            await context.bot.send_message(
                chat_id=chat_id,
                text=message
            )
    except Exception as e:
        print(f"Error sending status message: {e}")

# ============= CHAT MEMBER HANDLER =============
async def track_chat_members(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle bot status changes in groups"""
    chat_member_update = update.chat_member
    
    if chat_member_update.new_chat_member.user.id != context.bot.id:
        return
    
    if chat_member_update.chat.type not in ["group", "supergroup"]:
        return
    
    chat_id = chat_member_update.chat.id
    new_status = chat_member_update.new_chat_member.status
    
    if new_status in ["member", "administrator", "creator"]:
        owner_mention, lang, _ = await get_owner_mention(chat_id, context)
        is_admin = new_status in ["administrator", "creator"]
        
        await send_status_message(
            chat_id=chat_id,
            context=context,
            is_admin=is_admin,
            owner_mention=owner_mention,
            lang=lang
        )

# ============= PV START COMMAND =============
async def start_private(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /start in private chat"""
    user_id = update.effective_user.id
    lang = get_user_language(user_id)
    
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

# ============= GROUP START COMMAND =============
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
    
    lang = get_user_language(update.effective_user.id)
    await update.message.reply_text(
        TEXTS[lang]["group_start"].format(group_name=group_name),
        parse_mode="Markdown"
    )

# ============= CALLBACK QUERY HANDLER =============
async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle button clicks"""
    query = update.callback_query
    await query.answer()
    
    user_id = update.effective_user.id
    current_lang = get_user_language(user_id)
    
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
        save_user_language(user_id, lang_code)
        
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

# ============= FILTER COMMANDS =============
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
    
    group_data = get_group_data(chat_id)
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
    save_group_data(chat_id, group_data)
    
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
    lang = get_user_language(update.effective_user.id)
    
    group_data = get_group_data(chat_id)
    
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
        save_group_data(chat_id, group_data)
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
    lang = get_user_language(update.effective_user.id)
    
    group_data = get_group_data(chat_id)
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
    
    lang = get_user_language(update.effective_user.id)
    group_data = get_group_data(chat_id)
    total = len(group_data["gifs"]) + len(group_data["stickers"])
    
    if total == 0:
        await update.message.reply_text(TEXTS[lang]["no_media_to_remove"])
        return
    
    group_data["gifs"] = []
    group_data["stickers"] = []
    save_group_data(chat_id, group_data)
    
    await update.message.reply_text(TEXTS[lang]["cleared_filters"].format(total=total))

# ============= MESSAGE HANDLER (The Filter) =============
async def filter_media(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Delete messages that contain banned GIFs or stickers from banned sticker packs"""
    
    if update.effective_chat.type not in ["group", "supergroup"]:
        return
    
    chat_id = update.effective_chat.id
    
    if not await check_bot_status(chat_id, context):
        return
    
    message = update.message
    group_data = get_group_data(chat_id)
    lang = get_user_language(update.effective_user.id)
    
    if message.animation:
        file_id = message.animation.file_id
        for item in group_data["gifs"]:
            if item["file_id"] == file_id:
                # Delete the media
                await message.delete()
                # Send warning with reason
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

# ============= START HANDLER DISPATCHER =============
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Dispatch /start to appropriate handler based on chat type"""
    if update.effective_chat.type == "private":
        await start_private(update, context)
    else:
        await start_group(update, context)

def is_owner(update: Update) -> bool:
    """Check if user is the group owner"""
    chat = update.effective_chat
    user_id = update.effective_user.id
    
    try:
        member = chat.get_member(user_id)
        return member.status in ["creator", "administrator"] and member.is_chat_owner()
    except:
        return False

# ============= HEALTH CHECK ENDPOINT =============
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading

class HealthCheckHandler(BaseHTTPRequestHandler):
    """Handle health check requests to keep the bot alive on Render"""
    
    def do_GET(self):
        if self.path == '/health' or self.path == '/':
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'OK')
        else:
            self.send_response(404)
            self.end_headers()
    
    def log_message(self, format, *args):
        # Suppress logging to keep console clean
        pass

def run_health_server():
    """Run a simple HTTP server for health checks on Render's required port"""
    port = int(os.getenv('PORT', 8000))
    server = HTTPServer(('0.0.0.0', port), HealthCheckHandler)
    print(f"🩺 Health check server running on port {port}")
    print(f"🔗 Health check URL: http://0.0.0.0:{port}/health")
    server.serve_forever()

# Start the health check server in a separate thread
health_thread = threading.Thread(target=run_health_server, daemon=True)
health_thread.start()

# ============= MAIN APPLICATION =============
def main():
    app = ApplicationBuilder().token(TOKEN).build()
    
    app.add_handler(CommandHandler("start", start))
    app.add_handler(ChatMemberHandler(track_chat_members, ChatMemberHandler.CHAT_MEMBER))
    app.add_handler(CallbackQueryHandler(handle_callback))
    app.add_handler(CommandHandler("filterowner", filterowner))
    app.add_handler(CommandHandler("unfilterowner", unfilterowner))
    app.add_handler(CommandHandler("listfiltered", listfiltered))
    app.add_handler(CommandHandler("clearfiltered", clearfiltered))
    app.add_handler(MessageHandler(
        filters.ANIMATION | filters.Sticker.ALL, 
        filter_media
    ))
    
    print("🤖 Bot is running...")
    print("🔒 Database is encrypted with SQLCipher")
    print("📊 Using encrypted SQLite database for data storage")
    print("💡 Press Ctrl+C to stop")
    app.run_polling()

if __name__ == "__main__":
    main()
