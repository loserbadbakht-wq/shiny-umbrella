// src/index.js
// Telegram GUEST BOT: Persian ↔ Tajik Cyrillic transliteration.
// Update: guest_message. Reply: answerGuestQuery.
// All Persian values are \u-escaped to prevent Cyrillic lookalike corruption.

// ---------- Cyrillic → Persian letter map ----------
// (а, и, о are handled positionally in code below)

const cyrillicToPersian = {
  // Vowels
  'У': '\u0648', 'у': '\u0648',              // و
  'Ӯ': '\u0648', 'ӯ': '\u0648',              // و
  'Е': '\u06CC', 'е': '\u06CC',              // ی
  'Э': '\u06CC', 'э': '\u06CC',              // ی
  'Ӣ': '\u06CC', 'ӣ': '\u06CC',              // ی
  'Ё': '\u06CC\u0627', 'ё': '\u06CC\u0627',  // یا
  'Ю': '\u06CC\u0648', 'ю': '\u06CC\u0648',  // یو
  'Я': '\u06CC\u0627', 'я': '\u06CC\u0627',  // یا

  // Consonants
  'Б': '\u0628', 'б': '\u0628',              // ب
  'В': '\u0648', 'в': '\u0648',              // و
  'Г': '\u06AF', 'г': '\u06AF',              // گ
  'Ғ': '\u063A', 'ғ': '\u063A',              // غ
  'Д': '\u062F', 'д': '\u062F',              // د
  'Ж': '\u0698', 'ж': '\u0698',              // ژ
  'З': '\u0632', 'з': '\u0632',              // ز
  'Й': '\u06CC', 'й': '\u06CC',              // ی
  'К': '\u06A9', 'к': '\u06A9',              // ک
  'Қ': '\u0642', 'қ': '\u0642',              // ق
  'Л': '\u0644', 'л': '\u0644',              // ل
  'М': '\u0645', 'м': '\u0645',              // م
  'Н': '\u0646', 'н': '\u0646',              // ن
  'П': '\u067E', 'п': '\u067E',              // پ
  'Р': '\u0631', 'р': '\u0631',              // ر
  'С': '\u0633', 'с': '\u0633',              // س
  'Т': '\u062A', 'т': '\u062A',              // ت
  'Ф': '\u0641', 'ф': '\u0641',              // ف
  'Х': '\u062E', 'х': '\u062E',              // خ
  'Ҳ': '\u062D', 'ҳ': '\u062D',              // ح
  'Ч': '\u0686', 'ч': '\u0686',              // چ
  'Ҷ': '\u062C', 'ҷ': '\u062C',              // ج
  'Ш': '\u0634', 'ш': '\u0634',              // ش
  'Ъ': '\u0639', 'ъ': '\u0639',              // ع
};

// ---------- Persian → Cyrillic letter map ----------
const persianToCyrillic = {
  '\u0627': 'а',  // ا
  '\u0622': 'о',  // آ
  '\u0623': 'а',  // أ
  '\u0625': 'и',  // إ
  '\u0628': 'б',  // ب
  '\u067E': 'п',  // پ
  '\u062A': 'т',  // ت
  '\u062B': 'с',  // ث
  '\u062C': 'ҷ',  // ج
  '\u0686': 'ч',  // چ
  '\u062D': 'ҳ',  // ح
  '\u062E': 'х',  // خ
  '\u062F': 'д',  // د
  '\u0630': 'з',  // ذ
  '\u0631': 'р',  // ر
  '\u0632': 'з',  // ز
  '\u0698': 'ж',  // ژ
  '\u0633': 'с',  // س
  '\u0634': 'ш',  // ش
  '\u0635': 'с',  // ص
  '\u0636': 'з',  // ض
  '\u0637': 'т',  // ط
  '\u0638': 'з',  // ظ
  '\u0639': 'ъ',  // ع
  '\u063A': 'ғ',  // غ
  '\u0641': 'ф',  // ف
  '\u0642': 'қ',  // ق
  '\u06A9': 'к',  // ک
  '\u06AF': 'г',  // گ
  '\u0644': 'л',  // ل
  '\u0645': 'м',  // م
  '\u0646': 'н',  // ن
  '\u0648': 'в',  // و
  '\u0647': 'ҳ',  // ه
  '\u06CC': 'й',  // ی
  '\u0621': 'ъ',  // ء
  '\u0624': 'у',  // ؤ
  '\u0626': 'й',  // ئ
  '\u0629': 'ҳ',  // ة
};

// ---------- Punctuation maps ----------
const latinToPersianPunct = {
  ',': '\u060C',  // ،
  ';': '\u061B',  // ؛
  '?': '\u061F',  // ؟
};

const persianToLatinPunct = {
  '\u060C': ',',  // ،
  '\u061B': ';',  // ؛
  '\u061F': '?',  // ؟
};

