                                                      // ============= CONFIG =============
const MSG_LINE_1 = 'روز شمار سرور آقا سگه، روز';
const MSG_LINE_2 =
  'امروز هم سرور ماینکرفت آقا سگه نیومد، فعلا میهن کرفت نصب کن دا';
const MSG_EVENING = 'ساعت ۸ و نیم شد که آیدی سرور پس کو؟';

const CRON_MIDNIGHT = '30 20 * * *'; // 00:00 Iran
const CRON_EVENING  = '0 17 * * *';  // 20:30 Iran

const KV_CACHE_TTL = 30; // Cloudflare minimum

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

// ============= TELEMETRY =============
async function logEvent(env, event) {
  try {
    const raw = await env.BOT_KV.get('telemetry', { cacheTtl: KV_CACHE_TTL });
    let log = [];
    if (raw) {
      try { log = JSON.parse(raw); } catch { log = []; }
    }
    log.unshift({ t: new Date().toISOString(), ...event });
    log = log.slice(0, 30);
    await env.BOT_KV.put('telemetry', JSON.stringify(log));
  } catch (e) {
    console.error('telemetry write failed:', e.message);
  }
}

// ============= TARGETS HELPERS =============
// Targets are stored as an encrypted JSON array:
//   [ { chatId, threadId: number|null, counter: number }, ... ]
// Key: "targets"
//
// The "last_start" pointer is a plain JSON blob with short TTL, used by
// /end to defeat KV eventual consistency.

async function readTargets(env) {
  const raw = await env.BOT_KV.get('targets', { cacheTtl: KV_CACHE_TTL });
  if (!raw) {
    // Migrate from the old single-target key if present
    const legacy = await env.BOT_KV.get('target', { cacheTtl: KV_CACHE_TTL });
    if (legacy) {
      try {
        const one = decryptData(legacy, env.DB_ENCRYPTION_KEY);
        const migrated = [
          {
            chatId: one.chatId,
            threadId: one.threadId ?? null,
            counter: one.counter || 0,
          },
        ];
        await writeTargets(env, migrated);
        await env.BOT_KV.delete('target');
        return migrated;
      } catch {
        return [];
      }
    }
    return [];
  }
  try {
    return decryptData(raw, env.DB_ENCRYPTION_KEY);
  } catch (e) {
    console.error('readTargets decrypt failed:', e.message);
    return [];
  }
}

async function writeTargets(env, targets) {
  await env.BOT_KV.put(
    'targets',
    encryptData(targets, env.DB_ENCRYPTION_KEY)
  );
}

