/**
 * Telegram bot — Mensch ärgere Dich nicht
 * Cloudflare Worker + Durable Objects
 *
 * Dark-mode board rendered as PNG via resvg-wasm.
 * A fresh board photo is sent after every move (no in-place edit).
 * Rolling a 6 offers both "bring out a new piece" and "advance a piece".
 *
 * Deployed via: wrangler deploy --var BOT_TOKEN:... --var DB_ENCRYPTION_KEY:...
 * Reads env.BOT_TOKEN.
 */

import { Resvg, initWasm } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';

/* ============================ CONSTANTS ============================ */

const RULES = {
  piecesPerPlayer: 4,
  cellsPerPlayer: 10,
  homeCells: 4,
  extraTurnOnSix: true,
  threeSixesLoseTurn: true,
  blockOwnPieces: true,
};

const PHASE = {
  LOBBY: 'lobby',
  ROLL: 'roll',
  MOVE: 'move',
  GAMEOVER: 'gameover',
};

const MIN_PLAYERS = 4;
const MAX_HUMANS = 20;
const BOT_LOOP_SAFETY = 200;
const BOT_TURN_DELAY_MS = 350;
const BOARD_PNG_WIDTH = 900;

/** Dark-mode palette */
const PALETTE = {
  bg:          '#0b1220',
  cellFill:    '#1e293b',
  cellStroke:  '#334155',
  homeOuter:   '#1e293b',
  homeMid:     '#334155',
  homeInner:   '#475569',
  homeStroke:  '#475569',
  yardStroke:  '#475569',
  shadow:      '#000000',
  halo:        '#fbbf24',
  haloSoft:    '#fde68a',
  movableEdge: '#f8fafc',
  pieceTop:    '#ffffff',
};

/* ============================ UTILITIES ============================ */

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function displayName(user) {
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return full || user.username || `Player ${user.id}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================ TELEGRAM API ============================ */

async function tg(env, method, payload) {
  const token = env.BOT_TOKEN;
  if (!token) {
    console.error('BOT_TOKEN is not set');
    return { ok: false, description: 'BOT_TOKEN missing' };
  }
  const url = `https://api.telegram.org/bot${token}/${method}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) console.error('Telegram API error', method, data.description || data);
    return data;
  } catch (e) {
    console.error('Telegram fetch failed', method, e.message);
    return { ok: false, description: e.message };
  }
}

async function tgForm(env, method, form) {
  const token = env.BOT_TOKEN;
  if (!token) return { ok: false, description: 'BOT_TOKEN missing' };
  const url = `https://api.telegram.org/bot${token}/${method}`;
  try {
    const res = await fetch(url, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) console.error('Telegram form error', method, data.description || data);
    return data;
  } catch (e) {
    console.error('Telegram form fetch failed', method, e.message);
    return { ok: false, description: e.message };
  }
}

