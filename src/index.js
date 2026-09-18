// ============= CONFIG =============
const MSG_LINE_1 = 'روز شمار سرور آقا سگه، روز';
const MSG_LINE_2 =
  'امروز هم سرور ماینکرفت آقا سگه نیومد، فعلا میهن کرفت نصب کن دا';

// Second daily message (sent at 20:30 Iran time = 17:00 UTC)
const MSG_EVENING = 'ساعت ۸ و نیم شد که آیدی سرور پس کو؟';

// Cron expressions (must match wrangler.toml)
const CRON_MIDNIGHT = '30 20 * * *'; // 00:00 Iran
const CRON_EVENING  = '0 17 * * *';  // 20:30 Iran

// ============= ENCRYPTION HELPERS =============
function encryptData(data, key) {
  const jsonStr = JSON.stringify(data);
  const encoder = new TextEncoder();
  const plaintext = encoder.encode(jsonStr);
  const keyBytes = encoder.encode(key.padEnd(32, '0').slice(0, 32));

  const encrypted = new Uint8Array(plaintext.length);
  for (let i = 0; i < plaintext.length; i++) {
    encrypted[i] = plaintext[i] ^ keyBytes[i % keyBytes.length];
  }
  return btoa(String.fromCharCode(...encrypted));
}

function decryptData(encryptedStr, key) {
  const encrypted = Uint8Array.from(atob(encryptedStr), (c) =>
    c.charCodeAt(0)
  );
  const keyBytes = new TextEncoder().encode(
    key.padEnd(32, '0').slice(0, 32)
  );

  const decrypted = new Uint8Array(encrypted.length);
  for (let i = 0; i < encrypted.length; i++) {
    decrypted[i] = encrypted[i] ^ keyBytes[i % keyBytes.length];
  }
  return JSON.parse(new TextDecoder().decode(decrypted));
}

// ============= WORKER =============
export default {
  // ─── Webhook handler ───────────────────────────────────────────
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('OK', { status: 200 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    const msg = update.message;
    if (!msg || !msg.text) return new Response('OK');

    // ─── /start: enable the daily messages ───
    if (msg.text === '/start' || msg.text.startsWith('/start@')) {
      // threadId is:
      //   - a number  → inside a forum topic
      //   - undefined → General topic, regular group, or private chat
      const threadId =
        msg.is_topic_message && msg.message_thread_id
          ? msg.message_thread_id
          : undefined;

      // Preserve existing counter if re-configuring
      let counter = 0;
      const existing = await env.BOT_KV.get('target');
      if (existing) {
        try {
          counter = decryptData(existing, env.DB_ENCRYPTION_KEY).counter || 0;
        } catch {
          counter = 0;
        }
      }

      const encrypted = encryptData(
        {
          chatId: msg.chat.id,
          threadId: threadId ?? null, // JSON can't store undefined
          counter,
        },
        env.DB_ENCRYPTION_KEY
      );
      await env.BOT_KV.put('target', encrypted);

      const where = threadId
        ? 'تاپیک'
        : msg.chat.type === 'private'
        ? 'چت خصوصی'
        : 'چت';

      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `روز شمار در این ${where} فعال شد، شاید این جمعه بیایید`,
        threadId
      );

      return new Response('OK');
    }

    // ─── /end: stop the daily messages ───
    if (msg.text === '/end' || msg.text.startsWith('/end@')) {
      const threadId =
        msg.is_topic_message && msg.message_thread_id
          ? msg.message_thread_id
          : null;

      const encrypted = await env.BOT_KV.get('target');
      if (!encrypted) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ هیچ روز شماری فعال نیست.',
          threadId ?? undefined
        );
        return new Response('OK');
      }

      let target;
      try {
        target = decryptData(encrypted, env.DB_ENCRYPTION_KEY);
      } catch {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ خطا در خواندن اطلاعات. لطفاً دوباره /start بزنید.',
          threadId ?? undefined
        );
        return new Response('OK');
      }

      // Only allow stopping from the exact chat + topic that was configured
      const sameChat = target.chatId === msg.chat.id;
      const sameTopic = (target.threadId ?? null) === threadId;

      if (!sameChat || !sameTopic) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ روز شمار از اینجا فعال نشده، نمیتوانی از اینجا هم متوقفش کنی.',
          threadId ?? undefined
        );
        return new Response('OK');
      }

      // Delete the target
      await env.BOT_KV.delete('target');

      const where = threadId
        ? 'تاپیک'
        : msg.chat.type === 'private'
        ? 'چت خصوصی'
        : 'چت';

      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `روز شمار در این ${where} پایان یافت، سرور اومد، مبارک خیلیا`,
        threadId ?? undefined
      );

      return new Response('OK');
    }

    return new Response('OK');
  },

  // ─── Cron triggers ─────────────────────────────────────────────
  async scheduled(event, env) {
    const encrypted = await env.BOT_KV.get('target');
    if (!encrypted) {
      console.log('⚠️ No target chat set yet. Send /start first.');
      return;
    }

    let target;
    try {
      target = decryptData(encrypted, env.DB_ENCRYPTION_KEY);
    } catch (err) {
      console.error('❌ Failed to decrypt target:', err.message);
      return;
    }

    // null → undefined so sendMessage omits message_thread_id
    const threadId = target.threadId ?? undefined;

    // ── 20:30 Iran → evening reminder (no counter) ──
    if (event.cron === CRON_EVENING) {
      try {
        await sendMessage(
          env.BOT_TOKEN,
          target.chatId,
          MSG_EVENING,
          threadId
        );
        console.log('✅ Evening message sent (20:30 Iran).');
      } catch (err) {
        console.error('❌ Failed to send evening message:', err.message);
      }
      return;
    }

    // ── 00:00 Iran → day-counter message ──
    if (event.cron === CRON_MIDNIGHT) {
      const counter = (target.counter || 0) + 1;
      const text = `${MSG_LINE_1} ${counter}\n${MSG_LINE_2}`;

      try {
        await sendMessage(env.BOT_TOKEN, target.chatId, text, threadId);

        // Persist updated counter (encrypted)
        await env.BOT_KV.put(
          'target',
          encryptData(
            {
              chatId: target.chatId,
              threadId: target.threadId ?? null,
              counter,
            },
            env.DB_ENCRYPTION_KEY
          )
        );

        console.log(`✅ Midnight message sent. Counter = ${counter}`);
      } catch (err) {
        console.error('❌ Failed to send midnight message:', err.message);
      }
      return;
    }

    console.log(`⚠️ Unknown cron fired: ${event.cron}`);
  },
};

// ─── Helper: call Telegram Bot API ───────────────────────────────
async function sendMessage(token, chatId, text, threadId) {
  const body = { chat_id: chatId, text };
  if (threadId) body.message_thread_id = threadId;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram API error ${res.status}: ${err}`);
  }
  return res.json();
  }
