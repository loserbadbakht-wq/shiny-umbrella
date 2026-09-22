/**
 * Telegram bot — Mensch ärgere Dich nicht
 * Cloudflare Worker + Durable Objects + KV
 *
 * Modes:
 *   classic — 4 pieces per player, 4 home cells. First to bring all four home wins.
 *   solo    — 1 piece per player, 1 home cell. First to bring it home wins.
 *
 * Dice = the player's own Telegram 🎲 sticker, prompted by a reply
 * keyboard button so tapping it sends the dice from the player's account.
 * Forwarded dice are rejected.
 *
 * Avatars live inside the encrypted game state and are discarded with
 * the match (either via /end or by starting a new /new).
 *
 * Lloyd (the odd-count bot) uses the bot's own Telegram profile picture
 * as his avatar.
 */

import { Resvg, initWasm } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';

/* ============================ CONSTANTS ============================ */

const RULES = {
  extraTurnOnSix: true,
  threeSixesLoseTurn: true,
  blockOwnPieces: true,
};

const GAME_MODES = {
  classic: { pieces: 4, homeCells: 4 },
  solo:    { pieces: 1, homeCells: 1 },
};

const PHASE = { LOBBY: 'lobby', ROLL: 'roll', MOVE: 'move', GAMEOVER: 'gameover' };

const MIN_PLAYERS = 4;
const MAX_HUMANS = 20;
const DEFAULT_PLAYERS = 4;
const LOBBY_PLAYER_CHOICES = [4, 6, 8, 10, 12, 14, 16, 18, 20];
const BOT_TICK_DELAY_MS = 350;
const BOT_TICK_GUARD = 60;
const BOARD_COOLDOWN_MS = 5000;
const BOARD_PNG_WIDTH = 900;
const DEFAULT_LANG = 'en';
const AVATAR_MAX_BYTES = 40 * 1024;
const LLOYD_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

const RLM = '\u200F';

const PALETTE = {
  bg:'#0b1220', cellFill:'#1e293b', cellStroke:'#334155',
  homeOuter:'#1e293b', homeMid:'#334155', homeInner:'#475569', homeStroke:'#475569',
  shadow:'#000000', halo:'#fbbf24', flash1:'#fbbf24', flash2:'#fde68a',
  badge:'#0f172a', badgeText:'#fbbf24', movableEdge:'#f8fafc',
  pieceTop:'#ffffff', pieceNum:'#ffffff', pieceNumBg:'#0b1220', arrow:'#94a3b8',
};

const PLAYER_EMOJIS = [
  '🔴','🟠','🟡','🟢','🔵','🟣','🟤','⚫','⚪',
  '🟥','🟧','🟨','🟩','🟦','🟪','🟫','⬛','⬜','🔶','🔷',
];

const PLAYER_COLORS = [
  { h:   0, s: 75, l: 55 },
  { h:  25, s: 85, l: 55 },
  { h:  50, s: 85, l: 52 },
  { h: 135, s: 65, l: 48 },
  { h: 215, s: 75, l: 55 },
  { h: 275, s: 65, l: 60 },
  { h:  22, s: 60, l: 38 },
  { h:   0, s:  0, l: 28 },
  { h:   0, s:  0, l: 92 },
  { h:   0, s: 75, l: 45 },
  { h:  25, s: 85, l: 47 },
  { h:  50, s: 85, l: 45 },
  { h: 135, s: 60, l: 40 },
  { h: 215, s: 70, l: 45 },
  { h: 275, s: 60, l: 48 },
  { h:  22, s: 55, l: 30 },
  { h:   0, s:  0, l: 15 },
  { h:   0, s:  0, l: 98 },
  { h:  25, s: 90, l: 55 },
  { h: 215, s: 80, l: 55 },
];

const BOT_NAMES = ['cute femboy', 'hot tomboy', 'mesugaki'];
const SPECIAL_BOT_NAME = 'lloyd de saloum';

/* Per-player-count cell configuration. */
function cellsFor4()  { return 5; }
function cellsFor6()  { return 3; }
function cellsFor8()  { return 2; }
function cellsFor10() { return 2; }
function cellsFor12() { return 2; }
function cellsFor14() { return 2; }
function cellsFor16() { return 2; }
function cellsFor18() { return 2; }
function cellsFor20() { return 2; }

function cellsPerPlayerFor(numPlayers) {
  switch (numPlayers) {
    case 4:  return cellsFor4();
    case 6:  return cellsFor6();
    case 8:  return cellsFor8();
    case 10: return cellsFor10();
    case 12: return cellsFor12();
    case 14: return cellsFor14();
    case 16: return cellsFor16();
    case 18: return cellsFor18();
    case 20: return cellsFor20();
    default: {
      if (numPlayers < 6)  return cellsFor4();
      if (numPlayers < 8)  return cellsFor6();
      if (numPlayers < 10) return cellsFor8();
      if (numPlayers < 12) return cellsFor10();
      if (numPlayers < 14) return cellsFor12();
      if (numPlayers < 16) return cellsFor14();
      if (numPlayers < 18) return cellsFor16();
      if (numPlayers < 20) return cellsFor18();
      return cellsFor20();
    }
  }
}

let lloydImageCache;
let lloydBotId = null;

/* ============================ TRANSLATIONS ============================ */