function sendMessage(env, chatId, text, extra = {}) {
  return tg(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

function answerCallback(env, id, text) {
  return tg(env, 'answerCallbackQuery', {
    callback_query_id: id,
    text: text || '',
    show_alert: false,
  });
}

function editReplyMarkup(env, chatId, messageId, inlineKeyboard) {
  return tg(env, 'editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

/* ============================ SVG → PNG ============================ */

let wasmReady = null;
function ensureResvg() {
  if (!wasmReady) {
    wasmReady = initWasm(resvgWasm).catch(e => {
      console.error('resvg init failed', e && e.stack ? e.stack : e);
      wasmReady = null;
      throw e;
    });
  }
  return wasmReady;
}

async function svgToPng(svgString, width = BOARD_PNG_WIDTH) {
  await ensureResvg();
  const resvg = new Resvg(svgString, {
    fitTo: { mode: 'width', value: width },
    background: PALETTE.bg,
  });
  return resvg.render().asPng();
}

/** Always sends a NEW photo. Never edits. */
async function sendBoardPhoto(env, chatId, pngBytes, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) {
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
  }
  form.append('photo', new Blob([pngBytes], { type: 'image/png' }), 'board.png');
  return tgForm(env, 'sendPhoto', form);
}

/* ============================ BOARD CAPTION ============================ */

function boardCaption(game) {
  if (!game) return '';
  if (game.phase === PHASE.GAMEOVER) {
    const winner = game.players[game.winners[game.winners.length - 1]];
    return `🏆 <b>${escapeHtml(winner.name)}</b> wins!`;
  }
  if (game.phase === PHASE.LOBBY) {
    const humans = game.players.filter(p => !p.isBot).length;
    return `<b>Lobby</b> · ${humans}/${game.maxPlayers} humans`;
  }
  const player = game.players[game.current];
  if (game.phase === PHASE.MOVE) {
    return (
      `<b>Turn ${game.turn}</b> · ${escapeHtml(player.name)} rolled <b>${game.dice}</b>\n` +
      `Choose a piece from the buttons below.`
    );
  }
  if (game.phase === PHASE.ROLL) {
    if (player.isBot) {
      return `<b>Turn ${game.turn}</b> · 🤖 <b>${escapeHtml(player.name)}</b> rolling…`;
    }
    return (
      `<b>Turn ${game.turn}</b> · <b>${escapeHtml(player.name)}</b> to roll.\n` +
      `Send the 🎲 dice sticker.`
    );
  }
  return `<b>Turn ${game.turn}</b>`;
}

/* ============================ BOARD SYNC ============================ */

/** Sends a brand-new board photo. No editing, no tracking. */
async function sendBoard(env, game) {
  if (game.phase === PHASE.LOBBY) return;
  let png;
  try {
    const svg = renderBoardSVG(game, 1000);
    png = await svgToPng(svg, BOARD_PNG_WIDTH);
  } catch (e) {
    console.error('render failed:', e && e.stack ? e.stack : e);
    return;
  }
  await sendBoardPhoto(env, game.chatId, png, boardCaption(game));
}

/* ============================ GAME LOGIC ============================ */

function createGame(chatId, maxPlayers, hostUser) {
  return {
    chatId,
    maxPlayers,
    phase: PHASE.LOBBY,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    players: [],
    current: 0,
    dice: null,
    legalMoves: [],
    consecutiveSixes: 0,
    winners: [],
    turn: 1,
    log: [],
  };
}

function addHuman(game, user) {
  game.players.push({
    index: game.players.length,
    userId: user.id,
    isBot: false,
    name: displayName(user),
    color: '', colorLight: '', colorStroke: '',
    pieces: new Array(RULES.piecesPerPlayer).fill(-1),
  });
  reindexPlayers(game);
}

function addBot(game) {
  const n = game.players.filter(p => p.isBot).length + 1;
  game.players.push({
    index: game.players.length,
    userId: null,
    isBot: true,
    name: `🤖 Bot ${n}`,
    color: '', colorLight: '', colorStroke: '',
    pieces: new Array(RULES.piecesPerPlayer).fill(-1),
  });
  reindexPlayers(game);
}

/** Dark-mode player colors. */
function reindexPlayers(game) {
  const N = Math.max(game.players.length, 2);
  game.players.forEach((p, i) => {
    p.index = i;
    const h = Math.round((i * 360) / N + 15) % 360;
    p.color = `hsl(${h}, 70%, 58%)`;       // bright piece
    p.colorLight = `hsl(${h}, 35%, 20%)`;  // dark tinted yard
    p.colorStroke = `hsl(${h}, 55%, 42%)`; // medium border
  });
}

function botsNeeded(humanCount) {
  if (humanCount < MIN_PLAYERS) return MIN_PLAYERS - humanCount;
  if (humanCount % 2 === 1) return 1;
  return 0;
}

function trackLength(game) {
  return game.players.length * RULES.cellsPerPlayer;
}

function maxPos(game) {
  return trackLength(game) + RULES.homeCells - 1;
}

function cellOf(game, playerIndex, pos) {
  const L = trackLength(game);
  return (playerIndex * RULES.cellsPerPlayer + pos) % L;
}

function piecesOnCell(game, cell) {
  const L = trackLength(game);
  const out = [];
  for (const p of game.players) {
    for (let j = 0; j < RULES.piecesPerPlayer; j++) {
      const pos = p.pieces[j];
      if (pos >= 0 && pos < L && cellOf(game, p.index, pos) === cell) {
        out.push({ player: p.index, piece: j });
      }
    }
  }
  return out;
}

/**
 * Legal moves.
 * When dice === 6, BOTH options are generated:
 *   - yard pieces  → { from: -1, to: 0 }
 *   - track pieces → { from: pos, to: pos + 6 }
 * The caller decides which to present.
 */
function legalMoves(game, playerIndex, dice) {
  const p = game.players[playerIndex];
  const L = trackLength(game);
  const MAX = maxPos(game);
  const moves = [];

  for (let j = 0; j < RULES.piecesPerPlayer; j++) {
    const pos = p.pieces[j];
    if (pos === MAX) continue;

    if (pos === -1) {
      if (dice !== 6) continue;
      const cell = cellOf(game, playerIndex, 0);
      const occ = piecesOnCell(game, cell);
      if (RULES.blockOwnPieces && occ.some(o => o.player === playerIndex)) continue;
      moves.push({ piece: j, from: -1, to: 0 });
      continue;
    }

    const target = pos + dice;
    if (target > MAX) continue;

    if (target < L) {
      const cell = cellOf(game, playerIndex, target);
      const occ = piecesOnCell(game, cell);
      if (RULES.blockOwnPieces && occ.some(o => o.player === playerIndex)) continue;
      moves.push({ piece: j, from: pos, to: target });
    } else {
      const clash = p.pieces.some((q, k) => k !== j && q === target);
      if (clash) continue;
      moves.push({ piece: j, from: pos, to: target });
    }
  }

  // Yard moves first, then track, then home — keeps the choice obvious on a 6.
  moves.sort((a, b) => {
    const cat = m => m.from === -1 ? 0 : m.from < L ? 1 : 2;
    return cat(a) - cat(b);
  });

  return moves;
}

function applyMove(game, pieceIndex) {
  const move = game.legalMoves.find(m => m.piece === pieceIndex);
  if (!move) throw new Error(`Piece ${pieceIndex} has no legal move`);

  const L = trackLength(game);
  const MAX = maxPos(game);
  const player = game.players[game.current];
  const events = [];
  const diceWasSix = game.dice === 6;

  player.pieces[pieceIndex] = move.to;
  events.push({ type: 'move', player: game.current, piece: pieceIndex, from: move.from, to: move.to });

  if (move.to < L) {
    const cell = cellOf(game, game.current, move.to);
    for (const other of game.players) {
      if (other.index === game.current) continue;
      for (let j = 0; j < RULES.piecesPerPlayer; j++) {
        const q = other.pieces[j];
        if (q >= 0 && q < L && cellOf(game, other.index, q) === cell) {
          other.pieces[j] = -1;
          events.push({ type: 'capture', player: other.index, piece: j, cell });
          game.log.push(`${player.name} captured ${other.name}'s piece #${j + 1}`);
        }
      }
    }
  }

  if (move.to === MAX) {
    events.push({ type: 'finish', player: game.current, piece: pieceIndex });
    game.log.push(`${player.name} brought piece #${pieceIndex + 1} home`);
  }

  if (player.pieces.every(x => x === MAX)) {
    game.winners.push(game.current);
    game.phase = PHASE.GAMEOVER;
    game.dice = null;
    game.legalMoves = [];
    game.log.push(`🏆 ${player.name} wins!`);
    events.push({ type: 'win', player: game.current });
    return events;
  }

  if (diceWasSix && RULES.extraTurnOnSix) {
    game.dice = null;
    game.legalMoves = [];
    game.phase = PHASE.ROLL;
    game.consecutiveSixes = 0;
    game.log.push(`${player.name} rolls again (6)`);
    events.push({ type: 'extra_turn', player: game.current });
  } else {
    advanceTurn(game);
    events.push({ type: 'next_turn', player: game.current });
  }
  return events;
}

function advanceTurn(game) {
  game.dice = null;
  game.legalMoves = [];
  game.consecutiveSixes = 0;
  game.phase = PHASE.ROLL;
  game.current = (game.current + 1) % game.players.length;
  game.turn++;
}

/* ============================ BOT AI ============================ */

function chooseBotMove(game, moves) {
  const L = trackLength(game);
  const MAX = maxPos(game);
  let best = moves[0];
  let bestScore = -Infinity;

  for (const m of moves) {
    let score = 0;
    if (m.to === MAX) score += 1000;
    if (m.from === -1) score += 150;
    if (m.to < L) {
      const cell = cellOf(game, game.current, m.to);
      const occ = piecesOnCell(game, cell);
      const captures = occ.filter(o => o.player !== game.current).length;
      score += captures * 200;
    }
    score += m.to * 2;
    score += Math.random() * 10;
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best;
}

/* ============================ BOARD RENDERER (DARK) ============================ */
/* Text-free and filter-free for resvg compatibility.                        */

function renderBoardSVG(game, size = 1000) {
  const N = game.players.length;
  const L = trackLength(game);
  const cx = size / 2;
  const cy = size / 2;

  const R_TRACK = 330;
  const R_YARD = 430;
  const R_HOME_INNER = 80;

  const cellW = Math.min(30, ((2 * Math.PI * R_TRACK) / L) * 0.85);
  const cellH = Math.min(28, cellW * 1.5);

  const yardR = Math.max(26, 70 - N * 1.5);
  const pieceR = Math.max(7, yardR * 0.28);
  const slot = yardR * 0.45;

  const homeCells = RULES.homeCells;
  const homeStart = R_TRACK - cellH * 1.5;
  const homeSeg = (homeStart - R_HOME_INNER) / homeCells;

  const f = n => Number(n).toFixed(2);
  const out = [];

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}">`
  );

  // Dark background
  out.push(`<rect width="${size}" height="${size}" fill="${PALETTE.bg}"/>`);

  // Subtle vignette rings for depth (no filters)
  out.push(`<circle cx="${cx}" cy="${cy}" r="490" fill="none" stroke="${PALETTE.cellStroke}" stroke-width="1" opacity="0.35"/>`);
  out.push(`<circle cx="${cx}" cy="${cy}" r="470" fill="none" stroke="${PALETTE.cellStroke}" stroke-width="1" opacity="0.2"/>`);

  // Center home — three concentric rings
  out.push(`<circle cx="${cx}" cy="${cy}" r="72" fill="${PALETTE.homeOuter}" stroke="${PALETTE.homeStroke}" stroke-width="3"/>`);
  out.push(`<circle cx="${cx}" cy="${cy}" r="42" fill="${PALETTE.homeMid}" stroke="${PALETTE.homeStroke}" stroke-width="2"/>`);
  out.push(`<circle cx="${cx}" cy="${cy}" r="18" fill="${PALETTE.homeInner}"/>`);

  // Track cells
  for (let k = 0; k < L; k++) {
    const a = (k / L) * 2 * Math.PI - Math.PI / 2;
    const x = cx + R_TRACK * Math.cos(a);
    const y = cy + R_TRACK * Math.sin(a);
    const rot = (a * 180) / Math.PI + 90;
    out.push(
      `<rect x="${f(x - cellW / 2)}" y="${f(y - cellH / 2)}" width="${f(cellW)}" height="${f(cellH)}" ` +
      `rx="${f(cellH * 0.3)}" fill="${PALETTE.cellFill}" stroke="${PALETTE.cellStroke}" stroke-width="1" ` +
      `transform="rotate(${f(rot)} ${f(x)} ${f(y)})"/>`
    );
  }

  const slots = [[-slot, -slot], [slot, -slot], [-slot, slot], [slot, slot]];

  for (const p of game.players) {
    const i = p.index;
    const a = (i / N) * 2 * Math.PI - Math.PI / 2;

    // Home column
    for (let j = 0; j < homeCells; j++) {
      const r = homeStart - (j + 0.5) * homeSeg;
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      const rot = (a * 180) / Math.PI - 90;
      const w = Math.max(10, cellW * 0.8);
      const h = homeSeg * 0.78;
      out.push(
        `<rect x="${f(x - w / 2)}" y="${f(y - h / 2)}" width="${f(w)}" height="${f(h)}" ` +
        `rx="${f(w * 0.25)}" fill="${p.colorLight}" stroke="${p.colorStroke}" stroke-width="1.5" ` +
        `transform="rotate(${f(rot)} ${f(x)} ${f(y)})"/>`
      );
    }

    // Yard
    const yx = cx + R_YARD * Math.cos(a);
    const yy = cy + R_YARD * Math.sin(a);
    const isCurrent = game.current === i && game.phase !== PHASE.GAMEOVER && game.phase !== PHASE.LOBBY;

    out.push(
      `<circle cx="${f(yx)}" cy="${f(yy)}" r="${f(yardR)}" fill="${p.colorLight}" ` +
      `stroke="${p.colorStroke}" stroke-width="${isCurrent ? 5 : 3}"/>`
    );
    if (isCurrent) {
      out.push(
        `<circle cx="${f(yx)}" cy="${f(yy)}" r="${f(yardR + 9)}" fill="none" ` +
        `stroke="${PALETTE.halo}" stroke-width="2.5" stroke-dasharray="7 5" opacity="0.9"/>`
      );
    }

    // Pieces
    for (let j = 0; j < RULES.piecesPerPlayer; j++) {
      const pos = p.pieces[j];
      let x, y;

      if (pos === -1) {
        x = yx + slots[j][0];
        y = yy + slots[j][1];
      } else if (pos < L) {
        const cell = cellOf(game, i, pos);
        const ca = (cell / L) * 2 * Math.PI - Math.PI / 2;
        x = cx + R_TRACK * Math.cos(ca);
        y = cy + R_TRACK * Math.sin(ca);
      } else {
        const jj = pos - L;
        const r = homeStart - (jj + 0.5) * homeSeg;
        x = cx + r * Math.cos(a);
        y = cy + r * Math.sin(a);
      }

      const movable =
        game.phase === PHASE.MOVE &&
        game.current === i &&
        game.legalMoves.some(m => m.piece === j);

      // Soft halo for movable pieces
      if (movable) {
        out.push(
          `<circle cx="${f(x)}" cy="${f(y)}" r="${f(pieceR + 9)}" fill="${PALETTE.halo}" opacity="0.18"/>`
        );
        out.push(
          `<circle cx="${f(x)}" cy="${f(y)}" r="${f(pieceR + 6)}" fill="none" ` +
          `stroke="${PALETTE.halo}" stroke-width="2.5" stroke-dasharray="5 4"/>`
        );
      }

      // Dark shadow under piece
      out.push(
        `<circle cx="${f(x)}" cy="${f(y + pieceR * 0.32)}" r="${f(pieceR)}" ` +
        `fill="${PALETTE.shadow}" opacity="0.55"/>`
      );

      // Body
      out.push(
        `<circle cx="${f(x)}" cy="${f(y)}" r="${f(pieceR)}" fill="${p.color}" ` +
        `stroke="${movable ? PALETTE.movableEdge : PALETTE.pieceTop}" ` +
        `stroke-width="${movable ? 3 : 2}"/>`
      );

      // Glossy highlight
      out.push(
        `<circle cx="${f(x - pieceR * 0.3)}" cy="${f(y - pieceR * 0.3)}" r="${f(pieceR * 0.26)}" ` +
        `fill="${PALETTE.pieceTop}" opacity="0.55"/>`
      );

      // Bot marker
      if (p.isBot) {
        out.push(
          `<circle cx="${f(x)}" cy="${f(y)}" r="${f(pieceR * 0.3)}" ` +
          `fill="${PALETTE.pieceTop}" opacity="0.95"/>`
        );
      }
    }
  }

  out.push(`</svg>`);
  return out.join('');
}

/* ============================ LABEL HELPERS ============================ */

function moveLabel(game, move) {
  const L = trackLength(game);
  const MAX = maxPos(game);
  const from = move.from === -1 ? 'yard'
             : move.from < L ? `track ${move.from + 1}`
             : `home ${move.from - L + 1}`;
  const to = move.to === MAX ? 'FINISH'
           : move.to < L ? `track ${move.to + 1}`
           : `home ${move.to - L + 1}`;
  const icon = move.from === -1 ? '🆕' : '➡️';
  return `${icon} Piece ${move.piece + 1}: ${from} → ${to}`;
}

/* ============================ GAME ROOM ============================ */

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.lock = Promise.resolve();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/get' && request.method === 'GET') {
      const game = (await this.state.storage.get('game')) || null;
      return new Response(JSON.stringify(game), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/update' && request.method === 'POST') {
      const workerUrl = request.headers.get('X-Worker-Url') || '';
      let update;
      try { update = await request.json(); }
      catch (e) {
        console.error('Bad update body', e.message);
        return new Response('ok');
      }

      const prev = this.lock;
      const next = prev.then(() => this.handleUpdate(update, workerUrl)).catch(e => {
        console.error('Update handler failed:', e && e.stack ? e.stack : e);
      });
      this.lock = next;
      await next;

      return new Response('ok');
    }

    return new Response('Not found', { status: 404 });
  }

  async load() { return (await this.state.storage.get('game')) || null; }

  async save(game) {
    if (game === null) await this.state.storage.delete('game');
    else if (game) {
      game.updatedAt = Date.now();
      await this.state.storage.put('game', game);
    }
  }

  async handleUpdate(update, workerUrl) {
    const sender = update.message?.from
      || update.edited_message?.from
      || update.callback_query?.from;
    if (sender && sender.is_bot) return;

    const game = await this.load();

    if (update.callback_query) {
      let next;
      try {
        next = await this.onCallback(update.callback_query, game, workerUrl);
      } catch (e) {
        console.error('Callback failed:', e && e.stack ? e.stack : e);
        await answerCallback(this.env, update.callback_query.id, 'Internal error');
        return;
      }
      await this.save(next === undefined ? game : next);
      return;
    }

    const msg = update.message;
    if (!msg) return;

    if (msg.dice) {
      let next;
      try {
        next = await this.onDice(msg, game, workerUrl);
      } catch (e) {
        console.error('Dice failed:', e && e.stack ? e.stack : e);
      }
      await this.save(next === undefined ? game : next);
      return;
    }

    if (msg.text && msg.text.startsWith('/')) {
      let next;
      try {
        next = await this.onCommand(msg, game, workerUrl);
      } catch (e) {
        console.error('Command failed:', e && e.stack ? e.stack : e);
        await sendMessage(this.env, msg.chat.id,
          `⚠️ <b>Internal error</b>\n<code>${escapeHtml(e.message || String(e))}</code>`
        );
        return;
      }
      await this.save(next === undefined ? game : next);
      return;
    }
  }

  /* ------------------------------ COMMANDS ------------------------------ */

  async onCommand(msg, game, workerUrl) {
    const env = this.env;
    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    const user = msg.from;
    const userId = user.id;
    const parts = msg.text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase().replace(/@\S+$/, '');
    const isPrivate = chatType === 'private';

    switch (cmd) {
      case '/start':
      case '/help': {
        await sendMessage(env, chatId,
          `<b>🎲 Mensch ärgere Dich nicht</b>\n\n` +
          `<b>Commands</b>\n` +
          `/new &lt;n&gt; — open a lobby for up to n humans (4–20)\n` +
          `/join — join the open lobby\n` +
          `/leave — leave the lobby\n` +
          `/begin — start the game (host only)\n` +
          `/board — resend the current board\n` +
          `/state — show turn info\n` +
          `/end — end the current game\n\n` +
          `<b>Player count</b>\n` +
          `Minimum <b>4</b> players on the board. Fewer than 4 humans → the bot fills with 🤖 bots. More than 4 humans and odd → exactly one bot is added so the board stays even.\n\n` +
          `<b>How to play</b>\n` +
          `1. On your turn, send the 🎲 dice sticker in this chat.\n` +
          `2. Roll a 6 → you can <b>🆕 bring out a new piece</b> OR <b>➡️ advance an existing one</b>.\n` +
          `3. First to bring all 4 pieces home wins.\n\n` +
          `A fresh board photo is posted after every move.`
        );
        return undefined;
      }

      case '/new': {
        if (isPrivate) {
          await sendMessage(env, chatId,
            '⚠️ This bot is meant for group chats. Add me to a group and try again.'
          );
          return undefined;
        }
        if (game && game.phase !== PHASE.GAMEOVER) {
          await sendMessage(env, chatId, '⚠️ A game is already in progress. Use /end first.');
          return undefined;
        }
        const n = parseInt(parts[1], 10) || 4;
        if (!Number.isInteger(n) || n < MIN_PLAYERS || n > MAX_HUMANS) {
          await sendMessage(env, chatId,
            `⚠️ Human capacity must be between <b>${MIN_PLAYERS}</b> and <b>${MAX_HUMANS}</b>.`
          );
          return undefined;
        }
        const newGame = createGame(chatId, n, user);
        addHuman(newGame, user);
        await sendMessage(env, chatId,
          `<b>🎮 Lobby opened</b>\n\n` +
          `👥 Humans: <b>1 / ${n}</b>\n` +
          `👤 Host: <b>${escapeHtml(displayName(user))}</b>\n\n` +
          `Others can join with /join.\n` +
          `Host: /begin when ready.\n\n` +
          `<i>Board will always have at least 4 players — the bot fills any missing slots.</i>`,
          { reply_markup: { inline_keyboard: [[{ text: '🚀 Begin game', callback_data: 'begin' }]] } }
        );
        return newGame;
      }

      case '/join': {
        if (!game || game.phase !== PHASE.LOBBY) {
          await sendMessage(env, chatId, '⚠️ No open lobby to join.');
          return undefined;
        }
        if (game.players.some(p => !p.isBot && p.userId === userId)) {
          await sendMessage(env, chatId, '⚠️ You already joined.');
          return undefined;
        }
        const humanCount = game.players.filter(p => !p.isBot).length;
        if (humanCount >= game.maxPlayers) {
          await sendMessage(env, chatId, '⚠️ Lobby is full.');
          return undefined;
        }
        addHuman(game, user);
        await sendMessage(env, chatId,
          `✅ <b>${escapeHtml(displayName(user))}</b> joined!\n` +
          `👥 Humans: <b>${game.players.filter(p => !p.isBot).length} / ${game.maxPlayers}</b>`
        );
        return game;
      }

      case '/leave': {
        if (!game || game.phase !== PHASE.LOBBY) {
          await sendMessage(env, chatId, '⚠️ You can only leave before the game starts.');
          return undefined;
        }
        const idx = game.players.findIndex(p => !p.isBot && p.userId === userId);
        if (idx < 0) {
          await sendMessage(env, chatId, '⚠️ You are not in this lobby.');
          return undefined;
        }
        if (idx === 0) {
          await sendMessage(env, chatId, '⚠️ The host cannot leave. Use /end to cancel.');
          return undefined;
        }
        const removed = game.players.splice(idx, 1)[0];
        reindexPlayers(game);
        await sendMessage(env, chatId,
          `👋 <b>${escapeHtml(removed.name)}</b> left.\n` +
          `👥 Humans: <b>${game.players.filter(p => !p.isBot).length} / ${game.maxPlayers}</b>`
        );
        return game;
      }

      case '/begin': {
        if (!game || game.phase !== PHASE.LOBBY) {
          await sendMessage(env, chatId, '⚠️ No lobby to start.');
          return undefined;
        }
        if (game.players[0].userId !== userId) {
          await sendMessage(env, chatId, '⚠️ Only the host can start the game.');
          return undefined;
        }
        return await this.startGame(game, workerUrl);
      }

      case '/board': {
        if (!game) {
          await sendMessage(env, chatId, '⚠️ No game here.');
          return undefined;
        }
        await sendBoard(env, game);
        return undefined;
      }

      case '/state': {
        if (!game) {
          await sendMessage(env, chatId, '⚠️ No game here. Use /new to start one.');
          return undefined;
        }
        await this.sendStatus(game, workerUrl);
        return undefined;
      }

      case '/end': {
        if (!game) {
          await sendMessage(env, chatId, '⚠️ No game to end.');
          return undefined;
        }
        await sendMessage(env, chatId, '🛑 Game ended.');
        return null;
      }

      default:
        return undefined;
    }
  }

  /* ------------------------------ CALLBACKS ------------------------------ */

  async onCallback(cq, game, workerUrl) {
    const env = this.env;
    const chatId = cq.message.chat.id;
    const userId = cq.from.id;
    const data = cq.data || '';

    if (data === 'begin') {
      if (!game || game.phase !== PHASE.LOBBY) {
        await answerCallback(env, cq.id, 'No lobby to start.');
        return undefined;
      }
      if (game.players[0].userId !== userId) {
        await answerCallback(env, cq.id, 'Only the host can start.');
        return undefined;
      }
      await answerCallback(env, cq.id, 'Starting…');
      await editReplyMarkup(env, chatId, cq.message.message_id, []);
      return await this.startGame(game, workerUrl);
    }

    if (data.startsWith('mv:')) {
      const piece = parseInt(data.slice(3), 10);
      if (!game) { await answerCallback(env, cq.id, 'No game.'); return undefined; }
      if (game.phase !== PHASE.MOVE) { await answerCallback(env, cq.id, 'Wrong phase.'); return undefined; }
      if (game.players[game.current].userId !== userId) {
        await answerCallback(env, cq.id, 'Not your turn.');
        return undefined;
      }
      const move = game.legalMoves.find(m => m.piece === piece);
      if (!move) { await answerCallback(env, cq.id, 'Move unavailable.'); return undefined; }

      await answerCallback(env, cq.id, 'Moving…');
      // Clear the prompt buttons — they are now stale.
      await editReplyMarkup(env, chatId, cq.message.message_id, []);

      const mover = game.players[game.current];
      const events = applyMove(game, piece);
      await this.reportEvents(game, mover, move, events, workerUrl);

      // Always a fresh photo, never an edit
      await sendBoard(env, game);

      await this.continueWithBots(game, workerUrl);
      return game;
    }

    return undefined;
  }

  /* ------------------------------ START GAME ------------------------------ */

  async startGame(game, workerUrl) {
    const env = this.env;
    const chatId = game.chatId;

    const humanCount = game.players.filter(p => !p.isBot).length;
    const needed = botsNeeded(humanCount);
    for (let i = 0; i < needed; i++) addBot(game);

    const botCount = game.players.filter(p => p.isBot).length;
    const total = game.players.length;

    game.phase = PHASE.ROLL;
    game.current = 0;
    game.turn = 1;
    game.consecutiveSixes = 0;
    game.dice = null;
    game.legalMoves = [];
    game.log.push(`Game started with ${humanCount} humans + ${botCount} bots`);

    let text = `<b>🎮 Game begins!</b>\n`;
    text += `👥 Board: <b>${total} players</b> · 👤 Humans: <b>${humanCount}</b>`;
    if (botCount > 0) text += ` · 🤖 Bots: <b>${botCount}</b>`;
    await sendMessage(env, chatId, text);

    // Initial dark-mode board
    await sendBoard(env, game);

    const first = game.players[0];
    const hint = first.isBot
      ? `🤖 <b>${escapeHtml(first.name)}</b> is playing…`
      : `It's <b>${escapeHtml(first.name)}</b>'s turn.\nSend the 🎲 dice sticker to roll.`;
    await sendMessage(env, chatId, hint);

    await this.continueWithBots(game, workerUrl);
    return game;
  }

  /* ------------------------------ DICE HANDLER ------------------------------ */

  async onDice(msg, game, workerUrl) {
    const env = this.env;
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!game) return undefined;
    if (game.phase !== PHASE.ROLL) return undefined;
    if (msg.dice.emoji && msg.dice.emoji !== '🎲') return undefined;

    const currentPlayer = game.players[game.current];
    if (currentPlayer.isBot) return undefined;
    if (currentPlayer.userId !== userId) return undefined;

    const dice = msg.dice.value;
    game.log.push(`${currentPlayer.name} rolled a ${dice}`);

    if (dice === 6) game.consecutiveSixes++;
    else game.consecutiveSixes = 0;

    if (RULES.threeSixesLoseTurn && game.consecutiveSixes >= 3) {
      game.log.push('Three 6s — turn forfeited');
      await sendMessage(env, chatId,
        `🎲 <b>${escapeHtml(currentPlayer.name)}</b> rolled 6 three times — turn forfeited!`
      );
      advanceTurn(game);
      await sendBoard(env, game);
      await this.sendTurnPrompt(game, workerUrl);
      await this.continueWithBots(game, workerUrl);
      return game;
    }

    const moves = legalMoves(game, game.current, dice);
    if (moves.length === 0) {
      await sendMessage(env, chatId,
        `🎲 <b>${escapeHtml(currentPlayer.name)}</b> rolled <b>${dice}</b> — no legal moves.`
      );
      advanceTurn(game);
      await sendBoard(env, game);
      await this.sendTurnPrompt(game, workerUrl);
      await this.continueWithBots(game, workerUrl);
      return game;
    }

    game.dice = dice;
    game.legalMoves = moves;
    game.phase = PHASE.MOVE;

    // Show current board state (with halos on the movable pieces)
    await sendBoard(env, game);

    if (moves.length === 1) {
      const mover = game.players[game.current];
      const m = moves[0];
      const events = applyMove(game, m.piece);
      await this.reportEvents(game, mover, m, events, workerUrl);
      await sendBoard(env, game);
      await this.continueWithBots(game, workerUrl);
      return game;
    }

    // Multiple moves → button menu. On a 6, the user sees BOTH categories.
    const hasYard = moves.some(m => m.from === -1);
    const hasTrack = moves.some(m => m.from !== -1);
    const buttons = moves.map(m => [{
      text: moveLabel(game, m),
      callback_data: `mv:${m.piece}`,
    }]);

    let intro;
    if (dice === 6 && hasYard && hasTrack) {
      intro =
        `🎲 <b>${escapeHtml(currentPlayer.name)}</b> rolled <b>6</b>.\n` +
        `Choose:\n` +
        `  🆕 bring out a new piece, <b>or</b>\n` +
        `  ➡️ advance an existing piece.`;
    } else if (dice === 6 && hasYard) {
      intro =
        `🎲 <b>${escapeHtml(currentPlayer.name)}</b> rolled <b>6</b>.\n` +
        `Bring a new piece out of the yard.`;
    } else if (dice === 6) {
      intro =
        `🎲 <b>${escapeHtml(currentPlayer.name)}</b> rolled <b>6</b>.\n` +
        `Advance one of your pieces.`;
    } else {
      intro = `🎲 <b>${escapeHtml(currentPlayer.name)}</b> rolled <b>${dice}</b>.\nPick a piece:`;
    }

    await sendMessage(env, chatId, intro, {
      reply_markup: { inline_keyboard: buttons },
    });

    return game;
  }

  /* ------------------------------ BOT LOOP ------------------------------ */

  async continueWithBots(game, workerUrl) {
    let safety = 0;
    while (
      safety++ < BOT_LOOP_SAFETY &&
      game.phase !== PHASE.GAMEOVER &&
      game.phase !== PHASE.LOBBY &&
      game.players[game.current] &&
      game.players[game.current].isBot
    ) {
      await sleep(BOT_TURN_DELAY_MS);
      await this.runBotTurn(game, workerUrl);
    }
    if (safety >= BOT_LOOP_SAFETY) console.error('Bot loop safety limit hit');
  }

  async runBotTurn(game, workerUrl) {
    const env = this.env;
    const chatId = game.chatId;
    const bot = game.players[game.current];

    const diceRes = await tg(env, 'sendDice', { chat_id: chatId, emoji: '🎲' });
    let dice = 1 + Math.floor(Math.random() * 6);
    if (diceRes && diceRes.ok && diceRes.result && diceRes.result.dice) {
      dice = diceRes.result.dice.value;
    }

    game.log.push(`${bot.name} rolled a ${dice}`);

    if (dice === 6) game.consecutiveSixes++;
    else game.consecutiveSixes = 0;

    if (RULES.threeSixesLoseTurn && game.consecutiveSixes >= 3) {
      game.log.push('Three 6s — turn forfeited');
      await sendMessage(env, chatId,
        `🎲 <b>${escapeHtml(bot.name)}</b> rolled 6 three times — turn forfeited!`
      );
      advanceTurn(game);
      await sendBoard(env, game);
      await this.sendTurnPrompt(game, workerUrl);
      return;
    }

    const moves = legalMoves(game, game.current, dice);
    if (moves.length === 0) {
      await sendMessage(env, chatId,
        `🎲 <b>${escapeHtml(bot.name)}</b> rolled <b>${dice}</b> — no legal moves.`
      );
      advanceTurn(game);
      await sendBoard(env, game);
      await this.sendTurnPrompt(game, workerUrl);
      return;
    }

    game.dice = dice;
    game.legalMoves = moves;
    game.phase = PHASE.MOVE;

    const chosen = chooseBotMove(game, moves);
    const events = applyMove(game, chosen.piece);
    await this.reportEvents(game, bot, chosen, events, workerUrl);

    // Fresh board after each bot move
    await sendBoard(env, game);
    await this.sendTurnPrompt(game, workerUrl);
  }

  /* ------------------------------ SHARED REPORTS ------------------------------ */

  async sendTurnPrompt(game, workerUrl) {
    if (game.phase === PHASE.GAMEOVER) return;
    const env = this.env;
    const player = game.players[game.current];

    if (player.isBot) return; // bot loop handles it

    const text =
      `<b>Turn ${game.turn}</b> · It's <b>${escapeHtml(player.name)}</b>'s turn.\n` +
      `Send the 🎲 dice sticker to roll.`;
    await sendMessage(env, game.chatId, text);
  }

  async sendStatus(game, workerUrl) {
    const env = this.env;
    const player = game.players[game.current];

    let text = '';
    if (game.phase === PHASE.LOBBY) {
      text = `<b>🎮 Lobby open</b>\n👥 Humans: ${game.players.filter(p => !p.isBot).length} / ${game.maxPlayers}`;
    } else if (game.phase === PHASE.GAMEOVER) {
      const winner = game.players[game.winners[game.winners.length - 1]];
      text = `🏆 <b>${escapeHtml(winner.name)}</b> has won!`;
    } else if (game.phase === PHASE.ROLL) {
      text = `<b>Turn ${game.turn}</b>\nIt's <b>${escapeHtml(player.name)}</b>'s turn.`;
    } else if (game.phase === PHASE.MOVE) {
      text = `<b>Turn ${game.turn}</b>\n<b>${escapeHtml(player.name)}</b> rolled <b>${game.dice}</b>.`;
    }

    await sendMessage(env, game.chatId, text);
  }

  async reportEvents(game, mover, move, events, workerUrl) {
    const env = this.env;
    const chatId = game.chatId;

    const lines = [];
    lines.push(`<b>${escapeHtml(mover.name)}</b> moved: ${escapeHtml(moveLabel(game, move))}`);
    for (const e of events) {
      if (e.type === 'capture') {
        const victim = game.players[e.player];
        lines.push(`💥 Captured <b>${escapeHtml(victim.name)}</b>'s piece #${e.piece + 1}`);
      }
      if (e.type === 'finish') lines.push(`🏁 A piece reached home!`);
    }

    await sendMessage(env, chatId, lines.join('\n'));

    if (game.phase === PHASE.GAMEOVER) {
      const winner = game.players[game.winners[game.winners.length - 1]];
      await sendMessage(env, chatId,
        `🏆 <b>${escapeHtml(winner.name)}</b> wins!\nUse /new to start another game.`
      );
      return;
    }

    const extraTurn = events.some(e => e.type === 'extra_turn');
    const player = game.players[game.current];

    if (extraTurn && !player.isBot) {
      await sendMessage(env, chatId,
        `🎲 Rolled a 6 — <b>${escapeHtml(player.name)}</b> rolls again.\nSend the 🎲 dice sticker.`
      );
    }
  }
}

