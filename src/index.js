// ============= CONFIG =============
const MSG_LINE_1 = 'روز شمار سرور آقا سگه، روز';
const MSG_LINE_2 =
  'امروز هم سرور ماینکرفت آقا سگه نیومد، فعلا میهن کرفت نصب کن دا';
const MSG_EVENING = 'ساعت ۸ و نیم شد که آیدی سرور پس کو؟';

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

// ============= COMMAND PARSER =============
function parseCommand(text) {
  if (!text || typeof text !== 'string' || !text.startsWith('/')) return null;
  const first = text.trim().split(/\s+/)[0];
  return first.split('@')[0].toLowerCase();
}

// ============= TELEMETRY (ring buffer in KV) =============
async function logEvent(env, event) {
  try {
    const raw = await env.BOT_KV.get('telemetry', { cacheTtl: 0 });
    let log = [];
    if (raw) {
      try { log = JSON.parse(raw); } catch { log = []; }
    }
    log.unshift({ t: new Date().toISOString(), ...event });
    log = log.slice(0, 30); // keep last 30 events
    await env.BOT_KV.put('telemetry', JSON.stringify(log));
  } catch (e) {
    console.error('telemetry write failed:', e.message);
  }
}

// ============= WORKER =============
export default {
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
    if (msg?.text) {
      await logEvent(env, {
        ev: 'update',
        cmd: parseCommand(msg.text),
        chatId: msg.chat.id,
        threadId: msg.message_thread_id ?? null,
        from: msg.from?.id,
      });
    }

    try {
      await handleUpdate(update, env);
    } catch (err) {
      await logEvent(env, { ev: 'crash', msg: err.message });
      console.error('❌ handleUpdate crashed:', err.stack || err.message);
      if (msg?.chat?.id) {
        try {
          await sendMessage(
            env.BOT_TOKEN,
            msg.chat.id,
            `❌ خطای داخلی: ${err.message}`,
            topicOf(msg)
          );
        } catch { /* ignore */ }
      }
    }

    return new Response('OK', { status: 200 });
  },

  async scheduled(event, env) {
    console.log(`⏰ Cron fired: ${event.cron}`);
    await logEvent(env, { ev: 'cron', cron: event.cron });

    if (!env.BOT_TOKEN || !env.DB_ENCRYPTION_KEY || !env.BOT_KV) {
      console.error(
        '❌ Missing env bindings. BOT_TOKEN / DB_ENCRYPTION_KEY / BOT_KV'
      );
      await logEvent(env, { ev: 'cron_error', msg: 'missing env bindings' });
      return;
    }

    const encrypted = await env.BOT_KV.get('target', { cacheTtl: 0 });
    if (!encrypted) {
      console.log('⚠️ No target chat set yet. Send /start first.');
      await logEvent(env, { ev: 'cron_skip', reason: 'no target' });
      return;
    }

    let target;
    try {
      target = decryptData(encrypted, env.DB_ENCRYPTION_KEY);
    } catch (err) {
      console.error('❌ Failed to decrypt target:', err.message);
      await logEvent(env, { ev: 'cron_error', msg: 'decrypt: ' + err.message });
      return;
    }

    const threadId = target.threadId ?? undefined;

    if (event.cron === CRON_EVENING) {
      try {
        await sendMessage(env.BOT_TOKEN, target.chatId, MSG_EVENING, threadId);
        console.log('✅ Evening message sent.');
        await logEvent(env, { ev: 'evening_sent' });
      } catch (err) {
        console.error('❌ Evening send failed:', err.message);
        await logEvent(env, { ev: 'cron_error', msg: 'evening: ' + err.message });
      }
      return;
    }

    if (event.cron === CRON_MIDNIGHT) {
      const counter = (target.counter || 0) + 1;
      const text = `${MSG_LINE_1} ${counter}\n${MSG_LINE_2}`;
      try {
        await sendMessage(env.BOT_TOKEN, target.chatId, text, threadId);
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
        await logEvent(env, { ev: 'midnight_sent', counter });
      } catch (err) {
        console.error('❌ Midnight send failed:', err.message);
        await logEvent(env, { ev: 'cron_error', msg: 'midnight: ' + err.message });
      }
      return;
    }

    console.log(`⚠️ Unknown cron fired: ${event.cron}`);
    await logEvent(env, { ev: 'cron_error', msg: 'unknown: ' + event.cron });
  },
};