const TRANSLATIONS = {
  en: {
    helpTitle: '🎲 Mensch ärgere Dich nicht',
    helpCommands: 'Commands',
    helpNew: '/new — open a lobby with buttons to pick player count and mode',
    helpJoin: '/join — join the open lobby',
    helpLeave: '/leave — leave the lobby',
    helpBegin: '/begin — start the game (starter only)',
    helpBoard: '/board — resend the current board',
    helpState: '/state — show turn info',
    helpEnd: '/end — end the current game',
    helpLanguage: '/language — change bot language',
    helpDebug: '/debug — show bot diagnostics',
    helpPlayerCount: 'Player count',
    helpPlayerCountDesc:
      'Minimum <b>4</b> players. Fewer than 4 humans → the bot fills with bots. ' +
      'More than 4 humans and odd → exactly one bot is added so the board stays even.',
    helpModes: 'Game modes',
    helpModesDesc:
      '<b>classic</b> — 4 pieces per player, 4 home cells. First to bring all four home wins.\n' +
      '<b>solo</b> — 1 piece per player, 1 home cell. First to bring it home wins. Faster games.',
    helpHowToPlay: 'How to play',
    helpHowToPlayDesc:
      '1. The board caption tags the player whose turn it is.\n' +
      '2. That player taps the 🎲 button at the bottom of the chat to send a dice.\n' +
      '3. Roll a 6 → you can 🆕 bring out a new piece OR ➡️ advance an existing one.\n' +
      '4. Bring your pieces to the home column to win.\n\n' +
      'Each piece shows its number. The current yard flashes with amber rings, ' +
      'and a dashed arrow shows the clockwise direction of play.',

    lobbyOpened: '🎮 Lobby opened',
    humans: 'Humans',
    host: 'Starter',
    modeLabel: 'Mode',
    modeClassic: 'classic (4 pieces, 4 homes)',
    modeSolo: 'solo (1 piece, 1 home)',
    othersJoin: 'Others can join with /join.',
    hostBegin: 'Starter: tap 🚀 Begin game when ready.',
    lobbyNote: 'Board will always have at least 4 players — the bot fills any missing slots.',
    lobbyOpen: '🎮 Lobby open',
    joinSuccess: 'joined!',
    leftGame: 'left.',
    alreadyJoined: '⚠️ You already joined.',
    lobbyFull: '⚠️ Lobby is full.',
    noLobby: '⚠️ No open lobby to join.',
    noGameToEnd: '⚠️ No game to end.',
    gameEnded: '🛑 Game ended.',
    onlyHostStart: '⚠️ Only the starter can start the game.',
    gameInProgress: '⚠️ A game is already in progress. Use /end first.',
    groupOnly: '⚠️ This bot is meant for group chats. Add me to a group and try again.',
    capacityRange: '⚠️ Human capacity must be between <b>4</b> and <b>20</b>.',
    noGameHere: '⚠️ No game here. Use /new to start one.',
    hostCannotLeave: '⚠️ The starter cannot leave. Use /end to cancel.',
    lobbyNotHost: '⚠️ Only the starter can change lobby settings.',

    gameBegins: '🎮 Game begins!',
    board: 'Board',
    players: 'players',
    turn: 'Turn',
    toRoll: 'to roll',
    tapDice: 'tap the <b>🎲</b> button to roll.',
    dicePlaceholder: 'Tap 🎲 to roll',
    useRealDice: 'Please send the 🎲 sticker, not the text. Tap the button below the chat.',
    noForwardDice: '⛔ Forwarded dice are not allowed. Send your own 🎲.',
    rolling: 'rolling…',
    moving: 'Moving…',
    starting: 'Starting…',
    rolledN: 'rolled <b>{n}</b>',
    choosePiece: 'Choose a piece from the buttons below.',
    pickPiece: 'Pick a piece:',
    chooseOption: 'Choose: 🆕 bring out a new piece, <b>or</b> ➡️ advance an existing one.',
    bringNew: 'Bring a new piece out.',
    advanceOne: 'Advance one of your pieces.',
    rolledSixPlain: 'rolled 6',
    rollAgain: 'rolls again — tap 🎲.',
    noLegalMoves: 'no legal moves.',
    threeSixes: 'rolled 6 three times — turn forfeited!',
    wins: 'wins!',
    newGameHint: 'Use /new to start another game.',

    beginGame: '🚀 Begin game',
    viewBoard: '📋 View board',

    space: 'space',
    pieceWord: 'piece',
    yardWord: 'yard',
    moveFromYard: '{mover} moved {piece} {n} out of the {yard} to {space} {to}',
    moveNormal:   '{mover} moved {piece} {n} from {space} {from} to {space} {to}',

    captured: '💥 Captured',
    reachedHome: '🏁 A piece reached home!',

    noGame: 'No game.',
    wrongPhase: 'Wrong phase.',
    moveUnavailable: 'Move unavailable.',
    internalError: 'Internal error',
    noLobbyStart: 'No lobby to start.',
    onlyHostShort: 'Only the starter can start.',

    langTitle: '🌐 Choose your language',
    langSet: '✅ Language set to English',
    langCurrent: 'Current language: English',
    langError: '⚠️ Could not change language.',

    debugTitle: '🐞 Bot diagnostics',
    debugChat: 'Chat',
    debugLang: 'Language',
    debugWorker: 'Worker',
    debugOk: '✅ ok',
    debugMissing: '❌ missing',
    debugToken: 'BOT_TOKEN',
    debugKV: 'BOT_KV binding',
    debugDO: 'GAME_ROOM binding',
    debugEnc: 'DB_ENCRYPTION_KEY',
    debugResvg: 'resvg-wasm',
    debugLloyd: 'Bot profile picture (Lloyd)',
    debugTelegram: 'Telegram API',
    debugBot: 'Bot username',
    debugGame: 'Game state',
    debugNoGame: '(no game)',
    debugPhase: 'Phase',
    debugTurnNumber: 'Turn',
    debugCurrent: 'Current player',
    debugPlayers: 'Players',
    debugMode: 'Mode',
    debugPiecesPerPlayer: 'Pieces per player',
    debugHomeCells: 'Home cells',
    debugCellsPerPlayer: 'Cells per player',
    debugTrackCells: 'Track cells',
    debugAvatars: 'Profile pictures',
    debugAvatarNotFetched: '⚪ not fetched yet',
    debugAvatarNoPhoto: '❌ no photo from Telegram',
    debugAvatarNoPhotoReason: '(privacy or never started bot privately)',
    debugLogRecent: 'Recent rolls',

    bot: 'Bot',
  },

  fa: {
    helpTitle: '🎲 منچ',
    helpCommands: 'دستورات',
    helpNew: '/new — ساخت اتاق بازی با دکمه‌های انتخاب تعداد بازیکن و حالت',
    helpJoin: '/join — پیوستن به بازی',
    helpLeave: '/leave — خروج از بازی',
    helpBegin: '/begin — شروع بازی (فقط شروع کننده)',
    helpBoard: '/board — نمایش دوباره صفحه',
    helpState: '/state — نمایش وضعیت',
    helpEnd: '/end — پایان بازی',
    helpLanguage: '/language — تغییر زبان ربات',
    helpDebug: '/debug — نمایش وضعیت ربات',
    helpPlayerCount: 'تعداد بازیکن',
    helpPlayerCountDesc:
      'حداقل <b>۴</b> بازیکن. اگر کمتر از ۴ نفر باشند ربات با بازیکن مصنوعی پر می‌کند. ' +
      'اگر بیش از ۴ نفر و تعداد فرد باشد، یک بازیکن مصنوعی اضافه می‌شود تا تعداد زوج شود.',
    helpModes: 'حالت‌های بازی',
    helpModesDesc:
      '<b>classic</b> — چهار مهره و چهار خانه برای هر بازیکن. اولین کسی که همه را به خانه برساند برنده است.\n' +
      '<b>solo</b> — یک مهره و یک خانه برای هر بازیکن. اولین کسی که آن را به خانه برساند برنده است. سریع‌تر.',
    helpHowToPlay: 'روش بازی',
    helpHowToPlayDesc:
      '۱. زیر عکس صفحه، بازیکن نوبت‌دار منشن می‌شود.\n' +
      '۲. همان بازیکن دکمه 🎲 پایین چت را می‌زند تا تاس از طرف خودش فرستاده شود.\n' +
      '۳. اگر ۶ آوردید می‌توانید 🆕 مهره جدید بیاورید یا ➡️ مهره موجود را حرکت دهید.\n' +
      '۴. مهره‌هایتان را به ستون خانه برسانید تا برنده شوید.\n\n' +
      'هر مهره شماره‌اش را نشان می‌دهد. خانه بازیکن فعلی با حلقه‌های کهربایی چشمک می‌زند ' +
      'و فلش خط‌چین جهت گردش را نشان می‌دهد.',

    lobbyOpened: '🎮 اتاق بازی باز شد',
    humans: 'بازیکنان',
    host: 'شروع کننده',
    modeLabel: 'حالت',
    modeClassic: 'کلاسیک (۴ مهره، ۴ خانه)',
    modeSolo: 'تک‌مهره (۱ مهره، ۱ خانه)',
    othersJoin: 'سایرین می‌توانند با /join وارد شوند.',
    hostBegin: 'شروع کننده: وقتی آماده بودید دکمه 🚀 را بزنید.',
    lobbyNote: 'صفحه همیشه حداقل ۴ بازیکن خواهد داشت — ربات جاهای خالی را پر می‌کند.',
    lobbyOpen: '🎮 اتاق باز است',
    joinSuccess: 'پیوست!',
    leftGame: 'خارج شد.',
    alreadyJoined: '⚠️ شما قبلاً پیوسته‌اید.',
    lobbyFull: '⚠️ اتاق پر است.',
    noLobby: '⚠️ اتاق بازی برای پیوستن وجود ندارد.',
    noGameToEnd: '⚠️ بازی برای پایان وجود ندارد.',
    gameEnded: '🛑 بازی پایان یافت.',
    onlyHostStart: '⚠️ فقط شروع کننده می‌تواند بازی را شروع کند.',
    gameInProgress: '⚠️ یک بازی در حال اجراست. اول /end بزنید.',
    groupOnly: '⚠️ این ربات برای گروه‌ها ساخته شده. مرا به یک گروه اضافه کنید.',
    capacityRange: '⚠️ ظرفیت بازیکنان باید بین <b>۴</b> و <b>۲۰</b> باشد.',
    noGameHere: '⚠️ بازی‌ای اینجا نیست. با /new شروع کنید.',
    hostCannotLeave: '⚠️ شروع کننده نمی‌تواند خارج شود. با /end بازی را لغو کنید.',
    lobbyNotHost: '⚠️ فقط شروع کننده می‌تواند تنظیمات اتاق را تغییر دهد.',

    gameBegins: '🎮 بازی شروع شد!',
    board: 'صفحه',
    players: 'بازیکن',
    turn: 'نوبت',
    toRoll: 'برای تاس انداختن',
    tapDice: 'دکمه <b>🎲</b> را بزنید تا تاس فرستاده شود.',
    dicePlaceholder: 'برای تاس زدن 🎲 را بزنید',
    useRealDice: 'لطفاً استیکر 🎲 را بفرستید نه متن. دکمه پایین چت را بزنید.',
    noForwardDice: '⛔ تاس فوروارد شده مجاز نیست. تاس خودتان را بفرستید 🎲.',
    rolling: 'در حال انداختن…',
    moving: 'در حال حرکت…',
    starting: 'در حال شروع…',
    rolledN: 'تاس <b>{n}</b> آورد',
    choosePiece: 'یک مهره از دکمه‌های زیر انتخاب کنید.',
    pickPiece: 'یک مهره انتخاب کنید:',
    chooseOption: 'انتخاب: 🆕 آوردن مهره جدید، <b>یا</b> ➡️ حرکت دادن مهره موجود.',
    bringNew: 'مهره جدید بیاورید.',
    advanceOne: 'یکی از مهره‌های خود را حرکت دهید.',
    rolledSixPlain: 'تاس ۶ آورد',
    rollAgain: 'دوباره تاس می‌اندازد — 🎲 را بزنید.',
    noLegalMoves: 'حرکت قانونی وجود ندارد.',
    threeSixes: 'سه بار ۶ آورد — نوبت از دست رفت!',
    wins: 'برنده شد!',
    newGameHint: 'برای بازی جدید /new بزنید.',

    beginGame: '🚀 شروع بازی',
    viewBoard: '📋 نمایش صفحه',

    space: 'خانه',
    pieceWord: 'مهره',
    yardWord: 'شروع',
    moveFromYard: '{mover} {piece} {n} را از {yard} به {space} {to} حرکت داد',
    moveNormal:   '{mover} {piece} {n} را از {space} {from} به {space} {to} حرکت داد',

    captured: '💥 زده شد',
    reachedHome: '🏁 یک مهره به خانه رسید!',

    noGame: 'بازی‌ای نیست.',
    wrongPhase: 'فاز اشتباه.',
    moveUnavailable: 'حرکت ممکن نیست.',
    internalError: 'خطای داخلی',
    noLobbyStart: 'اتاقی برای شروع نیست.',
    onlyHostShort: 'فقط شروع کننده می‌تواند شروع کند.',

    langTitle: '🌐 زبان خود را انتخاب کنید',
    langSet: '✅ زبان به فارسی تغییر کرد',
    langCurrent: 'زبان فعلی: فارسی',
    langError: '⚠️ تغییر زبان ممکن نشد.',

    debugTitle: '🐞 وضعیت ربات',
    debugChat: 'چت',
    debugLang: 'زبان',
    debugWorker: 'ورکر',
    debugOk: '✅ سالم',
    debugMissing: '❌ ناموجود',
    debugToken: 'توکن ربات',
    debugKV: 'اتصال BOT_KV',
    debugDO: 'اتصال GAME_ROOM',
    debugEnc: 'کلید رمزنگاری',
    debugResvg: 'موتور resvg',
    debugLloyd: 'تصویر پروفایل ربات (Lloyd)',
    debugTelegram: 'API تلگرام',
    debugBot: 'نام کاربری ربات',
    debugGame: 'وضعیت بازی',
    debugNoGame: '(بدون بازی)',
    debugPhase: 'فاز',
    debugTurnNumber: 'نوبت',
    debugCurrent: 'بازیکن فعلی',
    debugPlayers: 'بازیکنان',
    debugMode: 'حالت',
    debugPiecesPerPlayer: 'مهره در هر بازیکن',
    debugHomeCells: 'خانه‌های پایان',
    debugCellsPerPlayer: 'خانه در هر بازیکن',
    debugTrackCells: 'کل خانه‌های مسیر',
    debugAvatars: 'تصویر پروفایل',
    debugAvatarNotFetched: '⚪ هنوز گرفته نشده',
    debugAvatarNoPhoto: '❌ تلگرام عکسی برنگرداند',
    debugAvatarNoPhotoReason: '(حریم خصوصی یا هرگز به ربات پیام نداده)',
    debugLogRecent: 'تاس‌های اخیر',

    bot: 'ربات',
  },
};

function t(lang, key) {
  const dict = TRANSLATIONS[lang] || TRANSLATIONS.en;
  return dict[key] ?? TRANSLATIONS.en[key] ?? key;
}

function rolledText(lang, dice) {
  return t(lang, 'rolledN').replaceAll('{n}', String(dice));
}

function modeOf(game) {
  return GAME_MODES[game.mode] || GAME_MODES.classic;
}

function piecesCount(game) {
  return modeOf(game).pieces;
}

function homeCellsFor(game) {
  return modeOf(game).homeCells;
}

function modeLabel(lang, mode) {
  return mode === 'solo' ? t(lang, 'modeSolo') : t(lang, 'modeClassic');
}

function mentionFor(player) {
  if (player && player.userId) {
    return `<a href="tg://user?id=${player.userId}">${escapeHtml(player.name)}</a>`;
  }
  return escapeHtml(player?.name || '');
}

function isForwardedMessage(msg) {
  if (!msg) return false;
  return !!(
    msg.forward_origin ||
    msg.forward_from ||
    msg.forward_from_chat ||
    msg.forward_sender_name
  );
}

/* ============================ ENCRYPTION ============================ */

function keyBytes(env) {
  const raw = env.DB_ENCRYPTION_KEY || 'default-key-please-change-me';
  const padded = String(raw).padEnd(32, '0').slice(0, 32);
  return new TextEncoder().encode(padded);
}

function encryptData(env, data) {
  const jsonStr = JSON.stringify(data);
  const plaintext = new TextEncoder().encode(jsonStr);
  const kb = keyBytes(env);
  const out = new Uint8Array(plaintext.length);
  for (let i = 0; i < plaintext.length; i++) out[i] = plaintext[i] ^ kb[i % kb.length];
  let s = '';
  for (let i = 0; i < out.length; i++) s += String.fromCharCode(out[i]);
  return btoa(s);
}

function decryptData(env, encryptedStr) {
  const bin = atob(encryptedStr);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const kb = keyBytes(env);
  const out = new Uint8Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ kb[i % kb.length];
  return JSON.parse(new TextDecoder().decode(out));
}

/* ============================ KV ============================ */

async function getChatLang(env, chatId) {
  if (!env.BOT_KV) return DEFAULT_LANG;
  const key = `chat_lang_${chatId}`;
  try {
    const raw = await env.BOT_KV.get(key);
    if (!raw) return DEFAULT_LANG;
    try {
      const val = decryptData(env, raw);
      if (val === 'fa' || val === 'en') return val;
      return DEFAULT_LANG;
    } catch (e) { console.error(`decrypt failed for ${key}`, e && e.message); return DEFAULT_LANG; }
  } catch (e) { console.error(`KV get failed for ${key}`, e && e.message); return DEFAULT_LANG; }
}

async function setChatLang(env, chatId, lang) {
  if (!env.BOT_KV) return;
  const key = `chat_lang_${chatId}`;
  try { await env.BOT_KV.put(key, encryptData(env, lang)); }
  catch (e) { console.error(`KV put failed for ${key}`, e && e.message); }
}

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

/* ============================ REPLY KEYBOARDS ============================ */

function diceReplyKeyboard(lang) {
  return {
    keyboard: [[{ text: '🎲' }]],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: t(lang, 'dicePlaceholder'),
  };
}

function removeReplyKeyboard() {
  return { remove_keyboard: true };
}

