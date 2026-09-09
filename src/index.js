// Cloudflare Worker for Telegram bot
// Environment variable BOT_TWO_TOKEN is set via wrangler deploy --var

const TELEGRAM_API = 'https://api.telegram.org';

async function handleRequest(request) {
  if (request.method !== 'POST') {
    return new Response('OK');
  }

  const payload = await request.json();

  if (payload.message) {
    await handleMessage(payload.message);
  } else if (payload.callback_query) {
    await handleCallbackQuery(payload.callback_query);
  }

  return new Response('OK');
}

async function handleMessage(message) {
  const text = message.text || '';
  if (text.startsWith('/paye')) {
    const gameName = text.slice('/paye'.length).trim();
    const chatId = message.chat.id;

    if (!gameName) {
      await sendMessage(chatId, 'لطفاً نام بازی را بعد از /paye بنویسید. مثال: /paye فوتبال');
      return;
    }

    const inlineKeyboard = {
      inline_keyboard: [
        [
          {
            text: 'پایه هستم',
            callback_data: 'paye',
          },
        ],
      ],
    };

    await sendMessage(chatId, `کیا پایه ${gameName} هستن؟`, inlineKeyboard);
  }
}

async function handleCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const user = callbackQuery.from;
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ');

  // Answer the callback to stop loading indicator
  await answerCallbackQuery(callbackQuery.id);

  // Get current text of the message
  let currentText = callbackQuery.message.text || '';

  // Create the line for this user
  const userLine = `کاربر ${fullName} پایه هست!🐧`;

  // Check if this user is already listed (avoid duplicates)
  if (!currentText.includes(userLine)) {
    // Append the new line
    currentText += '\n' + userLine;
  }

  // Keep the same inline keyboard so others can press
  const inlineKeyboard = {
    inline_keyboard: [
      [
        {
          text: 'پایه هستم',
          callback_data: 'paye',
        },
      ],
    ],
  };

  // Edit the original message with updated text
  await editMessageText(chatId, messageId, currentText, inlineKeyboard);
}

async function sendMessage(chatId, text, replyMarkup) {
  const token = BOT_TWO_TOKEN; // From environment (set by wrangler --var)
  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: text,
  };
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function editMessageText(chatId, messageId, text, replyMarkup) {
  const token = BOT_TWO_TOKEN;
  const url = `${TELEGRAM_API}/bot${token}/editMessageText`;
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
  };
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function answerCallbackQuery(callbackQueryId) {
  const token = BOT_TWO_TOKEN;
  const url = `${TELEGRAM_API}/bot${token}/answerCallbackQuery`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});
