// ============================================================
// Fetches AniList airing schedule and writes it to Cloudflare KV.
// Skips writes when the data hasn't meaningfully changed, so we
// don't burn through the 1000 writes/day free tier.
// ============================================================

const ANILIST_API = 'https://graphql.anilist.co';
const CF_API = 'https://api.cloudflare.com/client/v4';
const crypto = require('crypto');

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_KV_NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

if (!CF_ACCOUNT_ID || !CF_KV_NAMESPACE_ID || !CF_API_TOKEN) {
  console.error('Missing required env vars: CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID, CF_API_TOKEN');
  process.exit(1);
}

const KV_KEY = 'sched:anilist:v5:week';
const KV_TTL = 86400;         // 24 hours
const FORCE_WRITE_AFTER_MS = 6 * 60 * 60 * 1000;  // rewrite at least every 6h
const JST = 'Asia/Tokyo';

const ANILIST_QUERY = `
query($start: Int, $end: Int, $page: Int) {
  Page(perPage: 50, page: $page) {
    pageInfo { hasNextPage }
    airingSchedules(airingAt_greater: $start, airingAt_lesser: $end) {
      episode
      airingAt
      media {
        id
        idMal
        title { romaji english native }
        episodes
        siteUrl
        format
      }
    }
  }
}`;

async function anilistFetch(variables, attempt = 1) {
  try {
    const res = await fetch(ANILIST_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://anilist.co',
        'Referer': 'https://anilist.co/',
      },
      body: JSON.stringify({ query: ANILIST_QUERY, variables }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
    return json?.data?.Page || { airingSchedules: [], pageInfo: {} };
  } catch (e) {
    if (attempt < 3) {
      const wait = 2000 * attempt;
      console.warn(`AniList ${e.message}, retry ${attempt}/3 in ${wait}ms...`);
      await new Promise((r) => setTimeout(r, wait));
      return anilistFetch(variables, attempt + 1);
    }
    throw e;
  }
}

function getJstDayAndTime(unixSec) {
  const d = new Date(unixSec * 1000);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: JST, weekday: 'long' })
    .format(d).toLowerCase();
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: JST, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
  return { day, time };
}

function normalizeEntry(entry) {
  const media = entry.media || {};
  const title = media.title?.english || media.title?.romaji || media.title?.native || '';
  const malId = media.idMal || null;
  return {
    mal_id: malId,
    anilist_id: media.id,
    title,
    episodes: media.episodes || null,
    format: media.format || 'TV',
    airingAt: entry.airingAt,
    episode: entry.episode || null,
    url: malId ? `https://myanimelist.net/anime/${malId}` : media.siteUrl,
  };
}

async function buildWeek() {
  const nowJstYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: JST, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const startJst = new Date(`${nowJstYmd}T00:00:00+09:00`);
  const startUnix = Math.floor(startJst.getTime() / 1000);
  const endUnix = startUnix + 7 * 86400;

  const all = [];
  for (let page = 1; page <= 4; page++) {
    const pageData = await anilistFetch({ start: startUnix, end: endUnix, page });
    const entries = pageData.airingSchedules || [];
    all.push(...entries);
    console.log(`Page ${page}: ${entries.length} entries`);
    if (!pageData.pageInfo?.hasNextPage) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`Total AniList entries: ${all.length}`);

  const week = {};
  for (const e of all) {
    const norm = normalizeEntry(e);
    if (!norm.title || !norm.episode) continue;
    const { day, time } = getJstDayAndTime(norm.airingAt);
    if (!week[day]) week[day] = [];
    week[day].push({ ...norm, jstTime: time });
  }
  for (const d of Object.keys(week)) {
    week[d].sort((a, b) => a.airingAt - b.airingAt);
  }
  return week;
}

async function readKV(key) {
  const url = `${CF_API}/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    console.warn(`KV read failed: HTTP ${res.status}`);
    return null;
  }
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function writeToKV(key, value, ttl) {
  const url = `${CF_API}/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}?expiration_ttl=${ttl}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'text/plain',
    },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error(`KV write failed: HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  }
}

/**
 * Compute a stable fingerprint of just the parts that matter for
 * scheduling. We deliberately ignore ts and jstTime, because those
 * change every run without affecting airing logic.
 */
function fingerprint(week) {
  const basis = {};
  for (const day of Object.keys(week).sort()) {
    basis[day] = week[day].map((e) => ({
      id: e.anilist_id,
      ep: e.episode,
      at: e.airingAt,
      total: e.episodes,
    }));
  }
  return crypto.createHash('sha1').update(JSON.stringify(basis)).digest('hex');
}

(async () => {
  try {
    // 1. Read existing KV
    const existing = await readKV(KV_KEY);
    const existingFp = existing?.week ? fingerprint(existing.week) : null;
    const existingAge = existing?.ts ? Date.now() - existing.ts : Infinity;

    // 2. Fetch fresh data
    const week = await buildWeek();
    const newFp = fingerprint(week);

    const summary = Object.entries(week)
      .map(([d, list]) => `${d}: ${list.length}`)
      .join(', ');
    console.log(`Fetched: ${summary}`);
    console.log(`Old fingerprint: ${existingFp || '(none)'}`);
    console.log(`New fingerprint: ${newFp}`);

    // 3. Skip write if nothing changed (unless the entry is very old)
    if (existingFp === newFp && existingAge < FORCE_WRITE_AFTER_MS) {
      console.log(`✅ No change detected (age ${Math.round(existingAge / 60000)}m). Skipping KV write to save quota.`);
      process.exit(0);
    }

    // 4. Write
    const payload = { ts: Date.now(), week };
    await writeToKV(KV_KEY, payload, KV_TTL);
    console.log(`✅ KV write OK (${Object.values(week).flat().length} entries)`);
    process.exit(0);
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
  }
})();