function replyMarkupFor(game, lang) {
  if (game.phase === PHASE.MOVE) {
    const player = game.players[game.current];
    if (!player.isBot && game.legalMoves.length >= 1) {
      const buttons = game.legalMoves.map(m => [{
        text: moveLabel(game, m, lang),
        callback_data: `mv:${m.piece}`,
      }]);
      return { inline_keyboard: buttons };
    }
    return removeReplyKeyboard();
  }
  if (game.phase === PHASE.ROLL) {
    const player = game.players[game.current];
    if (player && !player.isBot) return diceReplyKeyboard(lang);
    return removeReplyKeyboard();
  }
  return removeReplyKeyboard();
}

/* ============================ AVATARS ============================ */

function detectImageType(buf) {
  if (!buf || buf.length < 4) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return 'image/webp';
  return 'image/jpeg';
}

async function fetchAvatarForUser(env, userId) {
  if (!userId) return null;
  try {
    const photosRes = await tg(env, 'getUserProfilePhotos', { user_id: userId, limit: 1 });
    if (!photosRes || !photosRes.ok) return null;
    const photos = photosRes.result?.photos || [];
    if (!photos.length) return null;

    const sizes = photos[0];
    const chosen = sizes.find(s => Math.max(s.width, s.height) >= 100)
                || sizes[sizes.length - 1];

    const fileRes = await tg(env, 'getFile', { file_id: chosen.file_id });
    if (!fileRes || !fileRes.ok || !fileRes.result?.file_path) return null;

    const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileRes.result.file_path}`;
    const imgRes = await fetch(fileUrl);
    if (!imgRes.ok) return null;

    const buf = new Uint8Array(await imgRes.arrayBuffer());
    if (buf.length > AVATAR_MAX_BYTES) return null;

    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
    }
    const contentType = detectImageType(buf);
    return `data:${contentType};base64,` + btoa(s);
  } catch (e) {
    console.error('[avatar] exception for user', userId, e && e.message);
    return null;
  }
}

async function ensureAvatarsInGame(env, game) {
  if (!game.avatars) game.avatars = {};
  await Promise.all(
    game.players
      .filter(p => !p.isBot && p.userId && !(p.userId in game.avatars))
      .map(async p => {
        game.avatars[p.userId] = await fetchAvatarForUser(env, p.userId);
      })
  );
}

async function ensureLloydImage(env) {
  if (lloydImageCache !== undefined) return lloydImageCache;
  if (!env || !env.BOT_TOKEN) { lloydImageCache = null; return null; }

  try {
    if (!lloydBotId) {
      const me = await tg(env, 'getMe', {});
      if (!me || !me.ok || !me.result || !me.result.id) {
        lloydImageCache = null;
        return null;
      }
      lloydBotId = me.result.id;
    }

    const photosRes = await tg(env, 'getUserProfilePhotos', { user_id: lloydBotId, limit: 1 });
    if (!photosRes || !photosRes.ok) { lloydImageCache = null; return null; }
    const photos = photosRes.result?.photos || [];
    if (!photos.length) { lloydImageCache = null; return null; }

    const sizes = photos[0];
    const chosen = sizes.find(s => Math.max(s.width, s.height) >= 100)
                || sizes[sizes.length - 1];

    const fileRes = await tg(env, 'getFile', { file_id: chosen.file_id });
    if (!fileRes || !fileRes.ok || !fileRes.result?.file_path) { lloydImageCache = null; return null; }

    const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileRes.result.file_path}`;
    const imgRes = await fetch(fileUrl);
    if (!imgRes.ok) { lloydImageCache = null; return null; }

    const buf = new Uint8Array(await imgRes.arrayBuffer());
    if (buf.length > LLOYD_IMAGE_MAX_BYTES) { lloydImageCache = null; return null; }

    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
    }
    const contentType = detectImageType(buf);
    lloydImageCache = `data:${contentType};base64,` + btoa(s);
    return lloydImageCache;
  } catch (e) {
    console.error('[lloyd] exception', e && e.message);
    lloydImageCache = null;
    return null;
  }
}

function avatarUriFor(game, p, lloydImg) {
  if (p.isBot) {
    if (p.name === SPECIAL_BOT_NAME && lloydImg) return lloydImg;
    return null;
  }
  if (!p.userId) return null;
  return (game.avatars && game.avatars[p.userId]) || null;
}

/* ============================ BITMAP FONT ============================ */

const BITMAP_DIGITS = {
  0:[[1,1,1],[1,0,1],[1,0,1],[1,0,1],[1,1,1]], 1:[[0,1,0],[1,1,0],[0,1,0],[0,1,0],[1,1,1]],
  2:[[1,1,1],[0,0,1],[1,1,1],[1,0,0],[1,1,1]], 3:[[1,1,1],[0,0,1],[1,1,1],[0,0,1],[1,1,1]],
  4:[[1,0,1],[1,0,1],[1,1,1],[0,0,1],[0,0,1]], 5:[[1,1,1],[1,0,0],[1,1,1],[0,0,1],[1,1,1]],
  6:[[1,1,1],[1,0,0],[1,1,1],[1,0,1],[1,1,1]], 7:[[1,1,1],[0,0,1],[0,0,1],[0,1,0],[0,1,0]],
  8:[[1,1,1],[1,0,1],[1,1,1],[1,0,1],[1,1,1]], 9:[[1,1,1],[1,0,1],[1,1,1],[0,0,1],[1,1,1]],
};

function bitmapNumber(num, cx, cy, maxW, maxH, color) {
  const str = String(num);
  const cols = str.length * 4 - 1;
  const rows = 5;
  const cellSize = Math.min(maxW / cols, maxH / rows);
  if (cellSize < 0.3) return '';
  const totalW = cols * cellSize;
  const totalH = rows * cellSize;
  const left = cx - totalW / 2;
  const top = cy - totalH / 2;
  const parts = [];
  for (let d = 0; d < str.length; d++) {
    const grid = BITMAP_DIGITS[str.charCodeAt(d) - 48];
    if (!grid) continue;
    const dx = left + d * 4 * cellSize;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < 3; c++) {
        if (grid[r][c]) {
          const x = dx + c * cellSize;
          const y = top + r * cellSize;
          parts.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cellSize.toFixed(2)}" height="${cellSize.toFixed(2)}" fill="${color}"/>`);
        }
      }
    }
  }
  return parts.join('');
}

const BITMAP_CHARS_5x7 = {
  ' ': '00000|00000|00000|00000|00000|00000|00000',
  'A': '01110|10001|10001|11111|10001|10001|10001',
  'B': '11110|10001|10001|11110|10001|10001|11110',
  'C': '01110|10001|10000|10000|10000|10001|01110',
  'D': '11110|10001|10001|10001|10001|10001|11110',
  'E': '11111|10000|10000|11110|10000|10000|11111',
  'F': '11111|10000|10000|11110|10000|10000|10000',
  'G': '01110|10001|10000|10111|10001|10001|01111',
  'H': '10001|10001|10001|11111|10001|10001|10001',
  'I': '11111|00100|00100|00100|00100|00100|11111',
  'J': '00111|00010|00010|00010|00010|10010|01100',
  'K': '10001|10010|10100|11000|10100|10010|10001',
  'L': '10000|10000|10000|10000|10000|10000|11111',
  'M': '10001|11011|10101|10001|10001|10001|10001',
  'N': '10001|11001|10101|10011|10001|10001|10001',
  'O': '01110|10001|10001|10001|10001|10001|01110',
  'P': '11110|10001|10001|11110|10000|10000|10000',
  'Q': '01110|10001|10001|10001|10101|10010|01101',
  'R': '11110|10001|10001|11110|10100|10010|10001',
  'S': '01111|10000|10000|01110|00001|00001|11110',
  'T': '11111|00100|00100|00100|00100|00100|00100',
  'U': '10001|10001|10001|10001|10001|10001|01110',
  'V': '10001|10001|10001|10001|10001|01010|00100',
  'W': '10001|10001|10001|10001|10101|11011|10001',
  'X': '10001|10001|01010|00100|01010|10001|10001',
  'Y': '10001|10001|01010|00100|00100|00100|00100',
  'Z': '11111|00001|00010|00100|01000|10000|11111',
  '0': '01110|10001|10011|10101|11001|10001|01110',
  '1': '00100|01100|00100|00100|00100|00100|01110',
  '2': '01110|10001|00001|00010|00100|01000|11111',
  '3': '11111|00010|00100|00010|00001|10001|01110',
  '4': '00010|00110|01010|10010|11111|00010|00010',
  '5': '11111|10000|11110|00001|00001|10001|01110',
  '6': '00110|01000|10000|11110|10001|10001|01110',
  '7': '11111|00001|00010|00100|01000|01000|01000',
  '8': '01110|10001|10001|01110|10001|10001|01110',
  '9': '01110|10001|10001|01111|00001|00010|01100',
  '-': '00000|00000|00000|11111|00000|00000|00000',
  '.': '00000|00000|00000|00000|00000|01100|01100',
  '_': '00000|00000|00000|00000|00000|00000|11111',
};

const GLYPH_CACHE = new Map();
function glyphOf(ch) {
  if (GLYPH_CACHE.has(ch)) return GLYPH_CACHE.get(ch);
  const s = BITMAP_CHARS_5x7[ch];
  if (!s) { GLYPH_CACHE.set(ch, null); return null; }
  const rows = s.split('|').map(row => row.split('').map(c => c === '1' ? 1 : 0));
  GLYPH_CACHE.set(ch, rows);
  return rows;
}

function bitmapString(str, cx, cy, maxW, maxH, color, rotationDeg = 0) {
  const text = String(str || '').toUpperCase().replace(/[^A-Z0-9 .\-_]/g, ' ').trim();
  if (!text) return '';

  const glyphs = [];
  for (const ch of text) glyphs.push(glyphOf(ch) || glyphOf(' '));
  if (!glyphs.length) return '';

  const cols = 5, rows = 7, spacing = 1;
  const totalCols = glyphs.length * cols + (glyphs.length - 1) * spacing;
  const cellSize = Math.min(maxW / totalCols, maxH / rows);
  if (cellSize < 0.5) return '';

  const totalW = totalCols * cellSize;
  const totalH = rows * cellSize;
  const left = -totalW / 2;
  const top = -totalH / 2;

  const parts = [];
  for (let i = 0; i < glyphs.length; i++) {
    const grid = glyphs[i];
    const gx = left + i * (cols + spacing) * cellSize;
    for (let r = 0; r < rows; r++) {
      const row = grid[r];
      for (let c = 0; c < cols; c++) {
        if (row[c]) {
          const x = gx + c * cellSize;
          const y = top + r * cellSize;
          parts.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cellSize.toFixed(2)}" height="${cellSize.toFixed(2)}" fill="${color}"/>`);
        }
      }
    }
  }

  const transform = rotationDeg
    ? `translate(${cx.toFixed(2)} ${cy.toFixed(2)}) rotate(${rotationDeg.toFixed(2)})`
    : `translate(${cx.toFixed(2)} ${cy.toFixed(2)})`;

  return `<g transform="${transform}">${parts.join('')}</g>`;
}