// ---------- Position-aware Cyrillic → Persian ----------
function cyrillicToPersianText(text) {
  const chars = Array.from(text);
  const isLetter = (c) => c != null && /\p{L}/u.test(c);
  let out = '';

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const prev = chars[i - 1];
    const next = chars[i + 1];
    const atStart = !isLetter(prev);
    const atEnd = !isLetter(next);

    if (ch === 'а' || ch === 'А') {
      // Short /a/: ا at word start, ه at word end, dropped medially
      out += atStart ? '\u0627' : atEnd ? '\u0647' : '';
    } else if (ch === 'и' || ch === 'И') {
      // Tajik и can be either Persian short kasra (unwritten) or long ی.
      // Heuristic: и before к → ی (Тоҷик → تاجیک, Тоҷикистон → تاجیکستان).
      // Word-initial → ا; word-final → ی; otherwise dropped.
      if (next === 'к' || next === 'К') {
        out += '\u06CC';                 // ی
      } else if (atStart) {
        out += '\u0627';                 // ا
      } else if (atEnd) {
        out += '\u06CC';                 // ی
      }
      // else: dropped
    } else if (ch === 'о' || ch === 'О') {
      // /ɔ/: آ at word start, ا otherwise
      out += atStart ? '\u0622' : '\u0627';
    } else if (latinToPersianPunct[ch]) {
      out += latinToPersianPunct[ch];
    } else {
      out += cyrillicToPersian[ch] ?? ch;
    }
  }
  return out;
}

// ---------- Persian → Cyrillic (capitalize at word start) ----------
function persianToCyrillicText(text) {
  let out = '';
  let atWordStart = true;
  for (const ch of text) {
    if (persianToLatinPunct[ch]) {
      out += persianToLatinPunct[ch];
      atWordStart = true;
      continue;
    }
    if (/[\s\p{P}\p{S}]/u.test(ch)) {
      out += ch;
      atWordStart = true;
      continue;
    }
    const mapped = persianToCyrillic[ch];
    if (mapped === undefined) {
      out += ch;
    } else {
      out += atWordStart ? mapped.toUpperCase() : mapped;
    }
    atWordStart = false;
  }
  return out;
}

// ---------- Script detection ----------
function detectScript(text) {
  const fa = (text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
  const cy = (text.match(/[\u0400-\u04FF]/g) || []).length;
  if (!fa && !cy) return 'unknown';
  return fa > cy ? 'persian' : cy > fa ? 'cyrillic' : 'unknown';
}

function convert(text) {
  const s = detectScript(text);
  if (s === 'persian')  return { converted: persianToCyrillicText(text),  direction: 'Persian → Cyrillic' };
  if (s === 'cyrillic') return { converted: cyrillicToPersianText(text), direction: 'Cyrillic → Persian' };
  return null;
}

// ---------- Telegram helper ----------
async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const txt = await res.text();
  if (!res.ok) console.error(`Telegram ${method} failed: ${res.status} ${txt}`);
  try { return JSON.parse(txt); } catch { return { ok: false, raw: txt }; }
}

// ---------- Guest handler ----------
async function handleGuestMessage(update, env) {
  const msg = update.guest_message;
  if (!msg) return;

  const guestQueryId = msg.guest_query_id;
  if (!guestQueryId) {
    console.error('guest_message without guest_query_id:', JSON.stringify(msg));
    return;
  }
  console.log('GUEST QUERY ID:', guestQueryId);

  const triggeringText = msg.text || msg.caption || '';
  const replied = msg.reply_to_message;
  const sourceText = replied
    ? (replied.text || replied.caption || '')
    : triggeringText.replace(/@\w+/g, '').trim();

  if (!sourceText) {
    return answerGuest(env, guestQueryId,
      '⚠️ Reply to a message containing Persian or Tajik Cyrillic text, then @mention me.');
  }

  const result = convert(sourceText);
  if (!result) {
    return answerGuest(env, guestQueryId,
      '⚠️ Could not detect Persian or Tajik Cyrillic in the referenced message.');
  }

  return answerGuest(
    env, guestQueryId,
    `*${result.direction}*\n\n${result.converted}`,
    'Markdown'
  );
}

async function answerGuest(env, guestQueryId, messageText, parseMode) {
  const inlineResult = {
    type: 'article',
    id: `guest-${Date.now()}`,
    title: 'Transliteration result',
    input_message_content: {
      message_text: messageText,
      ...(parseMode ? { parse_mode: parseMode } : {}),
    },
  };
  const res = await tg(env, 'answerGuestQuery', {
    guest_query_id: String(guestQueryId),
    result: inlineResult,
  });
  console.log('answerGuestQuery response:', JSON.stringify(res));
  return res;
}

// ---------- Worker ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('✅ Guest Bot is running.', { status: 200 });
    }
    if (request.method === 'GET' && url.pathname === '/env') {
      return Response.json({
        has_bot_token: Boolean(env.BOT_TOKEN),
        bot_username: env.BOT_USERNAME || null,
      });
    }
    if (request.method === 'POST' && url.pathname === '/webhook') {
      let update;
      try { update = await request.json(); }
      catch { return new Response('Bad JSON', { status: 400 }); }

      console.log('RAW UPDATE:', JSON.stringify(update));
      try { await handleGuestMessage(update, env); }
      catch (e) { console.error('handleGuestMessage error:', e && e.stack || e); }
      return new Response('OK', { status: 200 });
    }
    return new Response('Not Found', { status: 404 });
  },
};
