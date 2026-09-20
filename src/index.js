// src/index.js
// Telegram GUEST BOT: Persian ↔ Tajik Cyrillic transliteration

// ---------- Mapping tables (from fa.wikipedia.org/wiki/الفبای_تاجیکی) ----------

const persianToCyrillic = {
  'ا':'А','آ':'О','أ':'А','إ':'И','ب':'Б','پ':'П','ت':'Т','ث':'С','ج':'Ҷ','چ':'Ч',
  'ح':'Ҳ','خ':'Х','د':'Д','ذ':'З','ر':'Р','ز':'З','ژ':'Ж','س':'С','ش':'Ш','ص':'С',
  'ض':'З','ط':'Т','ظ':'З','ع':'ъ','غ':'Ғ','ف':'Ф','ق':'Қ','ک':'К','گ':'Г','ل':'Л',
  'م':'М','ن':'Н','و':'В','ه':'Ҳ','ی':'Й','ء':'ъ','ؤ':'У','ئ':'Й','ة':'Ҳ',
  'َ':'А','ِ':'И','ُ':'У','ً':'А','ٍ':'И','ٌ':'У','ْ':'','ّ':'',
};

const cyrillicToPersian = {
  'А':'ا','а':'ا','Б':'ب','б':'б','В':'و','в':'و','Г':'گ','г':'گ','Ғ':'غ','ғ':'غ',
  'Д':'د','д':'д','Е':'ای','е':'ای','Ё':'یا','ё':'یا','Ж':'ژ','ж':'ژ','З':'ز','з':'з',
  'И':'اِ','и':'اِ','Ӣ':'ی','ӣ':'ی','Й':'ی','й':'ی','К':'ک','к':'ک','Қ':'ق','қ':'ق',
  'Л':'ل','л':'л','М':'م','м':'м','Н':'ن','н':'н','О':'آ','о':'آ','П':'پ','п':'پ',
  'Р':'ر','р':'р','С':'س','с':'с','Т':'ت','т':'ت','У':'اُ','у':'اُ','Ӯ':'و','ӯ':'و',
  'Ф':'ف','ф':'ф','Х':'خ','х':'х','Ҳ':'ح','ҳ':'ح','Ч':'چ','ч':'ч','Ҷ':'ج','ҷ':'ج',
  'Ш':'ش','ш':'ш','ъ':'ع','Э':'ای','э':'ای','Ю':'یو','ю':'یو','Я':'یا','я':'یا',
};

// ---------- Transliteration helpers ----------

function detectScript(text) {
  const fa = (text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
  const cy = (text.match(/[\u0400-\u04FF]/g) || []).length;
  if (!fa && !cy) return 'unknown';
  return fa > cy ? 'persian' : cy > fa ? 'cyrillic' : 'unknown';
}

function mapText(text, table) {
  let out = '';
  for (const ch of text) out += table[ch] ?? ch;
  return out;
}

function convert(text) {
  const s = detectScript(text);
  if (s === 'persian')  return { converted: mapText(text, persianToCyrillic), direction: 'Persian → Cyrillic' };
  if (s === 'cyrillic') return { converted: mapText(text, cyrillicToPersian), direction: 'Cyrillic → Persian' };
  return null;
}

// ---------- Telegram API helper ----------

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

// ---------- Guest query handler ----------

async function handleGuestQuery(update, env) {
  const query = update.bot_guest_chat_query || update.guest_chat_query;
  if (!query) return;

  const queryId = query.query_id;
  const triggeringMsg = query.message;
  const refs = query.reference_messages || [];

  // 1. Identify the text to convert.
  //    Prefer the replied-to message (reference_messages[0]); fall back to the
  //    triggering message's own text (minus the @mention).
  let sourceText = '';
  if (refs.length > 0) {
    sourceText = refs[0].text || refs[0].caption || '';
  } else {
    // Strip @mentions from the triggering message
    sourceText = (triggeringMsg.text || triggeringMsg.caption || '')
      .replace(/@\w+/g, '').trim();
  }

  if (!sourceText) {
    // Nothing to convert — send a gentle hint as the guest reply
    await answerGuest(env, queryId, {
      type: 'article',
      id: 'no-text',
      title: 'Guest Bot',
      input_message_content: {
        message_text: '⚠️ Reply to a message containing Persian or Tajik Cyrillic text, then @mention me.',
      },
    });
    return;
  }

  // 2. Convert
  const result = convert(sourceText);
  if (!result) {
    await answerGuest(env, queryId, {
      type: 'article',
      id: 'no-script',
      title: 'Guest Bot',
      input_message_content: {
        message_text: '⚠️ Could not detect Persian or Tajik Cyrillic in the referenced message.',
      },
    });
    return;
  }

  // 3. Send the converted result as a guest message
  await answerGuest(env, queryId, {
    type: 'article',
    id: `convert-${Date.now()}`,
    title: result.direction,
    input_message_content: {
      message_text: `*${result.direction}*\n\n${result.converted}`,
      parse_mode: 'Markdown',
    },
  });
}

// ---------- Guest reply wrapper ----------

async function answerGuest(env, guestQueryId, inlineResult) {
  // The Bot API method is "answerGuestQuery" and takes:
  //   guest_query_id  (String, required)
  //   result          (InlineQueryResult, required)
  return tg(env, 'answerGuestQuery', {
    guest_query_id: String(guestQueryId),
    result: inlineResult,
  });
}

// ---------- Worker entrypoint ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('✅ Guest Bot is running.', { status: 200 });
    }

    if (request.method === 'GET' && url.pathname === '/env') {
      return Response.json({
        has_bot_token: Boolean(env.BOT_TOKEN),
        bot_token_len: env.BOT_TOKEN ? env.BOT_TOKEN.length : 0,
        bot_username: env.BOT_USERNAME || null,
      });
    }

    if (request.method === 'POST' && url.pathname === '/webhook') {
      let update;
      try { update = await request.json(); }
      catch { return new Response('Bad JSON', { status: 400 }); }

      console.log('UPDATE:', JSON.stringify(update));

      try {
        await handleGuestQuery(update, env);
      } catch (e) {
        console.error('handleGuestQuery error:', e && e.stack || e);
      }
      return new Response('OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  },
};