function sameTarget(a, chatId, threadId) {
  return a.chatId === chatId && (a.threadId ?? null) === (threadId ?? null);
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
      console.error('❌ Missing env bindings');
      await logEvent(env, { ev: 'cron_error', msg: 'missing env bindings' });
      return;
    }

    const targets = await readTargets(env);
    if (!targets.length) {
      console.log('⚠️ No targets set yet.');
      await logEvent(env, { ev: 'cron_skip', reason: 'no targets' });
      return;
    }

    const isMidnight = event.cron === CRON_MIDNIGHT;
    const isEvening = event.cron === CRON_EVENING;

    if (!isMidnight && !isEvening) {
      console.log(`⚠️ Unknown cron fired: ${event.cron}`);
      return;
    }

    let sent = 0;
    let failed = 0;

    for (const t of targets) {
      const threadId = t.threadId ?? undefined;

      try {
        if (isEvening) {
          await sendMessage(env.BOT_TOKEN, t.chatId, MSG_EVENING, threadId);
        } else {
          const counter = (t.counter || 0) + 1;
          const text = `${MSG_LINE_1} ${counter}\n${MSG_LINE_2}`;
          await sendMessage(env.BOT_TOKEN, t.chatId, text, threadId);
          t.counter = counter;
        }
        sent++;
      } catch (err) {
        failed++;
        console.error(
          `❌ Send failed to ${t.chatId}/${t.threadId ?? 'main'}: ${err.message}`
        );
        await logEvent(env, {
          ev: 'send_error',
          chatId: t.chatId,
          threadId: t.threadId ?? null,
          msg: err.message,
        });
      }
    }

    // Persist counter updates (only matters for the midnight cron)
    if (isMidnight) {
      try {
        await writeTargets(env, targets);
      } catch (e) {
        console.error('❌ Failed to persist counters:', e.message);
      }
    }

    console.log(`✅ Cron done: sent=${sent} failed=${failed}`);
    await logEvent(env, { ev: 'cron_done', sent, failed });
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
      const targets = await readTargets(env);
      const existing = targets.find((t) =>
        sameTarget(t, msg.chat.id, threadId)
      );

      let counter = 0;
      if (existing) {
        counter = existing.counter || 0;
      } else {
        targets.push({ chatId: msg.chat.id, threadId, counter: 0 });
      }

      await writeTargets(env, targets);

      // Short-lived pointer to defeat KV eventual consistency for /end
      await env.BOT_KV.put(
        'last_start',
        JSON.stringify({
          chatId: msg.chat.id,
          threadId,
          at: Date.now(),
        }),
        { expirationTtl: 120 }
      );

      await logEvent(env, {
        ev: 'start',
        chatId: msg.chat.id,
        threadId,
        counter,
        total: targets.length,
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
      const targets = await readTargets(env);
      const idx = targets.findIndex((t) =>
        sameTarget(t, msg.chat.id, threadId)
      );

      if (idx === -1) {
        // Pointer fallback: /start might have just happened here but KV
        // cache is still stale for "targets"
        let viaPointer = false;
        try {
          const rawPtr = await env.BOT_KV.get('last_start', {
            cacheTtl: KV_CACHE_TTL,
          });
          if (rawPtr) {
            const p = JSON.parse(rawPtr);
            if (p.chatId === msg.chat.id && (p.threadId ?? null) === threadId) {
              viaPointer = true;
            }
          }
        } catch { /* ignore */ }

        if (!viaPointer) {
          await logEvent(env, {
            ev: 'end_mismatch',
            chatId: msg.chat.id,
            threadId,
          });
          await sendMessage(
            env.BOT_TOKEN,
            msg.chat.id,
            '⚠️ روز شمار از اینجا فعال نشده، نمیتوانی از اینجا هم متوقفش کنی.',
            threadId ?? undefined
          );
          return;
        }
        // Pointer says /start was just here — nothing to remove from list,
        // but still confirm to the user
      } else {
        targets.splice(idx, 1);
        await writeTargets(env, targets);
      }

      await env.BOT_KV.delete('last_start');

      await logEvent(env, {
        ev: 'end_ok',
        chatId: msg.chat.id,
        threadId,
        remaining: targets.length,
      });

      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        `روز شمار در این ${where} پایان یافت، سرور اومد، مبارک خیلیا`,
        threadId ?? undefined
      );
      return;
    }

    // ─── /force-end ───
    case '/force-end': {
      await env.BOT_KV.delete('targets');
      await env.BOT_KV.delete('target'); // legacy
      await env.BOT_KV.delete('last_start');
      await logEvent(env, { ev: 'force_end', chatId: msg.chat.id, threadId });
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        '🛑 همه روز شمارها پاک شدند.',
        threadId ?? undefined
      );
      return;
    }

    // ─── /list ───
    case '/list': {
      const targets = await readTargets(env);
      if (!targets.length) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '📭 هیچ مقصدی ثبت نشده.',
          threadId ?? undefined
        );
        return;
      }
      const lines = ['📋 *مقصدهای فعال:*', ''];
      for (const t of targets) {
        const mark =
          t.chatId === msg.chat.id && (t.threadId ?? null) === threadId
            ? ' ← (اینجا)'
            : '';
        lines.push(
          `• chat \`${t.chatId}\` / topic \`${t.threadId ?? '—'}\` / counter ${t.counter}${mark}`
        );
      }
      await sendMessage(
        env.BOT_TOKEN,
        msg.chat.id,
        lines.join('\n'),
        threadId ?? undefined
      );
      return;
    }

    // ─── /test ───
    case '/test': {
      const targets = await readTargets(env);
      const t = targets.find((x) => sameTarget(x, msg.chat.id, threadId));
      if (!t) {
        await sendMessage(
          env.BOT_TOKEN,
          msg.chat.id,
          '⚠️ اول /start بزن.',
          threadId ?? undefined
        );
        return;
      }

      const tId = t.threadId ?? undefined;
      await sendMessage(
        env.BOT_TOKEN,
        t.chatId,
        `🧪 (test) ${MSG_EVENING}`,
        tId
      );
      await sendMessage(
        env.BOT_TOKEN,
        t.chatId,
        `🧪 (test) ${MSG_LINE_1} ${(t.counter || 0) + 1}\n${MSG_LINE_2}`,
        tId
      );
      await logEvent(env, { ev: 'test_sent', chatId: t.chatId });
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
        lines.push('🎯 Targets');
        try {
          const targets = await readTargets(env);
          if (!targets.length) {
            lines.push('  (none)');
          } else {
            for (const t of targets) {
              const mark =
                t.chatId === msg.chat.id &&
                (t.threadId ?? null) === threadId
                  ? ' ← (this chat)'
                  : '';
              lines.push(
                `  chat=${t.chatId} topic=${t.threadId ?? '—'} counter=${t.counter}${mark}`
              );
            }
          }
        } catch (e) {
          lines.push(`  ⚠️ read failed: ${e.message}`);
        }
        lines.push('');

        lines.push('💾 Pointer ["last_start"]');
        try {
          const rawPtr = await env.BOT_KV.get('last_start', {
            cacheTtl: KV_CACHE_TTL,
          });
          if (!rawPtr) {
            lines.push('  (empty)');
          } else {
            const p = JSON.parse(rawPtr);
            lines.push(`  chatId: ${p.chatId}`);
            lines.push(`  threadId: ${p.threadId ?? 'null'}`);
            lines.push(
              `  age: ${Math.round((Date.now() - p.at) / 1000)}s ago`
            );
          }
        } catch (e) {
          lines.push(`  ⚠️ pointer read failed: ${e.message}`);
        }
        lines.push('');
      }

      lines.push('🤖 Bot');
      try {
        const me = await telegram(env.BOT_TOKEN, 'getMe');
        lines.push(`  @${me.result.username} (id ${me.result.id})`);
      } catch (e) {
        lines.push(`  ⚠️ getMe failed: ${e.message}`);
      }
      lines.push('');

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
        const raw = await env.BOT_KV.get('telemetry', {
          cacheTtl: KV_CACHE_TTL,
        });
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
      lines.push('  /start /end /force-end /list /test /ping /debug');

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