function truncateForRing(name, playerCount) {
  const s = String(name || '').trim();
  const maxChars = playerCount <= 6 ? 10 : playerCount <= 10 ? 8 : playerCount <= 14 ? 6 : 5;
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

/* ============================ TELEGRAM API ============================ */

async function tg(env, method, payload) {
  const token = env.BOT_TOKEN;
  if (!token) return { ok: false, description: 'BOT_TOKEN missing' };
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

function sendMessage(env, chatId, text, extra = {}, lang = null) {
  const body = lang === 'fa' ? RLM + text : text;
  return tg(env, 'sendMessage', {
    chat_id: chatId,
    text: body,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

function editReplyMarkup(env, chatId, messageId, inlineKeyboard) {
  return tg(env, 'editMessageReplyMarkup', {
    chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

async function safeClearKeyboard(env, chatId, msgId) {
  if (!msgId) return;
  try { return await editReplyMarkup(env, chatId, msgId, []); }
  catch (e) { console.error('editReplyMarkup failed:', e && e.message); }
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
  const resvg = new Resvg(svgString, { fitTo: { mode: 'width', value: width }, background: PALETTE.bg });
  return resvg.render().asPng();
}

async function sendBoardPhoto(env, chatId, pngBytes, caption, replyMarkup, lang) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) {
    form.append('caption', lang === 'fa' ? RLM + caption : caption);
    form.append('parse_mode', 'HTML');
  }
  form.append('photo', new Blob([pngBytes], { type: 'image/png' }), 'board.png');
  if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
  return tgForm(env, 'sendPhoto', form);
}

async function editBoardPhoto(env, chatId, messageId, pngBytes, caption, replyMarkup, lang) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('message_id', String(messageId));

  const media = {
    type: 'photo',
    media: 'attach://board',
  };
  if (caption) {
    media.caption = lang === 'fa' ? RLM + caption : caption;
    media.parse_mode = 'HTML';
  }
  form.append('media', JSON.stringify(media));
  form.append('board', new Blob([pngBytes], { type: 'image/png' }), 'board.png');
  if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));

  return tgForm(env, 'editMessageMedia', form);
}

/* ============================ MOVE MESSAGE ============================ */

function moveMessage(lang, game, mover, move) {
  const L = trackLength(game);
  const pieceNum = move.piece + 1;
  const isYard = move.from === -1;
  const fromNum = isYard ? null : move.from < L ? (move.from + 1) : (move.from - L + 1);
  const toNum = move.to < L ? (move.to + 1) : (move.to - L + 1);

  const templateKey = isYard ? 'moveFromYard' : 'moveNormal';
  const template = t(lang, templateKey);
  const wordPiece = t(lang, 'pieceWord');
  const wordSpace = t(lang, 'space');
  const wordYard  = t(lang, 'yardWord');

  return template
    .replaceAll('{mover}', mover.emoji + ' <b>' + escapeHtml(mover.name) + '</b>')
    .replaceAll('{piece}', wordPiece)
    .replaceAll('{n}', String(pieceNum))
    .replaceAll('{space}', wordSpace)
    .replaceAll('{yard}', wordYard)
    .replaceAll('{from}', isYard ? '—' : String(fromNum))
    .replaceAll('{to}', String(toNum));
}

function buildMoveReport(game, mover, move, events, lang) {
  const lines = [];
  lines.push(moveMessage(lang, game, mover, move));
  for (const e of events) {
    if (e.type === 'capture') {
      const victim = game.players[e.player];
      lines.push(`${t(lang, 'captured')} ${victim.emoji} <b>${escapeHtml(victim.name)}</b> — ${t(lang, 'pieceWord')} ${e.piece + 1}`);
    }
    if (e.type === 'finish') lines.push(t(lang, 'reachedHome'));
  }

  if (game.phase === PHASE.GAMEOVER) {
    const winner = game.players[game.winners[game.winners.length - 1]];
    lines.push('');
    lines.push(`🏆 ${winner.emoji} <b>${mentionFor(winner)}</b> ${t(lang, 'wins')}\n${t(lang, 'newGameHint')}`);
  } else {
    const extraTurn = events.some(e => e.type === 'extra_turn');
    const player = game.players[game.current];
    if (extraTurn && !player.isBot) {
      lines.push('');
      lines.push(`🎲 ${player.emoji} ${mentionFor(player)} ${t(lang, 'rollAgain')}`);
    }
  }

  return lines.join('\n');
}

/* ============================ BOARD CAPTION ============================ */

function playersLine(game) {
  return game.players
    .map(p => {
      const name = p.index === game.current
        ? `<b>${mentionFor(p)}</b>`
        : escapeHtml(p.name);
      return `${p.emoji} ${name}`;
    })
    .join(' · ');
}

function boardCaption(game, lang, prefix = '') {
  if (!game) return prefix || '';

  let base;
  if (game.phase === PHASE.LOBBY) {
    const humans = game.players.filter(p => !p.isBot).length;
    base = `<b>${t(lang, 'lobbyOpen')}</b> · ${humans}/${game.maxPlayers} ${t(lang, 'humans')}`;
  } else if (game.phase === PHASE.GAMEOVER) {
    const winner = game.players[game.winners[game.winners.length - 1]];
    base = `🏆 <b>${mentionFor(winner)}</b> ${t(lang, 'wins')}\n\n${playersLine(game)}`;
  } else {
    const player = game.players[game.current];
    const tag = mentionFor(player);
    let head = '';

    if (game.phase === PHASE.MOVE) {
      head =
        `🎮 <b>${t(lang, 'turn')} ${game.turn}</b> · ${player.emoji} ${tag}\n` +
        `${rolledText(lang, game.dice)}\n` +
        t(lang, 'choosePiece');
    } else if (game.phase === PHASE.ROLL) {
      if (player.isBot) {
        head =
          `🎮 <b>${t(lang, 'turn')} ${game.turn}</b> · ${player.emoji} <b>${escapeHtml(player.name)}</b>\n` +
          `🤖 ${t(lang, 'rolling')}`;
      } else {
        head =
          `🎮 <b>${t(lang, 'turn')} ${game.turn}</b> · ${player.emoji} ${tag}\n` +
          `${t(lang, 'tapDice')}`;
      }
    } else {
      head = `🎮 <b>${t(lang, 'turn')} ${game.turn}</b>`;
    }

    base = `${head}\n\n${playersLine(game)}`;
  }

  return prefix ? `${prefix}\n\n${base}` : base;
}

/* ============================ BOARD SYNC ============================ */

async function sendBoard(env, game, lang, prefix = '') {
  if (game.phase === PHASE.LOBBY) return null;

  const sinceLast = Date.now() - (game.lastBoardAt || 0);
  if (sinceLast < BOARD_COOLDOWN_MS) {
    await sleep(BOARD_COOLDOWN_MS - sinceLast);
  }
  game.lastBoardAt = Date.now();

  let png;
  try {
    const needsLloyd = game.players.some(p => p.isBot && p.name === SPECIAL_BOT_NAME);
    const lloydImg = needsLloyd ? await ensureLloydImage(env) : null;
    const svg = renderBoardSVG(game, 1000, lloydImg);
    png = await svgToPng(svg, BOARD_PNG_WIDTH);
  } catch (e) { console.error('render failed:', e && e.stack ? e.stack : e); return null; }

  const replyMarkup = replyMarkupFor(game, lang);
  try {
    return await sendBoardPhoto(env, game.chatId, png, boardCaption(game, lang, prefix), replyMarkup, lang);
  } catch (e) { console.error('sendBoardPhoto failed:', e && e.message); return null; }
}

/* ============================ LOBBY PREVIEW ============================ */

function resetPiecesForMode(game) {
  const count = piecesCount(game);
  for (const p of game.players) {
    p.pieces = new Array(count).fill(-1);
  }
}

function buildPreviewGame(game) {
  const target = Math.max(game.maxPlayers, game.players.length);
  const players = [];
  for (let i = 0; i < target; i++) {
    if (i < game.players.length) {
      players.push(game.players[i]);
    } else {
      players.push({
        index: i, userId: null, isBot: false, isPlaceholder: true,
        name: '', emoji: '',
        color: '', colorLight: '', colorStroke: '',
        pieces: new Array(piecesCount(game)).fill(-1),
      });
    }
  }
  const preview = Object.assign({}, game, {
    players,
    current: -1,
    phase: PHASE.LOBBY,
    legalMoves: [],
  });
  reindexPlayers(preview);
  return preview;
}

async function renderLobbyPreviewPng(game) {
  const preview = buildPreviewGame(game);
  const svg = renderBoardSVG(preview, 1000, null);
  return await svgToPng(svg, BOARD_PNG_WIDTH);
}

function lobbyKeyboard(game, lang) {
  const rows = [];
  const perRow = 5;
  for (let i = 0; i < LOBBY_PLAYER_CHOICES.length; i += perRow) {
    rows.push(LOBBY_PLAYER_CHOICES.slice(i, i + perRow).map(n => ({
      text: (n === game.maxPlayers ? '✅ ' : '') + `${n}`,
      callback_data: `pc:${n}`,
    })));
  }
  rows.push([
    { text: (game.mode === 'classic' ? '✅ ' : '') + '🎯 Classic', callback_data: 'mode:classic' },
    { text: (game.mode === 'solo'    ? '✅ ' : '') + '🎯 Solo',    callback_data: 'mode:solo' },
  ]);
  rows.push([{ text: t(lang, 'beginGame'), callback_data: 'begin' }]);
  return { inline_keyboard: rows };
}

function lobbyPreviewCaption(game, lang) {
  const humans = game.players.filter(p => !p.isBot).length;
  const lines = [];
  lines.push(`<b>${t(lang, 'lobbyOpened')}</b>`);
  lines.push('');
  lines.push(`👥 ${t(lang, 'humans')}: <b>${humans} / ${game.maxPlayers}</b>`);
  lines.push(`🎯 ${t(lang, 'modeLabel')}: <b>${modeLabel(lang, game.mode)}</b>`);
  lines.push('');
  if (game.players.length) {
    lines.push(game.players.map(p => `${p.emoji} ${escapeHtml(p.name)}`).join('\n'));
  } else {
    lines.push('<i>—</i>');
  }
  lines.push('');
  lines.push(`${t(lang, 'othersJoin')}`);
  lines.push(`<i>${t(lang, 'lobbyNote')}</i>`);
  return lines.join('\n');
}

async function sendLobbyPreview(env, game, lang) {
  let png;
  try { png = await renderLobbyPreviewPng(game); }
  catch (e) { console.error('lobby preview render failed:', e && e.stack ? e.stack : e); return null; }

  try {
    return await sendBoardPhoto(env, game.chatId, png,
      lobbyPreviewCaption(game, lang),
      lobbyKeyboard(game, lang), lang);
  } catch (e) { console.error('sendLobbyPreview failed:', e && e.message); return null; }
}

async function updateLobbyPreview(env, game, lang, messageId) {
  if (!messageId) return null;
  let png;
  try { png = await renderLobbyPreviewPng(game); }
  catch (e) { console.error('lobby preview render failed:', e && e.stack ? e.stack : e); return null; }

  try {
    return await editBoardPhoto(env, game.chatId, messageId, png,
      lobbyPreviewCaption(game, lang),
      lobbyKeyboard(game, lang), lang);
  } catch (e) { console.error('updateLobbyPreview failed:', e && e.message); return null; }
}

/* ============================ GAME LOGIC ============================ */

function createGame(chatId, maxPlayers, hostUser, mode = 'classic') {
  const safeMode = GAME_MODES[mode] ? mode : 'classic';
  return {
    chatId, maxPlayers, mode: safeMode, phase: PHASE.LOBBY,
    createdAt: Date.now(), updatedAt: Date.now(),
    players: [], current: 0, dice: null, legalMoves: [],
    consecutiveSixes: 0, winners: [], turn: 1, log: [],
    avatars: {},
    diceLog: [],
    lastBoardAt: 0,
    lobbyMessageId: null,
  };
}

function addHuman(game, user) {
  game.players.push({
    index: game.players.length, userId: user.id, isBot: false,
    name: displayName(user), emoji: '',
    color: '', colorLight: '', colorStroke: '',
    pieces: new Array(piecesCount(game)).fill(-1),
  });
  reindexPlayers(game);
}

function addBot(game, name) {
  game.players.push({
    index: game.players.length, userId: null, isBot: true,
    name: name || 'Bot', emoji: '',
    color: '', colorLight: '', colorStroke: '',
    pieces: new Array(piecesCount(game)).fill(-1),
  });
  reindexPlayers(game);
}

function reindexPlayers(game) {
  const N = Math.max(game.players.length, 2);
  game.players.forEach((p, i) => {
    p.index = i;
    const pal = PLAYER_COLORS[i % PLAYER_COLORS.length];
    p.color = `hsl(${pal.h}, ${pal.s}%, ${pal.l}%)`;
    const lightSat = Math.max(pal.s * 0.6, 22);
    const lightLit = Math.max(pal.l * 0.32, 14);
    p.colorLight = `hsl(${pal.h}, ${lightSat}%, ${lightLit}%)`;
    const strokeSat = Math.max(pal.s * 0.85, 32);
    const strokeLit = Math.min(Math.max(pal.l * 0.8, 42), 70);
    p.colorStroke = `hsl(${pal.h}, ${strokeSat}%, ${strokeLit}%)`;
    p.emoji = PLAYER_EMOJIS[i % PLAYER_EMOJIS.length];
  });
}

function planBots(humanCount) {
  if (humanCount >= 3 && humanCount % 2 === 1) return [SPECIAL_BOT_NAME];
  if (humanCount < MIN_PLAYERS) {
    const count = MIN_PLAYERS - humanCount;
    const names = [];
    for (let i = 0; i < count; i++) names.push(BOT_NAMES[i % BOT_NAMES.length]);
    return names;
  }
  return [];
}

function trackLength(game) {
  return game.players.length * cellsPerPlayerFor(game.players.length);
}

function maxPos(game) {
  return trackLength(game) + homeCellsFor(game) - 1;
}

function cellOf(game, playerIndex, pos) {
  const L = trackLength(game);
  const cpp = cellsPerPlayerFor(game.players.length);
  return (playerIndex * cpp + pos) % L;
}

function piecesOnCell(game, cell) {
  const L = trackLength(game);
  const count = piecesCount(game);
  const out = [];
  for (const p of game.players) {
    for (let j = 0; j < count; j++) {
      const pos = p.pieces[j];
      if (pos >= 0 && pos < L && cellOf(game, p.index, pos) === cell) {
        out.push({ player: p.index, piece: j });
      }
    }
  }
  return out;
}

function hasWon(game, playerIdx) {
  const p = game.players[playerIdx];
  const L = trackLength(game);
  const MAX = maxPos(game);
  const count = piecesCount(game);

  if (count === 1) {
    // Solo: single piece must reach the (only) home cell.
    return p.pieces[0] === MAX;
  }
  // Classic: one piece per home cell.
  const hc = homeCellsFor(game);
  for (let h = 0; h < hc; h++) {
    if (!p.pieces.includes(L + h)) return false;
  }
  return true;
}

function legalMoves(game, playerIndex, dice) {
  const p = game.players[playerIndex];
  const L = trackLength(game);
  const MAX = maxPos(game);
  const count = piecesCount(game);
  const moves = [];

  for (let j = 0; j < count; j++) {
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
      // Each home cell holds exactly one of your own pieces.
      const clash = p.pieces.some((q, k) => k !== j && q === target);
      if (clash) continue;
      moves.push({ piece: j, from: pos, to: target });
    }
  }

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
  const player = game.players[game.current];
  const count = piecesCount(game);
  const events = [];
  const diceWasSix = game.dice === 6;

  player.pieces[pieceIndex] = move.to;
  events.push({ type: 'move', player: game.current, piece: pieceIndex, from: move.from, to: move.to });

  if (move.to < L) {
    const cell = cellOf(game, game.current, move.to);
    for (const other of game.players) {
      if (other.index === game.current) continue;
      for (let j = 0; j < count; j++) {
        const q = other.pieces[j];
        if (q >= 0 && q < L && cellOf(game, other.index, q) === cell) {
          other.pieces[j] = -1;
          events.push({ type: 'capture', player: other.index, piece: j, cell });
        }
      }
    }
  }

  if (move.from < L && move.to >= L) {
    events.push({ type: 'finish', player: game.current, piece: pieceIndex });
  }

  if (hasWon(game, game.current)) {
    game.winners.push(game.current);
    game.phase = PHASE.GAMEOVER;
    game.dice = null;
    game.legalMoves = [];
    events.push({ type: 'win', player: game.current });
    return events;
  }

  if (diceWasSix && RULES.extraTurnOnSix) {
    game.dice = null;
    game.legalMoves = [];
    game.phase = PHASE.ROLL;
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

function threatLevel(game, pos) {
  const L = trackLength(game);
  if (pos < 0 || pos >= L) return 0;
  const ourCell = cellOf(game, game.current, pos);
  const count = piecesCount(game);
  let threats = 0;
  for (const other of game.players) {
    if (other.index === game.current) continue;
    for (let j = 0; j < count; j++) {
      const op = other.pieces[j];
      if (op < 0 || op >= L) continue;
      const opCell = cellOf(game, other.index, op);
      const diff = (ourCell - opCell + L) % L;
      if (diff >= 1 && diff <= 6) threats++;
    }
  }
  return threats;
}

function evaluateMove(game, move) {
  const L = trackLength(game);
  const MAX = maxPos(game);
  const player = game.players[game.current];
  let score = 0;
  const isBringOut = move.from === -1;
  const outCount = player.pieces.filter(p => p >= 0).length;

  if (move.to >= L) score += 2500;
  if (move.to === MAX) score += 5000;

  if (move.to < L) {
    const cell = cellOf(game, game.current, move.to);
    const occ = piecesOnCell(game, cell);
    for (const o of occ) {
      if (o.player === game.current) continue;
      const victimPos = game.players[o.player].pieces[o.piece];
      score += 3000 + victimPos * 5;
    }
  }

  if (isBringOut) {
    if (outCount === 0) score += 4000;
    else if (outCount === 1) score += 1500;
    else if (outCount === 2) score += 800;
    else if (outCount === 3) score += 400;

    const startCell = cellOf(game, game.current, 0);
    const occ = piecesOnCell(game, startCell);
    const enemies = occ.filter(o => o.player !== game.current).length;
    score += enemies * 3000;
  }

  if (!isBringOut) {
    score += move.to * 10;
    if (move.from >= L) score += 500 + (move.from - L) * 200;
    const dangerFrom = threatLevel(game, move.from);
    const dangerTo = move.to < L ? threatLevel(game, move.to) : 0;
    score += (dangerFrom - dangerTo) * 200;
  }

  score += Math.random() * 20;
  return score;
}

function chooseBotMove(game, moves) {
  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    const s = evaluateMove(game, m);
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return best;
}

/* ============================ BOARD RENDERER ============================ */

function renderBoardSVG(game, size = 1000, lloydImg = null) {
  const N = game.players.length;
  const L = trackLength(game);
  const count = piecesCount(game);
  const homeCells = homeCellsFor(game);
  const cx = size / 2;
  const cy = size / 2;
  const R_TRACK = 330, R_YARD = 430, R_HOME_INNER = 80;
  const cellW = Math.min(30, ((2 * Math.PI * R_TRACK) / L) * 0.85);
  const cellH = Math.min(28, cellW * 1.5);
  const yardR = Math.max(26, 70 - N * 1.5);
  const pieceR = Math.max(7, yardR * 0.28);
  const slot = yardR * 0.45;
  const homeStart = R_TRACK - cellH * 1.5;
  const f = n => Number(n).toFixed(2);
  const out = [];

  /* Home cell layout. In solo there's only one cell — place it
     centered in the empty span between track and center; in classic
     the four cells are laid out as a normal column. */
  const homeSpan = homeStart - R_HOME_INNER;
  let homeSeg;
  let homePositions;
  if (homeCells === 1) {
    homeSeg = Math.min(homeSpan, cellH * 3);
    homePositions = [(homeStart + R_HOME_INNER) / 2];
  } else {
    homeSeg = homeSpan / homeCells;
    homePositions = [];
    for (let j = 0; j < homeCells; j++) {
      homePositions.push(homeStart - (j + 0.5) * homeSeg);
    }
  }

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`);
  out.push(`<rect width="${size}" height="${size}" fill="${PALETTE.bg}"/>`);
  out.push(`<circle cx="${cx}" cy="${cy}" r="490" fill="none" stroke="${PALETTE.cellStroke}" stroke-width="1" opacity="0.3"/>`);

  {
    const arrowR = R_TRACK - cellH;
    const aStart = -Math.PI / 2 + 0.20 * Math.PI;
    const aEnd = -Math.PI / 2 + 1.80 * Math.PI;
    const ax1 = cx + arrowR * Math.cos(aStart);
    const ay1 = cy + arrowR * Math.sin(aStart);
    const ax2 = cx + arrowR * Math.cos(aEnd);
    const ay2 = cy + arrowR * Math.sin(aEnd);
    const strokeW = Math.max(2, cellH * 0.12);
    const dashLen = Math.max(6, cellH * 0.4);
    const gapLen = Math.max(5, cellH * 0.3);
    out.push(`<path d="M ${f(ax1)} ${f(ay1)} A ${f(arrowR)} ${f(arrowR)} 0 1 1 ${f(ax2)} ${f(ay2)}" fill="none" stroke="${PALETTE.arrow}" stroke-width="${f(strokeW)}" stroke-dasharray="${f(dashLen)} ${f(gapLen)}" stroke-linecap="round" opacity="0.6"/>`);
    const tx = -Math.sin(aEnd), ty = Math.cos(aEnd);
    const nx = Math.cos(aEnd), ny = Math.sin(aEnd);
    const arrLen = Math.max(14, cellH * 0.85);
    const arrW = Math.max(10, cellH * 0.65);
    const p2x = ax2 - tx * arrLen + nx * (arrW / 2), p2y = ay2 - ty * arrLen + ny * (arrW / 2);
    const p3x = ax2 - tx * arrLen - nx * (arrW / 2), p3y = ay2 - ty * arrLen - ny * (arrW / 2);
    out.push(`<polygon points="${f(ax2)},${f(ay2)} ${f(p2x)},${f(p2y)} ${f(p3x)},${f(p3y)}" fill="${PALETTE.arrow}" opacity="0.85"/>`);
    const chevrons = 4;
    for (let c = 0; c < chevrons; c++) {
      const a = aStart + ((aEnd - aStart) * (c + 0.5)) / chevrons;
      const px = cx + arrowR * Math.cos(a);
      const py = cy + arrowR * Math.sin(a);
      const cTx = -Math.sin(a), cTy = Math.cos(a);
      const cNx = Math.cos(a), cNy = Math.sin(a);
      const l = arrLen * 0.55, w = arrW * 0.5;
      const q1x = px + cTx * l * 0.5, q1y = py + cTy * l * 0.5;
      const q2x = px - cTx * l * 0.5 + cNx * w, q2y = py - cTy * l * 0.5 + cNy * w;
      const q3x = px - cTx * l * 0.5 - cNx * w, q3y = py - cTy * l * 0.5 - cNy * w;
      out.push(`<polygon points="${f(q1x)},${f(q1y)} ${f(q2x)},${f(q2y)} ${f(q3x)},${f(q3y)}" fill="${PALETTE.arrow}" opacity="0.4"/>`);
    }
  }

  out.push(`<circle cx="${cx}" cy="${cy}" r="72" fill="${PALETTE.homeOuter}" stroke="${PALETTE.homeStroke}" stroke-width="3"/>`);
  out.push(`<circle cx="${cx}" cy="${cy}" r="42" fill="${PALETTE.homeMid}" stroke="${PALETTE.homeStroke}" stroke-width="2"/>`);
  out.push(`<circle cx="${cx}" cy="${cy}" r="18" fill="${PALETTE.homeInner}"/>`);

  for (let k = 0; k < L; k++) {
    const a = (k / L) * 2 * Math.PI - Math.PI / 2;
    const x = cx + R_TRACK * Math.cos(a);
    const y = cy + R_TRACK * Math.sin(a);
    const rot = (a * 180) / Math.PI + 90;
    out.push(`<rect x="${f(x - cellW / 2)}" y="${f(y - cellH / 2)}" width="${f(cellW)}" height="${f(cellH)}" rx="${f(cellH * 0.3)}" fill="${PALETTE.cellFill}" stroke="${PALETTE.cellStroke}" stroke-width="1" transform="rotate(${f(rot)} ${f(x)} ${f(y)})"/>`);
  }

  const slots = count === 1 ? [[0, 0]] : [[-slot, -slot], [slot, -slot], [-slot, slot], [slot, slot]];
  const badgeR = yardR * 0.32;

  const trackOuter = R_TRACK + cellH * 0.5;
  const yardInner  = R_YARD - yardR;
  const nameR = Math.max(trackOuter + 4, (trackOuter + yardInner) / 2);
  const radialBand = Math.max(8, yardInner - trackOuter);
  const nameMaxH = radialBand * 0.9;

  const avatarR = yardR * 0.96;

  const clipDefs = [];
  for (const p of game.players) {
    const i = p.index;
    const a = (i / N) * 2 * Math.PI - Math.PI / 2;
    const yx = cx + R_YARD * Math.cos(a);
    const yy = cy + R_YARD * Math.sin(a);
    const uri = avatarUriFor(game, p, lloydImg);
    if (uri) {
      clipDefs.push(`<clipPath id="avClip${i}"><circle cx="${f(yx)}" cy="${f(yy)}" r="${f(avatarR)}"/></clipPath>`);
    }
  }
  if (clipDefs.length) out.push(`<defs>${clipDefs.join('')}</defs>`);

  for (const p of game.players) {
    const i = p.index;
    const a = (i / N) * 2 * Math.PI - Math.PI / 2;

    for (let j = 0; j < homeCells; j++) {
      const r = homePositions[j];
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      const rot = (a * 180) / Math.PI - 90;
      const w = Math.max(10, cellW * 0.8);
      const h = homeCells === 1 ? homeSeg * 0.5 : homeSeg * 0.78;
      out.push(`<rect x="${f(x - w / 2)}" y="${f(y - h / 2)}" width="${f(w)}" height="${f(h)}" rx="${f(w * 0.25)}" fill="${p.colorLight}" stroke="${p.colorStroke}" stroke-width="1.5" transform="rotate(${f(rot)} ${f(x)} ${f(y)})"/>`);
    }

    const yx = cx + R_YARD * Math.cos(a);
    const yy = cy + R_YARD * Math.sin(a);
    const isCurrent = game.current === i && game.phase !== PHASE.GAMEOVER && game.phase !== PHASE.LOBBY;

    out.push(`<circle cx="${f(yx)}" cy="${f(yy)}" r="${f(yardR)}" fill="${p.colorLight}" stroke="${p.colorStroke}" stroke-width="3"/>`);

    const uri = avatarUriFor(game, p, lloydImg);
    if (uri) {
      out.push(`<image href="${uri}" xlink:href="${uri}" x="${f(yx - avatarR)}" y="${f(yy - avatarR)}" width="${f(avatarR * 2)}" height="${f(avatarR * 2)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#avClip${i})"/>`);
      out.push(`<circle cx="${f(yx)}" cy="${f(yy)}" r="${f(avatarR)}" fill="none" stroke="${p.color}" stroke-width="3"/>`);
    }

    if (isCurrent) {
      out.push(`<circle cx="${f(yx)}" cy="${f(yy)}" r="${f(yardR + 4)}" fill="none" stroke="${PALETTE.flash1}" stroke-width="3" opacity="1"/>`);
      out.push(`<circle cx="${f(yx)}" cy="${f(yy)}" r="${f(yardR + 12)}" fill="none" stroke="${PALETTE.flash1}" stroke-width="2.5" opacity="0.6"/>`);
      out.push(`<circle cx="${f(yx)}" cy="${f(yy)}" r="${f(yardR + 22)}" fill="none" stroke="${PALETTE.flash2}" stroke-width="2" stroke-dasharray="6 6" opacity="0.4"/>`);
    }

    const badgeRSize = uri ? badgeR * 0.72 : badgeR;
    const badgeOpacity = uri ? 0.85 : (isCurrent ? 1 : 0.85);
    out.push(`<circle cx="${f(yx)}" cy="${f(yy)}" r="${f(badgeRSize)}" fill="${PALETTE.badge}" stroke="${PALETTE.flash1}" stroke-width="${isCurrent ? 2.5 : 1.5}" opacity="${badgeOpacity}"/>`);
    out.push(bitmapNumber(i + 1, yx, yy, badgeRSize * 1.3, badgeRSize * 1.3, PALETTE.badgeText));

    {
      const nx = cx + nameR * Math.cos(a);
      const ny = cy + nameR * Math.sin(a);

      let rot = a * 180 / Math.PI + 90;
      while (rot > 180) rot -= 360;
      while (rot <= -180) rot += 360;
      if (rot > 90) rot -= 180;
      else if (rot <= -90) rot += 180;

      const tangential = (2 * Math.PI * nameR) / N;
      const nameMaxW = Math.max(40, tangential * 0.82);

      if (p.isPlaceholder) {
        const svg = bitmapString('-', nx, ny, nameMaxW * 0.35, nameMaxH, '#475569', rot);
        if (svg) out.push(svg);
      } else {
        const short = truncateForRing(p.name, N);
        let svg = bitmapString(short, nx, ny, nameMaxW, nameMaxH, p.color, rot);
        if (!svg) {
          svg = bitmapString('P' + (i + 1), nx, ny, nameMaxW, nameMaxH, p.color, rot);
        }
        if (svg) out.push(svg);
      }
    }

    for (let j = 0; j < count; j++) {
      const pos = p.pieces[j];
      let x, y;
      if (pos === -1) { x = yx + slots[j][0]; y = yy + slots[j][1]; }
      else if (pos < L) {
        const cell = cellOf(game, i, pos);
        const ca = (cell / L) * 2 * Math.PI - Math.PI / 2;
        x = cx + R_TRACK * Math.cos(ca);
        y = cy + R_TRACK * Math.sin(ca);
      } else {
        const jj = pos - L;
        const r = homePositions[jj];
        x = cx + r * Math.cos(a);
        y = cy + r * Math.sin(a);
      }

      const movable = game.phase === PHASE.MOVE && game.current === i && game.legalMoves.some(m => m.piece === j);
      if (movable) {
        out.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(pieceR + 9)}" fill="${PALETTE.halo}" opacity="0.18"/>`);
        out.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(pieceR + 6)}" fill="none" stroke="${PALETTE.halo}" stroke-width="2.5" stroke-dasharray="5 4"/>`);
      }
      out.push(`<circle cx="${f(x)}" cy="${f(y + pieceR * 0.32)}" r="${f(pieceR)}" fill="${PALETTE.shadow}" opacity="0.55"/>`);
      out.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(pieceR)}" fill="${p.color}" stroke="${movable ? PALETTE.movableEdge : PALETTE.pieceTop}" stroke-width="${movable ? 3 : 2}"/>`);
      out.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(pieceR * 0.72)}" fill="${PALETTE.pieceNumBg}" opacity="0.82"/>`);
      out.push(bitmapNumber(j + 1, x, y, pieceR * 1.15, pieceR * 1.15, PALETTE.pieceNum));
      if (p.isBot) {
        out.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(pieceR * 0.92)}" fill="none" stroke="${PALETTE.pieceTop}" stroke-width="1" stroke-dasharray="3 3" opacity="0.85"/>`);
      }
    }
  }

  out.push(`</svg>`);
  return out.join('');
}