/* ============================ WORKER ENTRY ============================ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/debug') {
      const token = env.BOT_TOKEN || '';
      const info = {
        worker: 'ok',
        hasToken: !!token,
        tokenFormat: token ? `${token.slice(0, 6)}…${token.slice(-4)} (len=${token.length})` : 'MISSING',
        hasGameRoom: !!env.GAME_ROOM,
      };
      if (token) {
        try {
          const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
          const j = await r.json();
          info.telegramOk = j.ok;
          info.telegramBot = j.ok ? j.result.username : (j.description || 'unknown error');
        } catch (e) {
          info.telegramOk = false;
          info.telegramBot = 'fetch failed: ' + e.message;
        }
      }
      try {
        await ensureResvg();
        info.resvgOk = true;
      } catch (e) {
        info.resvgOk = false;
        info.resvgError = e.message;
      }
      return new Response(JSON.stringify(info, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('Mensch ärgere Dich nicht bot is running 🎲', { status: 200 });
    }

    // Raw PNG board preview
    if (request.method === 'GET' && url.pathname.startsWith('/board/')) {
      const chatId = decodeURIComponent(url.pathname.slice('/board/'.length));
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(chatId));
      const stateRes = await stub.fetch('https://do/get', { method: 'GET' });
      const game = await stateRes.json();
      if (!game) return new Response('No active game', { status: 404 });
      try {
        const svg = renderBoardSVG(game, 1000);
        const png = await svgToPng(svg, BOARD_PNG_WIDTH);
        return new Response(png, {
          headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
        });
      } catch (e) {
        return new Response('Render failed: ' + e.message, { status: 500 });
      }
    }

    if (request.method === 'POST') {
      let update;
      try { update = await request.json(); }
      catch { return new Response('Bad JSON', { status: 400 }); }

      const chatId = extractChatId(update);
      if (chatId) {
        const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(String(chatId)));
        ctx.waitUntil(
          stub.fetch('https://do/update', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Worker-Url': url.origin,
            },
            body: JSON.stringify(update),
          }).catch(e => console.error('DO dispatch error:', e && e.stack ? e.stack : e))
        );
      }
      return new Response('ok');
    }

    return new Response('Not found', { status: 404 });
  },
};

function extractChatId(update) {
  if (update.message?.chat) return update.message.chat.id;
  if (update.callback_query?.message?.chat) return update.callback_query.message.chat.id;
  if (update.edited_message?.chat) return update.edited_message.chat.id;
  if (update.channel_post?.chat) return update.channel_post.chat.id;
  return null;
  }