// ============= UPDATE HANDLER =============
async function handleUpdate(update, env) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const cmd = parseCommand(msg.text);
  if (!cmd) return;

  if (!env.BOT_TOKEN) {
    console.error('❌ BOT_TOKEN env var is missing');
    return;
  }

  const threadId = topicOf(msg) ?? null;
  const where = !threadId
    ? msg.chat.type === 'private'
      ? 'چت خصوصی'
      : 'چت'
    : 'تاپیک';

  switch (cmd) {
    // ─── /start ───
    case '/start': {
      let counter = 0;
      const existing = await env.BOT_KV.get('target', { cacheTtl: 0 });
      if (existing) {
        try {
          counter =
            decryptData(existing, env.DB_ENCRYPTION_KEY).counter || 0;
        } catch {
          counter = 0;
        }
      }

      await env.BOT_KV.put(
        'target',
        encryptData(
          { chatId: msg.chat.id, threadId, counter },
          env.DB_ENCRYPTION_KEY
        )
      );

      await logEvent(env, {
        ev: 'start',
        chatId: msg.chat.id,
        threadId,
        counter,
      });

      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `روز شمار در این ${where} فعال شد، شاید این جمعه بیاید`,
        threadId ?? undefined
      );
      return;
    }

    // ─── /end ───
    case '/end': {
      const encrypted = await env.BOT_KV.get('target', { cacheTtl: 0 });

      if (!encrypted) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ هیچ روز شماری فعال نیست.',
          threadId ?? undefined
        );
        return;
      }

      let target;
      try {
        target = decryptData(encrypted, env.DB_ENCRYPTION_KEY);
      } catch (e) {
        console.error('❌ /end decrypt failed:', e.message);
        await env.BOT_KV.delete('target');
        await logEvent(env, { ev: 'end_decrypt_fail', msg: e.message });
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          `⚠️ اطلاعات قدیمی پاک شد. لطفاً دوباره /start بزنید.`,
          threadId ?? undefined
        );
        return;
      }

      const sameChat = target.chatId === msg.chat.id;
      const sameTopic = (target.threadId ?? null) === threadId;

      console.log(
        `[/end] sameChat=${sameChat} sameTopic=${sameTopic} ` +
          `stored={chat:${target.chatId},topic:${target.threadId}} ` +
          `current={chat:${msg.chat.id},topic:${threadId}}`
      );

      if (!sameChat || !sameTopic) {
        await logEvent(env, {
          ev: 'end_mismatch',
          storedChat: target.chatId,
          storedTopic: target.threadId ?? null,
          currentChat: msg.chat.id,
          currentTopic: threadId,
        });
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ روز شمار از اینجا فعال نشده، نمیتوانی از اینجا هم متوقفش کنی.\n\n' +
            `🔎 چت فعلی: \`${msg.chat.id}\`\n` +
            `🔎 چت ذخیرهشده: \`${target.chatId}\`\n` +
            `🔎 تاپیک فعلی: \`${threadId ?? '—'}\`\n` +
            `🔎 تاپیک ذخیرهشده: \`${target.threadId ?? '—'}\``,
          threadId ?? undefined
        );
        return;
      }

      await env.BOT_KV.delete('target');
      await logEvent(env, { ev: 'end_ok', chatId: msg.chat.id, threadId });

      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `روز شمار در این ${where} پایان یافت، سرور اومد، مبارک خیلیا`,
        threadId ?? undefined
      );
      return;
    }

    // ─── /force-end (unconditional delete — use if /end is stuck) ───
    case '/force-end': {
      await env.BOT_KV.delete('target');
      await logEvent(env, { ev: 'force_end', chatId: msg.chat.id, threadId });
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        '🛑 روز شمار به زور متوقف شد.',
        threadId ?? undefined
      );
      return;
    }

    // ─── /test — force-send both messages right now ───
    case '/test': {
      const encrypted = await env.BOT_KV.get('target', { cacheTtl: 0 });
      if (!encrypted) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ اول /start بزن.',
          threadId ?? undefined
        );
        return;
      }
      let target;
      try {
        target = decryptData(encrypted, env.DB_ENCRYPTION_KEY);
      } catch (e) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          `⚠️ decrypt failed: ${e.message}`,
          threadId ?? undefined
        );
        return;
      }

      const tId = target.threadId ?? undefined;

      await sendMessage(
        env.BOT_TOKEN,
        target.chatId,
        `🧪 (test) ${MSG_EVENING}`,
        tId
      );
      await sendMessage(
        env.BOT_TOKEN,
        target.chatId,
        `🧪 (test) ${MSG_LINE_1} ${(target.counter || 0) + 1}\n${MSG_LINE_2}`,
        tId
      );
      await logEvent(env, { ev: 'test_sent', chatId: target.chatId });
      return;
    }

    // ─── /ping ───
    case '/ping': {
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `🏓 pong — ${new Date().toISOString()}`,
        threadId ?? undefined
      );
      return;
    }

    // ─── /debug ───
    case '/debug': {
      const lines = [];
      lines.push('🔍 *Debug*');
      lines.push('');
      lines.push('📍 Chat');
      lines.push(`  id: ${msg.chat.id}`);
      lines.push(`  type: ${msg.chat.type}`);
      lines.push(`  is_topic_message: ${msg.is_topic_message ?? false}`);
      lines.push(`  message_thread_id: ${msg.message_thread_id ?? '—'}`);
      lines.push(`  topicOf(): ${topicOf(msg) ?? '—'}`);
      lines.push('');

      lines.push('⚙️ Env');
      lines.push(`  BOT_TOKEN: ${env.BOT_TOKEN ? '✅' : '❌ missing'}`);
      lines.push(
        `  DB_ENCRYPTION_KEY: ${env.DB_ENCRYPTION_KEY ? '✅' : '❌ missing'}`
      );
      lines.push(`  BOT_KV: ${env.BOT_KV ? '✅' : '❌ missing'}`);
      lines.push('');

      if (env.BOT_KV) {
        lines.push('💾 KV["target"] (cacheTtl=0)');
        try {
          const raw = await env.BOT_KV.get('target', { cacheTtl: 0 });
          if (!raw) {
            lines.push('  (empty — no /start yet)');
          } else {
            try {
              const dec = decryptData(raw, env.DB_ENCRYPTION_KEY);
              lines.push(`  chatId: ${dec.chatId}`);
              lines.push(`  threadId: ${dec.threadId ?? 'null'}`);
              lines.push(`  counter: ${dec.counter}`);
              lines.push(
                `  matches current chat? ${
                  dec.chatId === msg.chat.id &&
                  (dec.threadId ?? null) === threadId
                    ? '✅ yes'
                    : '❌ no'
                }`
              );
            } catch (e) {
              lines.push(`  ⚠️ decrypt failed: ${e.message}`);
              lines.push(`  raw length: ${raw.length}`);
            }
          }
        } catch (e) {
          lines.push(`  ⚠️ KV read error: ${e.message}`);
        }
        lines.push('');
      }

      // Bot identity
      lines.push('🤖 Bot');
      try {
        const me = await telegram(env.BOT_TOKEN, 'getMe');
        lines.push(`  @${me.result.username} (id ${me.result.id})`);
      } catch (e) {
        lines.push(`  ⚠️ getMe failed: ${e.message}`);
      }
      lines.push('');

      // Webhook status
      lines.push('🪝 Webhook');
      try {
        const info = await telegram(env.BOT_TOKEN, 'getWebhookInfo');
        const r = info.result || {};
        lines.push(`  url: ${r.url || '(none)'}`);
        lines.push(`  pending: ${r.pending_update_count ?? 0}`);
        if (r.last_error_message) {
          lines.push(`  ⚠️ last_error: ${r.last_error_message}`);
          lines.push(
            `  last_error_date: ${
              r.last_error_date
                ? new Date(r.last_error_date * 1000).toISOString()
                : '—'
            }`
          );
        } else {
          lines.push('  last_error: (none) ✅');
        }
      } catch (e) {
        lines.push(`  ⚠️ getWebhookInfo failed: ${e.message}`);
      }
      lines.push('');

      lines.push('⏰ Expected crons (UTC)');
      lines.push(`  ${CRON_MIDNIGHT}  → 00:00 Iran`);
      lines.push(`  ${CRON_EVENING}   → 20:30 Iran`);
      lines.push('');

      lines.push('📜 Recent events');
      try {
        const raw = await env.BOT_KV.get('telemetry', { cacheTtl: 0 });
        const log = raw ? JSON.parse(raw) : [];
        if (log.length === 0) {
          lines.push('  (none)');
        } else {
          for (const e of log.slice(0, 10)) {
            const ts = e.t.replace('T', ' ').slice(0, 19);
            const extra = Object.entries(e)
              .filter(([k]) => k !== 't' && k !== 'ev')
              .map(([k, v]) => `${k}=${v}`)
              .join(' ');
            lines.push(`  ${ts} ${e.ev}${extra ? ' ' + extra : ''}`);
          }
        }
      } catch (e) {
        lines.push(`  ⚠️ telemetry read failed: ${e.message}`);
      }
      lines.push('');

      lines.push('ℹ️ Commands');
      lines.push('  /start /end /force-end /test /ping /debug');

      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        lines.join('\n'),
        threadId ?? undefined
      );
      return;
    }

    default:
      return;
  }
}

// ============= HELPERS =============
function topicOf(msg) {
  return msg.is_topic_message && msg.message_thread_id
    ? msg.message_thread_id
    : undefined;
}

async function sendMessage(token, chatId, text, threadId) {
  const body = { chat_id: chatId, text };
  if (threadId) body.message_thread_id = threadId;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(
      `Telegram sendMessage ${res.status}: ${
        data.description || JSON.stringify(data)
      }`
    );
  }
  return data;
}

async function telegram(token, method, params = {}) {
  const res = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    Object.keys(params).length
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        }
      : undefined
  );
  return res.json();
}