/* ============================ BUTTON LABELS ============================ */

function moveLabel(game, move, lang) {
  const L = trackLength(game);
  const from = move.from === -1 ? t(lang, 'yardWord')
             : move.from < L ? `${move.from + 1}`
             : `${move.from - L + 1}`;
  const to = move.to < L ? `${move.to + 1}`
           : `${move.to - L + 1}`;
  const prefix = move.from === -1 ? '🆕' : '➡️';
  return `${prefix} ${t(lang, 'pieceWord')} ${move.piece + 1}: ${from} → ${to}`;
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
      const game = await this.load();
      return new Response(JSON.stringify(game), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/update' && request.method === 'POST') {
      const workerUrl = request.headers.get('X-Worker-Url') || '';
      let update;
      try { update = await request.json(); }
      catch (e) { return jsonResponse({ botsRemaining: 0 }); }

      let result = { botsRemaining: 0 };
      const prev = this.lock;
      const next = prev.then(async () => {
        try { result = await this.handleUpdate(update, workerUrl); }
        catch (e) { console.error('Update handler failed:', e && e.stack ? e.stack : e); }
      });
      this.lock = next;
      await next;
      return jsonResponse(result);
    }

    if (url.pathname === '/bot-tick' && request.method === 'POST') {
      let result = { botsRemaining: 0 };
      const prev = this.lock;
      const next = prev.then(async () => {
        try { result = await this.runBotTick(); }
        catch (e) { console.error('Bot tick failed:', e && e.stack ? e.stack : e); }
      });
      this.lock = next;
      await next;
      return jsonResponse(result);
    }

    return new Response('Not found', { status: 404 });
  }

  async load() {
    const enc = await this.state.storage.get('game');
    if (!enc) return null;
    try { return decryptData(this.env, enc); }
    catch (e) { console.error('Failed to decrypt game state:', e && e.message); return null; }
  }

  async save(game) {
    if (game === null) { await this.state.storage.delete('game'); return; }
    if (!game) return;
    game.updatedAt = Date.now();
    try { await this.state.storage.put('game', encryptData(this.env, game)); }
    catch (e) { console.error('Failed to encrypt game state:', e && e.message); }
  }

  async handleUpdate(update, workerUrl) {
    const sender = update.message?.from || update.edited_message?.from || update.callback_query?.from;
    if (sender && sender.is_bot) return { botsRemaining: 0 };

    const game = await this.load();
    const chatId = extractChatId(update);
    const lang = chatId ? await getChatLang(this.env, chatId) : DEFAULT_LANG;

    const maybeDice = update.message;
    if (maybeDice && maybeDice.dice && isForwardedMessage(maybeDice)) {
      if (game && game.phase === PHASE.ROLL) {
        const cur = game.players[game.current];
        if (cur && !cur.isBot && cur.userId === maybeDice.from?.id) {
          try {
            await sendMessage(this.env, chatId, t(lang, 'noForwardDice'), {}, lang);
          } catch (e) { /* silent */ }
        }
      }
      return { botsRemaining: 0 };
    }

    let next;
    if (update.callback_query) {
      try { next = await this.onCallback(update.callback_query, game, workerUrl, lang); }
      catch (e) { console.error('Callback failed:', e && e.stack ? e.stack : e); }
    } else if (update.message?.dice) {
      try { next = await this.onDice(update.message, game, workerUrl, lang); }
      catch (e) { console.error('Dice failed:', e && e.stack ? e.stack : e); }
    } else if (update.message?.text === '🎲' || update.message?.text === '🎲\uFE0F') {
      if (game && game.phase === PHASE.ROLL) {
        const cur = game.players[game.current];
        if (cur && !cur.isBot && cur.userId === update.message.from.id) {
          try {
            await sendMessage(this.env, update.message.chat.id,
              `⚠️ ${t(lang, 'useRealDice')}`, {}, lang);
          } catch (e) { /* silent */ }
        }
      }
      return { botsRemaining: 0 };
    } else if (update.message?.text?.startsWith('/')) {
      try { next = await this.onCommand(update.message, game, workerUrl, lang); }
      catch (e) {
        console.error('Command failed:', e && e.stack ? e.stack : e);
        await sendMessage(this.env, update.message.chat.id,
          `⚠️ <b>${t(lang, 'internalError')}</b>\n<code>${escapeHtml(e.message || String(e))}</code>`,
          {}, lang);
        return { botsRemaining: 0 };
      }
    } else {
      return { botsRemaining: 0 };
    }

    if (next === SAVED_SENTINEL) {
      if (game) await this.save(game);
    } else {
      await this.save(next === undefined ? game : next);
    }

    return await this.botsRemainingCheck();
  }

  async runBotTick() {
    const game = await this.load();
    if (!game) return { botsRemaining: 0 };
    if (game.phase === PHASE.GAMEOVER || game.phase === PHASE.LOBBY) {
      return { botsRemaining: 0 };
    }
    const cur = game.players[game.current];
    if (!cur || !cur.isBot) return { botsRemaining: 0 };

    const lang = await getChatLang(this.env, game.chatId);

    try { await this.runBotTurn(game, '', lang); }
    catch (e) { console.error('runBotTurn failed:', e && e.stack ? e.stack : e); }

    await this.save(game);
    return await this.botsRemainingCheck();
  }

  async botsRemainingCheck() {
    const game = await this.load();
    if (!game) return { botsRemaining: 0 };
    if (game.phase === PHASE.GAMEOVER || game.phase === PHASE.LOBBY) {
      return { botsRemaining: 0 };
    }
    const cur = game.players[game.current];
    return { botsRemaining: (cur && cur.isBot) ? 1 : 0 };
  }

  async onCommand(msg, game, workerUrl, lang) {
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
          `<b>${t(lang, 'helpTitle')}</b>\n\n` +
          `<b>${t(lang, 'helpCommands')}</b>\n` +
          `${t(lang, 'helpNew')}\n${t(lang, 'helpJoin')}\n${t(lang, 'helpLeave')}\n` +
          `${t(lang, 'helpBegin')}\n${t(lang, 'helpBoard')}\n${t(lang, 'helpState')}\n` +
          `${t(lang, 'helpEnd')}\n${t(lang, 'helpLanguage')}\n${t(lang, 'helpDebug')}\n\n` +
          `<b>${t(lang, 'helpPlayerCount')}</b>\n${t(lang, 'helpPlayerCountDesc')}\n\n` +
          `<b>${t(lang, 'helpModes')}</b>\n${t(lang, 'helpModesDesc')}\n\n` +
          `<b>${t(lang, 'helpHowToPlay')}</b>\n${t(lang, 'helpHowToPlayDesc')}`,
          {}, lang);
        return undefined;
      }

      case '/language':
      case '/lang': {
        await sendMessage(env, chatId,
          `${t(lang, 'langTitle')}\n<i>${t(lang, 'langCurrent')}</i>`,
          { reply_markup: { inline_keyboard: [[
            { text: '🇮🇷 فارسی', callback_data: 'lang:fa' },
            { text: '🇬🇧 English', callback_data: 'lang:en' },
          ]] } },
          lang);
        return undefined;
      }

      case '/debug': {
        await this.sendDebug(env, chatId, game, lang);
        return undefined;
      }

      case '/new': {
        if (isPrivate) { await sendMessage(env, chatId, t(lang, 'groupOnly'), {}, lang); return undefined; }
        if (game && game.phase !== PHASE.GAMEOVER) { await sendMessage(env, chatId, t(lang, 'gameInProgress'), {}, lang); return undefined; }

        const newGame = createGame(chatId, DEFAULT_PLAYERS, user, 'classic');
        addHuman(newGame, user);

        const sent = await sendLobbyPreview(env, newGame, lang);
        if (sent && sent.ok && sent.result) {
          newGame.lobbyMessageId = sent.result.message_id;
        }
        return newGame;
      }

      case '/join': {
        if (!game || game.phase !== PHASE.LOBBY) { await sendMessage(env, chatId, t(lang, 'noLobby'), {}, lang); return undefined; }
        if (game.players.some(p => !p.isBot && p.userId === userId)) { await sendMessage(env, chatId, t(lang, 'alreadyJoined'), {}, lang); return undefined; }
        const humanCount = game.players.filter(p => !p.isBot).length;
        if (humanCount >= game.maxPlayers) { await sendMessage(env, chatId, t(lang, 'lobbyFull'), {}, lang); return undefined; }
        addHuman(game, user);
        await sendMessage(env, chatId,
          `✅ <b>${escapeHtml(displayName(user))}</b> ${t(lang, 'joinSuccess')}\n` +
          `👥 ${t(lang, 'humans')}: <b>${game.players.filter(p => !p.isBot).length} / ${game.maxPlayers}</b>`,
          {}, lang);
        if (game.lobbyMessageId) {
          try { await updateLobbyPreview(env, game, lang, game.lobbyMessageId); }
          catch (e) { console.error('lobby refresh failed:', e && e.message); }
        }
        return game;
      }

      case '/leave': {
        if (!game || game.phase !== PHASE.LOBBY) { await sendMessage(env, chatId, t(lang, 'noLobby'), {}, lang); return undefined; }
        const idx = game.players.findIndex(p => !p.isBot && p.userId === userId);
        if (idx < 0) { await sendMessage(env, chatId, t(lang, 'noGameHere'), {}, lang); return undefined; }
        if (idx === 0) { await sendMessage(env, chatId, t(lang, 'hostCannotLeave'), {}, lang); return undefined; }
        const removed = game.players.splice(idx, 1)[0];
        reindexPlayers(game);
        await sendMessage(env, chatId,
          `👋 <b>${escapeHtml(removed.name)}</b> ${t(lang, 'leftGame')}\n` +
          `👥 ${t(lang, 'humans')}: <b>${game.players.filter(p => !p.isBot).length} / ${game.maxPlayers}</b>`,
          {}, lang);
        if (game.lobbyMessageId) {
          try { await updateLobbyPreview(env, game, lang, game.lobbyMessageId); }
          catch (e) { console.error('lobby refresh failed:', e && e.message); }
        }
        return game;
      }

      case '/begin': {
        if (!game || game.phase !== PHASE.LOBBY) { await sendMessage(env, chatId, t(lang, 'noLobby'), {}, lang); return undefined; }
        if (game.players[0].userId !== userId) { await sendMessage(env, chatId, t(lang, 'onlyHostStart'), {}, lang); return undefined; }
        if (game.lobbyMessageId) await safeClearKeyboard(env, chatId, game.lobbyMessageId);
        return await this.startGame(game, lang);
      }

      case '/board': {
        if (!game) { await sendMessage(env, chatId, t(lang, 'noGameHere'), {}, lang); return undefined; }
        await sendBoard(env, game, lang);
        return undefined;
      }

      case '/state': {
        if (!game) { await sendMessage(env, chatId, t(lang, 'noGameHere'), {}, lang); return undefined; }
        await this.sendStatus(game, lang);
        return undefined;
      }

      case '/end': {
        if (!game) { await sendMessage(env, chatId, t(lang, 'noGameToEnd'), {}, lang); return undefined; }
        await sendMessage(env, chatId, t(lang, 'gameEnded'),
          { reply_markup: removeReplyKeyboard() }, lang);
        return null;
      }

      default: return undefined;
    }
  }

  async sendDebug(env, chatId, game, lang) {
    const ok = t(lang, 'debugOk');
    const miss = t(lang, 'debugMissing');

    let tgLine = miss;
    let botName = '—';
    const token = env.BOT_TOKEN || '';
    if (token) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
        const j = await r.json();
        if (j && j.ok) { tgLine = ok; botName = '@' + (j.result.username || '?'); }
      } catch (e) { /* silent */ }
    }

    let resvgLine = miss;
    try { await ensureResvg(); resvgLine = ok; } catch (e) { /* silent */ }

    let lloydLine = miss;
    try { const img = await ensureLloydImage(env); if (img) lloydLine = ok; } catch (e) { /* silent */ }

    const lines = [];
    lines.push(`<b>${t(lang, 'debugTitle')}</b>`);
    lines.push('');
    lines.push(`<b>${t(lang, 'debugWorker')}</b>`);
    lines.push(`• ${t(lang, 'debugToken')}: ${token ? ok : miss}`);
    lines.push(`• ${t(lang, 'debugKV')}: ${env.BOT_KV ? ok : miss}`);
    lines.push(`• ${t(lang, 'debugDO')}: ${env.GAME_ROOM ? ok : miss}`);
    lines.push(`• ${t(lang, 'debugEnc')}: ${env.DB_ENCRYPTION_KEY ? ok : miss}`);
    lines.push(`• ${t(lang, 'debugResvg')}: ${resvgLine}`);
    lines.push(`• ${t(lang, 'debugLloyd')}: ${lloydLine}`);
    lines.push(`• ${t(lang, 'debugTelegram')}: ${tgLine}`);
    lines.push(`• ${t(lang, 'debugBot')}: <code>${escapeHtml(botName)}</code>`);
    lines.push('');
    lines.push(`<b>${t(lang, 'debugChat')}</b>`);
    lines.push(`• ID: <code>${chatId}</code>`);
    lines.push(`• ${t(lang, 'debugLang')}: <code>${lang}</code>`);
    lines.push('');
    lines.push(`<b>${t(lang, 'debugGame')}</b>`);

    if (!game) {
      lines.push(`<i>${t(lang, 'debugNoGame')}</i>`);
    } else {
      const humanCount = game.players.filter(p => !p.isBot).length;
      const botCount = game.players.filter(p => p.isBot).length;
      const cur = game.players[game.current];

      lines.push(`• ${t(lang, 'debugPhase')}: <code>${game.phase}</code>`);
      lines.push(`• ${t(lang, 'debugMode')}: <code>${game.mode}</code>`);
      lines.push(`• ${t(lang, 'debugTurnNumber')}: <code>${game.turn}</code>`);
      lines.push(`• ${t(lang, 'debugCurrent')}: ${cur ? mentionFor(cur) : '—'}`);
      lines.push(`• ${t(lang, 'debugPlayers')}: <b>${game.players.length}</b> (👤 ${humanCount}, 🤖 ${botCount})`);
      lines.push(`• ${t(lang, 'debugPiecesPerPlayer')}: <code>${piecesCount(game)}</code>`);
      lines.push(`• ${t(lang, 'debugHomeCells')}: <code>${homeCellsFor(game)}</code>`);
      lines.push(`• ${t(lang, 'debugCellsPerPlayer')}: <code>${cellsPerPlayerFor(game.players.length)}</code>`);
      lines.push(`• ${t(lang, 'debugTrackCells')}: <code>${trackLength(game)}</code>`);

      lines.push('');
      lines.push(`<b>🖼 ${t(lang, 'debugAvatars')}</b>`);

      const avatarsObj = game.avatars || {};
      if (humanCount === 0) {
        lines.push('—');
      } else {
        for (const p of game.players) {
          if (p.isBot) continue;
          const uid = p.userId;
          const entry = avatarsObj[uid];
          let status;
          if (entry === undefined) status = t(lang, 'debugAvatarNotFetched');
          else if (entry === null) status = t(lang, 'debugAvatarNoPhoto');
          else status = `✅ ${Math.round(entry.length / 1024)} KB`;

          const reason = entry === null
            ? ' ' + t(lang, 'debugAvatarNoPhotoReason')
            : '';

          lines.push(`• ${p.emoji} ${escapeHtml(p.name)} <code>${uid}</code>`);
          lines.push(`  → ${status}${reason}`);
        }
      }

      if (game.diceLog && game.diceLog.length) {
        lines.push('');
        const recent = game.diceLog.slice(-10).map(e => `${e.player}:${e.dice}`).join('  ');
        lines.push(`• ${t(lang, 'debugLogRecent')}: <code>${escapeHtml(recent)}</code>`);
      }
    }

    try {
      await sendMessage(env, chatId, lines.join('\n'), {}, lang);
    } catch (e) { console.error('sendDebug failed:', e && e.message); }
  }

  async onCallback(cq, game, workerUrl, lang) {
    const env = this.env;
    const chatId = cq.message?.chat?.id;
    const userId = cq.from?.id;
    const data = cq.data || '';
    const msgId = cq.message?.message_id;

    if (data === 'lang:fa' || data === 'lang:en') {
      const newLang = data.slice(5);
      if (chatId) {
        await setChatLang(env, chatId, newLang);
        await safeClearKeyboard(env, chatId, msgId);
        await sendMessage(env, chatId, t(newLang, 'langSet'), {}, newLang);
      }
      return undefined;
    }

    if (data.startsWith('pc:') || data.startsWith('mode:')) {
      if (!game || game.phase !== PHASE.LOBBY) return undefined;
      if (game.players[0].userId !== userId) {
        try { await sendMessage(env, chatId, t(lang, 'lobbyNotHost'), {}, lang); }
        catch (e) { /* silent */ }
        return undefined;
      }

      if (data.startsWith('pc:')) {
        const n = parseInt(data.slice(3), 10);
        if (!Number.isInteger(n) || n < MIN_PLAYERS || n > MAX_HUMANS) return undefined;
        const humanCount = game.players.filter(p => !p.isBot).length;
        if (humanCount > n) return undefined;
        game.maxPlayers = n;
      } else {
        const mode = data.slice(5);
        if (!GAME_MODES[mode]) return undefined;
        if (game.mode !== mode) {
          game.mode = mode;
          resetPiecesForMode(game);
        }
      }

      await this.save(game);
      try { await updateLobbyPreview(env, game, lang, msgId); }
      catch (e) { console.error('updateLobbyPreview failed:', e && e.message); }
      return SAVED_SENTINEL;
    }

    if (data === 'begin') {
      if (!game || game.phase !== PHASE.LOBBY) return undefined;
      if (game.players[0].userId !== userId) return undefined;
      await safeClearKeyboard(env, chatId, msgId);
      return await this.startGame(game, lang);
    }

    if (data.startsWith('mv:')) {
      const piece = parseInt(data.slice(3), 10);

      if (!game) return undefined;
      if (game.phase !== PHASE.MOVE) return undefined;
      if (game.players[game.current].userId !== userId) return undefined;
      const move = game.legalMoves.find(m => m.piece === piece);
      if (!move) return undefined;

      const mover = game.players[game.current];
      let events;
      try { events = applyMove(game, piece); }
      catch (e) { console.error('applyMove failed:', e && e.stack ? e.stack : e); return undefined; }
      await this.save(game);

      await safeClearKeyboard(env, chatId, msgId);

      const prefix = buildMoveReport(game, mover, move, events, lang);
      await sendBoard(env, game, lang, prefix);
      return SAVED_SENTINEL;
    }

    return undefined;
  }

  async startGame(game, lang) {
    const env = this.env;
    const chatId = game.chatId;

    const humanCount = game.players.filter(p => !p.isBot).length;
    const botNames = planBots(humanCount);
    for (const n of botNames) addBot(game, n);

    const botCount = game.players.filter(p => p.isBot).length;
    const total = game.players.length;

    game.phase = PHASE.ROLL;
    game.current = 0;
    game.turn = 1;
    game.consecutiveSixes = 0;
    game.dice = null;
    game.legalMoves = [];

    try { await ensureAvatarsInGame(env, game); }
    catch (e) { console.error('ensureAvatarsInGame failed:', e && e.message); }

    let prefix = `<b>${t(lang, 'gameBegins')}</b>\n`;
    prefix += `🎯 ${t(lang, 'modeLabel')}: <b>${modeLabel(lang, game.mode)}</b>\n`;
    prefix += `👥 ${t(lang, 'board')}: <b>${total} ${t(lang, 'players')}</b> · 👤 ${t(lang, 'humans')}: <b>${humanCount}</b>`;
    if (botCount > 0) prefix += ` · 🤖 ${t(lang, 'bot')}: <b>${botCount}</b>`;

    await this.save(game);
    await sendBoard(env, game, lang, prefix);
    return game;
  }

  async onDice(msg, game, workerUrl, lang) {
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
    if (dice === 6) game.consecutiveSixes++;
    else game.consecutiveSixes = 0;

    if (!Array.isArray(game.diceLog)) game.diceLog = [];
    game.diceLog.push({ player: currentPlayer.name, dice, at: Date.now() });
    if (game.diceLog.length > 200) game.diceLog.shift();

    if (RULES.threeSixesLoseTurn && game.consecutiveSixes >= 3) {
      const prefix = `🎲 <b>${escapeHtml(currentPlayer.name)}</b> ${t(lang, 'threeSixes')}`;
      advanceTurn(game);
      await this.save(game);
      await sendBoard(env, game, lang, prefix);
      return SAVED_SENTINEL;
    }

    const moves = legalMoves(game, game.current, dice);
    if (moves.length === 0) {
      const prefix = `🎲 <b>${escapeHtml(currentPlayer.name)}</b> ${rolledText(lang, dice)} — ${t(lang, 'noLegalMoves')}`;
      advanceTurn(game);
      await this.save(game);
      await sendBoard(env, game, lang, prefix);
      return SAVED_SENTINEL;
    }

    game.dice = dice;
    game.legalMoves = moves;
    game.phase = PHASE.MOVE;
    await this.save(game);

    await sendBoard(env, game, lang);
    return game;
  }

  async runBotTurn(game, workerUrl, lang) {
    const env = this.env;
    const chatId = game.chatId;
    const bot = game.players[game.current];

    let dice;
    try {
      const diceRes = await tg(env, 'sendDice', { chat_id: chatId, emoji: '🎲' });
      if (diceRes && diceRes.ok && diceRes.result && diceRes.result.dice) {
        dice = diceRes.result.dice.value;
      }
    } catch (e) { console.error('bot sendDice failed:', e && e.message); }
    if (typeof dice !== 'number') dice = 1 + Math.floor(Math.random() * 6);

    if (dice === 6) game.consecutiveSixes++;
    else game.consecutiveSixes = 0;

    if (!Array.isArray(game.diceLog)) game.diceLog = [];
    game.diceLog.push({ player: bot.name, dice, at: Date.now() });
    if (game.diceLog.length > 200) game.diceLog.shift();

    if (RULES.threeSixesLoseTurn && game.consecutiveSixes >= 3) {
      const prefix = `🎲 <b>${escapeHtml(bot.name)}</b> ${t(lang, 'threeSixes')}`;
      advanceTurn(game);
      await this.save(game);
      await sendBoard(env, game, lang, prefix);
      return;
    }

    const moves = legalMoves(game, game.current, dice);
    if (moves.length === 0) {
      const prefix = `🎲 <b>${escapeHtml(bot.name)}</b> ${rolledText(lang, dice)} — ${t(lang, 'noLegalMoves')}`;
      advanceTurn(game);
      await this.save(game);
      await sendBoard(env, game, lang, prefix);
      return;
    }

    game.dice = dice;
    game.legalMoves = moves;
    game.phase = PHASE.MOVE;

    const chosen = chooseBotMove(game, moves);
    const events = applyMove(game, chosen.piece);
    await this.save(game);

    const prefix = buildMoveReport(game, bot, chosen, events, lang);
    await sendBoard(env, game, lang, prefix);
  }

  async sendStatus(game, lang) {
    const env = this.env;
    const player = game.players[game.current];
    let text = '';
    if (game.phase === PHASE.LOBBY) {
      text = `<b>${t(lang, 'lobbyOpen')}</b>\n👥 ${t(lang, 'humans')}: ${game.players.filter(p => !p.isBot).length} / ${game.maxPlayers}\n🎯 ${t(lang, 'modeLabel')}: <b>${modeLabel(lang, game.mode)}</b>`;
    } else if (game.phase === PHASE.GAMEOVER) {
      const winner = game.players[game.winners[game.winners.length - 1]];
      text = `🏆 <b>${mentionFor(winner)}</b> ${t(lang, 'wins')}`;
    } else if (game.phase === PHASE.ROLL) {
      text = `<b>${t(lang, 'turn')} ${game.turn}</b>\n${player.emoji} ${mentionFor(player)} ${t(lang, 'toRoll')}.`;
    } else if (game.phase === PHASE.MOVE) {
      text = `<b>${t(lang, 'turn')} ${game.turn}</b>\n${player.emoji} ${mentionFor(player)} ${rolledText(lang, game.dice)}.`;
    }
    await sendMessage(env, game.chatId, text, {}, lang);
  }
}

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'Content-Type': 'application/json' },
  });
}

