// Fetch Gelbooru posts by tag, download via the Worker proxy,
// compress with 7z (LZMA2, ultra), and stage for git push.
//
// Environment (set by the workflow):
//   TAGS              - space/comma separated tags
//   RATING            - all | safe | questionable | explicit
//   USE_FILTER        - 'true' | 'false'
//   MAX_PAGES         - integer (100 posts per page)
//   COMPRESSION_LEVEL - 1..9
//   KEEP_RAW          - 'true' | 'false'
//   KEY               - Gelbooru API key (secret)
//   ID                - Gelbooru user id (secret)
//   PROXY_URL         - Worker media proxy base URL
//   FILTER_LIST_URL   - JSON with BLOCKED_TAGS

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const GELBOORU_API = 'https://gelbooru.com/index.php';

const PROXY_URL        = process.env.PROXY_URL || '';
const FILTER_LIST_URL  = process.env.FILTER_LIST_URL || '';
const TAGS             = (process.env.TAGS || '').trim();
const RATING           = (process.env.RATING || 'all').trim().toLowerCase();
const USE_FILTER       = (process.env.USE_FILTER || 'false') === 'true';
const KEEP_RAW         = (process.env.KEEP_RAW || 'false') === 'true';
const MAX_PAGES        = clampInt(process.env.MAX_PAGES, 1, 50, 10);
const COMPRESSION      = clampInt(process.env.COMPRESSION_LEVEL, 1, 9, 9);
const API_KEY          = process.env.KEY || '';
const USER_ID          = process.env.ID  || '';

// Safety caps
const PAGE_SIZE        = 100;
const MAX_TOTAL_POSTS  = 3000;

const RATING_MAP = { safe: 's', questionable: 'q', explicit: 'e' };

// Throttle — stay well under Gelbooru limits
const SLEEP_PAGE_FETCH = 1500; // ms between API pages
const SLEEP_DOWNLOAD   = 800;  // ms between media files
const SLEEP_ON_429     = 15000;

