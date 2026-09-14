// src/index.js
// Telegram "DL Link to Telegram Bot" — turns direct links into native Telegram media.
// Works in private chats and groups.

const VIDEO_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/x-matroska',
  'video/quicktime',
  'video/x-msvideo',
  'video/mpeg',
]);

const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/flac',
  'audio/x-flac',
  'audio/ogg',
  'audio/opus',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
]);

const EXT_MAP = {
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
  mov: 'video/quicktime', avi: 'video/x-msvideo', mpeg: 'video/mpeg', mpg: 'video/mpeg',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus',
  m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
};

const URL_RE = /https?:\/\/[^\s<>"']+/i;

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') {
      return new Response('🪄 DL Link to Telegram Bot is alive.', { status: 200 });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    ctx.waitUntil(handleUpdate(update, env).catch((e) => console.error('handler error:', e)));
    return new Response('OK', { status: 200 });
  },
};

async function handleUpdate(update, env) {
  const msg = update.message || update.edited_message || update.channel_post;
  if (!msg || typeof msg.text !== 'string') return;

  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const text = msg.text.trim();
  const token = env.BOT_TOKEN;

  if (!token) {
    console.error('BOT_TOKEN is missing');
    return;
  }

  // -------- Command parsing --------
  // Supported forms:
  //   /dl <url>
  //   /dl doc <url>
  //   /dl            (as reply to a message containing a URL)
  //   /dl doc        (as reply to a message containing a URL → send as document)
  //   /start | /help
  const parts = text.split(/\s+/);
  const rawCmd = parts[0] || '';
  const cmd = rawCmd.toLowerCase().replace(/@[A-Za-z0-9_]+$/, ''); // strip @BotName

  if (cmd === '/start' || cmd === '/help') {
    await sendMessage(
      token,
      chatId,
      [
        '🪄 *DL Link to Telegram Bot*',
        '',
        'Convert direct links to native Telegram media:',
        '• 🎬 Video → playable video',
        '• 🖼️ Image → photo',
        '• 🎵 Audio → music',
        '• 📎 Anything else → document',
        '',
        '*Commands:*',
        '`/dl <url>` — send link as media',
        '`/dl doc <url>` — force send as document',
        'Reply `/dl` to any message containing a link',
        'Reply `/dl doc` to send that link as document',
      ].join('\n'),
      'Markdown'
    );
    return;
  }

  if (cmd !== '/dl') return; // ignore anything else

  // -------- Extract URL + doc flag --------
  let idx = 1;
  let forceDoc = false;
  if ((parts[idx] || '').toLowerCase() === 'doc') {
    forceDoc = true;
    idx++;
  }

  let url = null;
  for (let i = idx; i < parts.length; i++) {
    const m = parts[i].match(URL_RE);
    if (m) { url = m[0]; break; }
  }

  // Fall back to the replied-to message's text or caption
  if (!url && msg.reply_to_message) {
    const reply = msg.reply_to_message;
    const source = reply.text || reply.caption || '';
    const m = source.match(URL_RE);
    if (m) url = m[0];
  }

  if (!url) {
    await sendMessage(
      token,
      chatId,
      '⚠️ No link found. Use `/dl <url>` or reply `/dl` to a message containing a link.',
      'Markdown',
      messageId
    );
    return;
  }

  // Strip trailing punctuation
  url = url.replace(/[)\].,>]+$/, '');

  try {
    let contentType = await getContentType(url);
    if (!contentType || contentType === 'application/octet-stream' || contentType === 'binary/octet-stream') {
      contentType = detectByExtension(url) || contentType || 'application/octet-stream';
    }
    const filename = getFilename(url, contentType);
    await sendMedia(token, chatId, url, contentType, filename, forceDoc, messageId);
  } catch (err) {
    console.error(err);
    await sendMessage(
      token,
      chatId,
      `❌ ${escapeMd(err.message || 'Unknown error')}`,
      'Markdown',
      messageId
    );
  }
}

/* ---------------- Content type detection ---------------- */

async function getContentType(url) {
  try {
    const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (head.ok) {
      const ct = head.headers.get('content-type');
      if (ct) return ct.split(';')[0].trim().toLowerCase();
    }
  } catch (_) {}

  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-1023' },
      redirect: 'follow',
    });
    if (resp.ok || resp.status === 206) {
      const ct = resp.headers.get('content-type');
      if (ct) return ct.split(';')[0].trim().toLowerCase();
    } else {
      throw new Error(`HTTP ${resp.status} while fetching URL`);
    }
  } catch (e) {
    throw new Error(e.message || 'Failed to inspect URL');
  }
  return null;
}

function detectByExtension(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const ext = path.split('.').pop();
    return EXT_MAP[ext] || null;
  } catch {
    return null;
  }
}

function getFilename(url, contentType) {
  try {
    const path = new URL(url).pathname;
    const last = decodeURIComponent(path.split('/').filter(Boolean).pop() || '');
    if (last && last.includes('.')) return last;
  } catch {}
  const ext = Object.entries(EXT_MAP).find(([, v]) => v === contentType)?.[0];
  return ext ? `file.${ext}` : 'file';
}

/* ---------------- Telegram helpers ---------------- */

async function sendMessage(token, chatId, text, parseMode, replyTo) {
  const payload = { chat_id: chatId, text };
  if (parseMode) payload.parse_mode = parseMode;
  if (replyTo) payload.reply_to_message_id = replyTo;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function sendMedia(token, chatId, url, contentType, filename, forceDoc, replyTo) {
  let method;
  let field;

  if (forceDoc) {
    method = 'sendDocument';
    field = 'document';
  } else if (VIDEO_TYPES.has(contentType)) {
    method = 'sendVideo';
    field = 'video';
  } else if (IMAGE_TYPES.has(contentType)) {
    method = 'sendPhoto';
    field = 'photo';
  } else if (AUDIO_TYPES.has(contentType)) {
    method = 'sendAudio';
    field = 'audio';
  } else {
    method = 'sendDocument';
    field = 'document';
  }

  const payload = { chat_id: chatId };
  if (replyTo) payload.reply_to_message_id = replyTo;

  if (method === 'sendDocument') {
    payload[field] = url;
    payload.caption = filename;
    // 👇 Forces Telegram to show it as a plain file, not inline media.
    // (Only reliably honored by a self-hosted local Bot API server;
    //  the public api.telegram.org may ignore it — see note below.)
    payload.disable_content_type_detection = true;
  } else {
    payload[field] = url;
    if (method === 'sendVideo') payload.supports_streaming = true;
    if (method === 'sendAudio') payload.title = filename;
  }

  const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));

  if (!data.ok) {
    const desc = data.description || `Telegram ${method} failed`;

    if (/file is too big|too big/i.test(desc)) {
      throw new Error(
        'Telegram refuses the URL because the file is too big for URL-based uploads (20 MB for videos/audio/documents, 5 MB for photos).'
      );
    }
    if (/wrong file identifier|failed to get http url content|webpage_curl_failed/i.test(desc)) {
      throw new Error('Telegram could not download the URL. Make sure it is public and returns the file directly.');
    }
    throw new Error(desc);
  }
}

function escapeMd(s) {
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  }
