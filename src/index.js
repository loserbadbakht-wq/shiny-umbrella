// src/index.js
// Telegram bot on Cloudflare Workers: Persian ↔ Tajik Cyrillic transliteration

// ---------- Mapping tables (from fa.wikipedia.org/wiki/الفبای_تاجیکی) ----------

const persianToCyrillic = {
  'ا': 'А', 'آ': 'О', 'أ': 'А', 'إ': 'И', 'ب': 'Б', 'پ': 'П',
  'ت': 'Т', 'ث': 'С', 'ج': 'Ҷ', 'چ': 'Ч', 'ح': 'Ҳ', 'خ': 'Х',
  'د': 'Д', 'ذ': 'З', 'ر': 'Р', 'ز': 'З', 'ژ': 'Ж', 'س': 'С',
  'ش': 'Ш', 'ص': 'С', 'ض': 'З', 'ط': 'Т', 'ظ': 'З', 'ع': 'ъ',
  'غ': 'Ғ', 'ف': 'Ф', 'ق': 'Қ', 'ک': 'К', 'گ': 'Г', 'ل': 'Л',
  'م': 'М', 'ن': 'Н', 'و': 'В', 'ه': 'Ҳ', 'ی': 'Й', 'ء': 'ъ',
  'ؤ': 'У', 'ئ': 'Й', 'ة': 'Ҳ',
  'َ': 'А', 'ِ': 'И', 'ُ': 'У', 'ً': 'А', 'ٍ': 'И', 'ٌ': 'У',
  'ْ': '', 'ّ': '',
};

const cyrillicToPersian = {
  'А': 'ا', 'а': 'ا',
  'Б': 'ب', 'б': 'ب',
  'В': 'و', 'в': 'و',
  'Г': 'گ', 'г': 'گ',
  'Ғ': 'غ', 'ғ': 'غ',
  'Д': 'د', 'д': 'د',
  'Е': 'ای', 'е': 'ای',
  'Ё': 'یا', 'ё': 'یا',
  'Ж': 'ژ', 'ж': 'ژ',
  'З': 'ز', 'з': 'ز',
  'И': 'اِ', 'и': 'اِ',
  'Ӣ': 'ی', 'ӣ': 'ی',
  'Й': 'ی', 'й': 'ی',
  'К': 'ک', 'к': 'ک',
  'Қ': 'ق', 'қ': 'ق',
  'Л': 'ل', 'л': 'ل',
  'М': 'م', 'м': 'م',
  'Н': 'ن', 'н': 'н',
  'О': 'آ', 'о': 'آ',
  'П': 'پ', 'п': 'پ',
  'Р': 'ر', 'р': 'ر',
  'С': 'س', 'с': 'с',
  'Т': 'ت', 'т': 'ت',
  'У': 'اُ', 'у': 'اُ',
  'Ӯ': 'و', 'ӯ': 'و',
  'Ф': 'ف', 'ф': 'ф',
  'Х': 'خ', 'х': 'х',
  'Ҳ': 'ح', 'ҳ': 'ح',
  'Ч': 'چ', 'ч': 'چ',
  'Ҷ': 'ج', 'ҷ': 'ج',
  'Ш': 'ش', 'ш': 'ш',
  'ъ': 'ع',
  'Э': 'ای', 'э': 'ای',
  'Ю': 'یو', 'ю': 'یو',
  'Я': 'یا', 'я': 'یا',
};

// ---------- Helpers ----------

function detectScript(text) {
  const persianCount = (text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
  const cyrillicCount = (text.match(/[\u0400-\u04FF]/g) || []).length;

  if (persianCount === 0 && cyrillicCount === 0) return 'unknown';
  if (persianCount > cyrillicCount) return 'persian';
  if (cyrillicCount > persianCount) return 'cyrillic';
  return 'unknown';
}

function mapText(text, table) {
  let out = '';
  for (const ch of text) out += table[ch] ?? ch;
  return out;
}

function convert(text) {
  const script = detectScript(text);
  if (script === 'persian') return { converted: mapText(text, persianToCyrillic), direction: 'Persian → Cyrillic' };
  if (script === 'cyrillic') return { converted: mapText(text, cyrillicToPersian), direction: 'Cyrillic → Persian' };
  return null;
}

// ---------- Telegram API helper ----------

async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

// ---------- Bot username cache (per isolate) ----------

let cachedUsername = null;
async function getBotUsername(env) {
  if (cachedUsername) return cachedUsername;
  const data = await tg(env, 'getMe', {});
  if (data.ok) cachedUsername = data.result.username;
  return cachedUsername;
}

// ---------- Core update handler ----------

async function handleUpdate(update, env) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  // Must be a reply and must include @botusername in the reply text
  if (!msg.reply_to_message) return;
  const replyText = msg.text || msg.caption || '';
  const username = await getBotUsername(env);
  if (!username) return;
  if (!replyText.toLowerCase().includes(`@${username.toLowerCase()}`)) return;

  // Extract the original text
  const original = msg.reply_to_message;
  const sourceText = original.text || original.caption || '';
  if (!sourceText.trim()) return;

  const result = convert(sourceText);

  if (!result) {
    await tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: '⚠️ Could not detect Persian or Tajik Cyrillic text.',
      reply_to_message_id: msg.message_id,
    });
    return;
  }

  await tg(env, 'sendMessage', {
    chat_id: msg.chat.id,
    text: `*${result.direction}*\n\n${result.converted}`,
    parse_mode: 'Markdown',
    reply_to_message_id: original.message_id,
  });
}

// ---------- Worker entrypoint ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('✅ Bot is running.', { status: 200 });
    }

    // Telegram webhook endpoint
    if (request.method === 'POST' && url.pathname === '/webhook') {
      let update;
      try {
        update = await request.json();
      } catch {
        return new Response('Bad Request', { status: 400 });
      }

      // Process in background so we can ACK Telegram quickly
      ctx.waitUntil(handleUpdate(update, env).catch((e) => console.error(e)));

      return new Response('OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  },
};