// ───────────────────────────────────────────── helpers
function clampInt(v, min, max, dflt) {
  const n = parseInt(String(v || ''), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, attempt = 0) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (arttag-archive)' },
  });
  if (res.status === 429 && attempt < 3) {
    console.warn(`429 on ${url} — backing off ${SLEEP_ON_429}ms`);
    await sleep(SLEEP_ON_429);
    return fetchJson(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function extFromUrl(u) {
  try {
    const p = new URL(u).pathname.split('.').pop() || '';
    if (/^[a-z0-9]{2,5}$/i.test(p)) return p.toLowerCase();
  } catch {}
  return null;
}

function extFromContentType(ct) {
  const c = (ct || '').toLowerCase();
  if (c.includes('jpeg')) return 'jpg';
  if (c.includes('png'))  return 'png';
  if (c.includes('gif'))  return 'gif';
  if (c.includes('webp')) return 'webp';
  if (c.includes('avif')) return 'avif';
  if (c.includes('mp4'))  return 'mp4';
  if (c.includes('webm')) return 'webm';
  if (c.includes('quicktime')) return 'mov';
  return 'bin';
}

function sanitizeSlug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'arttag';
}

// ───────────────────────────────────────────── main
async function main() {
  if (!TAGS && RATING === 'all') {
    throw new Error('At least one of `tags` or `rating` must be specified.');
  }
  if (!PROXY_URL) throw new Error('PROXY_URL env var is required.');

  // 1. Filter list
  let blockedTags = [];
  if (USE_FILTER) {
    console.log(`→ Fetching filter list: ${FILTER_LIST_URL}`);
    try {
      const cfg = await fetchJson(FILTER_LIST_URL);
      blockedTags = Array.isArray(cfg.BLOCKED_TAGS) ? cfg.BLOCKED_TAGS : [];
      console.log(`  Loaded ${blockedTags.length} blocked tags.`);
    } catch (e) {
      console.warn(`  ⚠️ Filter list failed (${e.message}) — continuing unfiltered.`);
    }
  } else {
    console.log('→ Filter list disabled (use_filter=false).');
  }

  // 2. Build query
  const tagParts = [];
  if (TAGS) {
    tagParts.push(...TAGS.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean));
  }
  if (RATING !== 'all') {
    if (!RATING_MAP[RATING]) {
      throw new Error(`Unknown rating "${RATING}". Use all|safe|questionable|explicit.`);
    }
    tagParts.push(`rating:${RATING_MAP[RATING]}`);
  }
  const baseQuery = tagParts.join(' ');
  const fullQuery = blockedTags.length
    ? `${baseQuery} ${blockedTags.map((t) => `-${t}`).join(' ')}`
    : baseQuery;

  console.log(`→ Query: ${fullQuery}`);

  // 3. Fetch posts
  const all = [];
  const seen = new Set();

  for (let pid = 0; pid < MAX_PAGES; pid++) {
    if (all.length >= MAX_TOTAL_POSTS) {
      console.log(`  hit MAX_TOTAL_POSTS (${MAX_TOTAL_POSTS}) — stopping pagination.`);
      break;
    }

    const params = new URLSearchParams({
      page: 'dapi', s: 'post', q: 'index', json: '1',
      limit: String(PAGE_SIZE), pid: String(pid), tags: fullQuery,
    });
    if (API_KEY) params.set('api_key', API_KEY);
    if (USER_ID) params.set('user_id', USER_ID);

    console.log(`→ Fetching page ${pid + 1}/${MAX_PAGES}...`);
    let data;
    try {
      data = await fetchJson(`${GELBOORU_API}?${params}`);
    } catch (e) {
      console.error(`  ✗ page ${pid + 1} failed: ${e.message}`);
      break;
    }

    const posts = data.post || [];
    console.log(`  Got ${posts.length} posts.`);
    if (!posts.length) break;

    for (const p of posts) {
      const id = parseInt(p.id, 10);
      if (!Number.isFinite(id) || seen.has(id)) continue;
      seen.add(id);
      all.push({ ...p, id });
    }

    if (posts.length < PAGE_SIZE) break;
    if (pid < MAX_PAGES - 1) await sleep(SLEEP_PAGE_FETCH);
  }

  console.log(`→ Total unique posts: ${all.length}`);

  // 4. Client-side filters (defense-in-depth)
  let filtered = all;
  if (RATING !== 'all') {
    const code = RATING_MAP[RATING];
    filtered = filtered.filter((p) => p.rating === code);
    console.log(`  After rating=${RATING}: ${filtered.length}`);
  }
  if (blockedTags.length) {
    const blocked = new Set(blockedTags);
    filtered = filtered.filter((p) => {
      const t = (p.tags || '').split(/\s+/).filter(Boolean);
      return !t.some((x) => blocked.has(x));
    });
    console.log(`  After blocked-tag filter: ${filtered.length}`);
  }

  if (!filtered.length) {
    console.log('→ Nothing matches. Aborting.');
    return;
  }

  // 5. Prepare output dirs
  fs.mkdirSync('archives', { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = sanitizeSlug(TAGS || 'rating_only');
  const ratingSuffix = RATING !== 'all' ? `_${RATING}` : '';
  const folderName = `${slug}${ratingSuffix}_${ts}`;
  const mediaDir = path.join('archives', folderName);
  fs.mkdirSync(mediaDir, { recursive: true });

  // 6. Download media
  let downloaded = 0;
  let failed = 0;
  const failedIds = [];

  for (const post of filtered) {
    const candidates = [post.sample_url]
      .filter((u) => typeof u === 'string' && u.length > 0);

    if (!candidates.length) {
      failed++;
      failedIds.push(post.id);
      continue;
    }

    let ok = false;

    for (const target of candidates) {
      try {
        const proxyUrl = `${PROXY_URL.replace(/\/+$/, '')}/${target}`;
        const res = await fetch(proxyUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (arttag-archive)' },
        });

        if (res.status === 429) {
          console.warn(`  ⏸ 429 on ${post.id} — waiting ${SLEEP_ON_429}ms`);
          await sleep(SLEEP_ON_429);
          continue;
        }
        if (!res.ok) {
          console.warn(`  ${post.id}: ${res.status} on ${target.slice(0, 80)}`);
          continue;
        }

        const ct = res.headers.get('content-type') || '';
        if (/text\/html|application\/xhtml/i.test(ct)) {
          console.warn(`  ${post.id}: upstream returned HTML — skipping`);
          continue;
        }

        const ext = extFromUrl(target) || extFromContentType(ct);
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) continue;

        const base = String(post.id).padStart(10, '0');
        fs.writeFileSync(path.join(mediaDir, `${base}.${ext}`), buf);

        // Sidecar metadata
        fs.writeFileSync(
          path.join(mediaDir, `${base}.json`),
          JSON.stringify({
            id: post.id,
            rating: post.rating,
            score: post.score,
            source: post.source,
            tags: post.tags,
            file_url: post.file_url,
            sample_url: post.sample_url,
            preview_url: post.preview_url,
            fetched_at: new Date().toISOString(),
            query: { tags: TAGS, rating: RATING, use_filter: USE_FILTER },
          }, null, 2)
        );

        downloaded++;
        console.log(`  ✓ ${post.id} (${(buf.length / 1024 / 1024).toFixed(2)} MB, ${ext})`);
        ok = true;
        break;
      } catch (e) {
        console.warn(`  ${post.id}: ${e.message}`);
      }
    }

    if (!ok) {
      failed++;
      failedIds.push(post.id);
      console.log(`  ✗ ${post.id} — all candidates failed`);
    }

    await sleep(SLEEP_DOWNLOAD);
  }

  console.log(`→ Downloaded: ${downloaded}   Failed: ${failed}`);

  if (!downloaded) {
    console.log('→ Nothing downloaded — aborting.');
    fs.rmSync(mediaDir, { recursive: true, force: true });
    return;
  }

  // Record failed IDs for reference (inside the archive)
  if (failedIds.length) {
    fs.writeFileSync(
      path.join(mediaDir, '_failed_ids.json'),
      JSON.stringify({ count: failedIds.length, ids: failedIds }, null, 2)
    );
  }

  // 7. Compress with 7z — full/ultra compression
  const archivePath = path.join('archives', `${folderName}.7z`);
  console.log(`→ Compressing to ${archivePath} (level ${COMPRESSION})…`);

  const sevenZipArgs = [
    'a',
    '-t7z',
    '-m0=lzma2',
    `-mx=${COMPRESSION}`,
    '-mfb=273',      // fast bytes (max)
    '-md=256m',      // 256 MB dictionary
    '-ms=on',        // solid archive
    '-mmt=on',       // multithread
    '-y',
    archivePath,
    mediaDir,
  ];

  execSync(`7z ${sevenZipArgs.map((a) => JSON.stringify(a)).join(' ')}`, {
    stdio: 'inherit',
    shell: '/bin/bash',
  });

  const size = fs.statSync(archivePath).size;
  console.log(`→ Archive: ${(size / 1024 / 1024).toFixed(2)} MB`);

  // 8. Cleanup
  if (!KEEP_RAW) {
    fs.rmSync(mediaDir, { recursive: true, force: true });
    console.log('→ Raw folder removed.');
  } else {
    console.log('→ Raw folder kept (KEEP_RAW=true).');
  }

  console.log('✓ Done.');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