const SAVED_SENTINEL = Symbol('saved');

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
        hasKV: !!env.BOT_KV,
        hasEncryptionKey: !!env.DB_ENCRYPTION_KEY,
      };
      if (token) {
        try {
          const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
          const j = await r.json();
          info.telegramOk = j.ok;
          info.telegramBot = j.ok ? j.result.username : (j.description || 'unknown error');
        } catch (e) { info.telegramOk = false; info.telegramBot = 'fetch failed: ' + e.message; }
      }
      try { await ensureResvg(); info.resvgOk = true; } catch (e) { info.resvgOk = false; info.resvgError = e.message; }
      try { const img = await ensureLloydImage(env); info.lloydOk = !!img; info.lloydSize = img ? img.length : 0; }
      catch (e) { info.lloydOk = false; }
      return new Response(JSON.stringify(info, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method === 'GET' && url.pathname === '/debug/avatars') {
      const chatId = url.searchParams.get('chat');
      if (!chatId) return new Response('missing ?chat=<chatId>', { status: 400 });
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(chatId));
      const stateRes = await stub.fetch('https://do/get', { method: 'GET' });
      const game = await stateRes.json();
      const avatars = game?.avatars || {};
      const summary = Object.entries(avatars).map(([uid, uri]) => ({
        userId: uid,
        present: !!uri,
        length: uri ? uri.length : 0,
        prefix: uri ? uri.slice(0, 30) : null,
      }));
      return new Response(JSON.stringify({
        chatId,
        mode: game?.mode || null,
        playerCount: game?.players?.length || 0,
        humanCount: game?.players?.filter(p => !p.isBot).length || 0,
        avatars: summary,
      }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('Mensch ärgere Dich nicht bot is running 🎲', { status: 200 });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/board/')) {
      const chatId = decodeURIComponent(url.pathname.slice('/board/'.length));
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(chatId));
      const stateRes = await stub.fetch('https://do/get', { method: 'GET' });
      const game = await stateRes.json();
      if (!game) return new Response('No active game', { status: 404 });
      try {
        const needsLloyd = game.players.some(p => p.isBot && p.name === SPECIAL_BOT_NAME);
        const lloydImg = needsLloyd ? await ensureLloydImage(env) : null;
        const svg = renderBoardSVG(game, 1000, lloydImg);
        const png = await svgToPng(svg, BOARD_PNG_WIDTH);
        return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
      } catch (e) { return new Response('Render failed: ' + e.message, { status: 500 }); }
    }

    if (request.method === 'POST') {
      let update;
      try { update = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }

      const chatId = extractChatId(update);
      if (chatId) {
        const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(String(chatId)));

        let initial = { botsRemaining: 0 };
        try {
          const res = await stub.fetch('https://do/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Worker-Url': url.origin },
            body: JSON.stringify(update),
          });
          initial = await res.json().catch(() => ({}));
        } catch (e) {
          console.error('Initial DO dispatch failed:', e && e.stack ? e.stack : e);
        }

        if (initial && initial.botsRemaining > 0) {
          ctx.waitUntil((async () => {
            let remaining = initial.botsRemaining;
            let guard = 0;
            while (remaining > 0 && guard++ < BOT_TICK_GUARD) {
              try {
                await new Promise(r => setTimeout(r, BOT_TICK_DELAY_MS));
                const tickRes = await stub.fetch('https://do/bot-tick', { method: 'POST' });
                const tickData = await tickRes.json().catch(() => ({}));
                remaining = tickData.botsRemaining || 0;
              } catch (e) {
                console.error('Bot tick failed:', e && e.stack ? e.stack : e);
                break;
              }
            }
          })());
        }
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
