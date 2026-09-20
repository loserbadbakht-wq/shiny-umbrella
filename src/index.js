// src/index.js
// Telegram GUEST BOT: Persian ↔ Tajik Cyrillic transliteration
// Correct update type: guest_message (Bot API), NOT updateBotGuestChatQuery (MTProto)

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
  'Ш':'ш','ш':'ш','ъ':'ع','Э':'ای','э':'ای','Ю':'یو','ю':'یو','Я':'یا','я':'یا',
};

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

// ---------- Guest message handler ----------
// The update arrives as: { update_id: N, guest_message: { ...Message..., guest_query_id: "..." } }

async function handleGuestMessage(update, env) {
  const msg = update.guest_message;
  if (!msg) return;

  const guestQueryId = msg.guest_query_id;
  if (!guestQueryId) {
    console.error('guest_message without guest_query_id:', JSON.stringify(msg));
    return;
  }

  console.log('GUEST QUERY ID:', guestQueryId);

  // The triggering message text (the message where the user @mentioned the bot)
  const triggeringText = msg.text || msg.caption || '';

  // The replied-to message (if any). In the Bot API, this is msg.reply_to_message.
  const replied = msg.reply_to_message;
  const sourceText = replied
    ? (replied.text || replied.caption || '')
    : triggeringText.replace(/@\w+/g, '').trim();

  if (!sourceText) {
    await answerGuest(env, guestQueryId, '⚠️ Reply to a message containing Persian or Tajik Cyrillic text, then @mention me.');
    return;
  }

  const result = convert(sourceText);
  if (!result) {
    await answerGuest(env, guestQueryId, '⚠️ Could not detect Persian or Tajik Cyrillic in the referenced message.');
    return;
  }

  await answerGuest(
    env,
    guestQueryId,
    `*${result.direction}*\n\n${result.converted}`,
    'Markdown'
  );
}

// ---------- Guest reply wrapper ----------
// answerGuestQuery takes: guest_query_id (String) and result (InlineQueryResult)

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

      // Log EVERY incoming update so we can see what Telegram actually sends
      console.log('RAW UPDATE:', JSON.stringify(update));

      try {
        await handleGuestMessage(update, env);
      } catch (e) {
        console.error('handleGuestMessage error:', e && e.stack || e);
      }
      return new Response('OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  },
};
